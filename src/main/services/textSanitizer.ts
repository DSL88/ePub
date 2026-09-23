import type { PdfOutlineEntry, PdfPageContent, TextLine } from './pdfInspector'

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
  /** subtítulo/intertítulo no meio do texto (renderizado como h2/h3) */
  kind?: ParagraphKind
}

export interface SanitizedText {
  paragraphs: SanitizedParagraph[]
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
/** espaçamento vertical mínimo acima/abaixo, relativo ao entrelinhamento */
const SUBHEADING_GAP_FACTOR = 1.4
/** proporção mínima de caracteres em fonte negrito para a linha ser bold */
const SUBHEADING_BOLD_RATIO = 0.6

interface PageLineMetrics {
  /** tamanho de fonte dominante do corpo da página (0 = indeterminado) */
  bodyFontSize: number
  /** entrelinhamento típico da página (0 = indeterminado) */
  lineSpacing: number
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
 * Entrelinhamento típico da página: percentil 25 dos espaços verticais
 * entre linhas consecutivas com corpo semelhante. O percentil baixo isola o
 * espaçamento intra-parágrafo (o mais recorrente), ignorando as quebras
 * maiores entre blocos, que contaminariam uma mediana.
 */
function typicalLineSpacing(lines: TextLine[]): number {
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y
    if (gap <= 0 || gap >= Math.max(lines[i - 1].fontSize, lines[i].fontSize) * 3) {
      continue
    }
    gaps.push(gap)
  }
  if (gaps.length === 0) {
    return 0
  }
  gaps.sort((a, b) => a - b)
  return gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.25))]
}

/**
 * Uma linha funciona como subtítulo quando cumpre TODOS os critérios:
 * tipografia de destaque (tamanho >= 1.15× o corpo OU fonte Bold/Black) +
 * linha curta, maioritariamente letras e sem pontuação terminal de frase +
 * espaçamento vertical acima/abaixo superior ao entrelinhamento regular.
 * Linhas OCR (sem métricas) nunca são subtítulos.
 */
function isSubheadingLine(
  line: TextLine,
  prev: TextLine | null,
  next: TextLine | null,
  metrics: PageLineMetrics
): boolean {
  if (metrics.bodyFontSize <= 0 || !(line.fontSize > 0)) {
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
  const letters = text.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, '').length
  const nonSpaces = text.replace(/\s/g, '').length
  if (nonSpaces === 0 || letters / nonSpaces < SUBHEADING_BOLD_RATIO) {
    return false
  }
  const typographic =
    line.fontSize >= metrics.bodyFontSize * SUBHEADING_SIZE_FACTOR || line.bold === true
  if (!typographic) {
    return false
  }
  const typical = metrics.lineSpacing > 0 ? metrics.lineSpacing : metrics.bodyFontSize * 1.6
  const gapAbove = prev ? prev.y - line.y : null
  const gapBelow = next ? line.y - next.y : null
  if (gapAbove == null && gapBelow == null) {
    return true
  }
  return (
    (gapAbove != null && gapAbove > typical * SUBHEADING_GAP_FACTOR) ||
    (gapBelow != null && gapBelow > typical * SUBHEADING_GAP_FACTOR)
  )
}

