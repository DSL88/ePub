import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCanvasModule } from './canvasLoader'

export interface TextLine {
  text: string
  x: number
  y: number
  fontSize: number
  /** extensão horizontal da linha em unidades PDF, quando conhecida */
  width?: number
  /** a linha é desenhada predominantemente com fonte Bold/Black/Heavy */
  bold?: boolean
}

/** Geometria normalizada de um item PDF.js, usada pelo layout puro abaixo. */
export interface PdfTextLayoutItem {
  str: string
  x: number
  y: number
  fontSize: number
  width?: number
  height?: number
  dir?: string
  hasEOL?: boolean
  bold?: boolean
}

export interface PdfTextLayoutOptions {
  /** Permutação completa dos índices dos itens não vazios, em ordem lógica. */
  logicalOrder?: readonly number[]
}

export interface PdfPageContent {
  index: number
  lines?: TextLine[]
  text?: string
  /** número impresso na página, extraído do cabeçalho ou rodapé */
  physicalPageNumber?: string
  /** título corrente identificado na zona geométrica do cabeçalho */
  headerTitle?: string
  imageOnly?: boolean
  hasImage?: boolean
  /** a página tem elementos visuais: imagens raster OU desenhos vetoriais */
  hasVisual?: boolean
  illustration?: boolean
  /** a página tem pouco texto (< 80 caracteres), com ou sem visuais */
  sparse?: boolean
  /** tamanho de fonte dominante do corpo da página (moda de transform[0]) */
  bodyFontSize?: number
  /** altura da página em unidades PDF (para regras de posição vertical) */
  height?: number
  /** largura da página em unidades PDF */
  width?: number
}

export interface PdfPageImage {
  id: string
  buffer: Buffer
  ext: string
  width: number
  height: number
}

/** Entrada do outline nativo do PDF (bookmarks), já resolvida a uma página. */
export interface PdfOutlineEntry {
  /** 0-based page index */
  pageIndex: number
  title: string
  /** profundidade no TOC (0 = nível de topo/capítulo) */
  depth: number
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
  outline?: PdfOutlineEntry[]
}

export interface PdfViewport {
  width: number
  height: number
}

interface PdfObjectsLike {
  has(objId: string): boolean
  get(objId: string): unknown
}

export interface PdfPageLike {
  getTextContent(options?: { includeMarkedContent?: boolean }): Promise<{ items: unknown[] }>
  getStructTree?(): Promise<unknown>
  getOperatorList?(): Promise<{ fnArray?: number[]; argsArray?: unknown[] }>
  getViewport(options: { scale: number }): PdfViewport
  render(options: { canvasContext: unknown; viewport: unknown }): Promise<{ promise?: Promise<void> } | void>
  cleanup(): void
  objs?: PdfObjectsLike | null
  commonObjs?: PdfObjectsLike | null
}

interface PdfOutlineItemLike {
  title?: unknown
  dest?: unknown
  url?: unknown
  items?: PdfOutlineItemLike[]
}

export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy(): Promise<void>
  getOutline?(): Promise<PdfOutlineItemLike[] | null>
  getDestination?(name: string): Promise<unknown>
  getPageIndex?(ref: unknown): Promise<number>
}

