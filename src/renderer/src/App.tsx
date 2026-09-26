import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Moon, Sun } from 'lucide-react'
import DropZone from './components/DropZone'
import MetadataForm from './components/MetadataForm'
import PagePreview from './components/PagePreview'
import ProgressBar from './components/ProgressBar'
import { useConversion } from './hooks/useConversion'
import type { BoundaryOverrides, LineMark, ManualLine, Metadata, PageLineOrder } from './types'

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
  const [boundaryOverrides, setBoundaryOverrides] = useState<BoundaryOverrides>({})
  const [lineMarks, setLineMarks] = useState<LineMark[]>([])
  const [manualLines, setManualLines] = useState<ManualLine[]>([])
  const [lineOrder, setLineOrder] = useState<PageLineOrder[]>([])
  const [pageOcrPsm, setPageOcrPsm] = useState<Record<number, string>>({})
  const [toast, setToast] = useState<string | null>(null)

  const { status, progress, outputPath, applied, error, start, reset } = useConversion()

  const pendingSummary = useMemo(() => {
    const parts: string[] = []
    const chapters =
      lineMarks.filter((mark) => mark.level === 'chapter').length +
      chapterMarks.length +
      Object.values(boundaryOverrides).filter((decision) => decision === 'chapter').length
    const subchapters = lineMarks.filter((mark) => mark.level === 'subchapter').length
    const ignored = lineMarks.filter((mark) => mark.level === 'ignore').length
    if (chapters > 0) parts.push(`${chapters} capítulo${chapters === 1 ? '' : 's'}`)
    if (subchapters > 0) parts.push(`${subchapters} subcapítulo${subchapters === 1 ? '' : 's'}`)
    if (ignored > 0) parts.push(`${ignored} linhas a ignorar`)
    if (manualLines.length > 0) parts.push(`${manualLines.length} linhas manuais`)
    if (lineOrder.length > 0) parts.push(`ordem revista em ${lineOrder.length} páginas`)
    const boundaries = Object.keys(boundaryOverrides).length
    if (boundaries > 0) parts.push(`${boundaries} fronteiras ajustadas`)
    const psm = Object.keys(pageOcrPsm).length
    if (psm > 0) parts.push(`OCR alternativo em ${psm} páginas`)
    return parts
  }, [lineMarks, chapterMarks, boundaryOverrides, manualLines, lineOrder, pageOcrPsm])

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
      setBoundaryOverrides({})
      setLineMarks([])
      setManualLines([])
      setLineOrder([])
      setPageOcrPsm({})
    }
  }, [status])

  const canConvert = useMemo(
    () => file !== null && metadata.title.trim().length > 0 && status !== 'converting',
    [file, metadata.title, status]
  )

  const handleConvert = (): void => {
    if (!canConvert || !file) return
    setToast(null)
    start(file, metadata, { chapterMarks, boundaryOverrides, lineMarks, manualLines, lineOrder, pageOcrPsm })
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 transition-colors dark:bg-neutral-950 dark:text-neutral-100">
      <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-white/80 backdrop-blur-md dark:border-white/10 dark:bg-neutral-950/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-600/25">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight">PDF → EPUB</h1>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">conversor local para e-readers</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Alternar tema"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="rounded-xl border border-neutral-200 p-2 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
          >
            {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-8">
        <section aria-label="Ficheiro">
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
            setBoundaryOverrides({})
            setLineMarks([])
            setManualLines([])
            setLineOrder([])
            setPageOcrPsm({})
            reset()
          }}
        />
        </section>

        {file && (
          <>
            <MetadataForm value={metadata} onChange={setMetadata} />
            <PagePreview
              file={file}
              onChapterMarks={setChapterMarks}
              onBoundaryOverrides={setBoundaryOverrides}
              onLineMarks={setLineMarks}
              onManualLines={setManualLines}
              onLineOrder={setLineOrder}
              onOcrPsm={setPageOcrPsm}
            />
            {pendingSummary.length > 0 && status !== 'converting' && (
              <p className="rounded-2xl border border-blue-200/70 bg-blue-50/60 px-4 py-2.5 text-sm text-neutral-700 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-neutral-300">
                Com esta conversão: {pendingSummary.join(' · ')}.
              </p>
            )}
            <div className="sticky bottom-4 z-10">
              <button
                type="button"
                disabled={!canConvert}
                onClick={handleConvert}
                className="w-full rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-3.5 text-base font-bold text-white shadow-lg shadow-blue-600/30 transition-all hover:from-blue-500 hover:to-indigo-500 hover:shadow-xl hover:shadow-blue-600/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:scale-[0.99] disabled:cursor-not-allowed disabled:from-neutral-400 disabled:to-neutral-400 disabled:shadow-none disabled:opacity-70 dark:focus:ring-offset-neutral-950"
              >
                {status === 'converting' ? 'A converter…' : 'Converter para EPUB'}
              </button>
              {!metadata.title.trim() && (
                <p className="mt-2 text-center text-xs text-neutral-500 dark:text-neutral-400">
                  Preenche o título do livro para ativar a conversão.
                </p>
              )}
            </div>
          </>
        )}

        <ProgressBar
          status={status}
          progress={progress}
          outputPath={outputPath}
          applied={applied}
          error={error}
        />

        {toast && (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-sm dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
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
