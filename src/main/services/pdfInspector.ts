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
  getTextContent(): Promise<{ items: unknown[] }>
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
        const textContent = await page.getTextContent()
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
        const lines = groupItemsIntoLines(bodyItems, boldFonts)
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

function groupItemsIntoLines(items: PdfTextItem[], boldFonts: Set<string> = new Set()): TextLine[] {
  // Ordem de leitura natural: primeiro de cima para baixo (Y decrescente no
  // sistema de coordenadas do PDF) e depois da esquerda para a direita (X
  // crescente). Os itens de texto chegam do pdf.js pela ordem do content
  // stream, que não corresponde à ordem visual — daí a ordenação espacial
  // antes de qualquer agrupamento.
  const positioned = items
    .map((item) => ({
      item,
      x: item.transform[4],
      y: item.transform[5],
      fontSize: Math.hypot(item.transform[2], item.transform[3])
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)

  interface Group {
    baseline: number
    count: number
    parts: typeof positioned
  }

  // Agrupa itens da mesma linha visual: um item entra no grupo quando está
  // a <= LINE_Y_TOLERANCE do baseline médio do grupo (tolerância ~3-5px para
  // elementos na mesma linha). O baseline médio absorve o drift gradual de
  // y dentro da mesma linha sem partir a linha ao meio.
  const groups: Group[] = []
  for (const part of positioned) {
    if (!part.item.str.trim()) {
      continue
    }
    const current = groups[groups.length - 1]
    if (current && current.baseline - part.y <= LINE_Y_TOLERANCE) {
      current.baseline = (current.baseline * current.count + part.y) / (current.count + 1)
      current.count += 1
      current.parts.push(part)
    } else {
      groups.push({ baseline: part.y, count: 1, parts: [part] })
    }
  }

  const lines: TextLine[] = []
  for (const group of groups) {
    const parts = [...group.parts].sort((a, b) => a.x - b.x)
    // Análise de estilo ANTES de qualquer concatenação: a flag de negrito de
    // cada item (via fontName) é calculada isoladamente, para não ser
    // contaminada pelo texto já unido da linha.
    const itemStyles = parts.map((part) => ({
      bold: part.item.fontName != null && boldFonts.has(part.item.fontName),
      charCount: part.item.str.trim().length
    }))
    let text = ''
    let prevEndX: number | null = null
    let fontSize = 0
    let minX = Infinity
    let maxX = -Infinity
    let boldChars = 0
    let totalChars = 0

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const str = part.item.str
      if (itemStyles[i].bold) {
        boldChars += itemStyles[i].charCount
      }
      totalChars += itemStyles[i].charCount
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
      maxX = Math.max(maxX, prevEndX)
    }

    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) {
      continue
    }
    // A linha é "bold" quando a maioria dos caracteres visíveis usa fonte
    // negrito (subtítulos destacados em peso, não apenas tamanho).
    const bold = totalChars > 0 && boldChars / totalChars >= 0.6
    lines.push({
      text: cleaned,
      x: minX,
      y: group.baseline,
      fontSize: Number(fontSize.toFixed(1)),
      width: Math.max(0, maxX - minX),
      ...(bold ? { bold: true } : {})
    })
  }

  // As linhas já saem em ordem de leitura pela construção; a ordenação final
  // é uma salvaguarda contra desempates instáveis do agrupamento.
  return lines.sort((a, b) => b.y - a.y || a.x - b.x)
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
