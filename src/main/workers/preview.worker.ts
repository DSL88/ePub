import { parentPort } from 'node:worker_threads'
import { inspectPdf, type PdfPageContent, type TextLine } from '../services/pdfInspector'
import { sanitizePages } from '../services/textSanitizer'
import type { ExtractionPreview, ExtractionPreviewLine } from '../../renderer/src/types'

const MAX_PREVIEW_PAGES = 300
const MAX_LINES_PER_PAGE = 150
const MAX_TOTAL_LINES = 12_000
const MAX_LINE_LENGTH = 500
const MAX_TOTAL_LINE_CHARACTERS = 1_000_000
const MAX_PARAGRAPHS = 5_000
const MAX_PARAGRAPH_LENGTH = 2_000
const MAX_TOTAL_PARAGRAPH_CHARACTERS = 1_000_000

interface PreviewRequest {
  type: 'preview'
  filePath: string
}

type PreviewResponse =
  | { type: 'done'; preview: ExtractionPreview }
  | { type: 'error'; message: string }

function post(message: PreviewResponse): void {
  parentPort?.postMessage(message)
}

function boundedText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (maxLength <= 0 && text.length > 0) {
    return { text: '', truncated: true }
  }
  if (text.length <= maxLength) {
    return { text, truncated: false }
  }
  return { text: `${text.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true }
}

function boundedNumber(value: number | undefined, fallback = 0, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(-max, Math.min(max, value))
}

function previewLine(line: TextLine, remainingCharacters: number): {
  line: ExtractionPreviewLine
  characters: number
  truncated: boolean
} {
  const maxLength = Math.max(0, Math.min(MAX_LINE_LENGTH, remainingCharacters))
  const text = boundedText(line.text, maxLength)
  return {
    line: {
      text: text.text,
      x: boundedNumber(line.x),
      y: boundedNumber(line.y),
      width: Math.max(0, boundedNumber(line.width)),
      fontSize: Math.max(0, boundedNumber(line.fontSize, 0, 1_000)),
      bold: line.bold === true
    },
    characters: text.text.length,
    truncated: text.truncated
  }
}

function pageText(page: PdfPageContent): string {
  return (page.lines ?? []).map((line) => line.text).join('\n')
}

function createBoundedPreview(
  mode: ExtractionPreview['mode'],
  pageCount: number,
  pages: PdfPageContent[],
  paragraphs: Array<{ text: string; startPage: number }>
): ExtractionPreview {
  let truncated = pages.length > MAX_PREVIEW_PAGES
  let totalLines = 0
  let totalLineCharacters = 0

  const previewPages = pages.slice(0, MAX_PREVIEW_PAGES).map((page) => {
    const sourceLines = page.lines ?? []
    const previewLines: ExtractionPreviewLine[] = []
    if (sourceLines.length > MAX_LINES_PER_PAGE) {
      truncated = true
    }

    for (const line of sourceLines) {
      if (previewLines.length >= MAX_LINES_PER_PAGE || totalLines >= MAX_TOTAL_LINES) {
        truncated = true
        break
      }
      const bounded = previewLine(line, MAX_TOTAL_LINE_CHARACTERS - totalLineCharacters)
      if (!bounded.line.text && line.text) {
        truncated = true
        break
      }
      previewLines.push(bounded.line)
      totalLines++
      totalLineCharacters += bounded.characters
      truncated ||= bounded.truncated
    }

    return {
      index: Math.max(0, Math.floor(boundedNumber(page.index, 0, MAX_PREVIEW_PAGES * 10))),
      width: Math.max(0, boundedNumber(page.width, 0, 100_000)),
      height: Math.max(0, boundedNumber(page.height, 0, 100_000)),
      lines: previewLines
    }
  })

  const visiblePageCount = previewPages.length
  const visibleParagraphs = paragraphs.filter(
    (paragraph) => paragraph.startPage >= 0 && paragraph.startPage < visiblePageCount
  )
  const previewParagraphs: ExtractionPreview['paragraphs'] = []
  let totalParagraphCharacters = 0

  for (const paragraph of visibleParagraphs) {
    if (previewParagraphs.length >= MAX_PARAGRAPHS) {
      truncated = true
      break
    }
    const maxLength = Math.max(
      0,
      Math.min(MAX_PARAGRAPH_LENGTH, MAX_TOTAL_PARAGRAPH_CHARACTERS - totalParagraphCharacters)
    )
    const text = boundedText(paragraph.text, maxLength)
    if (!text.text && paragraph.text) {
      truncated = true
      break
    }
    previewParagraphs.push({
      text: text.text,
      startPage: Math.floor(boundedNumber(paragraph.startPage, 0, MAX_PREVIEW_PAGES * 10))
    })
    totalParagraphCharacters += text.text.length
    truncated ||= text.truncated
  }

  if (visibleParagraphs.length > previewParagraphs.length) {
    truncated = true
  }

  return {
    mode,
    pageCount: Math.max(0, Math.floor(boundedNumber(pageCount, 0, 10_000_000))),
    pages: previewPages,
    paragraphs: previewParagraphs,
    truncated
  }
}

async function preview(filePath: string): Promise<ExtractionPreview> {
  const inspection = await inspectPdf(filePath)
  const pagesWithText = inspection.pages.map((page) => ({
    ...page,
    text: page.illustration ? '' : pageText(page)
  }))
  const sanitized = sanitizePages(pagesWithText)

  return createBoundedPreview(
    inspection.mode,
    inspection.pageCount,
    inspection.pages,
    sanitized.paragraphs
  )
}

parentPort?.on('message', async (message: unknown) => {
  const request = message as PreviewRequest | null
  if (!request || request.type !== 'preview' || typeof request.filePath !== 'string') {
    return
  }

  try {
    post({ type: 'done', preview: await preview(request.filePath) })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    parentPort?.close()
  }
})
