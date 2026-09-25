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

export interface ExtractionPreviewLine {
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  bold: boolean
}

export interface ExtractionPreviewPage {
  /** 0-based index in the PDF */
  index: number
  width: number
  height: number
  lines: ExtractionPreviewLine[]
}

export interface ExtractionPreviewParagraph {
  text: string
  /** 0-based index of the page where this paragraph begins */
  startPage: number
}

export interface ExtractionPreview {
  mode: 'text-layer' | 'image-only'
  pageCount: number
  pages: ExtractionPreviewPage[]
  paragraphs: ExtractionPreviewParagraph[]
  truncated: boolean
}

export interface ConverterAPI {
  getPathForFile: (file: File) => string
  selectFile: () => Promise<{ path: string; name: string; size: number } | null>
  readPdf: (filePath: string) => Promise<Uint8Array>
  readImage: (filePath: string) => Promise<Uint8Array>
  previewExtraction: (filePath: string, requestId: string) => Promise<ExtractionPreview>
  cancelExtractionPreview: (requestId: string) => Promise<void>
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
