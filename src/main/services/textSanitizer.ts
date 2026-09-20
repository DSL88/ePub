import type { PdfPageContent } from './pdfInspector'

export interface SanitizedParagraph {
  /** paragraph text */
  text: string
  /** 0-based index of the PDF page where the paragraph begins */
  startPage: number
}

export interface SanitizedText {
  paragraphs: SanitizedParagraph[]
}

export interface DetectedChapter {
  title: string
  content: string
  startPage: number
}

export interface SanitizeOptions {
  looseParagraphs?: boolean
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

export function removeNoise(pages: string[]): string[] {
  const withoutPageNumbers = pages.map(stripPageNumbers)

  const headerCounts = new Map<string, number>()
  for (const page of withoutPageNumbers) {
    const firstLine = firstNonEmptyLine(page)
    if (!firstLine) {
      continue
    }
    // Strip varying page numbers so running headers like "172 EMILY HAUSER"
    // and "MÍTICAS 175" are recognised as the same repeated header.
    const key = firstLine.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    headerCounts.set(key, (headerCounts.get(key) ?? 0) + 1)
  }

  const repeatedHeaders = new Set(
    [...headerCounts.entries()]
      .filter(([key, count]) => count >= 2 && count / withoutPageNumbers.length >= 0.5)
      .map(([key]) => key)
  )

  if (repeatedHeaders.size === 0) {
    return withoutPageNumbers
  }

  return withoutPageNumbers.map((page) => removeRepeatedHeader(page, repeatedHeaders))
}

function stripPageNumbers(page: string): string {
  const lines = page.split('\n')
  let start = 0
  let end = lines.length - 1
  while (start <= end && !lines[start].trim()) start++
  while (end >= start && !lines[end].trim()) end--
  if (start > end) {
    return ''
  }

  let sliceEnd = end + 1
  let sliceStart = start
  if (PAGE_NUMBER_RE.test(lines[end].trim())) {
    sliceEnd = end
  }
  if (PAGE_NUMBER_RE.test(lines[start].trim())) {
    sliceStart = start + 1
  }
  return lines.slice(sliceStart, sliceEnd).join('\n')
}

function firstNonEmptyLine(page: string): string | null {
  for (const line of page.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return null
}

function removeRepeatedHeader(page: string, headers: Set<string>): string {
  const lines = page.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) {
      continue
    }
    // Compare both the raw line and its page-number-normalized form.
    const normalized = trimmed.replace(/\b\d{1,4}\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (headers.has(normalized)) {
      lines.splice(i, 1)
    }
    break
  }
  return lines.join('\n')
}

export function rebuildParagraphList(text: string, options?: SanitizeOptions): string[] {
  const lines = text.split('\n')
  const hasIndentation = lines.some((line) => /^\s{2,}\S/.test(line))
  const loose = options?.looseParagraphs ?? !hasIndentation

  const paragraphs: string[] = []
  let current: string[] = []

  const flush = (): void => {
    if (!current.length) {
      return
    }
    const paragraph = current.join(' ').replace(/\s+/g, ' ').trim()
    if (paragraph) {
      paragraphs.push(paragraph)
    }
    current = []
  }

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      flush()
      continue
    }

    if (current.length) {
      const prev = current[current.length - 1].trimEnd()
      const next = rawLine.trim()
      const prevEndsSentence = /[.:!?…]["»']?$/.test(prev)
      const nextStartsUpper = /^[A-ZÀ-ÖØ-Þ\u0100-\u017F]/.test(next)
      const prevIsShortHeading = prev.length < 30 && !/[.:!?…]$/.test(prev)

      if (prevEndsSentence && nextStartsUpper && (loose || /^\s{2,}\S/.test(rawLine))) {
        flush()
      } else if (prevIsShortHeading) {
        flush()
      }
    }
    current.push(rawLine.trim())
  }
  flush()

  return paragraphs
}

