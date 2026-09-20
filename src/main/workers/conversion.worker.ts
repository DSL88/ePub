import { parentPort } from 'node:worker_threads'
import { basename } from 'node:path'
import { inspectPdf, loadPdfDocument, type PdfPageContent } from '../services/pdfInspector'
import { renderPageToImage, runOcr } from '../services/ocrService'
import { detectChapters, sanitizePages } from '../services/textSanitizer'
import { buildChapterBody, buildEpub, type EpubImageInput, type SendProgress } from '../services/epubBuilder'
import type { ConversionRequestMessage } from '../types'

function post(message: unknown): void {
  parentPort?.postMessage(message)
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)))
}

function makeProgress(stage: string, percent: number): void {
  post({ type: 'progress', stage, percent: clampPercent(percent) })
}

function sampleEvenly<T>(items: T[], targetCount: number): T[] {
  if (items.length <= targetCount) {
    return items
  }
  const selected: T[] = []
  for (let i = 0; i < targetCount; i++) {
    const index = Math.round((i * (items.length - 1)) / Math.max(1, targetCount - 1))
    selected.push(items[index])
  }
  return selected
}

function extractPageText(page: PdfPageContent): string {
  return (page.lines ?? []).map((line) => line.text).join('\n')
}

async function ocrAllPages(
  filePath: string,
  pageCount: number,
  dpi: number
): Promise<string[]> {
  const doc = await loadPdfDocument(filePath)
  const texts: string[] = []

  try {
    for (let i = 0; i < pageCount; i++) {
      const imageBuffer = await renderPageToImage(doc, i, dpi)
      texts.push(await runOcr(imageBuffer, 'por'))
      makeProgress('ocr', 10 + ((i + 1) / pageCount) * 50)
    }
  } finally {
    await doc.destroy().catch(() => undefined)
  }

  return texts
}

async function renderIllustrations(
  filePath: string,
  pages: PdfPageContent[],
  dpi: number
): Promise<{ images: EpubImageInput[]; illustrationIds: Map<number, string> }> {
  const candidates = pages.filter((page) => page.imageOnly)
  const targetCount = Math.min(candidates.length, Math.max(1, Math.round(pages.length * 0.1)))
  if (targetCount <= 0) {
    return { images: [], illustrationIds: new Map() }
  }

  const chosen = sampleEvenly(candidates, targetCount)
  const images: EpubImageInput[] = []
  const illustrationIds = new Map<number, string>()

  const doc = await loadPdfDocument(filePath)
  try {
    for (const page of chosen) {
      try {
        const buffer = await renderPageToImage(doc, page.index, dpi)
        const id = `page-${page.index}`
        images.push({ id, buffer, ext: 'png' })
        illustrationIds.set(page.index, id)
      } catch {
        /* ilustração ignorada */
      }
    }
  } finally {
    await doc.destroy().catch(() => undefined)
  }

  return { images, illustrationIds }
}

async function convert(msg: ConversionRequestMessage): Promise<void> {
  const { filePath, outPath, metadata, options } = msg

  makeProgress('inspect', 5)

  const inspection = await inspectPdf(filePath, (stage, percent) => {
    makeProgress(stage, 5 + (percent / 100) * 5)
  })

  const pageCount = inspection.pageCount
  const dpi = options?.dpi ?? 200

  let pagesWithText: PdfPageContent[]

  if (inspection.mode === 'text-layer') {
    pagesWithText = inspection.pages.map((page) => ({ ...page, text: extractPageText(page) }))
    const needsOcr = pagesWithText.some((page) => page.imageOnly)
    if (needsOcr) {
      try {
        const ocrTexts = await ocrAllPages(filePath, pageCount, dpi)
        pagesWithText = pagesWithText.map((page, i) => ({
          ...page,
          text: page.text || ocrTexts[i] || ''
        }))
      } catch {
        /* sem tesseract disponível: mantém apenas a camada de texto */
      }
    }
  } else {
    const ocrTexts = await ocrAllPages(filePath, pageCount, dpi)
    pagesWithText = inspection.pages.map((page, i) => ({ ...page, text: ocrTexts[i] ?? '' }))
  }

  makeProgress('sanitize', 65)
  const sanitized = sanitizePages(pagesWithText)

  makeProgress('segment', 70)
  let images: EpubImageInput[] = []
  let illustrationIds = new Map<number, string>()

  if (inspection.mode === 'text-layer') {
    makeProgress('images', 72)
    const rendered = await renderIllustrations(filePath, inspection.pages, dpi)
    images = rendered.images
    illustrationIds = rendered.illustrationIds
    makeProgress('images', 78)
  }

  const interject = (pageIndex: number): string => {
    const id = illustrationIds.get(pageIndex)
    return id ? `@image:${id}` : ''
  }

  const chapterMarks = Array.isArray(options?.chapterMarks)
    ? options.chapterMarks.filter((mark): mark is number => typeof mark === 'number' && Number.isFinite(mark))
    : undefined
  const chapters = detectChapters(sanitized.paragraphs, interject, chapterMarks)

  makeProgress('build', 80)
  const title = metadata?.title?.trim() || basename(filePath).replace(/\.pdf$/i, '')
  const outputPath = await buildEpub(
    {
      title,
      author: metadata?.author,
      language: metadata?.language,
      coverPath: metadata?.coverPath,
      chapters: chapters.map((chapter) => ({ title: chapter.title, xhtml: buildChapterBody(chapter.content) })),
      images,
      outPath
    },
    (stage, percent) => makeProgress(stage, 80 + (percent / 100) * 18)
  )

  post({ type: 'done', outputPath })
}

parentPort?.on('message', async (msg: unknown) => {
  const request = msg as ConversionRequestMessage | null
  if (!request || request.type !== 'convert') {
    return
  }
  try {
    await convert(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    post({ type: 'error', message })
  }
})
