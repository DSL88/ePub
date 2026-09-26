import { extractHeaderMetadata, type PdfOutlineEntry, type PdfPageContent, type TextLine } from './pdfInspector'

export type ParagraphKind = 'text' | 'subheading'

export interface SanitizedParagraph {
  /** paragraph text */
  text: string
  /** 0-based index of the PDF page where the paragraph begins */
  startPage: number
  /** o parágrafo é o primeiro bloco de conteúdo da sua página (quebra de página explícita) */
  atPageTop?: boolean
  /** o parágrafo é precedido de um espaçamento vertical significativo */
  afterBigGap?: boolean
  /** a primeira linha tem o recuo típico de início de parágrafo */
  firstLineIndented?: boolean
  /** subtítulo/intertítulo no meio do texto (renderizado como h2/h3) */
  kind?: ParagraphKind
  /** nível do subtítulo: 2 = h2 (destaque por tamanho), 3 = h3 (destaque apenas em peso) */
  level?: 2 | 3
}

export interface SanitizedText {
  paragraphs: SanitizedParagraph[]
  pages: SanitizedPageMetadata[]
}

export interface SanitizedPageMetadata {
  /** índice zero-based da página PDF */
  pageIndex: number
  physicalPageNumber?: string
  headerTitle?: string
}

export interface DetectedChapter {
  title: string
  content: string
  startPage: number
}

export function pageText(page: PdfPageContent): string {
  if (typeof page.text === 'string') {
    return page.text
  }
  return (page.lines ?? []).map((line) => line.text).join('\n')
}

export function dehyphenate(text: string): string {
  const withoutSoftHyphens = text.replace(/\u00AD/g, '')
  const lines = withoutSoftHyphens.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : ''
    const prevTrim = prev.trimEnd()
    const next = line.trim()

    if (prevTrim.endsWith('-') && next) {
      if (/^[a-z\u00E0-\u00FF]/.test(next)) {
        out[out.length - 1] = prevTrim.slice(0, -1) + next
      } else {
        out[out.length - 1] = prevTrim + next
      }
      continue
    }
    out.push(line)
  }

  return out.join('\n')
}

const PAGE_NUMBER_RE = /^[\dIVXLCDMivxlcdm]{1,6}\.?$/

// --- Deteção semântica de subtítulos (intertítulos) ---

const SUBHEADING_MAX_LENGTH = 80
/** tamanho mínimo do corpo relativo ao corpo dominante da página */
const SUBHEADING_SIZE_FACTOR = 1.15
/** proporção mínima de caracteres em fonte negrito para a linha ser bold */
const SUBHEADING_BOLD_RATIO = 0.6

interface PageLineMetrics {
  /** tamanho de fonte dominante do corpo da página (0 = indeterminado) */
  bodyFontSize: number
}

/**
 * Tamanho de fonte dominante do corpo da página: moda ponderada pelo número
 * de caracteres, recolhida apenas sobre linhas longas (parágrafos), para
 * não ser contaminada por títulos, números de página ou legendas.
 */
function dominantBodyFontSize(lines: TextLine[]): number {
  const weights = new Map<number, number>()
  for (const line of lines) {
    if (!(line.fontSize > 0) || line.text.length < 20) {
      continue
    }
    const key = Math.round(line.fontSize * 2) / 2
    weights.set(key, (weights.get(key) ?? 0) + line.text.length)
  }
  let bestSize = 0
  let bestWeight = 0
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestSize = size
      bestWeight = weight
    }
  }
  return bestSize
}

/**
 * Uma linha funciona como subtítulo quando cumpre TODOS os critérios:
 * tipografia de destaque (tamanho >= 1.15× o corpo da página OU fonte
 * Bold/Black/Heavy/Medium) + linha curta, maioritariamente letras, sem
 * pontuação terminal e visualmente separada do texto corrido. O isolamento
 * evita partir um parágrafo só porque uma das suas linhas está a negrito.
 */
function isSubheadingLine(line: TextLine, metrics: PageLineMetrics, visuallySeparated: boolean): boolean {
  if (metrics.bodyFontSize <= 0 || !(line.fontSize > 0)) {
    return false
  }
  if (!visuallySeparated) {
    return false
  }
  const text = line.text.trim()
  if (!text || text.length > SUBHEADING_MAX_LENGTH || PAGE_NUMBER_RE.test(text)) {
    return false
  }
  // frases corridas terminam com pontuação; títulos não
  if (/[.,;:]$/.test(text)) {
    return false
  }
  // letra capitular (drop cap): letra isolada grande, sem peso de negrito
  if (line.bold !== true && text.length <= 3) {
    return false
  }
  const letters = text.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, '').length
  const nonSpaces = text.replace(/\s/g, '').length
  if (nonSpaces === 0 || letters / nonSpaces < SUBHEADING_BOLD_RATIO) {
    return false
  }
  return line.fontSize >= metrics.bodyFontSize * SUBHEADING_SIZE_FACTOR || line.bold === true
}

function computeLineMetrics(lines: TextLine[], bodyFontSizeOverride = 0): PageLineMetrics {
  return {
    bodyFontSize: bodyFontSizeOverride > 0 ? bodyFontSizeOverride : dominantBodyFontSize(lines)
  }
}

