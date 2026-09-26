import { AlertCircle, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import type { ConversionStatus } from '../hooks/useConversion'
import type { AppliedSummary, ConversionProgress } from '../types'

interface ProgressBarProps {
  status: ConversionStatus
  progress: ConversionProgress
  outputPath: string | null
  applied: AppliedSummary | null
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

export default function ProgressBar({ status, progress, outputPath, applied, error }: ProgressBarProps) {
  if (status === 'idle') return null

  const stageLabel = STAGE_LABELS[progress.stage] ?? progress.stage
  const percent = Math.round(Math.min(100, Math.max(0, progress.percent)))

  if (status === 'error') {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-red-300 bg-red-50 p-4 shadow-sm dark:border-red-900 dark:bg-red-950/40">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div>
          <p className="font-medium text-red-700 dark:text-red-300">Erro na conversão</p>
          <p className="text-sm text-red-600 dark:text-red-400">{error ?? 'Erro desconhecido.'}</p>
        </div>
      </div>
    )
  }

  if (status === 'done') {
    const parts: string[] = []
    if (applied) {
      if (applied.chapterMarks > 0) parts.push(`${applied.chapterMarks} capítulo${applied.chapterMarks === 1 ? '' : 's'}`)
      if (applied.subchapters > 0) parts.push(`${applied.subchapters} subcapítulo${applied.subchapters === 1 ? '' : 's'}`)
      if (applied.ignoredRemoved > 0) parts.push(`${applied.ignoredRemoved} linhas ignoradas removidas`)
      if (applied.manuals > 0) parts.push(`${applied.manuals} linhas manuais`)
      if (applied.boundaries > 0) parts.push(`${applied.boundaries} fronteiras ajustadas`)
    }
    return (
      <div className="rounded-2xl border border-green-300 bg-green-50 p-4 shadow-sm dark:border-green-900 dark:bg-green-950/40">
        <div className="flex items-center gap-3">
          <CheckCircle className="h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
          <p className="font-medium text-green-700 dark:text-green-300">EPUB criado com sucesso!</p>
        </div>
        {applied && (
          <p className="mt-2 pl-8 text-sm text-neutral-600 dark:text-neutral-300">
            {applied.chaptersOpened} capítulo{applied.chaptersOpened === 1 ? '' : 's'} no EPUB
            {applied.pagesWithoutText > 0 && <> · {applied.pagesWithoutText} páginas sem texto (imagem)</>}
            {parts.length > 0 && <> · aplicado: {parts.join(' · ')}</>}
          </p>
        )}
        {applied && applied.unmatched.length > 0 && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {applied.unmatched.length} marca{applied.unmatched.length === 1 ? '' : 's'} sem correspondência no texto: {applied.unmatched.slice(0, 3).map((text) => `“${text}”`).join(', ')}
              {applied.unmatched.length > 3 && ` (+${applied.unmatched.length - 3})`}. Revê o OCR dessa página e reconverte.
            </p>
          </div>
        )}
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
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900">
      <div className="mb-2 flex items-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-400" />
        <p className="font-medium text-neutral-900 dark:text-neutral-100">
          {stageLabel || 'A converter…'}
        </p>
        <span className="ml-auto text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
          {percent}%
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
