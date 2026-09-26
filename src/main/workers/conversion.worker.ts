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
import {
  detectChapters,
  excludeMarkedLines,
  hasUserContentOnPage,
  insertManualLines,
  matchLineMarkExists,
  normalizeLineMarks,
  normalizeLineOrder,
  normalizeManualLines,
  normalizeMatchText,
  reorderMarkedLines,
  sanitizePages
} from '../services/textSanitizer'
import { normalizeOcrPsm } from '../services/ocrService'
import { boundaryChaptersToMarks, normalizeBoundaryOverrides } from '../services/pageBoundaries'
import { buildChapterBody, buildEpub, type EpubImageInput, type SendProgress } from '../services/epubBuilder'
import type { AppliedSummary, ConversionRequestMessage } from '../types'

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

/**
 * Páginas-título isoladas ("A detenção", "O PROCESSO") têm < 80 caracteres e,
 * com um ornamento/vinheta, seriam classificadas como imageOnly — o texto era
 * descartado e o título desaparecia do EPUB. Se a primeira linha tem aspeto
 * de título e a página tem poucas linhas (não é um mapa com dezenas de
 * rótulos), o texto é preservado.
 */
function looksLikeStandaloneTitle(page: PdfPageContent): boolean {
  const lines = (page.lines ?? []).filter((line) => line.text.trim())
  if (lines.length === 0 || lines.length > 8) {
    return false
  }
  const first = lines[0].text.replace(/\s+/g, ' ').trim()
  if (first.length < 4 || first.length > 70 || first.startsWith('@')) {
    return false
  }
  if (/[.,;:!?…]$/.test(first) || /^[\dIVXLCDMivxlcdm]{1,6}\.?$/.test(first)) {
    return false
  }
  const letters = first.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ]/g, '').length
  const nonSpaces = first.replace(/\s/g, '').length
  return nonSpaces > 0 && letters / nonSpaces >= 0.6
}