function headerKey(text: string): string {
  // Normaliza números de página variáveis para que cabeçalhos correntes como
  // "172 EMILY HAUSER" e "MÍTICAS 175" sejam reconhecidos como o mesmo
  // cabeçalho repetido.
  return text.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function stripPageNumberLines(lines: TextLine[]): TextLine[] {
  const out = [...lines]
  if (out.length > 0 && PAGE_NUMBER_RE.test(out[0].text.trim())) {
    out.shift()
  }
  if (out.length > 0 && PAGE_NUMBER_RE.test(out[out.length - 1].text.trim())) {
    out.pop()
  }
  return out
}

/**
 * Remove o "móbil" de página no topo e no fundo: cabeçalho corrente
 * repetido seguido/precedido de número de página ("MÍTICAS" + "3") ou um
 * número de página isolado. Executa DEPOIS de remover o cabeçalho, para
 * apanhar o número que fica exposto por baixo dele.
 */
function stripPageFurniture(lines: TextLine[], repeatedHeaders: Set<string>): TextLine[] {
  const out = [...lines]
  if (out.length > 0) {
    const first = out[0].text.trim()
    if (repeatedHeaders.has(headerKey(first))) {
      out.shift()
      if (out.length > 0 && PAGE_NUMBER_RE.test(out[0].text.trim())) {
        out.shift()
      }
    } else if (PAGE_NUMBER_RE.test(first)) {
      out.shift()
    }
  }
  if (out.length > 0 && PAGE_NUMBER_RE.test(out[out.length - 1].text.trim())) {
    out.pop()
  }
  return out
}

/**
 * A physical line-end hyphen is repaired only when the next line is a close,
 * unindented continuation in the same reading flow. Geometry cannot always
 * distinguish a lexical hyphen from a discretionary one, so keep non-lowercase
 * continuations hyphenated and never repair across a column-flow reset.
 */
const PHYSICAL_LINE_HYPHEN_RE = /[-\u2010]$/

function hasTrailingPhysicalHyphen(text: string): boolean {
  return PHYSICAL_LINE_HYPHEN_RE.test(text.trimEnd())
}

function startsWithLowercaseLetter(text: string): boolean {
  const firstLetter = text.trim().match(/\p{L}/u)?.[0]
  return !!firstLetter && /\p{Ll}/u.test(firstLetter)
}

function dehyphenateLines(lines: TextLine[]): TextLine[] {
  const fontSize = dominantBodyFontSize(lines)
  const normalGap = typicalLineGap(lines, fontSize)
  // Linhas sintéticas (OCR sem coordenadas: fontSize 0, gaps artificiais de
  // 100) têm geometria não fiável — sem este fallback a desifenização NUNCA
  // corria para elas (gap 100 > maxLineBreak 18) e os hífens de fim de linha
  // do papel ("dei- / xar-se") ficavam no EPUB. Prática padrão (Calibre
  // --unwrap-factor, PyMuPDF: juntar linhas do mesmo bloco): sem geometria,
  // decide só pelo texto.
  const geometryReliable = fontSize > 0 && normalGap > 0
  const maxLineBreak = Math.max(normalGap * 1.6, fontSize * 2.2, 18)
  const out: TextLine[] = []
  for (const line of lines) {
    const text = line.text.replace(/\u00AD/g, '')
    const prev = out.length ? out[out.length - 1] : null
    if (prev) {
      const prevTrim = prev.text.trimEnd()
      const next = text.trim()
      if (hasTrailingPhysicalHyphen(prevTrim) && next) {
        if (!geometryReliable) {
          if (startsWithLowercaseLetter(next)) {
            prev.text = prevTrim.slice(0, -1) + next
          } else {
            prev.text = prevTrim + next
          }
          continue
        }
        const lineFontSize = Math.max(prev.fontSize, line.fontSize)
        const verticalGap = prev.y - line.y
        const nextStartsIndented =
          line.x - prev.x >= Math.max(lineFontSize * 0.65, 5) &&
          line.x - prev.x <= Math.max(lineFontSize * 3, 24)
        const sameTextBlock =
          verticalGap > 0 &&
          verticalGap <= maxLineBreak &&
          !nextStartsIndented &&
          !isReadingFlowReset(prev, line, lineFontSize)
        if (sameTextBlock) {
          if (startsWithLowercaseLetter(next)) {
            prev.text = prevTrim.slice(0, -1) + next
          } else {
            prev.text = prevTrim + next
          }
          continue
        }
      }
    }
    out.push({ ...line, text })
  }
  return out
}

/**
 * Rede de segurança: linhas que foram coladas com espaço ("dei- xar-se")
 * porque a geometria vetou a desifenização têm de ser reparadas, senão o
 * e-reader parte a linha no hífen e o texto parece "não seguido". Junta
 * letra-hífen-espaços-letra.minúscula (padrão Calibre). Não toca em
 * travessões ("palavra - continua": há espaço antes do hífen) nem em
 * continuações maiúsculas (hínens lexicais preservados).
 */
export function repairLeftoverHyphenation(text: string): string {
  return text.replace(/(\p{L})[-\u2010]\s+(\p{Ll})/gu, '$1$2')
}

/** Texto OCR: sem coordenadas; preserva espaços/linhas em branco tal como
 * chegaram do OCR. Cada linha recebe um y sintético com espaçamento maior
 * que a tolerância de agrupamento, para que nunca se fundam duas linhas. */
function synthesizeLines(text: string): TextLine[] {
  return text.split('\n').map((raw, index) => ({
    text: raw,
    x: 0,
    y: -index * 100,
    fontSize: 0
  }))
}

/**
 * Linhas de origem de uma página. Um `text` explicitamente vazio significa
 * página ilustração (texto de mapa descartado de propósito) ou página em
 * branco: sem parágrafos. Com `lines` estruturadas usa-as (têm coordenadas
 * para as regras de posição); em alternativa, usa o texto (OCR).
 */
function pageSourceLines(page: PdfPageContent): TextLine[] {
  if (typeof page.text === 'string' && !page.text.trim()) {
    return []
  }
  const structured = page.lines ?? []
  if (structured.some((line) => line.text.trim())) {
    return structured
  }
  if (typeof page.text === 'string' && page.text.trim()) {
    return synthesizeLines(page.text)
  }
  return []
}

interface SegmentedPage {
  lines: TextLine[]
  geometryAware: boolean
  metadata: SanitizedPageMetadata
}

/** Aplica as mesmas zonas aos textos OCR com coordenadas e aos textos pdf.js. */
function segmentPage(page: PdfPageContent, pageIndex: number): SegmentedPage {
  const sourceLines = pageSourceLines(page)
  const geometryAware = (page.lines?.length ?? 0) > 0 && (page.height ?? 0) > 0
  if (!geometryAware) {
    return {
      lines: sourceLines,
      geometryAware: false,
      metadata: {
        pageIndex,
        ...(page.physicalPageNumber ? { physicalPageNumber: page.physicalPageNumber } : {}),
        ...(page.headerTitle ? { headerTitle: page.headerTitle } : {})
      }
    }
  }

  const height = page.height!
  // Mesma zona estreita do pdfInspector (topo 5% / fundo 5%): títulos de
  // capítulo no topo (~8-12%) ficam no corpo, não no cabeçalho.
  const headerLines = page.lines!.filter((line) => line.text.trim() && line.y >= height * 0.95)
  const footerLines = page.lines!.filter((line) => line.text.trim() && line.y <= height * 0.05)
  const bodyLines = sourceLines.length === 0
    ? []
    : page.lines!.filter((line) => line.y < height * 0.95 && line.y > height * 0.05)
  const header = extractHeaderMetadata(headerLines)
  const footer = extractHeaderMetadata(footerLines)

  return {
    lines: bodyLines,
    geometryAware: true,
    metadata: {
      pageIndex,
      ...(page.physicalPageNumber ?? header.physicalPageNumber ?? footer.physicalPageNumber
        ? { physicalPageNumber: page.physicalPageNumber ?? header.physicalPageNumber ?? footer.physicalPageNumber }
        : {}),
      ...(page.headerTitle ?? (header.title || undefined)
        ? { headerTitle: page.headerTitle ?? header.title }
        : {})
    }
  }
}

// Um salto entre linhas só é quebra de parágrafo se exceder claramente a
// entrelinha normal da página. A pontuação terminal, por si só, não separa
// frases que pertencem ao mesmo parágrafo.
const PARAGRAPH_GAP_FACTOR = 1.3
const PARAGRAPH_FONT_GAP_FACTOR = 1.45
const MIN_PARAGRAPH_GAP = 5
/** Top-quarter/bottom-fifth zones are deliberately generous page-edge checks. */
const PAGE_TOP_CONTINUATION_FRACTION = 0.75
const PAGE_BOTTOM_CONTINUATION_FRACTION = 0.2

interface PageParagraph {
  text: string
  /** primeiro bloco de conteúdo da página */
  atPageTop: boolean
  /** primeiro bloco na ordem de leitura, distinto de um bloco apenas alto na página */
  firstContentBlock: boolean
  /** primeira linha está fisicamente na zona superior quando há geometria */
  startsNearPageTop: boolean
  /** precedido de grande espaçamento vertical */
  afterBigGap: boolean
  /** primeira linha alinhada com recuo de parágrafo */
  firstLineIndented: boolean
  /** índice da primeira linha do bloco */
  firstLineIndex: number
  /** índice da última linha do bloco */
  lastLineIndex: number
  /** a posição vertical pode ser comparada com a altura da página */
  geometryAware: boolean
  /** última linha chega à zona inferior que normalmente antecede uma viragem */
  endsNearPageBottom: boolean
  /** subtítulo tipográfico vs parágrafo normal */
  kind: ParagraphKind
  /** nível do subtítulo (2 = h2 por tamanho, 3 = h3 por peso) */
  level: 2 | 3
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))
  return sorted[index]
}

