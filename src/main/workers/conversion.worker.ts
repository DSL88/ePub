import { parentPort } from 'node:worker_threads'
import { basename } from 'node:path'
import {
  inspectPdf,
  loadPdfDocument,
  extractPageImages,
  type PdfPageContent,
  type PdfPageImage
} from '../services/pdfInspector'
import { renderPageToImage, runOcr, type OcrResult } from '../services/ocrService'
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

function pageLinesText(page: PdfPageContent): string {
  return (page.lines ?? []).map((line) => line.text).join('\n')
}

async function ocrPages(
  filePath: string,
  pageIndices: number[],
  dpi: number
): Promise<Map<number, OcrResult>> {
  const results = new Map<number, OcrResult>()
  if (pageIndices.length === 0) {
    return results
  }

  const doc = await loadPdfDocument(filePath)
  try {
    for (let k = 0; k < pageIndices.length; k++) {
      const pageIndex = pageIndices[k]
      const imageBuffer = await renderPageToImage(doc, pageIndex, dpi)
      results.set(pageIndex, await runOcr(imageBuffer, 'por'))
      makeProgress('ocr', 10 + ((k + 1) / pageIndices.length) * 50)
    }
  } finally {
    await doc.destroy().catch(() => undefined)
  }

  return results
}

// Sem limite artificial de 10%: páginas marcadas como ilustração são
// deliberadas (mapas, gravuras). Limita apenas a máximos absolutos.
const MAX_ILLUSTRATION_PAGES = 40
const MAX_IMAGES_TOTAL = 120

// Confiança média do OCR abaixo da qual a página é considerada de leitura
// pobre (páginas estilizadas de capítulo, mapas, scans rotacionados): o
// texto reconhecido é lixo e a página é renderizada como imagem. Calibrado
// em livro real: texto legível ~94-96, páginas estilizadas ~32.
const LOW_OCR_CONFIDENCE = 65

