import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { ExtractionPreview, PageOcrResult } from '../renderer/src/types'

type Unsubscribe = () => void

function subscribe<T>(
  channel: string,
  cb: (data: T) => void
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, data: T): void => {
    cb(data)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const converterAPI = {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  selectFile: (): Promise<{ path: string; name: string; size: number } | null> =>
    ipcRenderer.invoke('select-file'),
  readPdf: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('read-pdf', filePath),
  readImage: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('read-image', filePath),
  previewExtraction: (filePath: string, requestId: string): Promise<ExtractionPreview> =>
    ipcRenderer.invoke('preview-extraction', { filePath, requestId }),
  cancelExtractionPreview: (requestId: string): Promise<void> =>
    ipcRenderer.invoke('cancel-extraction-preview', requestId),
  previewPageOcr: (filePath: string, pageIndex: number, psm?: string): Promise<PageOcrResult> =>
    ipcRenderer.invoke('preview-page-ocr', { filePath, pageIndex, psm }),
  selectCover: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('select-cover'),
  saveEpub: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('save-epub', defaultName),
  startConversion: (payload: {
    filePath: string
    metadata: { title: string; author: string; language: string; coverPath?: string }
    options: Record<string, unknown>
  }): Promise<unknown> => ipcRenderer.invoke('start-conversion', payload),
  onProgress: (
    cb: (data: { stage: string; percent: number }) => void
  ): Unsubscribe => subscribe('conversion-progress', cb),
  onDone: (
    cb: (data: { outputPath: string }) => void
  ): Unsubscribe => subscribe('conversion-done', cb),
  onError: (
    cb: (data: { message: string }) => void
  ): Unsubscribe => subscribe('conversion-error', cb)
}

export type ConverterAPI = typeof converterAPI

contextBridge.exposeInMainWorld('converterAPI', converterAPI)
