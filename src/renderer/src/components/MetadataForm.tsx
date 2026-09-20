import { useEffect, useState } from 'react'
import { FileImage, X } from 'lucide-react'
import type { Metadata } from '../types'

interface MetadataFormProps {
  value: Metadata
  onChange: (metadata: Metadata) => void
}

const LANGUAGES = [
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
  { value: 'fr', label: 'Francês' }
]

function toImageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

const inputClass =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder-neutral-500'

export default function MetadataForm({ value, onChange }: MetadataFormProps) {
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCoverDataUrl(null)
    if (!value.coverPath) return
    window.converterAPI
      .readImage(value.coverPath)
      .then((bytes) => {
        if (cancelled) return
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
        }
        setCoverDataUrl(`data:${toImageMime(value.coverPath as string)};base64,${btoa(binary)}`)
      })
      .catch(() => setCoverDataUrl(null))
    return () => {
      cancelled = true
    }
  }, [value.coverPath])

  const handleCoverPick = async (): Promise<void> => {
    try {
      const result = await window.converterAPI.selectCover()
      if (result) onChange({ ...value, coverPath: result.path })
    } catch (err) {
      console.error('Erro ao escolher capa:', err)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl bg-neutral-100 p-4 dark:bg-neutral-800 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="meta-title" className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Título <span className="text-red-500">*</span>
        </label>
        <input
          id="meta-title"
          type="text"
          required
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="Título do livro"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="meta-author" className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Autor
        </label>
        <input
          id="meta-author"
          type="text"
          value={value.author}
          onChange={(e) => onChange({ ...value, author: e.target.value })}
          placeholder="Nome do autor"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="meta-language" className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Idioma
        </label>
        <select
          id="meta-language"
          value={value.language}
          onChange={(e) => onChange({ ...value, language: e.target.value })}
          className={inputClass}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-2">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Capa
        </span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void handleCoverPick()}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            <FileImage className="h-4 w-4" />
            Escolher capa
          </button>
          {coverDataUrl && (
            <div className="relative">
              <img
                src={coverDataUrl}
                alt="Pré-visualização da capa"
                className="h-20 w-14 rounded-lg object-cover"
              />
              <button
                type="button"
                aria-label="Remover capa"
                onClick={() => onChange({ ...value, coverPath: undefined })}
                className="absolute -right-2 -top-2 rounded-full bg-neutral-700 p-1 text-white hover:bg-red-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Formatos permitidos: JPG, JPEG, PNG e WEBP (recomendado: imagem vertical, ex. 1200×1600 px).
        </p>
      </div>
    </div>
  )
}