interface PdfTextItem {
  str: string
  transform: number[]
  width?: number
  height?: number
  dir?: string
  hasEOL?: boolean
  /** id interno da fonte usada pelo item (ex.: "g_d0_f1") */
  fontName?: string
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextContentItem(item: unknown): item is { str: string } {
  return isObjectRecord(item) && typeof item.str === 'string'
}

/** Lê IDs de conteúdo apenas de uma árvore PDF.js completa e bem formada. */
function collectStructContentIds(tree: unknown): string[] | null {
  if (!isObjectRecord(tree) || tree.role !== 'Root' || !Array.isArray(tree.children)) {
    return null
  }

  const ids: string[] = []
  const visited = new WeakSet<object>([tree])
  let visitedCount = 0
  const MAX_STRUCT_NODES = 20000
  const MAX_STRUCT_DEPTH = 64

  const visitChildren = (children: unknown[], depth: number): boolean => {
    if (depth > MAX_STRUCT_DEPTH) {
      return false
    }
    for (const child of children) {
      if (!isObjectRecord(child) || visited.has(child)) {
        return false
      }
      visited.add(child)
      visitedCount++
      if (visitedCount > MAX_STRUCT_NODES) {
        return false
      }

      if (child.type === 'content') {
        if (typeof child.id !== 'string' || !child.id) {
          return false
        }
        ids.push(child.id)
      } else if (child.type === 'object' || child.type === 'annotation') {
        // Object and annotation references are valid non-text leaves, not MCIDs.
        if (typeof child.id !== 'string' || !child.id) {
          return false
        }
      } else if (typeof child.role === 'string' && Array.isArray(child.children)) {
        if (!visitChildren(child.children, depth + 1)) {
          return false
        }
      } else {
        return false
      }
    }
    return true
  }

  if (!visitChildren(tree.children, 0) || ids.length === 0) {
    return null
  }
  return ids
}

/**
 * Resolve a complete logical order through PDF.js' shared marked-content IDs.
 * Partial or malformed tagging returns null so the caller uses the geometric
 * region/column fallback instead of mixing two uncertain orders.
 */
function resolveTaggedTextItemOrder(
  contentItems: readonly unknown[],
  structureTree: unknown,
  selectedItems: readonly { str: string }[]
): number[] | null {
  const structureIds = collectStructContentIds(structureTree)
  if (!structureIds) {
    return null
  }

  const structureIdSet = new Set(structureIds)
  const selectedIndex = new Map<object, number>()
  selectedItems.forEach((item, index) => selectedIndex.set(item, index))
  const indicesById = new Map<string, number[]>()
  const markedContentStack: Array<string | null> = []
  let sawMarkedContent = false

  for (const rawItem of contentItems) {
    if (isTextContentItem(rawItem)) {
      const index = selectedIndex.get(rawItem)
      if (index === undefined || !rawItem.str.trim()) {
        continue
      }
      // The innermost structure-backed scope owns this text. If an inner
      // marked scope is untagged, an enclosing mapped scope remains usable.
      for (let i = markedContentStack.length - 1; i >= 0; i--) {
        const id = markedContentStack[i]
        if (id && structureIdSet.has(id)) {
          const indices = indicesById.get(id) ?? []
          indices.push(index)
          indicesById.set(id, indices)
          break
        }
      }
      continue
    }

    if (!isObjectRecord(rawItem) || typeof rawItem.type !== 'string') {
      continue
    }
    if (rawItem.type === 'beginMarkedContent' || rawItem.type === 'beginMarkedContentProps') {
      sawMarkedContent = true
      if (rawItem.type === 'beginMarkedContentProps' && typeof rawItem.id !== 'string') {
        return null
      }
      markedContentStack.push(
        rawItem.type === 'beginMarkedContentProps' ? rawItem.id as string : null
      )
    } else if (rawItem.type === 'endMarkedContent') {
      sawMarkedContent = true
      if (markedContentStack.length === 0) {
        return null
      }
      markedContentStack.pop()
    } else {
      return null
    }
  }

  if (!sawMarkedContent || markedContentStack.length > 0) {
    return null
  }

  const required = selectedItems
    .map((item, index) => item.str.trim() ? index : -1)
    .filter((index) => index >= 0)
  if (required.length === 0) {
    return null
  }

  const order: number[] = []
  const ordered = new Set<number>()
  for (const id of structureIds) {
    for (const index of indicesById.get(id) ?? []) {
      if (!ordered.has(index)) {
        ordered.add(index)
        order.push(index)
      }
    }
  }
  return order.length === required.length && required.every((index) => ordered.has(index))
    ? order
    : null
}

/**
 * Pure PDF.js tagged-order mapping for synthetic and real text-content data.
 * The result indexes the text-only list in content-stream order; null means
 * the tree, markers, or complete text-item mapping is unavailable/malformed.
 */
export function getTaggedTextItemOrder(
  contentItems: readonly unknown[],
  structureTree: unknown
): number[] | null {
  return resolveTaggedTextItemOrder(
    contentItems,
    structureTree,
    contentItems.filter(isTextContentItem)
  )
}

// Marcadores de peso pesado em nomes de fonte. Sem word boundaries para
// "bold"/"black"/"heavy"/"medium" (nomes como "TimesNewRomanPS-BoldMT" juntam
// "Bold" a "MT" e \b falharia). "w700"/"700" levam \b para não apanharem
// fragmentos como "e700". "Italic" nunca contém estes marcadores; "Book"/"bk"
// (peso normal) também não — daí a exclusão de "bk".
const isBoldFontName = /bold|black|heavy|medium|[-_]bd\b|\bw?700\b/i

/**
 * Conjunto de fontNames usados em peso negrito/ pesado, para deteção
 * semântica de subtítulos. Inspeciona diretamente cada `item.fontName` (o id
 * do pdf.js é opaco, mas alguns documentos entregam o nome real), o
 * `fontFamily` do estilo associado e a flag `bold`/`black` do objeto de
 * fonte (page.commonObjs), ignorando falhas silenciosamente.
 */
function collectBoldFontNames(
  page: PdfPageLike,
  items: PdfTextItem[],
  styles: Record<string, { fontFamily?: unknown } | undefined>
): Set<string> {
  const boldNames = new Set<string>()
  const usedNames = new Set<string>()
  for (const item of items) {
    if (item.fontName) {
      usedNames.add(item.fontName)
    }
  }
  for (const name of usedNames) {
    const style = styles[name]
    const styleFamily = typeof style?.fontFamily === 'string' ? style.fontFamily : ''
    if (isBoldFontName.test(name) || isBoldFontName.test(styleFamily)) {
      boldNames.add(name)
      continue
    }
    const store = page.commonObjs
    if (!store || typeof store.has !== 'function' || !store.has(name)) {
      continue
    }
    try {
      const fontObj = store.get(name) as { bold?: unknown; black?: unknown; name?: unknown } | null
      if (!fontObj || typeof fontObj !== 'object') {
        continue
      }
      const flagged = fontObj.bold === true || fontObj.black === true
      const named = typeof fontObj.name === 'string' && isBoldFontName.test(fontObj.name)
      if (flagged || named) {
        boldNames.add(name)
      }
    } catch {
      /* fonte não acessível: ignora */
    }
  }
  return boldNames
}

const OPS_PER_IMAGE_SCAN = 20000

/**
 * Tamanho padrão da fonte da página: moda de |transform[0]| (escala X =
 * corpo da fonte) ponderada pelo número de caracteres, sobre TODOS os itens
 * de `getTextContent()` — o texto corrido do corpo é o que mais repete, pelo
 * que domina a moda sem filtragem adicional. Fallback para a altura
 * (hypot de transform[2..3]) quando a escala X é nula (texto rodado).
 */
function dominantItemFontSize(items: PdfTextItem[]): number {
  const weights = new Map<number, number>()
  for (const item of items) {
    const text = item.str.trim()
    if (!text) {
      continue
    }
    const scaleX = Math.abs(item.transform[0])
    const size = scaleX > 0.1 ? scaleX : Math.hypot(item.transform[2], item.transform[3])
    if (!(size > 0)) {
      continue
    }
    const key = Math.round(size * 2) / 2
    weights.set(key, (weights.get(key) ?? 0) + text.length)
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
 * Códigos dos operadores de desenho, resolvidos a partir de pdfjsLib.OPS
 * (nomes estáveis) com fallback para os valores numéricos de pdfjs-dist 4:
 * 83 paintImageMaskXObject, 84 paintImageMaskXObjectGroup, 85
 * paintImageXObject, 86 paintInlineImageXObject, 87
 * paintInlineImageXObjectGroup, 88 paintImageXObjectRepeat, 89
 * paintImageMaskXObjectRepeat. O 90 (paintSolidColorImageMask) fica de
 * fora: é usado para retângulos de cor sólida e geraria falsas deteções em
 * páginas de texto.
 */
const IMAGE_OP_FALLBACK = [83, 84, 85, 86, 87, 88, 89]

async function imageOpCodes(): Promise<Set<number>> {
  try {
    const pdfjsLib = await loadPdfjs()
    const OPS = (pdfjsLib as { OPS?: Record<string, number> }).OPS
    if (OPS) {
      const names = [
        'paintImageMaskXObject',
        'paintImageMaskXObjectGroup',
        'paintImageXObject',
        'paintInlineImageXObject',
        'paintInlineImageXObjectGroup',
        'paintImageXObjectRepeat',
        'paintImageMaskXObjectRepeat'
      ]
      const codes = names.map((name) => OPS[name]).filter((code) => typeof code === 'number')
      if (codes.length > 0) {
        return new Set(codes)
      }
    }
  } catch {
    /* fallback abaixo */
  }
  return new Set(IMAGE_OP_FALLBACK)
}

/**
 * Operadores de desenho vetorial (traços, preenchimentos, sombreados). Uma
 * página com muitos operadores destes e pouco texto é um mapa/gráfico
 * vetorial — tem de ser rasterizada, senão desaparece do ePub.
 */
const VECTOR_OP_FALLBACK = [91, 20, 21, 22, 23, 24, 25, 26, 27, 62] as const

const VECTOR_OP_NAMES = [
  'constructPath',
  'stroke',
  'closeStroke',
  'fill',
  'eoFill',
  'fillStroke',
  'closeFillStroke',
  'eoFillStroke',
  'closeEOFillStroke',
  'shadingFill'
] as const

async function vectorOpCodes(): Promise<Set<number>> {
  try {
    const pdfjsLib = await loadPdfjs()
    const OPS = (pdfjsLib as { OPS?: Record<string, number> }).OPS
    if (OPS) {
      const codes = VECTOR_OP_NAMES.map((name) => OPS[name]).filter((code) => typeof code === 'number')
      if (codes.length > 0) {
        return new Set(codes)
      }
    }
  } catch {
    /* fallback abaixo */
  }
  return new Set(VECTOR_OP_FALLBACK)
}

/** Operadores vetoriais mínimos para considerar a página "desenhada":
 * sublinha um-régua (~4 ops) não conta; mapas/gráficos têm dezenas. */
const MIN_VECTOR_OPS = 10

interface VisualScan {
  hasImage: boolean
  vectorOps: number
}

function scanPageVisuals(
  operatorList: { fnArray?: number[]; argsArray?: unknown[] },
  imageOps: Set<number>,
  vectorOps: Set<number>
): VisualScan {
  const { fnArray } = operatorList
  if (!fnArray) {
    return { hasImage: false, vectorOps: 0 }
  }

  let hasImage = false
  let vectorCount = 0
  for (let i = 0; i < Math.min(fnArray.length, OPS_PER_IMAGE_SCAN); i++) {
    const fn = fnArray[i]
    if (imageOps.has(fn)) {
      hasImage = true
    } else if (vectorOps.has(fn)) {
      vectorCount++
    }
  }
  return { hasImage, vectorOps: vectorCount }
}

async function resolveOutlinePageIndex(
  doc: PdfDocumentLike,
  item: PdfOutlineItemLike
): Promise<number> {
  let dest = item.dest
  if (typeof dest === 'string') {
    if (typeof doc.getDestination !== 'function') {
      return -1
    }
    try {
      dest = await doc.getDestination(dest)
    } catch {
      return -1
    }
  }
  if (!Array.isArray(dest) || dest.length === 0) {
    return -1
  }
  const ref = dest[0]
  if (typeof doc.getPageIndex !== 'function') {
    return -1
  }
  try {
    // dest[0] é um Ref { num, gen } do pdf.js; alguns produtores usam o
    // índice da página diretamente.
    if (ref && typeof ref === 'object' && Number.isFinite((ref as { num?: unknown }).num)) {
      return await doc.getPageIndex(ref)
    }
    if (typeof ref === 'number' && ref >= 0) {
      return Math.floor(ref)
    }
  } catch {
    return -1
  }
  return -1
}

/**
 * Lê o outline nativo (bookmarks) do PDF e resolve cada destino à página
 * 0-based correspondente. As entradas com URL externo, título vazio ou
 * destino não resolvível são ignoradas. A ordem do documento é preservada
 * (DFS: pais antes dos filhos) e cada entrada guarda a profundidade no TOC
 * — o consumidor decide que nível corresponde a capítulos.
 */
export async function collectOutline(doc: PdfDocumentLike): Promise<PdfOutlineEntry[]> {
  if (typeof doc.getOutline !== 'function') {
    return []
  }

  let items: PdfOutlineItemLike[] | null = null
  try {
    items = await doc.getOutline()
  } catch {
    return []
  }
  if (!Array.isArray(items)) {
    return []
  }

  const entries: PdfOutlineEntry[] = []
  const MAX_OUTLINE_ENTRIES = 500
  const visited = new Set<PdfOutlineItemLike>()

  const walk = async (list: PdfOutlineItemLike[], depth: number): Promise<void> => {
    for (const item of list) {
      if (!item || visited.has(item) || entries.length >= MAX_OUTLINE_ENTRIES) {
        continue
      }
      visited.add(item)
      const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : ''
      if (title && item.url == null) {
        const pageIndex = await resolveOutlinePageIndex(doc, item)
        if (pageIndex >= 0) {
          entries.push({ pageIndex, title, depth })
        }
      }
      if (Array.isArray(item.items) && item.items.length > 0) {
        await walk(item.items, depth + 1)
      }
    }
  }

  await walk(items, 0)
  return entries
}

const PRINTED_PAGE_NUMBER_RE = /^(?:\d{1,5}|[IVXLCDM]{1,8})[.)]?$/i
const PAGE_NUMBER_TOKEN_RE = /^(\d{1,5}|[IVXLCDM]{1,8})[.)]?$/i

/**
 * Separa o número impresso do texto do cabeçalho/rodapé. Números isolados
 * (incluindo romanos) são a forma mais fiável; também são aceites quando
 * surgem no início ou no fim da mesma linha do título corrente.
 */
export function extractHeaderMetadata(lines: TextLine[]): { physicalPageNumber?: string; title: string } {
  let physicalPageNumber: string | undefined
  const titleParts: string[] = []

  const rememberNumber = (value: string): void => {
    if (!physicalPageNumber) {
      physicalPageNumber = value.replace(/[.)]$/, '').toUpperCase()
    }
  }