const SENTENCE_END_RE = /[.!?…»"'”’)\]]$/

function joinParagraphFragments(prev: string, next: string): string {
  if (prev.endsWith('-')) {
    // hard hyphen at page break: join directly (dehyphenation across pages)
    return prev.slice(0, -1) + next
  }
  return `${prev} ${next}`
}

export function sanitizePages(pages: PdfPageContent[]): SanitizedText {
  const rawPages = pages.map(pageText)
  const cleanedPages = removeNoise(rawPages)
  const dehyphenated = cleanedPages.map(dehyphenate)
  const paragraphsPerPage = dehyphenated.map((text) => rebuildParagraphList(text))

  // Merge paragraph fragments across page boundaries: a paragraph that does
  // not end with sentence punctuation continues on the next page.
  const paragraphs: SanitizedParagraph[] = []
  let open: SanitizedParagraph | null = null

  paragraphsPerPage.forEach((pageParas, pageIndex) => {
    for (const para of pageParas) {
      if (!para) {
        continue
      }
      if (!open) {
        open = { text: para, startPage: pageIndex }
      } else {
        // Only merge a genuine mid-sentence continuation: the previous
        // paragraph lacks terminal punctuation AND the next fragment starts
        // with a lowercase word. Never absorb headings (chapter markers).
        const continuesMidSentence =
          !SENTENCE_END_RE.test(open.text) &&
          !isChapterMarker(open.text) &&
          /^[a-z\u00E0-\u00FF«(\d]/.test(para)
        if (continuesMidSentence) {
          open = { text: joinParagraphFragments(open.text, para), startPage: open.startPage }
        } else {
          paragraphs.push(open)
          open = { text: para, startPage: pageIndex }
        }
      }
    }
  })
  if (open) {
    paragraphs.push(open)
  }

  return { paragraphs }
}

function rebuildParagraphs(text: string, options?: SanitizeOptions): string {
  return rebuildParagraphList(text, options).join('\n\n')
}

const CHAPTER_TITLE_MAX_LENGTH = 60

export function isChapterMarker(block: string): boolean {
  const text = block.replace(/\s+/g, ' ').trim()
  if (!text || text.length > CHAPTER_TITLE_MAX_LENGTH) {
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
    !/[.,;:!?…]$/.test(text)
  ) {
    return true
  }

  return false
}

export function detectChapters(
  paragraphs: SanitizedParagraph[],
  interject?: (pageIndex: number) => string,
  explicitMarks?: number[]
): DetectedChapter[] {
  interface WorkingChapter {
    title: string
    parts: string[]
    startPage: number
  }

  // Group paragraphs by the page they begin on, preserving order.
  const groups: { startPage: number; blocks: string[] }[] = []
  for (const paragraph of paragraphs) {
    const last = groups[groups.length - 1]
    if (last && last.startPage === paragraph.startPage) {
      last.blocks.push(paragraph.text)
    } else {
      groups.push({ startPage: paragraph.startPage, blocks: [paragraph.text] })
    }
  }

  // Marks from the UI are 1-based page numbers; chapter breaks land at
  // paragraph boundaries (a paragraph belongs to the chapter of the page
  // where it begins).
  const markPages = [...new Set((explicitMarks ?? [])
    .filter((mark) => typeof mark === 'number' && Number.isFinite(mark))
    .map((mark) => Math.floor(mark)))]
    .filter((mark) => mark >= 1)
    .sort((a, b) => a - b)
    .map((mark) => mark - 1)
  const markSet = new Set(markPages)

  const chapters: WorkingChapter[] = []
  const lead: string[] = []
  let current: WorkingChapter | null = null

  const closeCurrent = (): void => {
    if (current) {
      chapters.push(current)
      current = null
    } else if (lead.length) {
      chapters.push({ title: 'Introdução', parts: [...lead], startPage: 0 })
      lead.length = 0
    }
  }

  for (const group of groups) {
    const blocks = group.blocks

    if (markSet.has(group.startPage)) {
      closeCurrent()
      const pdfPage = group.startPage + 1
      // Pick a heading-like block (chapter marker: short, mostly letters,
      // no digits) among the first few blocks; skip pure page numbers and
      // running headers like "172 EMILY HAUSER" or "MÍTICAS 175". Fall back
      // to a generic title named after the PDF page.
      let title: string = `Capítulo ${pdfPage}`
      let titleIndex = -1
      for (let i = 0; i < Math.min(3, blocks.length); i++) {
        if (PAGE_NUMBER_RE.test(blocks[i])) {
          continue
        }
        if (isChapterMarker(blocks[i])) {
          title = blocks[i]
          titleIndex = i
          break
        }
      }
      current = {
        title,
        parts: titleIndex >= 0 ? blocks.filter((_, i) => i !== titleIndex) : blocks,
        startPage: group.startPage
      }
    } else {
      for (const block of blocks) {
        if (isChapterMarker(block)) {
          closeCurrent()
          current = { title: block, parts: [], startPage: group.startPage }
        } else {
          if (current) {
            current.parts.push(block)
          } else {
            lead.push(block)
          }
        }
      }
    }

    const extra = interject?.(group.startPage)
    if (extra) {
      if (current) {
        current.parts.push(extra)
      } else {
        lead.push(extra)
      }
    }
  }

  closeCurrent()

  const result = chapters
    .map((chapter) => ({
      title: chapter.title,
      content: chapter.parts.filter(Boolean).join('\n\n').trim(),
      startPage: chapter.startPage
    }))
    .filter((chapter) => chapter.content.length > 0)

  // Drop OCR false-positive chapters (tiny ALL-CAPS fragments like "VN",
  // "PENELOPE / FIM") by merging them into the previous chapter. Chapters the
  // user explicitly marked are always kept.
  const MIN_CHAPTER_WORDS = 30
  const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length
  for (let i = result.length - 1; i > 0; i--) {
    const isMarked = markPages.length > 0 && markSet.has(result[i].startPage)
    if (!isMarked && wordCount(result[i].content) < MIN_CHAPTER_WORDS) {
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

  return result
}
