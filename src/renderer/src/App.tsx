import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Moon, Sun } from 'lucide-react'
import DropZone from './components/DropZone'
import MetadataForm from './components/MetadataForm'
import PagePreview from './components/PagePreview'
import ProgressBar from './components/ProgressBar'
import { useConversion } from './hooks/useConversion'
import type { Metadata } from './types'

interface SelectedFile {
  path: string
  name: string
  size: number
}

const THEME_KEY = 'theme'

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as 'dark' | 'light') ?? 'dark'
    } catch {
      return 'dark'
    }
  })
  const [file, setFile] = useState<SelectedFile | null>(null)
  const [metadata, setMetadata] = useState<Metadata>({
    title: '',
    author: '',
    language: 'pt'
  })
  const [chapterMarks, setChapterMarks] = useState<number[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const { status, progress, outputPath, error, start, reset } = useConversion()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore
    }
  }, [theme])

  useEffect(() => {
    if (status === 'error' && error) setToast(error)
  }, [status, error])

  useEffect(() => {
    if (status === 'done') {
      setFile(null)
      setChapterMarks([])
    }
  }, [status])

  const canConvert = useMemo(
    () => file !== null && metadata.title.trim().length > 0 && status !== 'converting',
    [file, metadata.title, status]
  )

  const handleConvert = (): void => {
    if (!canConvert || !file) return
    setToast(null)
    start(file, metadata, { chapterMarks })
  }

  return (
    <div className="min-h-screen bg-white text-neutral-900 transition-colors dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
            <BookOpen className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold">PDF → EPUB Converter</h1>
        </div>
        <button
          type="button"
          aria-label="Alternar tema"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
        <DropZone
          selectedFile={file}
          onSelect={(f) => {
            setFile(f)
            reset()
            setToast(null)
          }}
          onClear={() => {
            setFile(null)
            setChapterMarks([])
            reset()
          }}
        />

        {file && (
          <>
            <MetadataForm value={metadata} onChange={setMetadata} />
            <PagePreview file={file} onChapterMarks={setChapterMarks} />
            <button
              type="button"
              disabled={!canConvert}
              onClick={handleConvert}
              className="rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white shadow transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 dark:focus:ring-offset-neutral-950"
            >
              {status === 'converting' ? 'A converter…' : 'Converter para EPUB'}
            </button>
          </>
        )}

        <ProgressBar
          status={status}
          progress={progress}
          outputPath={outputPath}
          error={error}
        />

        {toast && (
          <div className="flex items-center justify-between rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <span className="break-all">{toast}</span>
            <button
              type="button"
              aria-label="Fechar"
              onClick={() => setToast(null)}
              className="ml-4 shrink-0 font-medium hover:underline"
            >
              Fechar
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
