export interface Metadata {
  title: string
  author: string
  language: string
  coverPath?: string
}

export interface ConversionProgress {
  stage: string
  percent: number
}

export interface ChapterMark {
  /** 1-based indices of pages that start a chapter */
  pageIndices: number[]
}

export interface ConverterAPI {
  getPathForFile: (file: File) => string
  selectFile: () => Promise<{ path: string; name: string; size: number } | null>
  readPdf: (filePath: string) => Promise<Uint8Array>
  readImage: (filePath: string) => Promise<Uint8Array>
  selectCover: () => Promise<{ path: string; name: string } | null>
  saveEpub: (defaultName: string) => Promise<string | null>
  startConversion: (payload: {
    filePath: string
    metadata: Metadata
    options: Record<string, unknown>
  }) => Promise<unknown>
  onProgress: (
    cb: (data: { stage: string; percent: number }) => void
  ) => () => void
  onDone: (cb: (data: { outputPath: string }) => void) => () => void
  onError: (cb: (data: { message: string }) => void) => () => void
}

declare global {
  interface Window {
    converterAPI: ConverterAPI
  }
}

export {}
