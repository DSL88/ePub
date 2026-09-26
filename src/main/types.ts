import type { AppliedSummary } from '../renderer/src/types'

export type { AppliedSummary }

export interface ConversionMetadata {
  title?: string
  author?: string
  language?: string
  coverPath?: string
}

export interface ConversionOptions {
  dpi?: number
  outPath?: string
  /** 1-based page numbers that force the start of a chapter (from UI) */
  chapterMarks?: number[]
  /** manual page-boundary decisions, keyed by 0-based destination page */
  boundaryOverrides?: Record<number, 'join' | 'break' | 'chapter'>
  /** user-picked lines forced to chapter/subchapter/ignore (matched by page + text) */
  lineMarks?: LineMarkInput[]
  /** user-typed lines missing from extraction (e.g. OCR edge misses) */
  manualLines?: ManualLineInput[]
  /** user-reordered page lines (full ordered text per page) */
  lineOrder?: LineOrderInput[]
  /** per-page Tesseract PSM chosen in the preview, keyed by 0-based page */
  pageOcrPsm?: Record<number, string>
}

export interface LineMarkInput {
  /** 0-based PDF page index */
  pageIndex: number
  /** line text as seen in the preview (matched tolerantly) */
  lineText: string
  level: 'chapter' | 'subchapter' | 'ignore'
}

export interface ManualLineInput {
  /** 0-based PDF page index */
  pageIndex: number
  anchor: 'start' | 'end'
  text: string
}

export interface LineOrderInput {
  /** 0-based PDF page index */
  pageIndex: number
  orderedTexts: string[]
}

export interface ConversionRequestMessage {
  type: 'convert'
  filePath: string
  outPath: string
  metadata: ConversionMetadata
  options?: ConversionOptions
}

export type WorkerOutgoingMessage =
  | { type: 'progress'; stage: string; percent: number }
  | { type: 'done'; outputPath: string; applied?: AppliedSummary }
  | { type: 'error'; message: string }

export interface ConversionStartResult {
  ok: boolean
  canceled?: boolean
  outPath?: string
  error?: string
}
