import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = ''
}

const THUMBNAIL_WIDTH = 120
const THUMB_PLACEHOLDER = ''

interface PagePreviewProps {
  file: { path: string; name: string } | null
  onChapterMarks: (indices: number[]) => void
}

interface ThumbState {
  dataUrl: string
  loading: boolean
  failed: boolean
}

function createSequentialQueue(): {
  enqueue(task: () => Promise<void>): void
  cancel(): void
} {
  let chain: Promise<void> = Promise.resolve()
  let dropped = false
  return {
    enqueue(task: () => Promise<void>): void {
      if (dropped) return
      chain = chain
        .then(task)
        .catch(() => undefined)
        .then(() => {
          if (dropped) {
            chain = Promise.resolve()
          }
        })
    },
    // resets the queue when the document changes
    cancel(): void {
      dropped = true
      chain = chain.then(() => {
        dropped = false
      })
    }
  }
}

export default function PagePreview({ file, onChapterMarks }: PagePreviewProps) {
  const [thumbs, setThumbs] = useState<Record<number, ThumbState>>({})
  const [numPages, setNumPages] = useState(0)
  const [marks, setMarks] = useState<number[]>([])
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const queueRef = useRef(createSequentialQueue())
  const visibleRef = useRef(new Set<number>())
  const renderedRef = useRef(new Set<number>())

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      queueRef.current.cancel()
      visibleRef.current = new Set()
      renderedRef.current = new Set()
      setThumbs({})
      setMarks([])
      setNumPages(0)
      onChapterMarks([])
      if (!file) {
        docRef.current = null
        return
      }
      try {
        const data = await window.converterAPI.readPdf(file.path)
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        docRef.current = doc
        setNumPages(doc.numPages)
      } catch (err) {
        console.error('Falha ao carregar PDF para pré-visualização:', err)
      }
    }

    void load()
    return () => {
      cancelled = true
      queueRef.current.cancel()
      void docRef.current?.destroy()
      docRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path])

  const renderPage = useCallback(async (pageNumber: number): Promise<void> => {
    const doc = docRef.current
    if (!doc || pageNumber < 1 || pageNumber > doc.numPages) return

    setThumbs((prev) => ({ ...prev, [pageNumber]: { dataUrl: THUMB_PLACEHOLDER, loading: true, failed: false } }))

    try {
      const page = await doc.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = THUMBNAIL_WIDTH / baseViewport.width
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas indisponível')
      await page.render({ canvasContext: ctx, viewport }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      setThumbs((prev) => ({ ...prev, [pageNumber]: { dataUrl, loading: false, failed: false } }))
    } catch (err) {
      console.error(`Falha ao renderizar página ${pageNumber}:`, err)
      setThumbs((prev) => ({ ...prev, [pageNumber]: { dataUrl: THUMB_PLACEHOLDER, loading: false, failed: true } }))
    }
  }, [])

  // Lazy rendering: render pages only when their tile enters the viewport.
  useEffect(() => {
    if (!numPages) return
    const queue = queueRef.current

    const renderVisible = (): void => {
      for (const pageNumber of visibleRef.current) {
        if (renderedRef.current.has(pageNumber)) continue
        renderedRef.current.add(pageNumber)
        setThumbs((prev) => ({ ...prev, [pageNumber]: { dataUrl: THUMB_PLACEHOLDER, loading: true, failed: false } }))
        queue.enqueue(() => renderPage(pageNumber))
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page)
          if (entry.isIntersecting) {
            visibleRef.current.add(pageNumber)
          } else {
            visibleRef.current.delete(pageNumber)
          }
        }
        renderVisible()
      },
      { root: null, rootMargin: '400px' }
    )

    const tiles = document.querySelectorAll<HTMLElement>('[data-page-tile]')
    tiles.forEach((tile) => observer.observe(tile))

    renderVisible()
    return () => observer.disconnect()
  }, [numPages, renderPage])

  const toggleMark = (page: number): void => {
    setMarks((prev) => {
      const next = prev.includes(page)
        ? prev.filter((p) => p !== page)
        : [...prev, page].sort((a, b) => a - b)
      onChapterMarks(next)
      return next
    })
  }

  const clearMarks = (): void => {
    setMarks([])
    onChapterMarks([])
  }

  const allSelected = numPages > 0 && marks.length === numPages

  const handleToggleAll = (): void => {
    if (allSelected) {
      clearMarks()
      return
    }
    const all = Array.from({ length: numPages }, (_, i) => i + 1)
    setMarks(all)
    onChapterMarks(all)
  }

  if (!file) return null

  return (
    <div className="rounded-xl bg-neutral-100 p-4 dark:bg-neutral-800">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium text-neutral-900 dark:text-neutral-100">
          Páginas ({numPages})
        </h3>
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            disabled={numPages === 0}
            checked={allSelected}
            onChange={handleToggleAll}
            ref={(el) => {
              if (el) el.indeterminate = marks.length > 0 && !allSelected
            }}
            title="Marcar/desmarcar todas as páginas como início de capítulo"
            className="h-4 w-4 rounded border-neutral-400 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-neutral-600"
          />
          {allSelected ? 'Limpar todas' : 'Selecionar todas'}
        </label>
      </div>
      <div className="grid max-h-80 grid-cols-4 gap-3 overflow-y-auto sm:grid-cols-6 lg:grid-cols-10">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => {
          const markNumber = marks.indexOf(page)
          const marked = markNumber >= 0
          const thumb = thumbs[page]
          return (
            <button
              key={page}
              data-page-tile
              data-page={page}
              type="button"
              onClick={() => toggleMark(page)}
              title={marked ? 'Remover marca de capítulo' : 'Marcar como início de capítulo'}
              className={`relative min-h-[160px] rounded-lg border-2 overflow-hidden bg-neutral-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-neutral-700 ${
                marked
                  ? 'border-blue-500 ring-1 ring-blue-500'
                  : 'border-transparent hover:border-neutral-400 dark:hover:border-neutral-500'
              }`}
            >
              {thumb?.dataUrl && (
                <img src={thumb.dataUrl} alt={`Página ${page}`} className="block w-full" />
              )}
              <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
                {page}
              </span>
              {marked && (
                <span className="absolute left-1 top-1 rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                  Cap. {markNumber + 1}
                </span>
              )}
            </button>
          )
        })}
        {numPages === 0 && (
          <p className="col-span-full text-sm text-neutral-500 dark:text-neutral-400">
            A gerar miniaturas…
          </p>
        )}
      </div>
    </div>
  )
}