  for (const line of lines) {
    let text = line.text.replace(/\s+/g, ' ').trim()
    if (!text) {
      continue
    }
    if (PRINTED_PAGE_NUMBER_RE.test(text)) {
      rememberNumber(text)
      continue
    }

    const leading = text.match(/^(\S+)(\s+)(.+)$/)
    if (leading && PAGE_NUMBER_TOKEN_RE.test(leading[1])) {
      rememberNumber(leading[1])
      text = leading[3]
    } else {
      const trailing = text.match(/^(.+?)(\s+)(\S+)$/)
      if (trailing && PAGE_NUMBER_TOKEN_RE.test(trailing[3])) {
        // "CAPÍTULO IV" e "PARTE II" são títulos, não números físicos.
        const titleEndsInSectionWord = /\b(?:cap[ií]tulo|chapter|parte|part|sec[cç][aã]o|section)$/i.test(trailing[1].trim())
        if (!titleEndsInSectionWord) {
          rememberNumber(trailing[3])
          text = trailing[1]
        }
      }
    }

    const title = text.replace(/^[\s|:;,.–—-]+|[\s|:;,.–—-]+$/g, '').trim()
    if (title) {
      titleParts.push(title)
    }
  }

  return {
    ...(physicalPageNumber ? { physicalPageNumber } : {}),
    title: titleParts.join(' ').replace(/\s+/g, ' ').trim()
  }
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
    const [imageOps, vectorOps] = await Promise.all([imageOpCodes(), vectorOpCodes()])

