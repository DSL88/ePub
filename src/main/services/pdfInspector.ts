import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCanvasModule } from './canvasLoader'

export interface TextLine {
  text: string
  x: number
  y: number
  fontSize: number
}

export interface PdfPageContent {
  index: number
  lines?: TextLine[]
  text?: string
  imageOnly?: boolean
}

export interface PdfThumbnail {
  index: number
  dataUrl: string
}

export interface PdfInspection {
  mode: 'text-layer' | 'image-only'
  pageCount: number
  pages: PdfPageContent[]
  thumbnails?: PdfThumbnail[]
}

export interface PdfViewport {
  width: number
  height: number
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: unknown[] }>
  getViewport(options: { scale: number }): PdfViewport
  render(options: { canvasContext: unknown; viewport: unknown }): Promise<{ promise?: Promise<void> } | void>
  cleanup(): void
}

export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy(): Promise<void>
}

interface PdfTextItem {
  str: string
  transform: number[]
  width?: number
}

const PDFJS_MODULE_PATH = ['pdfjs-dist', 'legacy', 'build', 'pdf.mjs'].join('/')

let pdfjsCache: Promise<any> | null = null

function resolvePdfjsAssets(): { standardFontDataUrl?: string; cMapUrl?: string } {
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    const packageRoot = path.dirname(path.dirname(path.dirname(workerPath)))
    return {
      standardFontDataUrl: path.join(packageRoot, 'standard_fonts') + path.sep,
      cMapUrl: path.join(packageRoot, 'cmaps') + path.sep
    }
  } catch {
    return {}
  }
}

async function loadPdfjs(): Promise<any> {
  if (!pdfjsCache) {
    pdfjsCache = import(/* @vite-ignore */ PDFJS_MODULE_PATH)
      .then((mod: any) => mod?.default?.getDocument ? mod.default : mod)
      .then(async (pdfjsLib: any) => {
        try {
          const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
          pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
        } catch {
          pdfjsLib.GlobalWorkerOptions.workerSrc ||= './pdf.worker.mjs'
        }
        return pdfjsLib
      })
      .catch((err) => {
        pdfjsCache = null
        throw new Error(`Falha ao carregar o módulo pdfjs-dist: ${err?.message ?? err}`)
      })
  }
  return pdfjsCache
}

export async function loadPdfDocument(pdfPath: string): Promise<PdfDocumentLike> {
  const pdfjsLib = await loadPdfjs()
  const data = new Uint8Array(await fsp.readFile(pdfPath))
  const { standardFontDataUrl, cMapUrl } = resolvePdfjsAssets()
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    verbosity: 0
  }).promise
  return doc as PdfDocumentLike
}

function isTextItem(item: unknown): item is PdfTextItem {
  const candidate = item as PdfTextItem | null
  return (
    !!candidate &&
    typeof candidate.str === 'string' &&
    Array.isArray(candidate.transform) &&
    candidate.transform.length >= 6
  )
}

export async function inspectPdf(
  pdfPath: string,
  sendProgress: (stage: string, percent: number) => void = () => {}
): Promise<PdfInspection> {
  const doc = await loadPdfDocument(pdfPath)
  try {
    const pageCount = doc.numPages
    if (!pageCount || pageCount < 1) {
      throw new Error('O PDF não contém páginas legíveis.')
    }

    const pages: PdfPageContent[] = []
    let totalChars = 0

    for (let i = 0; i < pageCount; i++) {
      const page = await doc.getPage(i + 1)
      try {
        const textContent = await page.getTextContent()
        const items = textContent.items.filter(isTextItem)
        const lines = groupItemsIntoLines(items)
        const pageChars = items.reduce((acc, item) => acc + item.str.trim().length, 0)
        totalChars += pageChars
        pages.push({ index: i, lines, imageOnly: pageChars < 20 })
      } finally {
        try {
          page.cleanup()
        } catch {
          /* página pode já ter sido limpa */
        }
      }
      sendProgress('inspect', ((i + 1) / pageCount) * 100)
    }

    const avgCharsPerPage = totalChars / pageCount
    const mode: PdfInspection['mode'] = avgCharsPerPage > 20 ? 'text-layer' : 'image-only'

    let thumbnails: PdfThumbnail[] = []
    try {
      thumbnails = await renderThumbnails(doc)
    } catch {
      thumbnails = []
    }

    return { mode, pageCount, pages, thumbnails }
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}

function groupItemsIntoLines(items: PdfTextItem[]): TextLine[] {
  const positioned = items
    .map((item) => ({
      item,
      x: item.transform[4],
      y: item.transform[5],
      fontSize: Math.hypot(item.transform[2], item.transform[3])
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  const tolerance = 4
  const groups: { y: number; parts: typeof positioned }[] = []

  for (const part of positioned) {
    if (!part.item.str.trim()) {
      continue
    }
    const current = groups[groups.length - 1]
    if (current && Math.abs(part.y - current.y) <= tolerance) {
      current.parts.push(part)
    } else {
      groups.push({ y: part.y, parts: [part] })
    }
  }

  const lines: TextLine[] = []
  for (const group of groups) {
    const parts = [...group.parts].sort((a, b) => a.x - b.x)
    let text = ''
    let prevEndX: number | null = null
    let fontSize = 0
    let minX = Infinity

    for (const part of parts) {
      const str = part.item.str
      if (!text) {
        text = str
      } else {
        const gap = part.x - (prevEndX ?? part.x)
        const needsSpace = gap > Math.max(1, part.fontSize * 0.18) && !/\s$/.test(text) && !/^\s/.test(str)
        text += (needsSpace ? ' ' : '') + str
      }
      prevEndX = part.x + (part.item.width ?? 0)
      fontSize = Math.max(fontSize, part.fontSize)
      minX = Math.min(minX, part.x)
    }

    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) {
      continue
    }
    lines.push({ text: cleaned, x: minX, y: group.y, fontSize: Number(fontSize.toFixed(1)) })
  }

  return lines
}

async function renderThumbnails(doc: PdfDocumentLike, count = 8, width = 120): Promise<PdfThumbnail[]> {
  const canvasModule = await loadCanvasModule()
  if (!canvasModule) {
    return []
  }

  const pageCount = doc.numPages
  const indices = new Set<number>()
  for (let k = 0; k < count; k++) {
    const denominator = count > 1 ? count - 1 : 1
    indices.add(Math.min(pageCount - 1, Math.round(((pageCount - 1) * k) / denominator)))
  }

  const thumbnails: PdfThumbnail[] = []
  for (const pageIndex of indices) {
    try {
      const page = await doc.getPage(pageIndex + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / base.width })
      const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      const task = page.render({ canvasContext: context, viewport }) as { promise?: Promise<void> } | void
      await task?.promise
      thumbnails.push({ index: pageIndex, dataUrl: canvas.toDataURL('image/png') })
      page.cleanup()
    } catch {
      /* ignora páginas problemáticas na pré-visualização */
    }
  }
  return thumbnails
}