function computeLineMetrics(lines: TextLine[]): PageLineMetrics {
  return {
    bodyFontSize: dominantBodyFontSize(lines),
    lineSpacing: typicalLineSpacing(lines)
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
 * Junção de hifenização dentro da página: uma linha que termina em "-" é
 * unida à linha seguinte (removendo o hífen quando a próxima começa em
 * minúscula). As coordenadas da primeira linha prevalecem, para que o
 * espaçamento antes do bloco continue a ser medido corretamente.
 */
function dehyphenateLines(lines: TextLine[]): TextLine[] {
  const out: TextLine[] = []
  for (const line of lines) {
    const text = line.text.replace(/\u00AD/g, '')
    const prev = out.length ? out[out.length - 1] : null
    if (prev) {
      const prevTrim = prev.text.trimEnd()
      const next = text.trim()
      if (prevTrim.endsWith('-') && next) {
        if (/^[a-z\u00E0-\u00FF]/.test(next)) {
          prev.text = prevTrim.slice(0, -1) + next
        } else {
          prev.text = prevTrim + next
        }
        continue
      }
    }
    out.push({ ...line, text })
  }
  return out
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
  const structured = (page.lines ?? []).filter((line) => line.text.trim())
  if (structured.length > 0) {
    return structured
  }
  if (typeof page.text === 'string' && page.text.trim()) {
    return synthesizeLines(page.text)
  }
  return []
}

// Espaço vertical (em pt) a partir do qual se considera "espaçamento
// significativo" antes de um título de capítulo: nunca menos que 14pt
// (linha em branco larga) nem menos que ~2.2× o corpo da linha anterior.
const LINE_GAP_FACTOR = 2.2
const MIN_LINE_GAP = 14

interface PageParagraph {
  text: string
  /** primeiro bloco de conteúdo da página */
  atPageTop: boolean
  /** precedido de grande espaçamento vertical */
  afterBigGap: boolean
  /** índice da primeira linha do bloco */
  firstLineIndex: number
  /** subtítulo tipográfico vs parágrafo normal */
  kind: ParagraphKind
}

function buildPageParagraphs(lines: TextLine[], pageHeight: number): PageParagraph[] {
  const firstContentIndex = lines.findIndex((line) => line.text.trim())
  const metrics = computeLineMetrics(lines)
  const subheadingAt = lines.map((line, i) =>
    isSubheadingLine(
      line,
      i > 0 ? lines[i - 1] : null,
      i + 1 < lines.length ? lines[i + 1] : null,
      metrics
    )
  )

  const paragraphs: PageParagraph[] = []
  let parts: string[] = []
  let start = -1
  let afterBigGap = false
  let blockKind: ParagraphKind = 'text'

  const flush = (): void => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (text) {
      paragraphs.push({
        text,
        atPageTop: start === firstContentIndex,
        afterBigGap,
        firstLineIndex: start,
        kind: blockKind
      })
    }
    parts = []
    start = -1
    afterBigGap = false
    blockKind = 'text'
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const raw = line.text
    if (!raw.trim()) {
      flush()
      continue
    }

    const lineKind: ParagraphKind = subheadingAt[i] ? 'subheading' : 'text'
    // um subtítulo nunca partilha bloco com o parágrafo: quebra antes e
    // depois, sem forçar quebra de capítulo
    if (parts.length > 0 && blockKind !== lineKind) {
      flush()
    }

    if (parts.length === 0) {
      start = i
      blockKind = lineKind
    } else if (i > 0) {
      const prev = lines[i - 1]
      const prevText = prev.text.trimEnd()
      const nextText = raw.trim()
      const prevEndsSentence = /[.:!?…]["»']?$/.test(prevText)
      const nextStartsUpper = /^[A-ZÀ-ÖØ-Þ\u0100-\u017F]/.test(nextText)
      const prevIsShortHeading = prevText.length < 30 && !/[.:!?…]$/.test(prevText)
      const bigGap =
        prev.fontSize > 0 &&
        line.fontSize > 0 &&
        prev.y - line.y > Math.max(LINE_GAP_FACTOR * prev.fontSize, MIN_LINE_GAP)

      if (bigGap) {
        flush()
        afterBigGap = true
      } else if (prevEndsSentence && nextStartsUpper) {
        flush()
      } else if (prevIsShortHeading) {
        flush()
      }
    }

    parts.push(raw.trim())
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
  const pageLineSets = pages.map((page) => stripPageNumberLines(pageSourceLines(page)))

  const headerCounts = new Map<string, number>()
  for (const lines of pageLineSets) {
    const first = lines.find((line) => line.text.trim())
    if (!first) {
      continue
    }
    const key = headerKey(first.text)
    headerCounts.set(key, (headerCounts.get(key) ?? 0) + 1)
  }

  const repeatedHeaders = new Set(
    [...headerCounts.entries()]
      .filter(([, count]) => count >= 2 && count / Math.max(1, pages.length) >= 0.5)
      .map(([key]) => key)
  )

  // Separação em parágrafos com posição: cada página produz blocos com a
  // informação de posição vertical (topo da página / grande espaçamento).
  const paragraphsPerPage = pageLineSets.map((lines, pageIndex) => {
    const withoutFurniture = stripPageFurniture(lines, repeatedHeaders)
    const dehyphenated = dehyphenateLines(withoutFurniture)
    return buildPageParagraphs(dehyphenated, pages[pageIndex]?.height ?? 0)
  })

  // Junção de fragmentos de parágrafo entre páginas: um parágrafo que não
  // termina com pontuação de frase continua na página seguinte.
  const paragraphs: SanitizedParagraph[] = []
  let open: SanitizedParagraph | null = null

  paragraphsPerPage.forEach((pageParas, pageIndex) => {
    for (const para of pageParas) {
      if (!para.text) {
        continue
      }
      if (!open) {
        open = toSanitized(para, pageIndex)
      } else {
        // Só junta uma continuação genuína a meio de frase: o parágrafo
        // anterior não tem pontuação terminal E o fragmento seguinte começa
        // com minúscula. Nunca absorve títulos (marcadores de capítulo) nem
        // subtítulos tipográficos.
        const continuesMidSentence =
          open.kind !== 'subheading' &&
          para.kind !== 'subheading' &&
          !SENTENCE_END_RE.test(open.text) &&
          !isChapterMarker(open.text) &&
          /^[a-z\u00E0-\u00FF«(\d]/.test(para.text)
        if (continuesMidSentence) {
          open = { ...open, text: joinParagraphFragments(open.text, para.text) }
        } else {
          paragraphs.push(open)
          open = toSanitized(para, pageIndex)
        }
      }
    }
  })
  if (open) {
    paragraphs.push(open)
  }

  return { paragraphs }
}

function toSanitized(para: PageParagraph, pageIndex: number): SanitizedParagraph {
  return {
    text: para.text,
    startPage: pageIndex,
    atPageTop: para.atPageTop,
    afterBigGap: para.afterBigGap,
    kind: para.kind
  }
}

const SENTENCE_END_RE = /[.!?…»"'”’)\]]$/

function joinParagraphFragments(prev: string, next: string): string {
  if (prev.endsWith('-')) {
    // hífen físico na quebra de página: junta diretamente (dehyphenation
    // entre páginas)
    return prev.slice(0, -1) + next
  }
  return `${prev} ${next}`
}

const CHAPTER_TITLE_MAX_LENGTH = 70

export function isChapterMarker(block: string): boolean {
  const text = block.replace(/\s+/g, ' ').trim()
  if (!text || text.length > CHAPTER_TITLE_MAX_LENGTH) {
    return false
  }
  // placeholders internos (@image:, @sub:) nunca são títulos de capítulo
  if (text.startsWith('@')) {
    return false
  }

  // Títulos não terminam com pontuação terminal (frases e itens de lista
  // terminam; títulos não).
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

  const letters = text.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, '')
  const nonSpaces = text.replace(/\s/g, '')
  const isAllCaps = text === text.toUpperCase() && letters.length >= 4
  const isMostlyLetters = letters.length / Math.max(1, nonSpaces.length) >= 0.7
  if (
    text.length >= 4 &&
    isAllCaps &&
    isMostlyLetters &&
    !/\d/.test(text) &&
    !/[!?…]$/.test(text)
  ) {
    return true
  }

  return false
}

export function detectChapters(
  paragraphs: SanitizedParagraph[],
  illustrations?: Map<number, string[]>,
  explicitMarks?: number[],
  outline?: PdfOutlineEntry[]
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
    chapterEntries = validOutline.filter((entry) => entry.depth <= chapterDepth)
  }
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

  const chapters: WorkingChapter[] = []
  const lead: string[] = []
  let current: WorkingChapter | null = null
  let sawChapterMarker = false

  const encodeParagraph = (para: SanitizedParagraph): string =>
    para.kind === 'subheading' ? `@sub:${para.text}` : para.text

  const closeCurrent = (): void => {
    if (current) {
      chapters.push(current)
      current = null
    } else if (lead.length) {
      chapters.push({ title: 'Introdução', parts: [...lead], startPage: 0, pinned: titleByPage.has(0) })
      lead.length = 0
    }
  }

  const STRONG_CHAPTER_RE = /^(cap[íi]tulo|parte)\b/i
  const ROMAN_NUMERAL_RE = /^[IVXLCDM]{1,7}$/

  /**
   * Heurística textual (só sem outline nativo). Critérios cumulativos:
   * marcador de capítulo + posição/quebra. Marcadores fortes ("Capítulo 3",
   * "Parte II", numerais romanos isolados) valem no topo da página ou após
   * grande espaçamento; títulos genéricos em maiúsculas exigem posição no
   * topo da página e não podem ser subtítulos tipográficos (esses ficam
   * como h2 no meio da secção, sem quebrar capítulo).
   */
  const startsHeuristicChapter = (para: SanitizedParagraph): boolean => {
    if (hasNativeOutline || !isChapterMarker(para.text)) {
      return false
    }
    if (STRONG_CHAPTER_RE.test(para.text) || ROMAN_NUMERAL_RE.test(para.text.trim())) {
      return para.atPageTop === true || para.afterBigGap === true
    }
    return para.atPageTop === true && para.kind !== 'subheading'
  }

  for (const pageIndex of [...groupsByPage.keys(), ...(illustrations?.keys() ?? [])]
    .filter((value, index, self) => self.indexOf(value) === index)
    .sort((a, b) => a - b)) {
    const pageParas = groupsByPage.get(pageIndex) ?? []
    const chapterHint = titleByPage.get(pageIndex)

    if (chapterHint) {
      sawChapterMarker = true
      closeCurrent()

      let title = `Capítulo ${pageIndex + 1}`
      let body = pageParas.map(encodeParagraph)

      if (chapterHint.source === 'outline') {
        title = chapterHint.title
        // Remove o bloco que duplica o título do bookmark (ex.: o texto
        // "Capítulo 3" impresso no topo da página).
        if (body.length > 0 && normalizeTitle(body[0]) === normalizeTitle(title)) {
          body = body.slice(1)
        }
      } else {
        // Marca do utilizador: escolhe um bloco com aspeto de título
        // (marcador de capítulo curto, maioritariamente letras, sem
        // dígitos) entre os primeiros; salta números de página, cabeçalhos
        // correntes como "172 EMILY HAUSER" e placeholders internos.
        let titleIndex = -1
        for (let i = 0; i < Math.min(3, body.length); i++) {
          if (body[i].startsWith('@') || PAGE_NUMBER_RE.test(body[i])) {
            continue
          }
          if (isChapterMarker(body[i])) {
            title = body[i]
            titleIndex = i
            break
          }
        }
        if (titleIndex >= 0) {
          body = body.filter((_, i) => i !== titleIndex)
        }
      }

      current = { title, parts: body, startPage: pageIndex, pinned: true }
    } else {
      for (let blockIndex = 0; blockIndex < pageParas.length; blockIndex++) {
        const para = pageParas[blockIndex]
        if (startsHeuristicChapter(para)) {
          sawChapterMarker = true
          closeCurrent()

          let title = para.text
          // Títulos em 2 linhas ("CAPÍTULO 3" / "A FUGA"): absorve o bloco
          // seguinte se também for um marcador.
          const next = pageParas[blockIndex + 1]
          if (next && next.kind !== 'subheading' && isChapterMarker(next.text)) {
            const joined = `${title} — ${next.text}`
            if (joined.length <= CHAPTER_TITLE_MAX_LENGTH) {
              title = joined
              blockIndex++
            }
          }
          current = { title, parts: [], startPage: pageIndex, pinned: false }
        } else {
          if (current) {
            current.parts.push(encodeParagraph(para))
          } else {
            lead.push(encodeParagraph(para))
          }
        }
      }
    }

    const ids = illustrations?.get(pageIndex)
    if (ids?.length) {
      for (const id of ids) {
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

function normalizeTitle(text: string): string {
  return text.replace(/^@sub:/, '').replace(/\s+/g, ' ').trim().toLowerCase()
}
