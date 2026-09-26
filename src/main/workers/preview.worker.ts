import { parentPort } from 'node:worker_threads'
import { inspectPdf, loadPdfDocument, type PdfPageContent, type TextLine } from '../services/pdfInspector'
import { sanitizePages } from '../services/textSanitizer'
import { assessPageQuality, suggestBoundaries } from '../services/pageBoundaries'
import { renderPageToImage, normalizeOcrPsm, runOcr } from '../services/ocrService'
import type { ExtractionPreview, ExtractionPreviewLine, PageOcrResult } from '../../renderer/src/types'

const MAX_PREVIEW_PAGES = 300
const MAX_LINES_PER_PAGE = 150
const MAX_TOTAL_LINES = 12_000
const MAX_LINE_LENGTH = 500
const MAX_TOTAL_LINE_CHARACTERS = 1_000_000
const MAX_PARAGRAPHS = 8_000
const MAX_PARAGRAPH_LENGTH = 2_000
const MAX_TOTAL_PARAGRAPH_CHARACTERS = 1_500_000
/** mesmo DPI da conversão: o texto do OCR da preview coincide com o final */
const PAGE_OCR_DPI = 200

type PreviewRequest =
  | { type: 'preview'; filePath: string }
  | { type: 'page-ocr'; filePath: string; pageIndex: number; psm?: unknown }

type PreviewResponse =
  | { type: 'preview-done'; preview: ExtractionPreview }
  | { type: 'page-ocr-done'; pageOcr: PageOcrResult }
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
  // Orçamento distribuído: com livros grandes o teto global esgotava-se nas
  // primeiras páginas e as últimas ficavam com 0 linhas (sem nada para
  // escolher). Cada página mostra sempre as suas primeiras N linhas.
  const perPageLineCap = Math.max(
    25,
    Math.min(MAX_LINES_PER_PAGE, Math.ceil(MAX_TOTAL_LINES / Math.max(1, pages.length)))
  )

  const previewPages = pages.slice(0, MAX_PREVIEW_PAGES).map((page) => {
    const sourceLines = page.lines ?? []
    const previewLines: ExtractionPreviewLine[] = []
    if (sourceLines.length > perPageLineCap) {
      truncated = true
    }

    for (const line of sourceLines) {
      if (previewLines.length >= perPageLineCap || totalLines >= MAX_TOTAL_LINES) {
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
    truncated,
    qualities: assessPageQuality(pages.slice(0, MAX_PREVIEW_PAGES)).map((quality) => ({
      pageIndex: quality.pageIndex,
      level: quality.level,
      chars: quality.chars,
      reason: quality.reason
    })),
    boundaries: suggestBoundaries(pages.slice(0, MAX_PREVIEW_PAGES))
      .slice(0, MAX_PREVIEW_PAGES)
      .map((boundary) => ({
        fromPage: boundary.fromPage,
        toPage: boundary.toPage,
        suggestion: boundary.suggestion,
        reason: boundary.reason,
        tail: boundary.tail.map((line) => boundedText(line, MAX_LINE_LENGTH).text),
        head: boundary.head.map((line) => boundedText(line, MAX_LINE_LENGTH).text),
        headIsTitle: boundary.headIsTitle === true
      }))
  }
}

async function preview(filePath: string): Promise<ExtractionPreview> {
  const inspection = await inspectPdf(filePath)
  // Mesma regra da conversão: só imageOnly descarta texto; illustration
  // (80-400 car.) mantém texto para não esconder títulos com ornamentos.
  const pagesWithText = inspection.pages.map((page) => ({
    ...page,
    text: page.imageOnly ? '' : pageText(page)
  }))
  const sanitized = sanitizePages(pagesWithText)

  return createBoundedPreview(
    inspection.mode,
    inspection.pageCount,
    inspection.pages,
    sanitized.paragraphs
  )
}

/**
 * OCR de UMA página para a pré-visualização: páginas digitalizadas não têm
 * linhas na camada de texto e sem isto não há nada para escolher. Usa o
 * mesmo DPI da conversão para o texto coincidir com o resultado final.
 * As linhas OCR têm coordenadas em unidades PDF (para as caixas) mas nunca
 * trazem negrito — o Tesseract não deteta peso de fonte.
 */
async function pageOcr(filePath: string, pageIndex: number, psm: unknown): Promise<PageOcrResult> {
  const doc = await loadPdfDocument(filePath)
  try {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) {
      throw new Error('Página fora do intervalo do PDF.')
    }
    const mode = normalizeOcrPsm(psm)
    const image = await renderPageToImage(doc, pageIndex, PAGE_OCR_DPI)
    const ocr = await runOcr(image, 'por', 72 / PAGE_OCR_DPI, mode)
    const sourceLines = (ocr.lines ?? []).filter((line) => line.text.trim())
    const lines: ExtractionPreviewLine[] = []
    for (const line of sourceLines.slice(0, MAX_LINES_PER_PAGE)) {
      const bounded = previewLine(line, MAX_LINE_LENGTH)
      if (bounded.line.text) {
        lines.push(bounded.line)
      }
    }
    return {
      pageIndex,
      lines,
      meanConfidence: Math.round(ocr.meanConfidence * 10) / 10,
      truncated: sourceLines.length > lines.length,
      psm: mode
    }
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}

parentPort?.on('message', async (message: unknown) => {
  const request = message as PreviewRequest | null
  if (!request || typeof request.filePath !== 'string') {
    return
  }

  try {
    if (request.type === 'page-ocr') {
      if (!Number.isInteger(request.pageIndex)) {
        throw new Error('Página inválida para OCR.')
      }
      post({ type: 'page-ocr-done', pageOcr: await pageOcr(request.filePath, request.pageIndex, request.psm) })
    } else if (request.type === 'preview') {
      post({ type: 'preview-done', preview: await preview(request.filePath) })
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    parentPort?.close()
  }
})