function typicalLineGap(lines: TextLine[], bodyFontSize: number): number {
  const positioned = lines
    .filter((line) => line.text.trim())
    .sort((a, b) => b.y - a.y)
  const gaps: number[] = []
  for (let i = 1; i < positioned.length; i++) {
    const gap = positioned[i - 1].y - positioned[i].y
    const fontSize = Math.max(positioned[i - 1].fontSize, positioned[i].fontSize, bodyFontSize)
    if (gap > 0 && gap <= Math.max(fontSize * 2.5, 30)) {
      gaps.push(gap)
    }
  }
  // O quartil inferior aproxima a entrelinha, mesmo que haja alguns saltos
  // de parágrafo no conjunto de linhas da página.
  return percentile(gaps, 0.25)
}

function commonBodyLeft(lines: TextLine[]): number {
  const weights = new Map<number, number>()
  for (const line of lines) {
    if (!line.text.trim()) {
      continue
    }
    const bucket = Math.round(line.x / 2) * 2
    weights.set(bucket, (weights.get(bucket) ?? 0) + Math.min(line.text.length, 120))
  }
  let left = 0
  let bestWeight = 0
  for (const [x, weight] of weights) {
    if (weight > bestWeight) {
      left = x
      bestWeight = weight
    }
  }
  return left
}

/**
 * The ordered line stream can enter a new column even when its baseline does
 * not rise. Keep the x threshold above the largest ordinary first-line or
 * hanging indent, and use an absolute delta so RTL column traversal behaves
 * the same as LTR.
 */
function isReadingFlowReset(previous: TextLine, line: TextLine, bodyFontSize = 0): boolean {
  const fontSize = Math.max(previous.fontSize, line.fontSize, bodyFontSize)
  const ordinaryIndentLimit = Math.max(fontSize * 3, 24)
  const horizontalResetThreshold = ordinaryIndentLimit + Math.max(fontSize, 12)
  return previous.y <= line.y || Math.abs(line.x - previous.x) > horizontalResetThreshold
}

/**
 * Finds the common left edge separately for each ordered reading flow. A
 * column-aware TextLine[] may signal a new column by either a y rise or a
 * strong x discontinuity, so one page-wide left edge would mistake every line
 * in later columns for an unindented or excessively indented line.
 */
