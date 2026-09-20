import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import type { ConversionStatus } from '../hooks/useConversion'
import type { ConversionProgress } from '../types'

interface ProgressBarProps {
  status: ConversionStatus
  progress: ConversionProgress
  outputPath: string | null
  error: string | null
}

const STAGE_LABELS: Record<string, string> = {
  inspect: 'Inspeção do PDF',
  'inspect-pdf': 'Inspeção do PDF',
  extract: 'Extração de texto',
  'extract-text': 'Extração de texto',
  ocr: 'OCR',
  clean: 'Limpeza',
  sanitize: 'Limpeza',
  build: 'Construção do EPUB',
  'build-epub': 'Construção do EPUB'
}

export default function ProgressBar({ status, progress, outputPath, error }: ProgressBarProps) {
  if (status === 'idle') return null

  const stageLabel = STAGE_LABELS[progress.stage] ?? progress.stage
  const percent = Math.round(Math.min(100, Math.max(0, progress.percent)))

  if (status === 'error') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div>
          <p className="font-medium text-red-700 dark:text-red-300">Erro na conversão</p>
          <p className="text-sm text-red-600 dark:text-red-400">{error ?? 'Erro desconhecido.'}</p>
        </div>
      </div>
    )
  }

  if (status === 'done') {
    return (
      <div className="rounded-xl border border-green-300 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40">
        <div className="flex items-center gap-3">
          <CheckCircle className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
          <p className="font-medium text-green-700 dark:text-green-300">EPUB criado com sucesso!</p>
        </div>
        {outputPath && (
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
            <p className="break-all text-sm text-neutral-600 dark:text-neutral-300">{outputPath}</p>
            {typeof (window.converterAPI as { revealPath?: unknown }).revealPath ===
              'function' && (
              <button
                type="button"
                onClick={() => {
                  void (
                    window.converterAPI as unknown as {
                      revealPath: (path: string) => Promise<void>
                    }
                  ).revealPath(outputPath)
                }}
                className="text-sm font-medium text-green-700 underline-offset-2 hover:underline dark:text-green-400"
              >
                Revelar no Finder
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-neutral-100 p-4 dark:bg-neutral-800">
      <div className="mb-2 flex items-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
        <p className="font-medium text-neutral-900 dark:text-neutral-100">
          {stageLabel || 'A converter…'}
        </p>
        <span className="ml-auto text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
          {percent}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-300 dark:bg-neutral-700">
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out dark:bg-blue-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
