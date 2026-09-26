import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { loadCanvasModule } from './canvasLoader'
import type { PdfDocumentLike, TextLine } from './pdfInspector'

const execFileAsync = promisify(execFile)

const OCR_TIMEOUT_MS = 5 * 60 * 1000

export type OcrLanguage = 'por'

/** Modos de segmentação do Tesseract oferecidos na UI: 3 = automático,
 * 6 = bloco uniforme de texto (apanha linhas de borda que o 3 corta). */
export const OCR_PSM_MODES = ['3', '6'] as const
export type OcrPsm = (typeof OCR_PSM_MODES)[number]

export function normalizeOcrPsm(value: unknown): OcrPsm {
  return value === '6' ? '6' : '3'
}

/** Resultado do OCR: texto em linhas + confiança média das palavras (0-100).
 * A confiança distingue páginas bem digitalizadas (>90) de páginas
 * estilizadas/mapas/rasterizações pobres (<60), que devem ser renderizadas
 * como imagem e não como texto. */
export interface OcrResult {
  text: string
  meanConfidence: number
  /** linhas com coordenadas convertidas para unidades PDF */
  lines: TextLine[]
}

export async function runOcr(
  imageBuffer: Buffer,
  lang: OcrLanguage = 'por',
  pixelToPdfScale = 1,
  psm: unknown = '3'
): Promise<OcrResult> {
  const token = randomBytes(8).toString('hex')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `epub-ocr-${token}-`))
  const imagePath = path.join(dir, `page-${token}.png`)
  const mode = normalizeOcrPsm(psm)

  try {
    await fsp.writeFile(imagePath, imageBuffer)

    try {
      // O TSV (em vez do .txt) traz a confiança de cada palavra; o texto é
      // reconstruído a partir dele, numa única passagem.
      const { stdout } = await execFileAsync(
        'tesseract',
        [imagePath, 'stdout', '-l', lang, '--psm', mode, 'tsv'],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
      )
      return parseTesseractTsv(stdout, pixelToPdfScale)
    } catch (error) {
      throw translateOcrError(error, lang)
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface TesseractWordRow {
  lineKey: string
  parKey: string
  word: string
  confidence: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * Reconstrói o texto a partir do TSV do tesseract (nível 5 = palavra),
 * preservando linhas e parágrafos (mudança de par → linha em branco) e
 * calculando a confiança média das palavras reconhecidas.
 */
export function parseTesseractTsv(tsv: string, coordinateScale = 1): OcrResult {
  const rows = tsv.split(/\r?\n/)
  const words: TesseractWordRow[] = []
  let imageHeight = 0
  for (const raw of rows.slice(1)) {
    const cols = raw.split('\t')
    if (cols.length < 12) {
      continue
    }
    const [level, , block, par, line] = cols
    if (level === '1') {
      imageHeight = Number(cols[9]) || imageHeight
      continue
    }
    if (level !== '5') {
      continue
    }
    const word = (cols[11] ?? '').trim()
    if (!word) {
      continue
    }
    const confidence = Number(cols[10])
    words.push({
      lineKey: `${block}:${par}:${line}`,
      parKey: `${block}:${par}`,
      word,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      left: Number(cols[6]) || 0,
      top: Number(cols[7]) || 0,
      width: Number(cols[8]) || 0,
      height: Number(cols[9]) || 0
    })
  }
  if (imageHeight <= 0) {
    imageHeight = words.reduce((height, word) => Math.max(height, word.top + word.height), 0)
  }

  const parts: string[] = []
  const lines: TextLine[] = []
  let current: TesseractWordRow[] = []
  let lastParKey: string | null = null
  let lastLineKey: string | null = null

  const flushLine = (): void => {
    if (current.length > 0) {
      const text = current.map((entry) => entry.word).join(' ')
      const minTop = Math.min(...current.map((entry) => entry.top))
      const maxBottom = Math.max(...current.map((entry) => entry.top + entry.height))
      const x = Math.min(...current.map((entry) => entry.left))
      const maxRight = Math.max(...current.map((entry) => entry.left + entry.width))
      parts.push(text)
      lines.push({
        text,
        x: x * coordinateScale,
        width: Math.max(0, maxRight - x) * coordinateScale,
        // O Tesseract mede top a partir do topo da imagem; TextLine.y usa a
        // origem PDF no fundo da página.
        y: Math.max(0, imageHeight - maxBottom) * coordinateScale,
        fontSize: Math.max(0, maxBottom - minTop) * coordinateScale
      })
      current = []
    }
  }

  for (const entry of words) {
    if (lastParKey !== null && entry.parKey !== lastParKey) {
      flushLine()
      parts.push('')
      const previousY = lines[lines.length - 1]?.y ?? 0
      const nextY = Math.max(0, imageHeight - (entry.top + entry.height)) * coordinateScale
      lines.push({ text: '', x: 0, y: (previousY + nextY) / 2, fontSize: 0 })
    } else if (lastLineKey !== null && entry.lineKey !== lastLineKey) {
      flushLine()
    }
    current.push(entry)
    lastParKey = entry.parKey
    lastLineKey = entry.lineKey
  }
  flushLine()

  const confidences = words.map((entry) => entry.confidence)
  const meanConfidence = confidences.length > 0
    ? confidences.reduce((acc, value) => acc + value, 0) / confidences.length
    : 0

  return { text: parts.join('\n'), meanConfidence, lines }
}

function translateOcrError(error: unknown, lang: OcrLanguage): Error {
  const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }

  if (err?.code === 'ENOENT') {
    return new Error(
      'Tesseract OCR não encontrado. Instala: brew install tesseract (macOS) ou apt install tesseract-ocr tesseract-ocr-por (Linux)'
    )
  }
  if (err?.killed) {
    return new Error('O OCR excedeu o tempo limite (5 min por página).')
  }

  const stderr = err?.stderr ?? ''
  if (/Failed loading language|Error opening data file|Tesseract didn't detect any text/i.test(stderr)) {
    return new Error(
      `Pacote de idioma "${lang}" do Tesseract indisponível. Instala: brew install tesseract-lang (macOS) ou apt install tesseract-ocr-${lang} (Linux)`
    )
  }

  return err instanceof Error ? err : new Error(String(err))
}

export async function renderPageToImage(
  pdfDoc: PdfDocumentLike,
  pageIndex: number,
  dpi = 200
): Promise<Buffer> {
  const canvasModule = await loadCanvasModule()
  if (!canvasModule) {
    throw new Error('renderização de página indisponível — instala @napi-rs/canvas')
  }

  const page = await pdfDoc.getPage(pageIndex + 1)
  try {
    const viewport = page.getViewport({ scale: dpi / 72 })
    const canvas = canvasModule.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    // pdf.js page.render() returns a RenderTask (not a Promise); the rendered
    // canvas is only valid once task.promise resolves.
    const task = page.render({ canvasContext: context, viewport }) as { promise?: Promise<void> } | void
    await task?.promise
    return canvas.toBuffer('image/png')
  } finally {
    try {
      page.cleanup()
    } catch {
      /* página pode já ter sido limpa */
    }
  }
}