function commonBodyLeftByLine(lines: TextLine[], bodyFontSize = 0): number[] {
  const leftByLine = new Array<number>(lines.length).fill(0)
  const flowStarts = [0]
  let previousContentIndex = -1

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text.trim()) {
      continue
    }
    if (
      previousContentIndex >= 0 &&
      isReadingFlowReset(lines[previousContentIndex], lines[i], bodyFontSize)
    ) {
      flowStarts.push(i)
    }
    previousContentIndex = i
  }
  flowStarts.push(lines.length)

  for (let flowIndex = 0; flowIndex < flowStarts.length - 1; flowIndex++) {
    const start = flowStarts[flowIndex]
    const end = flowStarts[flowIndex + 1]
    if (end <= start) {
      continue
    }
    const left = commonBodyLeft(lines.slice(start, end))
    for (let i = start; i < end; i++) {
      leftByLine[i] = left
    }
  }
  return leftByLine
}

function isIndentedLine(line: TextLine, bodyLeft: number, bodyFontSize: number): boolean {
  const indent = line.x - bodyLeft
  const fontSize = line.fontSize || bodyFontSize
  return indent >= Math.max(fontSize * 0.65, 5) && indent <= Math.max(fontSize * 3, 24)
}

function buildPageParagraphs(
  lines: TextLine[],
  pageHeight: number,
  bodyFontSize = 0,
  geometryAware = false
): PageParagraph[] {
  const firstContentIndex = lines.findIndex((line) => line.text.trim())
  const metrics = computeLineMetrics(lines, bodyFontSize)
  const lineGap = typicalLineGap(lines, metrics.bodyFontSize)
  const bodyLeftByLine = commonBodyLeftByLine(lines, metrics.bodyFontSize)
  // Nível do subtítulo: 2 quando o destaque vem do tamanho (h2), 3 quando
  // vem apenas do peso da fonte (h3). `false` = não é subtítulo.
  // Fallback literário: títulos como "A detenção" no topo da página, curtos,
  // isolados por grande espaço branco, mesmo sem negrito/tamanho maior
  // (comum em OCR onde o tamanho é ruidoso). Exige gap abaixo >= 2x para
  // não confundir com a primeira linha de um parágrafo normal.
  const subheadingAt = lines.map((line, index): false | 2 | 3 => {
    const prev = index > 0 ? lines[index - 1] : undefined
    const next = index + 1 < lines.length ? lines[index + 1] : undefined
    const gapThreshold = Math.max(
      lineGap * PARAGRAPH_GAP_FACTOR,
      line.fontSize * PARAGRAPH_FONT_GAP_FACTOR,
      MIN_PARAGRAPH_GAP
    )
    const separatedAbove = !!prev && (
      !prev.text.trim() || prev.y <= line.y || prev.y - line.y > gapThreshold
    )
    const separatedBelow = !!next && (
      !next.text.trim() || line.y <= next.y || line.y - next.y > gapThreshold
    )
    const prominentAtPageTop =
      index === firstContentIndex &&
      (line.bold === true || line.fontSize >= metrics.bodyFontSize * SUBHEADING_SIZE_FACTOR)
    if (!isSubheadingLine(line, metrics, separatedAbove || separatedBelow || prominentAtPageTop)) {
      // Fallback sem tipografia: só no topo, só com geometria, só isolado.
      if (
        geometryAware &&
        index === firstContentIndex &&
        next?.text.trim()
      ) {
        const text = line.text.trim()
        const gapBelow = line.y - next.y
        const bigTitleGap = Math.max(lineGap * 2.0, line.fontSize * 2.0, 18)
        const letters = text.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, '').length
        const nonSpaces = text.replace(/\s/g, '').length
        if (
          text.length >= 4 &&
          text.length <= SUBHEADING_MAX_LENGTH &&
          !PAGE_NUMBER_RE.test(text) &&
          !/[.,;:!?…]$/.test(text) &&
          nonSpaces > 0 &&
          letters / nonSpaces >= SUBHEADING_BOLD_RATIO &&
          gapBelow > bigTitleGap &&
          gapBelow > 0
        ) {
          return 2
        }
      }
      return false
    }
    return line.fontSize >= metrics.bodyFontSize * SUBHEADING_SIZE_FACTOR ? 2 : 3
  })

  const paragraphs: PageParagraph[] = []
  let parts: string[] = []
  let start = -1
  let end = -1
  let afterBigGap = false
  let blockKind: ParagraphKind = 'text'
  let blockLevel: 2 | 3 = 2
  let previousLine: TextLine | null = null

  const flush = (): void => {
    const rawText = parts.join(' ').replace(/\s+/g, ' ').trim()
    // Linhas coladas com espaço após falha de geometria ("dei- xar-se"):
    // repara aqui para o parágrafo fluir no EPUB reflowável.
    const text = repairLeftoverHyphenation(rawText)
    if (text) {
      const lastLine = end >= 0 ? lines[end] : undefined
      paragraphs.push({
        text,
        atPageTop: start === firstContentIndex,
        firstContentBlock: start === firstContentIndex,
        startsNearPageTop:
          start === firstContentIndex &&
          (!geometryAware || (!!lines[start] && lines[start].y >= pageHeight * PAGE_TOP_CONTINUATION_FRACTION)),
        afterBigGap,
        firstLineIndented:
          start >= 0 && isIndentedLine(lines[start], bodyLeftByLine[start] ?? 0, metrics.bodyFontSize),
        firstLineIndex: start,
        lastLineIndex: end,
        geometryAware,
        // With geometry, an unfinished fragment away from the lower fifth is
        // ambiguous rather than evidence that the page itself cut the block.
        endsNearPageBottom:
          geometryAware &&
          pageHeight > 0 &&
          !!lastLine &&
          lastLine.y <= pageHeight * PAGE_BOTTOM_CONTINUATION_FRACTION,
        kind: blockKind,
        level: blockLevel
      })
    }
    parts = []
    start = -1
    end = -1
    afterBigGap = false
    blockKind = 'text'
    blockLevel = 2
    previousLine = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const raw = line.text
    if (!raw.trim()) {
      flush()
      continue
    }

    const lineLevel = subheadingAt[i]
    const lineKind: ParagraphKind = lineLevel ? 'subheading' : 'text'
    // um subtítulo nunca partilha bloco com o parágrafo: quebra antes e
    // depois, sem forçar quebra de capítulo
    if (parts.length > 0 && blockKind !== lineKind) {
      flush()
    }

    if (parts.length === 0) {
      start = i
      blockKind = lineKind
      blockLevel = lineLevel === false ? 2 : lineLevel
    } else if (previousLine) {
      const fontSize = Math.max(previousLine.fontSize, line.fontSize, metrics.bodyFontSize)
      const verticalGap = previousLine.y - line.y
      const bigGap =
        verticalGap > Math.max(
          lineGap * PARAGRAPH_GAP_FACTOR,
          fontSize * PARAGRAPH_FONT_GAP_FACTOR,
          MIN_PARAGRAPH_GAP
        )
      const startsIndentedParagraph = isIndentedLine(line, bodyLeftByLine[i] ?? 0, fontSize)
      // The input order is authoritative. Vertical or strong horizontal
      // discontinuities mark a new reading flow; ordinary indents stay below
      // the shared x threshold and remain paragraph-level evidence instead.
      const startsNewReadingFlow = isReadingFlowReset(previousLine, line, metrics.bodyFontSize)

      if (bigGap || startsIndentedParagraph || startsNewReadingFlow) {
        flush()
        afterBigGap = bigGap
      }
    }

    parts.push(raw.trim())
    previousLine = line
    end = i
  }
  flush()

  // Um bloco no topo da página (até ao 2.º bloco de conteúdo, dentro do
  // quartzo superior) também é considerado posição de título — cobre o caso
  // "título do livro" seguido do título do capítulo no topo da página.
  if (pageHeight > 0) {
    let blockIndex = -1
    for (const paragraph of paragraphs) {
      blockIndex++
      if (paragraph.firstLineIndex === firstContentIndex || paragraph.atPageTop) {
        continue
      }
      if (blockIndex > 1) {
        break
      }
      const firstLine = lines[paragraph.firstLineIndex]
      if (firstLine && firstLine.y >= pageHeight * 0.75) {
        paragraph.atPageTop = true
      }
    }
  }

  return paragraphs
}

