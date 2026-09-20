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
  | { type: 'done'; outputPath: string }
  | { type: 'error'; message: string }

export interface ConversionStartResult {
  ok: boolean
  canceled?: boolean
  outPath?: string
  error?: string
}
