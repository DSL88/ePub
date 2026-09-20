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
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          dragOver
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-neutral-300 bg-white hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800/60'
        }`}
      >
        <FileUp className="h-10 w-10 text-neutral-500 dark:text-neutral-400" />
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
        <div className="mt-3 flex items-center justify-between rounded-xl bg-neutral-100 px-4 py-3 dark:bg-neutral-800">
          <div className="min-w-0">
            <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
              {selectedFile.name}
            </p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {formatSize(selectedFile.size)}
            </p>
          </div>
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="ml-4 shrink-0 text-sm text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
            >
              Remover
            </button>
          )}
        </div>
      )}
    </div>
  )
}