    for (let i = 0; i < pageCount; i++) {
      const page = await doc.getPage(i + 1)
      try {
        const textContent = await page.getTextContent({ includeMarkedContent: true })
        const items = textContent.items.filter(isTextItem)
        const viewport = page.getViewport({ scale: 1.0 })
        const headerY = viewport.height * 0.92
        const footerY = viewport.height * 0.06
        // As transformações dos itens de texto estão no sistema PDF (origem
        // no fundo): separam-se as zonas antes de agrupar as linhas para que
        // cabeçalhos/rodapés nunca cheguem ao fluxo do corpo.
        const headerItems = items.filter((item) => item.transform[5] >= headerY)
        const footerItems = items.filter((item) => item.transform[5] <= footerY)
        const bodyItems = items.filter((item) => item.transform[5] < headerY && item.transform[5] > footerY)
        const pageChars = bodyItems.reduce((acc, item) => acc + item.str.trim().length, 0)
        let logicalBodyOrder: number[] | undefined
        const hasMarkedContent = textContent.items.some((item) =>
          isObjectRecord(item) &&
          (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps' || item.type === 'endMarkedContent')
        )
        if (hasMarkedContent && typeof page.getStructTree === 'function') {
          try {
            const structureTree = await page.getStructTree()
            logicalBodyOrder = resolveTaggedTextItemOrder(textContent.items, structureTree, bodyItems) ?? undefined
          } catch {
            /* PDFs sem árvore estrutural válida seguem pela geometria */
          }
        }
        // Os operadores têm de vir ANTES da deteção de bold: só depois de
        // getOperatorList() é que as fontes estão carregadas em
        // page.commonObjs (com nomes como "TimesNewRomanPS-BoldMT").
        let hasImage = false
        let vectorCount = 0
        try {
          if (typeof page.getOperatorList === 'function') {
            const operatorList = await page.getOperatorList()
            const scan = scanPageVisuals(operatorList, imageOps, vectorOps)
            hasImage = scan.hasImage
            vectorCount = scan.vectorOps
          }
        } catch {
          /* assume sem visuais se a análise falhar */
        }
        const styles = (textContent as { styles?: Record<string, { fontFamily?: unknown } | undefined> }).styles ?? {}
        const boldFonts = collectBoldFontNames(page, items, styles)
        const headerLines = groupItemsIntoLines(headerItems, boldFonts)
        const footerLines = groupItemsIntoLines(footerItems, boldFonts)
        const lines = groupItemsIntoLines(bodyItems, boldFonts, logicalBodyOrder)
        const { physicalPageNumber: headerPageNumber, title: headerTitle } = extractHeaderMetadata(headerLines)
        const { physicalPageNumber: footerPageNumber } = extractHeaderMetadata(footerLines)
        const physicalPageNumber = headerPageNumber ?? footerPageNumber
        const bodyFontSize = dominantItemFontSize(bodyItems)
        totalChars += pageChars
        // Página com elementos visuais (imagem raster OU traçados vetoriais
        // — nada é descartado por ter o textContent vazio ou reduzido):
        //   • < 80 caracteres + visuais → mapa/gráfico/gravura: a página
        //     INTEIRA é rasterizada (imageOnly) e o texto disperso, lixo;
        //   • imagem raster com 80-400 caracteres de texto disperso (ex.:
        //     nomes de cidades num mapa raster): extrai as imagens, texto
        //     descartado. Páginas só com vetores mas texto denso (índices
        //     com pontilhado, tabelas) mantêm-se como texto normal.
        const hasVisual = hasImage || vectorCount >= MIN_VECTOR_OPS
        const sparse = pageChars < 80
        const imageOnly = hasVisual && sparse
        const illustration = imageOnly || (hasImage && pageChars < 400)
        pages.push({
          index: i,
          lines,
          physicalPageNumber,
          headerTitle,
          imageOnly,
          hasImage,
          hasVisual,
          illustration,
          sparse,
          bodyFontSize,
          height: viewport.height,
          width: viewport.width
        })
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

    const outline = await collectOutline(doc)

    return { mode, pageCount, pages, thumbnails, outline }
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}

const LINE_Y_TOLERANCE = 4

interface PositionedLayoutItem {
  input: PdfTextLayoutItem
  index: number
  x: number
  y: number
  left: number
  right: number
  width: number
  height: number
  fontSize: number
  direction: 'ltr' | 'rtl' | 'ttb'
}

interface BaselineBand {
  baseline: number
  items: PositionedLayoutItem[]
}

interface HorizontalGutter {
  left: number
  right: number
  center: number
}

interface BuiltTextLine {
  line: TextLine
  logicalRank: number
  sequence: number
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function normalizeDirection(dir: string | undefined): PositionedLayoutItem['direction'] {
  return dir === 'rtl' || dir === 'ttb' ? dir : 'ltr'
}

function prepareLayoutItems(items: readonly PdfTextLayoutItem[]): PositionedLayoutItem[] {
  const positioned: PositionedLayoutItem[] = []
  items.forEach((input, index) => {
    if (
      typeof input.str !== 'string' ||
      !input.str.trim() ||
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y)
    ) {
      return
    }
    const height = Number.isFinite(input.height) ? Math.abs(input.height as number) : 0
    const fontSize = Number.isFinite(input.fontSize) && input.fontSize > 0
      ? input.fontSize
      : height || 10
    const suppliedWidth = Number.isFinite(input.width) ? Math.abs(input.width as number) : 0
    // Width/height are supplied by PDF.js in ordinary text items; the estimate
    // is only a conservative fallback for synthetic or incomplete inputs.
    const width = suppliedWidth || Math.max(fontSize * 0.45, Array.from(input.str).length * fontSize * 0.5)
    positioned.push({
      input,
      index,
      x: input.x,
      y: input.y,
      left: input.x,
      right: input.x + width,
      width,
      height: height || fontSize,
      fontSize,
      direction: normalizeDirection(input.dir)
    })
  })
  return positioned
}

function baselineTolerance(a: PositionedLayoutItem, b: PositionedLayoutItem): number {
  // The 4-unit ceiling matches the former grouping tolerance; font dimensions
  // make it tighter for small text and absorb ordinary baseline drift.
  return Math.min(LINE_Y_TOLERANCE, Math.max(1.5, Math.min(a.height, b.height) * 0.32))
}

function makeBaselineBands(items: readonly PositionedLayoutItem[]): BaselineBand[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const bands: BaselineBand[] = []
  for (const item of sorted) {
    const current = bands[bands.length - 1]
    if (current && Math.abs(current.baseline - item.y) <= baselineTolerance(current.items[0], item)) {
      current.baseline = (current.baseline * current.items.length + item.y) / (current.items.length + 1)
      current.items.push(item)
    } else {
      bands.push({ baseline: item.y, items: [item] })
    }
  }
  return bands
}

function dominantDirection(items: readonly PositionedLayoutItem[]): PositionedLayoutItem['direction'] {
  let ltrWeight = 0
  let rtlWeight = 0
  let ttbWeight = 0
  for (const item of items) {
    const weight = item.input.str.trim().length
    if (item.direction === 'rtl') {
      rtlWeight += weight
    } else if (item.direction === 'ttb') {
      ttbWeight += weight
    } else {
      ltrWeight += weight
    }
  }
  if (ttbWeight > ltrWeight && ttbWeight > rtlWeight) {
    return 'ttb'
  }
  return rtlWeight > ltrWeight ? 'rtl' : 'ltr'
}

function validGutter(
  gutter: HorizontalGutter,
  ordinaryItems: readonly PositionedLayoutItem[],
  pageSpan: number,
  typicalFontSize: number
): boolean {
  const leftItems = ordinaryItems.filter((item) => item.right <= gutter.left + 0.5)
  const rightItems = ordinaryItems.filter((item) => item.left >= gutter.right - 0.5)
  // Three independent baselines on each side plus overlapping vertical spans
  // reject paragraph gaps, indents, and isolated side notes as columns.
  if (leftItems.length < 3 || rightItems.length < 3) {
    return false
  }
  const leftBands = makeBaselineBands(leftItems)
  const rightBands = makeBaselineBands(rightItems)
  if (leftBands.length < 3 || rightBands.length < 3) {
    return false
  }

  const leftMinY = leftItems.reduce((min, item) => Math.min(min, item.y), Infinity)
  const leftMaxY = leftItems.reduce((max, item) => Math.max(max, item.y), -Infinity)
  const rightMinY = rightItems.reduce((min, item) => Math.min(min, item.y), Infinity)
  const rightMaxY = rightItems.reduce((max, item) => Math.max(max, item.y), -Infinity)
  const leftSpan = leftMaxY - leftMinY
  const rightSpan = rightMaxY - rightMinY
  const minimumSpan = Math.max(typicalFontSize * 1.5, pageSpan * 0.22)
  if (leftSpan < minimumSpan || rightSpan < minimumSpan) {
    return false
  }
  const overlap = Math.min(leftMaxY, rightMaxY) - Math.max(leftMinY, rightMinY)
  return overlap >= Math.max(typicalFontSize * 1.25, Math.min(leftSpan, rightSpan) * 0.3)
}

function detectHorizontalGutters(items: readonly PositionedLayoutItem[]): HorizontalGutter[] {
  // A split is considered only for a wide, persistent blank projection. The
  // width and support thresholds intentionally prefer a missed split over an
  // arbitrary split of a normal one-column paragraph.
  if (items.length < 6) {
    return []
  }
  const contentLeft = items.reduce((min, item) => Math.min(min, item.left), Infinity)
  const contentRight = items.reduce((max, item) => Math.max(max, item.right), -Infinity)
  const contentWidth = contentRight - contentLeft
  if (!(contentWidth > 0)) {
    return []
  }

  const typicalFontSize = median(items.map((item) => item.fontSize)) || 10
  const typicalWidth = median(items.map((item) => item.width)) || typicalFontSize
  // Items at least 62% of the content span and 1.65x a typical item are
  // treated as possible full-width headings, not evidence for a column edge.
  const wideItemThreshold = Math.max(contentWidth * 0.62, typicalWidth * 1.65, typicalFontSize * 8)
  const ordinaryItems = items.filter((item) => item.width < wideItemThreshold)
  if (ordinaryItems.length < 6) {
    return []
  }

  const intervals = [...ordinaryItems].sort((a, b) => a.left - b.left || a.right - b.right)
  const mergeDistance = Math.max(4, typicalFontSize * 0.65)
  // A gutter must be at least 18 PDF units, 1.8 font sizes, or 2.5% of the
  // content width; then validGutter requires three baselines and vertical overlap.
  const minimumGap = Math.max(18, typicalFontSize * 1.8, contentWidth * 0.025)
  const projectedGaps: HorizontalGutter[] = []
  let runRight = intervals[0].right
  for (let i = 1; i < intervals.length; i++) {
    const interval = intervals[i]
    const gapWidth = interval.left - runRight
    if (gapWidth > mergeDistance) {
      if (gapWidth >= minimumGap) {
        projectedGaps.push({ left: runRight, right: interval.left, center: (runRight + interval.left) / 2 })
      }
      runRight = interval.right
    } else {
      runRight = Math.max(runRight, interval.right)
    }
  }

  const minY = ordinaryItems.reduce((min, item) => Math.min(min, item.y), Infinity)
  const maxY = ordinaryItems.reduce((max, item) => Math.max(max, item.y), -Infinity)
  const pageSpan = maxY - minY
  return projectedGaps.filter((gutter) =>
    validGutter(gutter, ordinaryItems, pageSpan, typicalFontSize)
  )
}

function logicalRanksForItems(
  items: readonly PositionedLayoutItem[],
  logicalOrder: readonly number[] | undefined
): Map<number, number> | null {
  if (!logicalOrder || logicalOrder.length !== items.length) {
    return null
  }
  const validIndexes = new Set(items.map((item) => item.index))
  const ranks = new Map<number, number>()
  logicalOrder.forEach((index, rank) => {
    if (!validIndexes.has(index) || ranks.has(index)) {
      ranks.clear()
      return
    }
    ranks.set(index, rank)
  })
  return ranks.size === items.length ? ranks : null
}

function buildLineFromParts(parts: readonly PositionedLayoutItem[]): TextLine | null {
  if (parts.length === 0) {
    return null
  }
  let text = ''
  let previous: PositionedLayoutItem | null = null
  let fontSize = 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let boldChars = 0
  let totalChars = 0

  for (const part of parts) {
    const str = part.input.str
    const charCount = str.trim().length
    if (part.input.bold) {
      boldChars += charCount
    }
    totalChars += charCount
    if (text) {
      const centerGap = Math.abs((part.left + part.right) / 2 - ((previous?.left ?? 0) + (previous?.right ?? 0)) / 2)
        - (part.width + (previous?.width ?? 0)) / 2
      const needsSpace = centerGap > Math.max(1, part.fontSize * 0.18) && !/\s$/.test(text) && !/^\s/.test(str)
      text += (needsSpace ? ' ' : '') + str
    } else {
      text = str
    }
    previous = part
    fontSize = Math.max(fontSize, part.fontSize)
    minX = Math.min(minX, part.left)
    maxX = Math.max(maxX, part.right)
    minY = Math.min(minY, part.y)
    maxY = Math.max(maxY, part.y)
  }

  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) {
    return null
  }
  const bold = totalChars > 0 && boldChars / totalChars >= 0.6
  return {
    text: cleaned,
    x: minX,
    y: (minY + maxY) / 2,
    fontSize: Number(fontSize.toFixed(1)),
    width: Math.max(0, maxX - minX),
    ...(bold ? { bold: true } : {})
  }
}

function buildLinesFromBand(
  items: readonly PositionedLayoutItem[],
  logicalRanks: Map<number, number> | null,
  firstSequence: number
): BuiltTextLine[] {
  if (items.length === 0) {
    return []
  }
  const direction = dominantDirection(items)
  const ordered = [...items].sort((a, b) => {
    if (logicalRanks) {
      return (logicalRanks.get(a.index) ?? Infinity) - (logicalRanks.get(b.index) ?? Infinity)
    }
    return direction === 'ltr' ? a.left - b.left || b.y - a.y : b.right - a.right || b.y - a.y
  })

  const chunks: PositionedLayoutItem[][] = []
  let current: PositionedLayoutItem[] = []
  for (const item of ordered) {
    // PDF.js hasEOL is a line terminator only; it never starts a paragraph.
    if (current.length > 0 && current[current.length - 1].input.hasEOL === true) {
      chunks.push(current)
      current = []
    }
    current.push(item)
  }
  if (current.length > 0) {
    chunks.push(current)
  }

  const lines: BuiltTextLine[] = []
  chunks.forEach((parts, index) => {
    const line = buildLineFromParts(parts)
    if (!line) {
      return
    }
    const logicalRank = logicalRanks
      ? parts.reduce((rank, part) => Math.min(rank, logicalRanks.get(part.index) ?? Infinity), Infinity)
      : Infinity
    lines.push({ line, logicalRank, sequence: firstSequence + index })
  })
  return lines
}

/**
 * Pure spatial text layout, exported so column/line ordering can be exercised
 * with synthetic PDF.js-like items. A complete tagged permutation wins; if
 * absent, geometry uses top-to-bottom bands and column-wise reading order.
 */
export function layoutPdfTextItems(
  items: readonly PdfTextLayoutItem[],
  options: PdfTextLayoutOptions = {}
): TextLine[] {
  const positioned = prepareLayoutItems(items)
  if (positioned.length === 0) {
    return []
  }
  const logicalRanks = logicalRanksForItems(positioned, options.logicalOrder)
  const gutters = detectHorizontalGutters(positioned)
  const pageDirection = dominantDirection(positioned)
  const bands = makeBaselineBands(positioned)
  const builtLines: BuiltTextLine[] = []
  let sequence = 0
  let pendingBands: BaselineBand[] = []

  const appendItems = (bandItems: readonly PositionedLayoutItem[]): void => {
    const lines = buildLinesFromBand(bandItems, logicalRanks, sequence)
    builtLines.push(...lines)
    sequence += lines.length
  }

  const appendBand = (band: BaselineBand, regionIndex?: number): void => {
    const bandItems = regionIndex === undefined
      ? band.items
      : band.items.filter((item) => {
          let itemRegion = 0
          for (const gutter of gutters) {
            if (item.left < gutter.center && item.right > gutter.center) {
              return false
            }
            if ((item.left + item.right) / 2 >= gutter.center) {
              itemRegion++
            }
          }
          return itemRegion === regionIndex
        })
    appendItems(bandItems)
  }

  const flushPendingBands = (): void => {
    if (pendingBands.length === 0) {
      return
    }
    const regionCount = gutters.length + 1
    const regionOrder = Array.from({ length: regionCount }, (_, index) => index)
    if (pageDirection !== 'ltr') {
      regionOrder.reverse()
    }
    // Once a page has a supported gutter, finish each region top-to-bottom
    // before moving horizontally to the next; this avoids row-wise columns.
    for (const regionIndex of regionOrder) {
      for (const band of pendingBands) {
        appendBand(band, regionIndex)
      }
    }
    pendingBands = []
  }

  for (const band of bands) {
    const spanningItems = band.items.filter((item) =>
      gutters.some((gutter) => item.left < gutter.center && item.right > gutter.center)
    )
    if (spanningItems.length > 0) {
      // Full-width text is a visual separator between column regions.
      flushPendingBands()
      appendItems(spanningItems)
      const sameBaselineColumnItems = band.items.filter((item) => !spanningItems.includes(item))
      if (sameBaselineColumnItems.length > 0) {
        const regionOrder = Array.from({ length: gutters.length + 1 }, (_, index) => index)
        if (pageDirection !== 'ltr') {
          regionOrder.reverse()
        }
        const remainderBand = { baseline: band.baseline, items: sameBaselineColumnItems }
        for (const regionIndex of regionOrder) {
          appendBand(remainderBand, regionIndex)
        }
      }
    } else {
      pendingBands.push(band)
    }
  }
  flushPendingBands()

  if (logicalRanks) {
    builtLines.sort((a, b) => a.logicalRank - b.logicalRank || a.sequence - b.sequence)
  }
  return builtLines.map(({ line }) => line)
}

function groupItemsIntoLines(
  items: PdfTextItem[],
  boldFonts: Set<string> = new Set(),
  logicalOrder?: readonly number[]
): TextLine[] {
  const layoutItems = items.map((item): PdfTextLayoutItem => ({
    str: item.str,
    x: item.transform[4],
    y: item.transform[5],
    fontSize: Math.hypot(item.transform[2], item.transform[3]),
    width: item.width,
    height: item.height,
    dir: item.dir,
    hasEOL: item.hasEOL,
    bold: item.fontName != null && boldFonts.has(item.fontName)
  }))
  return layoutPdfTextItems(layoutItems, { logicalOrder })
}

/** Imagem decodificada como a entrega o pdf.js (display-ready). */
interface PdfImageDataLike {
  width?: unknown
  height?: unknown
  kind?: unknown
  data?: unknown
}

// ImageKind do pdf.js
const IMAGE_KIND_GRAYSCALE_1BPP = 1
const IMAGE_KIND_RGB_24BPP = 2
const IMAGE_KIND_RGBA_32BPP = 3

/** Dimensão mínima para considerar uma imagem como conteúdo real (exclui
 * bullets e ornamentos). */
const MIN_IMAGE_SIDE = 16
const MAX_IMAGES_PER_PAGE = 12

function imageDataToPng(imgData: PdfImageDataLike, canvasModule: any): Buffer | null {
  const width = typeof imgData.width === 'number' ? imgData.width : 0
  const height = typeof imgData.height === 'number' ? imgData.height : 0
  const kind = typeof imgData.kind === 'number' ? imgData.kind : -1
  const data = imgData.data as Uint8Array | Uint8ClampedArray | undefined
  if (width <= 0 || height <= 0 || !data || data.length === 0) {
    return null
  }

  const rgba = new Uint8ClampedArray(width * height * 4)

  if (kind === IMAGE_KIND_RGB_24BPP) {
    if (data.length < width * height * 3) {
      return null
    }
    for (let src = 0, dst = 0; src < width * height * 3; src += 3, dst += 4) {
      rgba[dst] = data[src]
      rgba[dst + 1] = data[src + 1]
      rgba[dst + 2] = data[src + 2]
      rgba[dst + 3] = 255
    }
  } else if (kind === IMAGE_KIND_RGBA_32BPP) {
    if (data.length < width * height * 4) {
      return null
    }
    rgba.set(data.subarray(0, width * height * 4))
  } else if (kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    // 1 bit/pixel: bit 0 = preto, bit 1 = branco; linhas alinhadas a byte.
    const rowBytes = (width + 7) >> 3
    if (data.length < rowBytes * height) {
      return null
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const value = bit ? 255 : 0
        const dst = (y * width + x) * 4
        rgba[dst] = value
        rgba[dst + 1] = value
        rgba[dst + 2] = value
        rgba[dst + 3] = 255
      }
    }
  } else {
    return null
  }

  try {
    const canvas = canvasModule.createCanvas(width, height)
    const context = canvas.getContext('2d')
    const imageData = context.createImageData(width, height)
    imageData.data.set(rgba)
    context.putImageData(imageData, 0, 0)
    return canvas.toBuffer('image/png')
  } catch {
    return null
  }
}

function lookupPdfObject(
  page: PdfPageLike,
  objId: string
): PdfImageDataLike | null {
  const store = objId.startsWith('g_') ? page.commonObjs : page.objs
  if (!store || typeof store.has !== 'function' || typeof store.get !== 'function') {
    return null
  }
  try {
    if (!store.has(objId)) {
      return null
    }
    return store.get(objId) as PdfImageDataLike
  } catch {
    return null
  }
}

/**
 * Extrai as imagens da página (XObjects de imagem, image masks e imagens
 * inline) pela ordem de desenho, INDEPENDENTEMENTE de existir texto na
 * página. Depois de getOperatorList() o pdf.js entrega os pixéis já
 * descodificados em page.objs / page.commonObjs, ou inline nos args do
 * operador (masks e inline images).
 */
export async function extractPageImages(
  doc: PdfDocumentLike,
  pageIndex: number
): Promise<PdfPageImage[]> {
  const page = await doc.getPage(pageIndex + 1)
  try {
    if (typeof page.getOperatorList !== 'function') {
      return []
    }
    const operatorList = await page.getOperatorList()
    const { fnArray, argsArray } = operatorList
    if (!fnArray || !argsArray) {
      return []
    }

    const canvasModule = await loadCanvasModule()
    if (!canvasModule) {
      return []
    }

    const images: PdfPageImage[] = []
    const seenObjIds = new Set<string>()
    const seenData = new Set<PdfImageDataLike>()

    const pushImage = (imgData: PdfImageDataLike, { forceMask = false, objId = null }: { forceMask?: boolean; objId?: string | null } = {}): void => {
      if (objId) {
        if (seenObjIds.has(objId)) {
          return
        }
        seenObjIds.add(objId)
      } else {
        if (seenData.has(imgData)) {
          return
        }
        seenData.add(imgData)
      }

      const normalized: PdfImageDataLike = forceMask
        ? { ...imgData, kind: IMAGE_KIND_GRAYSCALE_1BPP }
        : imgData

      const width = typeof normalized.width === 'number' ? normalized.width : 0
      const height = typeof normalized.height === 'number' ? normalized.height : 0
      if (Math.min(width, height) < MIN_IMAGE_SIDE) {
        return
      }
      if (images.length >= MAX_IMAGES_PER_PAGE) {
        return
      }
      const buffer = imageDataToPng(normalized, canvasModule)
      if (!buffer) {
        return
      }
      images.push({ id: `page-${pageIndex}-img-${images.length}`, buffer, ext: 'png', width, height })
    }

    const pushFromValue = (value: unknown, forceMask = false, objId: string | null = null): void => {
      if (!value || typeof value !== 'object') {
        return
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushFromValue(entry, forceMask)
        }
        return
      }
      pushImage(value as PdfImageDataLike, { forceMask, objId })
    }

    for (let i = 0; i < Math.min(fnArray.length, OPS_PER_IMAGE_SCAN); i++) {
      const fn = fnArray[i]
      const args = argsArray[i] as unknown[] | undefined
      if (!Array.isArray(args)) {
        continue
      }
      switch (fn) {
        case 85: // paintImageXObject
        case 88: {
          // paintImageXObjectRepeat — dados em page.objs / page.commonObjs
          const objId = typeof args[0] === 'string' ? args[0] : null
          if (objId) {
            const imgData = lookupPdfObject(page, objId)
            if (imgData) {
              pushImage(imgData, { objId })
            }
          }
          break
        }
        case 86: {
          // paintInlineImageXObject — imgData vem nos próprios args
          pushFromValue(args[0])
          break
        }
        case 87: {
          // paintInlineImageXObjectGroup — args[0] é a lista de imagens
          pushFromValue(args[0])
          break
        }
        case 83: // paintImageMaskXObject
        case 89: {
          // paintImageMaskXObjectRepeat — mask (1bpp) vem nos args
          pushFromValue(args[0], true)
          break
        }
        case 84: {
          // paintImageMaskXObjectGroup — args[0] é a lista de masks
          pushFromValue(args[0], true)
          break
        }
        default:
          break
      }
    }

    return images
  } finally {
    try {
      page.cleanup()
    } catch {
      /* página pode já ter sido limpa */
    }
  }
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
