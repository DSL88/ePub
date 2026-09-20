import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { loadCanvasModule } from './canvasLoader'
import type { PdfDocumentLike } from './pdfInspector'

const execFileAsync = promisify(execFile)

const OCR_TIMEOUT_MS = 5 * 60 * 1000

export type OcrLanguage = 'por'

export async function runOcr(imageBuffer: Buffer, lang: OcrLanguage = 'por'): Promise<string> {
  const token = randomBytes(8).toString('hex')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `epub-ocr-${token}-`))
  const imagePath = path.join(dir, `page-${token}.png`)
  const outputBase = path.join(dir, `ocr-${token}`)

  try {
    await fsp.writeFile(imagePath, imageBuffer)

    try {
      await execFileAsync(
        'tesseract',
        [imagePath, outputBase, '-l', lang, '--psm', '3'],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
      )
    } catch (error) {
      throw translateOcrError(error, lang)
    }

    const textPath = `${outputBase}.txt`
    return await fsp.readFile(textPath, 'utf8')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
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