export function sanitizePages(pages: PdfPageContent[]): SanitizedText {
  const segmentedPages = pages.map((page, pageIndex) => segmentPage(page, pageIndex))
  const pageLineSets = segmentedPages.map((page) =>
    page.geometryAware ? page.lines : stripPageNumberLines(page.lines)
  )
  const pageMetadata = segmentedPages.map((page) => page.metadata)

  const headerCounts = new Map<string, number>()
  let unstructuredPageCount = 0
  for (let i = 0; i < pageLineSets.length; i++) {
    if (segmentedPages[i].geometryAware) {
      continue
    }
    unstructuredPageCount++
    const lines = pageLineSets[i]
    const first = lines.find((line) => line.text.trim())
    if (!first) {
      continue
    }
    const key = headerKey(first.text)
    headerCounts.set(key, (headerCounts.get(key) ?? 0) + 1)
  }

  const repeatedHeaders = new Set(
    [...headerCounts.entries()]
      .filter(([, count]) => count >= 2 && count / Math.max(1, unstructuredPageCount) >= 0.5)
      .map(([key]) => key)
  )

  // Separação em parágrafos com posição: cada página produz blocos com a
  // informação de posição vertical (topo da página / grande espaçamento).
  const paragraphsPerPage = pageLineSets.map((lines, pageIndex) => {
    const withoutFurniture = segmentedPages[pageIndex].geometryAware
      ? lines
      : stripPageFurniture(lines, repeatedHeaders)
    const dehyphenated = dehyphenateLines(withoutFurniture)
    return buildPageParagraphs(
      dehyphenated,
      pages[pageIndex]?.height ?? 0,
      pages[pageIndex]?.bodyFontSize ?? 0,
      segmentedPages[pageIndex].geometryAware
    )
  })

  // A falta de recuo, isoladamente, não prova continuação: muitos livros
  // iniciam novos parágrafos flush-left. Exigimos uma quebra de frase ainda
  // aberta e, quando há geometria, que o fragmento anterior chegue à margem.
  const paragraphs: SanitizedParagraph[] = []
  let open: SanitizedParagraph | null = null
  let openPageIndex = -1
  let openPageHasGeometry = false
  let openEndsNearPageBottom = false

  paragraphsPerPage.forEach((pageParas, pageIndex) => {
    for (let paragraphIndex = 0; paragraphIndex < pageParas.length; paragraphIndex++) {
      const para = pageParas[paragraphIndex]
      if (!para.text) {
        continue
      }
      if (!open) {
        open = toSanitized(para, pageIndex)
        openPageIndex = pageIndex
        openPageHasGeometry = para.geometryAware
        openEndsNearPageBottom = para.endsNearPageBottom
      } else {
        const isAdjacentPageTop =
          pageIndex === openPageIndex + 1 &&
          paragraphIndex === 0 &&
          para.firstContentBlock &&
          para.atPageTop &&
          para.startsNearPageTop
        const isTextFlow =
          open.kind === 'text' &&
          para.kind === 'text' &&
          !isChapterMarker(open.text) &&
          !isChapterMarker(para.text)
        const hasNewParagraphEvidence = para.firstLineIndented || para.afterBigGap
        const hyphenHasLowercaseContinuation =
          hasTrailingPhysicalHyphen(open.text) && startsWithLowercaseLetter(para.text)
        const previousLooksUnfinished =
          hyphenHasLowercaseContinuation || !SENTENCE_END_RE.test(open.text)
        // A trailing physical hyphen plus a lowercase next-page start is
        // stronger evidence than the lower-fifth baseline check alone.
        const previousReachedPageEdge =
          !openPageHasGeometry || openEndsNearPageBottom || hyphenHasLowercaseContinuation

        // A terminal sentence is ambiguous even when both blocks are flush-left.
        // An unfinished fragment (including a trailing hard hyphen) is positive
        // evidence; indentation/gap, headings, and non-edge geometry veto it.
        const continuesMidSentence =
          isAdjacentPageTop &&
          isTextFlow &&
          !hasNewParagraphEvidence &&
          previousLooksUnfinished &&
          previousReachedPageEdge

        if (continuesMidSentence) {
          open = { ...open, text: joinParagraphFragments(open.text, para.text) }
          openPageIndex = pageIndex
          openPageHasGeometry = para.geometryAware
          openEndsNearPageBottom = para.endsNearPageBottom
        } else {
          paragraphs.push(open)
          open = toSanitized(para, pageIndex)
          openPageIndex = pageIndex
          openPageHasGeometry = para.geometryAware
          openEndsNearPageBottom = para.endsNearPageBottom
        }
      }
    }
  })
  if (open) {
    paragraphs.push(open)
  }

  return { paragraphs, pages: pageMetadata }
}

