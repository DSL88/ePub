import type { PdfOutlineEntry, PdfPageContent, TextLine } from './pdfInspector'

export interface SanitizedParagraph {
  /** paragraph text */
  text: string
  /** 0-based index of the PDF page where the paragraph begins */
  startPage: number
  /** o parágrafo é o primeiro bloco de conteúdo da sua página (quebra de página explícita) */
  atPageTop?: boolean
  /** o parágrafo é precedido de um espaçamento vertical significativo */
  afterBigGap?: boolean
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

function removeRepeatedHeaderLines(lines: TextLine[], headers: Set<string>): TextLine[] {
  const first = lines.findIndex((line) => line.text.trim())
  if (first === -1) {
    return lines
  }
  if (headers.has(headerKey(lines[first].text))) {
    const out = [...lines]
    out.splice(first, 1)
    return out
  }
  return lines
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
}

function buildPageParagraphs(lines: TextLine[], pageHeight: number): PageParagraph[] {
  const firstContentIndex = lines.findIndex((line) => line.text.trim())

  const paragraphs: PageParagraph[] = []
  let parts: string[] = []
  let start = -1
  let afterBigGap = false

  const flush = (): void => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (text) {
      paragraphs.push({
        text,
        atPageTop: start === firstContentIndex,
        afterBigGap,
        firstLineIndex: start
      })
    }
    parts = []
    start = -1
    afterBigGap = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const raw = line.text
    if (!raw.trim()) {
      flush()
      continue
    }

    if (parts.length === 0) {
      start = i
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
    const withoutHeaders = removeRepeatedHeaderLines(lines, repeatedHeaders)
    const dehyphenated = dehyphenateLines(withoutHeaders)
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
        // com minúscula. Nunca absorve títulos (marcadores de capítulo).
        const continuesMidSentence =
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
    afterBigGap: para.afterBigGap
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
  const titleByPage = new Map<number, { title: string; source: 'outline' | 'mark' }>()
  for (const entry of outline ?? []) {
    if (entry && entry.pageIndex >= 0 && entry.title) {
      titleByPage.set(entry.pageIndex, { title: entry.title, source: 'outline' })
    }
  }
  for (const pageIndex of markPages) {
    // A marca do utilizador prevalece sobre o outline.
    titleByPage.set(pageIndex, { title: '', source: 'mark' })
  }

  // Com outline nativo válido, a heurística de texto fica desligada: o
  // sumário do documento é a autoridade para as quebras de capítulo.
  const hasNativeOutline = (outline ?? []).some((entry) => entry && entry.pageIndex >= 0 && entry.title)

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

  const closeCurrent = (): void => {
    if (current) {
      chapters.push(current)
      current = null
    } else if (lead.length) {
      chapters.push({ title: 'Introdução', parts: [...lead], startPage: 0, pinned: titleByPage.has(0) })
      lead.length = 0
    }
  }

  const startsHeuristicChapter = (para: SanitizedParagraph): boolean =>
    !hasNativeOutline &&
    isChapterMarker(para.text) &&
    (para.atPageTop === true || para.afterBigGap === true)

  for (const pageIndex of [...groupsByPage.keys(), ...(illustrations?.keys() ?? [])]
    .filter((value, index, self) => self.indexOf(value) === index)
    .sort((a, b) => a - b)) {
    const pageParas = groupsByPage.get(pageIndex) ?? []
    const chapterHint = titleByPage.get(pageIndex)

    if (chapterHint) {
      sawChapterMarker = true
      closeCurrent()

      let title = `Capítulo ${pageIndex + 1}`
      let body = pageParas.map((para) => para.text)

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
        // dígitos) entre os primeiros; salta números de página e cabeçalhos
        // correntes como "172 EMILY HAUSER".
        let titleIndex = -1
        for (let i = 0; i < Math.min(3, body.length); i++) {
          if (PAGE_NUMBER_RE.test(body[i])) {
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
          if (next && isChapterMarker(next.text)) {
            const joined = `${title} — ${next.text}`
            if (joined.length <= CHAPTER_TITLE_MAX_LENGTH) {
              title = joined
              blockIndex++
            }
          }
          current = { title, parts: [], startPage: pageIndex, pinned: false }
        } else {
          if (current) {
            current.parts.push(para.text)
          } else {
            lead.push(para.text)
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
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}
