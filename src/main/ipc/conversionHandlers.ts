import * as fs from 'node:fs'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Dialog, IpcMain, WebContents } from 'electron'
import type {
  ConversionMetadata,
  ConversionOptions,
  ConversionRequestMessage,
  ConversionStartResult,
  WorkerOutgoingMessage
} from '../types'

let currentWorker: Worker | null = null

function compiledWorkerCandidates(): string[] {
  return [
    path.join(__dirname, 'workers', 'conversion.worker.js'),
    path.join(__dirname, '..', 'workers', 'conversion.worker.js'),
    path.join(__dirname, '..', '..', 'workers', 'conversion.worker.js')
  ]
}

function sourceWorkerCandidates(): string[] {
  return [
    path.join(__dirname, '..', '..', 'src', 'main', 'workers', 'conversion.worker.ts'),
    path.join(__dirname, '..', '..', '..', 'src', 'main', 'workers', 'conversion.worker.ts')
  ]
}

function resolveWorkerPath(): string {
  for (const candidate of compiledWorkerCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  for (const candidate of sourceWorkerCandidates()) {
    if (!fs.existsSync(candidate)) {
      continue
    }
    try {
      require.resolve('ts-node/register/transpile-only')
      return candidate
    } catch {
      break
    }
  }

  const compiled = compiledWorkerCandidates()[0]
  throw new Error(
    `Worker de conversão não encontrado: ${compiled}. Corre "npm run build" ou "npm run dev" para o compilar.`
  )
}

function spawnConversionWorker(payload: ConversionRequestMessage, sender: WebContents): Worker {
  const workerPath = resolveWorkerPath()
  const isTypeScript = workerPath.endsWith('.ts')

  const worker = isTypeScript
    ? new Worker(workerPath, { execArgv: ['--require', 'ts-node/register/transpile-only'] })
    : new Worker(workerPath)

  let reportedError = false

  worker.on('message', (message: WorkerOutgoingMessage) => {
    if (!message || typeof message !== 'object' || sender.isDestroyed()) {
      return
    }
    if (message.type === 'progress') {
      sender.send('conversion-progress', { stage: message.stage, percent: message.percent })
    } else if (message.type === 'done') {
      sender.send('conversion-done', { outputPath: message.outputPath })
    } else if (message.type === 'error') {
      reportedError = true
      sender.send('conversion-error', { message: message.message })
    }
  })

  worker.on('error', (error) => {
    reportedError = true
    if (!sender.isDestroyed()) {
      sender.send('conversion-error', { message: error.message })
    }
  })

  worker.on('exit', (code) => {
    if (currentWorker === worker) {
      currentWorker = null
    }
    if (code !== 0 && !reportedError && !sender.isDestroyed()) {
      sender.send('conversion-error', {
        message: `A conversão terminou inesperadamente (código ${code}).`
      })
    }
  })

  return worker
}

export async function showOpenPdfDialog(dialog: Dialog): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function showOpenCoverDialog(dialog: Dialog): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function showSaveEpubDialog(dialog: Dialog, defaultName?: string): Promise<string | null> {
  const fallback = typeof defaultName === 'string' && defaultName.trim() ? defaultName.trim() : 'livro'
  const result = await dialog.showSaveDialog({
    defaultPath: /\.epub$/i.test(fallback) ? fallback : `${fallback}.epub`,
    filters: [{ name: 'EPUB', extensions: ['epub'] }]
  })
  if (result.canceled || !result.filePath) {
    return null
  }
  return result.filePath
}

export function registerConversionHandlers(ipcMain: IpcMain, dialog: Dialog): void {
  ipcMain.handle('select-file', async () => {
    const filePath = await showOpenPdfDialog(dialog)
    if (!filePath) return null
    const stat = await fs.promises.stat(filePath)
    return { path: filePath, name: path.basename(filePath), size: stat.size }
  })

  ipcMain.handle('select-cover', async () => {
    const filePath = await showOpenCoverDialog(dialog)
    if (!filePath) return null
    return { path: filePath, name: path.basename(filePath) }
  })

  ipcMain.handle('read-image', (_event, filePath?: string): Promise<Buffer> => {
    if (!filePath || typeof filePath !== 'string') {
      return Promise.reject(new Error('Caminho de imagem inválido.'))
    }
    return fs.promises.readFile(filePath)
  })

  ipcMain.handle('read-pdf', (_event, filePath?: string): Promise<Buffer> => {
    if (!filePath || typeof filePath !== 'string') {
      return Promise.reject(new Error('Caminho de PDF inválido.'))
    }
    return fs.promises.readFile(filePath)
  })

  ipcMain.handle('save-epub', async (_event, defaultName?: string) => showSaveEpubDialog(dialog, defaultName))

  ipcMain.handle(
    'start-conversion',
    async (
      event,
      payload?: { filePath?: string; metadata?: ConversionMetadata; options?: ConversionOptions }
    ): Promise<ConversionStartResult> => {
      const filePath = payload?.filePath
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'Nenhum ficheiro PDF selecionado.' }
      }

      let outPath = payload?.options?.outPath ?? ''
      if (!outPath) {
        const suggested = payload?.metadata?.title?.trim() || path.basename(filePath).replace(/\.pdf$/i, '')
        const chosen = await showSaveEpubDialog(dialog, suggested)
        if (!chosen) {
          return { ok: false, canceled: true }
        }
        outPath = chosen
      }

      if (currentWorker) {
        currentWorker.removeAllListeners()
        await currentWorker.terminate().catch(() => undefined)
        currentWorker = null
      }

      const request: ConversionRequestMessage = {
        type: 'convert',
        filePath,
        outPath,
        metadata: payload?.metadata ?? {},
        options: payload?.options ?? {}
      }

      try {
        const worker = spawnConversionWorker(request, event.sender)
        currentWorker = worker
        worker.postMessage(request)
        return { ok: true, outPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!event.sender.isDestroyed()) {
          event.sender.send('conversion-error', { message })
        }
        return { ok: false, error: message }
      }
    }
  )
}

export function stopCurrentConversion(): void {
  const worker = currentWorker
  currentWorker = null
  if (worker) {
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }
}
