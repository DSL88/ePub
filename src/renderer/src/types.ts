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

export type BoundaryDecision = 'join' | 'break' | 'chapter'

export type PageQualityLevel = 'good' | 'fair' | 'poor'

export interface PageQuality {
  pageIndex: number
  level: PageQualityLevel
  chars: number
  reason: string
}

export interface BoundarySuggestion {
  fromPage: number
  toPage: number
  suggestion: BoundaryDecision
  reason: string
  tail: string[]
  head: string[]
  headIsTitle?: boolean
}

export type BoundaryOverrides = Record<number, BoundaryDecision>

export type LineMarkLevel = 'chapter' | 'subchapter' | 'ignore'

export interface LineMark {
  /** 0-based index da página PDF */
  pageIndex: number
  /** 0-based index da linha na página (ordem de leitura) */
  lineIndex: number
  lineText: string
  level: LineMarkLevel
}

export interface PageOcrResult {
  /** 0-based index da página PDF */
  pageIndex: number
  lines: ExtractionPreviewLine[]
  /** confiança média das palavras (0-100) */
  meanConfidence: number
  truncated: boolean
  /** modo PSM usado nesta passagem */
  psm: string
}

export type ManualAnchor = 'start' | 'end'

export interface ManualLine {
  /** 0-based index da página PDF */
  pageIndex: number
  anchor: ManualAnchor
  text: string
}

export interface PageLineOrder {
  /** 0-based index da página PDF */
  pageIndex: number
  orderedTexts: string[]
}

/** Relatório do que a conversão realmente aplicou (manual-first). */
export interface AppliedSummary {
  chapterMarks: number
  subchapters: number
  ignoredRemoved: number
  manuals: number
  boundaries: number
  chaptersOpened: number
  pagesWithoutText: number
  /** textos (truncados) das marcas sem correspondência */
  unmatched: string[]
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
  qualities?: PageQuality[]
  boundaries?: BoundarySuggestion[]
}

export interface ConverterAPI {
  getPathForFile: (file: File) => string
  selectFile: () => Promise<{ path: string; name: string; size: number } | null>
  readPdf: (filePath: string) => Promise<Uint8Array>
  readImage: (filePath: string) => Promise<Uint8Array>
  previewExtraction: (filePath: string, requestId: string) => Promise<ExtractionPreview>
  cancelExtractionPreview: (requestId: string) => Promise<void>
  previewPageOcr: (filePath: string, pageIndex: number, psm?: string) => Promise<PageOcrResult>
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
  onDone: (cb: (data: { outputPath: string; applied?: AppliedSummary }) => void) => () => void
  onError: (cb: (data: { message: string }) => void) => () => void
}

declare global {
  interface Window {
    converterAPI: ConverterAPI
  }
}

export {}