async function extractIllustrations(
  filePath: string,
  pages: PdfPageContent[],
  dpi: number
): Promise<{ images: EpubImageInput[]; illustrationIds: Map<number, string[]> }> {
  // Páginas com visuais relevantes para o ePub: só-para-imagem (mapas,
  // gravuras, fotografias de página inteira) ou ilustração (imagem com
  // texto disperso). Páginas de texto denso não entram.
  const candidates = pages.filter((page) => page.hasVisual && (page.imageOnly || page.illustration))
  if (candidates.length === 0) {
    return { images: [], illustrationIds: new Map() }
  }
  const chosen = candidates.length <= MAX_ILLUSTRATION_PAGES ? candidates : sampleEvenly(candidates, MAX_ILLUSTRATION_PAGES)
  const images: EpubImageInput[] = []
  const illustrationIds = new Map<number, string[]>()

  const doc = await loadPdfDocument(filePath)
  try {
    for (const page of chosen) {
      if (images.length >= MAX_IMAGES_TOTAL) {
        break
      }
      // Página quase sem texto legível (mapa, gráfico, gravura de página
      // inteira): rasteriza a página COMPLETA — preserva vetores, legenda e
      // orientação (incl. paisagem), e a página nunca desaparece do ePub.
      // A rasterização usa o viewport do pdf.js, que aplica a rotação da
      // página automaticamente.
      if (page.imageOnly) {
        try {
          const id = `page-${page.index + 1}-full`
          const buffer = await renderPageToImage(doc, page.index, dpi)
          images.push({ id, buffer, ext: 'png' })
          illustrationIds.set(page.index, [id])
        } catch {
          /* página impossível de rasterizar: ignora */
        }
        continue
      }
      let extracted: PdfPageImage[] = []
      try {
        extracted = await extractPageImages(doc, page.index)
      } catch {
        extracted = []
      }
      if (extracted.length === 0) {
        // A página tem imagem mas os recursos não puderam ser descodificados
        // (padrões, imagem em Form XObject exótico, etc.): rasteriza a página
        // inteira para que a página ilustração nunca fique de fora.
        try {
          const id = `page-${page.index + 1}-full`
          const buffer = await renderPageToImage(doc, page.index, dpi)
          extracted = [{ id, buffer, ext: 'png', width: 0, height: 0 }]
        } catch {
          continue
        }
      }
      const ids: string[] = []
      for (const image of extracted) {
        if (images.length >= MAX_IMAGES_TOTAL) {
          break
        }
        images.push({ id: image.id, buffer: image.buffer, ext: image.ext })
        ids.push(image.id)
      }
      if (ids.length > 0) {
        illustrationIds.set(page.index, ids)
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
    // Páginas com operadores gráficos e pouco texto (< 80 caracteres, ex.:
    // mapa vetorial com nomes de cidades) tornam-se ilustrações de página
    // inteira: o texto disperso é descartado para não gerar falsos capítulos
    // nem parágrafos fragmentados — a página NUNCA desaparece do ePub.
    pagesWithText = inspection.pages.map((page) => ({
      ...page,
      text: page.illustration ? '' : pageLinesText(page)
    }))
    // OCR apenas nas páginas com pouco texto e SEM visuais (visuais quase
    // sem texto tornam-se figuras rasterizadas, pelo que o OCR nelas seria
    // tempo perdido).
    const ocrTargets = pagesWithText
      .filter((page) => !page.hasVisual && (page.imageOnly || page.sparse))
      .map((page) => page.index)
    if (ocrTargets.length > 0) {
      try {
        const ocrTexts = await ocrPages(filePath, ocrTargets, dpi)
        pagesWithText = pagesWithText.map((page) => ({
          ...page,
          text: page.illustration ? '' : page.text || ocrTexts.get(page.index)?.text || ''
        }))
      } catch {
        /* sem tesseract disponível: mantém apenas a camada de texto */
      }
    }
  } else {
    let ocrResults = new Map<number, OcrResult>()
    try {
      ocrResults = await ocrPages(filePath, inspection.pages.map((page) => page.index), dpi)
    } catch {
      /* sem tesseract: as páginas ficam sem texto e entram como ilustrações */
    }
    // Modo digitalizado: cada página é texto (OCR fiável) OU figura (sem
    // texto reconhecido, ou OCR de má qualidade — páginas estilizadas,
    // mapas): nesta última a página completa é rasterizada e o texto
    // reconhecido é descartado, para não gerar falsos capítulos nem
    // parágrafos fragmentados.
    pagesWithText = inspection.pages.map((page) => {
      const ocr = ocrResults.get(page.index)
      const text = ocr?.text ?? ''
      const isFigure = !text.trim() || (ocr?.meanConfidence ?? 0) < LOW_OCR_CONFIDENCE
      return { ...page, illustration: isFigure || page.illustration === true, text: isFigure ? '' : text }
    })
  }

  makeProgress('sanitize', 65)
  const sanitized = sanitizePages(pagesWithText)

  makeProgress('segment', 70)
  let images: EpubImageInput[] = []
  let illustrationIds = new Map<number, string[]>()

  makeProgress('images', 72)
  if (inspection.mode === 'text-layer') {
    const rendered = await extractIllustrations(filePath, pagesWithText, dpi)
    images = rendered.images
    illustrationIds = rendered.illustrationIds
  } else {
    // Modo digitalizado: páginas classificadas como figura (sem texto
    // reconhecido ou OCR de má qualidade) incluem a rasterização da página
    // no ePub.
    const blankPages = pagesWithText.filter((page) => page.illustration && page.hasVisual)
    const rendered = await extractIllustrations(filePath, blankPages, dpi)
    images = rendered.images
    illustrationIds = rendered.illustrationIds
  }
  makeProgress('images', 78)

  const chapterMarks = Array.isArray(options?.chapterMarks)
    ? options.chapterMarks.filter((mark) => typeof mark === 'number' && Number.isFinite(mark))
    : undefined
  const chapters = detectChapters(
    sanitized.paragraphs,
    illustrationIds,
    chapterMarks,
    inspection.outline,
    sanitized.pages
  )

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