async function ocrPages(
  filePath: string,
  pageIndices: number[],
  dpi: number,
  psmByPage: Record<number, string> = {}
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
      results.set(pageIndex, await runOcr(imageBuffer, 'por', 72 / dpi, psmByPage[pageIndex] ?? '3'))
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
  // Páginas imageOnly NÃO têm texto: a imagem É o conteúdo. Amostrá-las
  // (sampleEvenly 40) apagava páginas do livro — foi o caso das páginas
  // digitalizadas que "não estavam a ser convertidas". Inclui-as sempre;
  // amostra só o excedente de illustration-com-texto (foto + legenda), onde
  // a imagem é duplicado opcional e o texto já preserva o conteúdo.
  const imageOnlyPages = candidates.filter((page) => page.imageOnly)
  const illustratedTextPages = candidates.filter((page) => !page.imageOnly)
  const budgetForIllustratedText = Math.max(0, MAX_ILLUSTRATION_PAGES - imageOnlyPages.length)
  const chosenIllustrated =
    illustratedTextPages.length <= budgetForIllustratedText
      ? illustratedTextPages
      : sampleEvenly(illustratedTextPages, Math.max(0, budgetForIllustratedText))
  // Se nem as imageOnly couberem no teto absoluto, inclui pela ordem do
  // livro até ao limite em vez de amostrar (amostrar apagava meio do livro).
  const chosenImageOnly =
    imageOnlyPages.length <= MAX_IMAGES_TOTAL
      ? imageOnlyPages
      : imageOnlyPages.slice(0, MAX_IMAGES_TOTAL)
  const chosen = [...chosenImageOnly, ...chosenIllustrated].sort((a, b) => a.index - b.index)
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

  // Linhas que o utilizador mandou ignorar (nºs de página do livro, restos
  // de cabeçalho, artefactos): saem já aqui para não contaminarem texto,
  // capítulos nem fronteiras. Aplica-se à camada de texto e, abaixo, aos
  // resultados do OCR (mesma normalização exata).
  const pendingLineMarks = normalizeLineMarks(options?.lineMarks)
  const manualLines = normalizeManualLines(options?.manualLines)
  const lineOrder = normalizeLineOrder(options?.lineOrder)
  // Mesmo PSM escolhido na pré-visualização, para o texto final coincidir
  // com o que o utilizador viu e ordenou.
  const pageOcrPsm: Record<number, string> = {}
  if (options?.pageOcrPsm && typeof options.pageOcrPsm === 'object') {
    for (const [key, value] of Object.entries(options.pageOcrPsm)) {
      const pageIndex = Number(key)
      if (Number.isInteger(pageIndex) && pageIndex >= 0 && typeof value === 'string') {
        pageOcrPsm[pageIndex] = normalizeOcrPsm(value)
      }
    }
  }
  const ignoredByPage = new Map<number, Set<string>>()
  for (const mark of pendingLineMarks) {
    if (mark.level !== 'ignore') {
      continue
    }
    const normalized = normalizeMatchText(mark.matchText)
    if (!normalized) {
      continue
    }
    const set = ignoredByPage.get(mark.pageIndex) ?? new Set<string>()
    set.add(normalized)
    ignoredByPage.set(mark.pageIndex, set)
  }
  let ignoredRemoved = 0
  const stripIgnoredOcr = (pageIndex: number, ocr: OcrResult): OcrResult => {
    const banned = ignoredByPage.get(pageIndex)
    if (!banned || banned.size === 0) {
      return ocr
    }
    const before = (ocr.lines ?? []).length
    const kept = (ocr.lines ?? []).filter((line) => {
      const normalized = normalizeMatchText(line.text)
      return normalized.length === 0 || !banned.has(normalized)
    })
    if (kept.length === before) {
      return ocr
    }
    ignoredRemoved += before - kept.length
    return { ...ocr, lines: kept, text: kept.map((line) => line.text).join('\n') }
  };
  if (ignoredByPage.size > 0) {
    const before = inspection.pages.reduce((n, page) => n + (page.lines?.length ?? 0), 0)
    inspection.pages = excludeMarkedLines(
      inspection.pages,
      [...ignoredByPage.entries()].flatMap(([pageIndex, texts]) =>
        [...texts].map((lineText) => ({ pageIndex, lineText }))
      )
    )
    ignoredRemoved += before - inspection.pages.reduce((n, page) => n + (page.lines?.length ?? 0), 0)
  }

  let pagesWithText: PdfPageContent[]

  if (inspection.mode === 'text-layer') {
    // Páginas de mapa/gráfico (< 80 car. + visuais → imageOnly) têm o texto
    // disperso descartado para não gerar falsos capítulos — a página é
    // rasterizada na íntegra e NUNCA desaparece. Páginas com 80-400 car.
    // (illustration, ex.: título + ornamento + início de texto) MANTÊM o
    // texto: descartá-lo apagava títulos de capítulo. Exceção: página-título
    // isolada com ornamento (< 80 car. mas com aspeto de título) também
    // mantém o texto.
    pagesWithText = inspection.pages.map((page) => {
      const keepTitle = looksLikeStandaloneTitle(page)
      // Manual-first: página afirmada pelo utilizador nunca perde o texto.
      const rescued = hasUserContentOnPage(page.index, pendingLineMarks, manualLines)
      const discard = page.imageOnly && !keepTitle && !rescued
      return {
        ...page,
        ...(keepTitle ? { imageOnly: false, illustration: false } : {}),
        text: discard ? '' : pageLinesText(page)
      }
    })
    // OCR apenas nas páginas com pouco texto e SEM visuais (visuais quase
    // sem texto tornam-se figuras rasterizadas, pelo que o OCR nelas seria
    // tempo perdido).
    const ocrTargets = pagesWithText
      .filter((page) => !page.hasVisual && (page.imageOnly || page.sparse))
      .map((page) => page.index)
    if (ocrTargets.length > 0) {
      try {
        const ocrTexts = await ocrPages(filePath, ocrTargets, dpi, pageOcrPsm)
        for (const [pageIndex, ocr] of ocrTexts) {
          ocrTexts.set(pageIndex, stripIgnoredOcr(pageIndex, ocr))
        }
        pagesWithText = pagesWithText.map((page) => {
          const ocr = ocrTexts.get(page.index)
          const useOcrLines = !page.imageOnly && !page.text?.trim() && !!ocr?.text.trim()
          return {
            ...page,
            ...(useOcrLines ? { lines: ocr?.lines } : {}),
            text: page.imageOnly ? '' : page.text || ocr?.text || ''
          }
        })
      } catch {
        /* sem tesseract disponível: mantém apenas a camada de texto */
      }
    }
  } else {
    let ocrResults = new Map<number, OcrResult>()
    try {
      ocrResults = await ocrPages(filePath, inspection.pages.map((page) => page.index), dpi, pageOcrPsm)
      for (const [pageIndex, ocr] of ocrResults) {
        ocrResults.set(pageIndex, stripIgnoredOcr(pageIndex, ocr))
      }
    } catch (error) {
      // Sem OCR um PDF digitalizado fica sem texto nenhum: falhar com
      // mensagem clara (instalar tesseract) em vez de gerar um EPUB com
      // páginas em falta por amostragem silenciosa.
      const message = error instanceof Error ? error.message : String(error)
      if (/tesseract/i.test(message)) {
        throw error
      }
      /* outro erro: as páginas entram como ilustrações */
    }
    // Modo digitalizado: cada página é texto (OCR fiável) OU figura (sem
    // texto reconhecido, ou OCR de má qualidade — páginas estilizadas,
    // mapas): nesta última a página completa é rasterizada e o texto
    // reconhecido é descartado, para não gerar falsos capítulos nem
    // parágrafos fragmentados. Páginas com OCR bom deixam de ser
    // illustration: o texto já é o conteúdo, rasterizá-las duplicava cada
    // página e esgotava os tetos de imagens.
    pagesWithText = inspection.pages.map((page) => {
      const ocr = ocrResults.get(page.index)
      const text = ocr?.text ?? ''
      // Manual-first: páginas com marcas/linhas do utilizador nunca são
      // classificadas como figura (o texto fraco mantém-se em vez de ser
      // descartado em silêncio e matar as marcas).
      const rescued = hasUserContentOnPage(page.index, pendingLineMarks, manualLines)
      const isFigure = !rescued && (!text.trim() || (ocr?.meanConfidence ?? 0) < LOW_OCR_CONFIDENCE)
      return {
        ...page,
        lines: isFigure ? page.lines : ocr?.lines ?? [],
        illustration: isFigure,
        imageOnly: isFigure ? page.imageOnly : false,
        text: isFigure ? '' : text
      }
    })
    if (ocrResults.size === 0 && pagesWithText.every((page) => !page.text?.trim())) {
      throw new Error(
        'OCR sem resultado: instala o Tesseract (`brew install tesseract tesseract-lang` no macOS ou `apt install tesseract-ocr tesseract-ocr-por` no Linux) e reconverte.'
      )
    }
  }

  makeProgress('sanitize', 65)
  const boundaryOverrides = normalizeBoundaryOverrides(options?.boundaryOverrides)
  const lineMarks = pendingLineMarks
  // Uma linha marcada como capítulo/subcapítulo tem de começar um bloco novo:
  // garante a quebra na fronteira da sua página (sem sobrepor um 'chapter'
  // explícito do utilizador).
  for (const mark of lineMarks) {
    if (boundaryOverrides[mark.pageIndex] !== 'chapter') {
      boundaryOverrides[mark.pageIndex] = 'break'
    }
  }
  const orderedPages = reorderMarkedLines(pagesWithText, lineOrder)
  const withManualLines = insertManualLines(orderedPages, manualLines)
  const sanitized = sanitizePages(withManualLines, boundaryOverrides)

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
    : []
  // Overrides 'chapter' do editor de fronteiras valem como marcas de capítulo.
  for (const mark of boundaryChaptersToMarks(boundaryOverrides)) {
    if (!chapterMarks.includes(mark)) {
      chapterMarks.push(mark)
    }
  }
  chapterMarks.sort((a, b) => a - b)
  const chapters = detectChapters(
    sanitized.paragraphs,
    illustrationIds,
    chapterMarks.length > 0 ? chapterMarks : undefined,
    inspection.outline,
    sanitized.pages,
    lineMarks
  )

  // Relatório manual-first: o que foi realmente aplicado + marcas que não
  // encontraram texto (para o utilizador rever o OCR em vez de achar que
  // "ficou igual").
  const unmatched = lineMarks
    .filter(
      (mark) =>
        (mark.level === 'chapter' || mark.level === 'subchapter') &&
        !matchLineMarkExists(sanitized.paragraphs, mark)
    )
    .map((mark) => mark.matchText.slice(0, 80))
  const applied: AppliedSummary = {
    chapterMarks: lineMarks.filter((mark) => mark.level === 'chapter').length,
    subchapters: lineMarks.filter((mark) => mark.level === 'subchapter').length,
    ignoredRemoved,
    manuals: manualLines.length,
    boundaries: Object.keys(boundaryOverrides).length,
    chaptersOpened: chapters.length,
    pagesWithoutText: pagesWithText.filter((page) => !page.text?.trim()).length,
    unmatched
  }

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

  post({ type: 'done', outputPath, applied })
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
