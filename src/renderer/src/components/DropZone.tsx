import { useRef, useState } from 'react'
import { FileUp } from 'lucide-react'

interface DropZoneProps {
  selectedFile: { path: string; name: string; size: number } | null
  onSelect: (file: { path: string; name: string; size: number }) => void
  onClear?: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function DropZone({ selectedFile, onSelect, onClear }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const validate = (name: string): boolean => {
    const ok = name.toLowerCase().endsWith('.pdf')
    if (!ok) setError('Apenas ficheiros PDF são suportados.')
    else setError(null)
    return ok
  }

  const handleLocalFile = async (file: File): Promise<void> => {
    if (!validate(file.name)) return
    // file.path was removed in Electron >= 32; resolve the absolute path via
    // webUtils.getPathForFile exposed in the preload bridge.
    let path = file.name
    try {
      const resolved = window.converterAPI.getPathForFile(file)
      if (resolved) path = resolved
    } catch {
      // bridge unavailable (plain browser/dev); keep fallback
    }
    onSelect({ path, name: file.name, size: file.size })
  }

  const handleDialogPick = async (): Promise<void> => {
    try {
      const result = await window.converterAPI.selectFile()
      if (result) onSelect(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao escolher ficheiro.')
    }
  }

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void handleLocalFile(file)
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          dragOver
            ? 'scale-[1.01] border-blue-500 bg-blue-500/10 shadow-md shadow-blue-600/10'
            : 'border-neutral-300 bg-white hover:border-blue-400 hover:bg-blue-50/40 dark:border-white/10 dark:bg-neutral-900 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/5'
        }`}
      >
        <div className={`flex h-14 w-14 items-center justify-center rounded-2xl transition-colors ${
          dragOver ? 'bg-blue-600 text-white' : 'bg-blue-600/10 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
        }`}>
          <FileUp className="h-7 w-7" />
        </div>
        <div>
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            Arrasta o teu PDF aqui
          </p>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            ou clica para escolher um ficheiro (.pdf)
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleLocalFile(file)
            e.target.value = ''
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => void handleDialogPick()}
        className="mt-2 text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
      >
        Abrir diálogo do sistema
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {selectedFile && (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
              <FileUp className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                {selectedFile.name}
              </p>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {formatSize(selectedFile.size)}
              </p>
            </div>
          </div>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
            >
              Remover
            </button>
          )}
        </div>
      )}
    </div>
  )
}