function toSanitized(para: PageParagraph, pageIndex: number): SanitizedParagraph {
  return {
    text: para.text,
    startPage: pageIndex,
    atPageTop: para.atPageTop,
    afterBigGap: para.afterBigGap,
    firstLineIndented: para.firstLineIndented,
    kind: para.kind,
    level: para.level
  }
}

function joinParagraphFragments(prev: string, next: string): string {
  const previous = prev.trimEnd()
  const following = next.trimStart()
  if (hasTrailingPhysicalHyphen(previous)) {
    if (startsWithLowercaseLetter(following)) {
      // Repair only lowercase word continuations; uppercase starts keep their
      // hyphen because a lexical hyphen is otherwise indistinguishable.
      return previous.slice(0, -1) + following
    }
    return previous + following
  }
  return `${previous} ${following}`
}

const CHAPTER_TITLE_MAX_LENGTH = 70
const SENTENCE_END_RE = /[.!?…]["»'”’)]?$/

export function isChapterMarker(block: string): boolean {
  const text = block.replace(/\s+/g, ' ').trim()
  if (!text || text.length > CHAPTER_TITLE_MAX_LENGTH) {
    return false
  }
  // placeholders internos (@image:, @sub:, @sub3:) nunca são títulos de capítulo
  if (text.startsWith('@')) {
    return false
  }

  // Títulos explícitos não terminam com pontuação terminal.
  if (/[.,;:]$/.test(text)) {
    return false
  }

  if (/^cap[íi]tulo\s+[\d]+[ivxlcdm]*$/i.test(text) || /^cap[íi]tulo\s+[ivxlcdm\d]+/i.test(text)) {
    return true
  }
  if (/^parte\s+\S+/i.test(text)) {
    return true
  }
  if (/^[IVXLCDM]{1,7}$/.test(text)) {
    return true
  }

  return false
}

export function detectChapters(
  paragraphs: SanitizedParagraph[],
  illustrations?: Map<number, string[]>,
  explicitMarks?: number[],
  outline?: PdfOutlineEntry[],
  pageMetadata: SanitizedPageMetadata[] = []
): DetectedChapter[] {
  interface WorkingChapter {
    title: string
    parts: string[]
    startPage: number
    /** capítulo vindo do TOC nativo ou de marcação do utilizador: nunca é
     * fundido como falso positivo. */
    pinned: boolean
  }

  // Marks do utilizador são números de página 1-based; as quebras caem em
  // fronteiras de parágrafo (um parágrafo pertence ao capítulo da página em
  // que começa).
  const markPages = [...new Set((explicitMarks ?? [])
    .filter((mark) => typeof mark === 'number' && Number.isFinite(mark))
    .map((mark) => Math.floor(mark)))]
    .filter((mark) => mark >= 1)
    .sort((a, b) => a - b)
    .map((mark) => mark - 1)

  // TOC nativo (bookmarks do PDF): título por página. Entradas repetidas na
  // mesma página resolvem para a última (os filhos vêm depois dos pais).
  //
  // Escolha do nível de capítulo: um TOC pode conter secções e subsecções
  // (ex.: "1. Some Fundamentals" > "Programming" > "The int Type") — usar
  // todas promovia subsecções a falsos capítulos. Também pode estar
  // organizado por PARTES com os capítulos um nível abaixo. Regra em dois
  // passos:
  //  1. nível-base = nível mais raso com >= 2 entradas;
  //  2. desce um nível enquanto os "capítulos" desse nível abrangem muitas
  //     páginas (gap mediano > 60 entre entradas distantes) — são PARTES,
  //     não capítulos — e o nível seguinte também tem >= 2 entradas.
  // No fim ficam de fora apenas os níveis MAIS PROFUNDOS que o escolhido
  // (secções dentro do capítulo); os níveis mais rasos (partes) mantêm-se
  // como quebras válidas.
  const validOutline = (outline ?? [])
    .filter((entry): entry is PdfOutlineEntry => !!entry && entry.pageIndex >= 0 && !!entry.title)
    // entrada vinda de fora da app pode não ter profundidade: nível de topo
    .map((entry) => ({ ...entry, depth: entry.depth ?? 0 }))
  const entriesByDepth = new Map<number, PdfOutlineEntry[]>()
  for (const entry of validOutline) {
    const list = entriesByDepth.get(entry.depth)
    if (list) {
      list.push(entry)
    } else {
      entriesByDepth.set(entry.depth, [entry])
    }
  }
  const depths = [...entriesByDepth.keys()].sort((a, b) => a - b)
  let chapterEntries = validOutline
  if (depths.length > 0) {
    const levelsWithSeveral = depths.filter((depth) => entriesByDepth.get(depth)!.length >= 2)
    const baseDepth = levelsWithSeveral.length > 0 ? levelsWithSeveral[0] : depths[0]

    /** gap mediano (em páginas) entre entradas consecutivas; só gaps >= 5
     * contam, para ignorar o bloco de prefácios página a página. */
    const medianSpread = (entries: PdfOutlineEntry[]): number => {
      const starts = [...new Set(entries.map((entry) => entry.pageIndex))].sort((a, b) => a - b)
      const gaps: number[] = []
      for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1]
        if (gap >= 5) {
          gaps.push(gap)
        }
      }
      if (gaps.length === 0) {
        return 0
      }
      gaps.sort((a, b) => a - b)
      return gaps[Math.floor(gaps.length / 2)]
    }

    const MAX_CHAPTER_SPREAD = 60
    let chosenIndex = depths.indexOf(baseDepth)
    while (
      chosenIndex < depths.length - 1 &&
      medianSpread(entriesByDepth.get(depths[chosenIndex])!) > MAX_CHAPTER_SPREAD &&
      entriesByDepth.get(depths[chosenIndex + 1])!.length >= 2
    ) {
      chosenIndex++
    }
    const chapterDepth = depths[chosenIndex]
    // Os pais do nível escolhido são normalmente partes/categorias do índice,
    // não capítulos. Promovê-los todos cria divisões que não correspondem a
    // títulos impressos no corpo.
    chapterEntries = validOutline.filter((entry) => entry.depth === chapterDepth)
  }

  // Um bookmark só pode dividir o texto se o respetivo título estiver
  // realmente impresso no início do conteúdo da página de destino. PDFs
  // frequentemente trazem bookmarks desatualizados ou apontados a páginas
  // erradas; nesse caso, o texto do corpo é a fonte de verdade.
  chapterEntries = chapterEntries.filter((entry) => {
    const titleKey = normalizeChapterEvidence(entry.title)
    if (titleKey.length < 4) {
      return false
    }
    const pageParagraphs = paragraphs
      .filter((paragraph) => paragraph.startPage === entry.pageIndex)
      .slice(0, 3)
    for (let count = 1; count <= pageParagraphs.length; count++) {
      const bodyKey = normalizeChapterEvidence(pageParagraphs.slice(0, count).map((paragraph) => paragraph.text).join(' '))
      if (bodyKey === titleKey || (titleKey.length >= 10 && bodyKey.startsWith(titleKey))) {
        return true
      }
    }
    return false
  })
  const hasNativeOutline = chapterEntries.length > 0

  const titleByPage = new Map<number, { title: string; source: 'outline' | 'mark' }>()
  for (const entry of chapterEntries) {
    titleByPage.set(entry.pageIndex, { title: entry.title, source: 'outline' })
  }
  for (const pageIndex of markPages) {
    // A marca do utilizador prevalece sobre o outline.
    titleByPage.set(pageIndex, { title: '', source: 'mark' })
  }

  // Com outline nativo válido, a heurística de texto fica desligada: o
  // sumário do documento é a autoridade para as quebras de capítulo.
  // (hasNativeOutline calculado acima a partir do nível escolhido.)

  const groupsByPage = new Map<number, SanitizedParagraph[]>()
  for (const paragraph of paragraphs) {
    const blocks = groupsByPage.get(paragraph.startPage)
    if (blocks) {
      blocks.push(paragraph)
    } else {
      groupsByPage.set(paragraph.startPage, [paragraph])
    }
  }
  const metadataByPage = new Map(pageMetadata.map((page) => [page.pageIndex, page]))

  const chapters: WorkingChapter[] = []
  const lead: string[] = []
  let pendingPageBreaks: string[] = []
  let current: WorkingChapter | null = null
  let sawChapterMarker = false

  const encodeParagraph = (para: SanitizedParagraph): string =>
    para.kind === 'subheading'
      ? `@sub${para.level === 3 ? '3' : ''}:${para.text}`
      : para.text

  const closeCurrent = (): void => {
    if (current) {
      chapters.push(current)
      current = null
    } else if (lead.some((part) => !/^@pagebreak:[^\s]+$/.test(part))) {
      chapters.push({ title: 'Introdução', parts: [...lead], startPage: 0, pinned: titleByPage.has(0) })
      lead.length = 0
    } else if (lead.length) {
      // Marcadores anteriores ao primeiro título pertencem à abertura do
      // primeiro capítulo; não devem criar um capítulo "Introdução" vazio.
      pendingPageBreaks = [...lead, ...pendingPageBreaks]
      lead.length = 0
    }
  }

  const STRONG_CHAPTER_RE = /^(cap[íi]tulo|parte)\b/i
  const ROMAN_NUMERAL_RE = /^[IVXLCDM]{1,7}$/

  /**
   * Um título tipográfico (negrito/maior) no topo da página abre capítulo.
   * Sem esse sinal ou um outline validado, só se aceitam marcadores textuais
   * explícitos, nunca nomes correntes ou linhas normais em maiúsculas.
   */
  const startsHeuristicChapter = (para: SanitizedParagraph): boolean => {
    const styledPageTitle =
      para.kind === 'subheading' &&
      para.atPageTop === true &&
      para.text.length <= CHAPTER_TITLE_MAX_LENGTH &&
      !/[.!?…]$/.test(para.text)
    if (styledPageTitle) {
      return true
    }
    if (hasNativeOutline || !isChapterMarker(para.text)) {
      return false
    }
    // Sem bookmark validado, só divisões explícitas e inequívocas. A regra
    // antiga que promovia qualquer bloco em MAIÚSCULAS no topo transformava
    // cabeçalhos de página, nomes e títulos correntes em capítulos.
    if (STRONG_CHAPTER_RE.test(para.text) || ROMAN_NUMERAL_RE.test(para.text.trim())) {
      return para.atPageTop === true || para.afterBigGap === true
    }
    return false
  }

  for (const pageIndex of [...groupsByPage.keys(), ...(illustrations?.keys() ?? []), ...metadataByPage.keys()]
    .filter((value, index, self) => self.indexOf(value) === index)
    .sort((a, b) => a - b)) {
    const pageParas = groupsByPage.get(pageIndex) ?? []
    const pageMeta = metadataByPage.get(pageIndex)
    const pageIllustrations = illustrations?.get(pageIndex) ?? []
    const hasPageContent = pageParas.length > 0 || pageIllustrations.length > 0
    const chapterHint = hasPageContent ? titleByPage.get(pageIndex) : undefined

    const pageBreaks = [...pendingPageBreaks]
    pendingPageBreaks = []
    if (pageMeta?.physicalPageNumber) {
      pageBreaks.push(`@pagebreak:${pageMeta.physicalPageNumber}`)
    }

    // Páginas sem texto/ilustrações não abrem capítulos. Os marcadores ficam
    // no capítulo atual ou aguardam pelo primeiro conteúdo do livro.
    if (!hasPageContent) {
      if (current) {
        current.parts.push(...pageBreaks)
      } else {
        pendingPageBreaks.push(...pageBreaks)
      }
      continue
    }

    if (chapterHint) {
      sawChapterMarker = true
      closeCurrent()

      let title = `Capítulo ${pageIndex + 1}`
      let body = pageParas.map(encodeParagraph)

      if (chapterHint.source === 'outline') {
        title = chapterHint.title
      } else {
        // Marca do utilizador: escolhe um bloco com aspeto de título
        // (marcador de capítulo curto, maioritariamente letras, sem
        // dígitos) entre os primeiros; salta números de página, cabeçalhos
        // correntes como "172 EMILY HAUSER" e placeholders internos.
        for (let i = 0; i < Math.min(3, body.length); i++) {
          if (body[i].startsWith('@') || PAGE_NUMBER_RE.test(body[i])) {
            continue
          }
          if (isChapterMarker(body[i])) {
            title = body[i]
            break
          }
        }
      }

      body = [...pendingPageBreaks, ...pageBreaks, ...body]
      pendingPageBreaks = []
      current = { title, parts: body, startPage: pageIndex, pinned: true }
    } else {
      if (pageBreaks.length > 0) {
        if (current) {
          current.parts.push(...pageBreaks)
        } else {
          lead.push(...pageBreaks)
        }
      }

      for (let blockIndex = 0; blockIndex < pageParas.length; blockIndex++) {
        const para = pageParas[blockIndex]
        if (startsHeuristicChapter(para)) {
          sawChapterMarker = true
          closeCurrent()

          const styledPageTitle = para.kind === 'subheading' && para.atPageTop === true
          let title = para.text
          const titleBlocks = [...pendingPageBreaks, encodeParagraph(para)]
          pendingPageBreaks = []
          // Títulos em 2 linhas ("CAPÍTULO 3" / "A FUGA"): absorve o bloco
          // seguinte se também for um marcador de capítulo.
          const next = pageParas[blockIndex + 1]
          if (next && isChapterMarker(next.text)) {
            const joined = `${title} — ${next.text}`
            if (joined.length <= CHAPTER_TITLE_MAX_LENGTH) {
              title = joined
              titleBlocks.push(encodeParagraph(next))
              blockIndex++
            }
          }
          // O título permanece no corpo exatamente como aparece no PDF;
          // `title` serve apenas como rótulo de navegação no sumário.
          current = { title, parts: titleBlocks, startPage: pageIndex, pinned: styledPageTitle }
        } else {
          if (current) {
            current.parts.push(encodeParagraph(para))
          } else {
            lead.push(encodeParagraph(para))
          }
        }
      }
    }

    if (pageIllustrations.length > 0) {
      for (const id of pageIllustrations) {
        const placeholder = `@image:${id}`
        if (current) {
          current.parts.push(placeholder)
        } else {
          lead.push(placeholder)
        }
      }
    }
  }

  closeCurrent()

  const result = chapters
    .map((chapter) => ({
      title: chapter.title,
      content: chapter.parts.filter(Boolean).join('\n\n').trim(),
      startPage: chapter.startPage,
      pinned: chapter.pinned
    }))
    .filter((chapter) => chapter.content.length > 0)

  // Elimina falsos positivos de OCR (fragmentos curtos em maiúsculas, como
  // "VN") fundindo-os no capítulo anterior. Capítulos do TOC nativo ou
  // marcados pelo utilizador são sempre mantidos.
  const MIN_CHAPTER_WORDS = 30
  const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length
  for (let i = result.length - 1; i > 0; i--) {
    if (!result[i].pinned && wordCount(result[i].content) < MIN_CHAPTER_WORDS) {
      result[i - 1].content = `${result[i - 1].content}\n\n${result[i].content}`.trim()
      result.splice(i, 1)
    }
  }

  if (result.length === 0) {
    const content = paragraphs
      .map((paragraph) => paragraph.text)
      .filter(Boolean)
      .join('\n\n')
    return [{ title: 'Corpo do texto', content, startPage: 0 }]
  }

  // Sem nenhum marcador de capítulo no documento, o bloco único não deve
  // aparecer como "Introdução" no índice do e-reader.
  if (!sawChapterMarker && result.length === 1 && result[0].title === 'Introdução') {
    result[0].title = 'Corpo do texto'
  }

  return result.map(({ title, content, startPage }) => ({ title, content, startPage }))
}

function normalizeChapterEvidence(text: string): string {
  return text
    .replace(/^@sub\d?:/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}
