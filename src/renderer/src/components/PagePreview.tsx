import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ExtractionPreview } from '../types'

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = ''
}

const THUMBNAIL_WIDTH = 120
const DIAGNOSTIC_RENDER_WIDTH = 900
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

type ExtractionPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ExtractionPreview }

type DiagnosticImageState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; dataUrl: string }
  | { status: 'failed'; key: string; message: string }

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
  const [extractionPreviewState, setExtractionPreviewState] = useState<ExtractionPreviewState>({ status: 'idle' })
  const [extractionPreviewPath, setExtractionPreviewPath] = useState<string | null>(null)
  const [selectedPreviewPage, setSelectedPreviewPage] = useState(0)
  const [pdfLoadState, setPdfLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [diagnosticImageState, setDiagnosticImageState] = useState<DiagnosticImageState>({ status: 'idle' })
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const queueRef = useRef(createSequentialQueue())
  const visibleRef = useRef(new Set<number>())
  const renderedRef = useRef(new Set<number>())
  const activePreviewRequestRef = useRef<string | null>(null)
  const previewRequestNumberRef = useRef(0)
  const diagnosticRenderRequestRef = useRef(0)
  const diagnosticRenderCancelRef = useRef<(() => void) | null>(null)
  const diagnosticImageKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      queueRef.current.cancel()
      diagnosticRenderRequestRef.current++
      diagnosticRenderCancelRef.current?.()
      diagnosticRenderCancelRef.current = null
      visibleRef.current = new Set()
      renderedRef.current = new Set()
      setThumbs({})
      setMarks([])
      setNumPages(0)
      setPdfLoadState('loading')
      setDiagnosticImageState({ status: 'idle' })
      setExtractionPreviewState({ status: 'idle' })
      setExtractionPreviewPath(null)
      setSelectedPreviewPage(0)
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
        setPdfLoadState('ready')
      } catch (err) {
        console.error('Falha ao carregar PDF para pré-visualização:', err)
        if (!cancelled) {
          setPdfLoadState('failed')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      queueRef.current.cancel()
      diagnosticRenderRequestRef.current++
      diagnosticRenderCancelRef.current?.()
      diagnosticRenderCancelRef.current = null
      const requestId = activePreviewRequestRef.current
      if (requestId) {
        activePreviewRequestRef.current = null
        void window.converterAPI.cancelExtractionPreview(requestId).catch(() => undefined)
      }
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

  const enqueueThumbnail = useCallback((pageNumber: number): void => {
    if (renderedRef.current.has(pageNumber)) return
    renderedRef.current.add(pageNumber)
    setThumbs((prev) => ({ ...prev, [pageNumber]: { dataUrl: THUMB_PLACEHOLDER, loading: true, failed: false } }))
    queueRef.current.enqueue(() => renderPage(pageNumber))
  }, [renderPage])

  // Lazy rendering: render pages only when their tile enters the viewport.
  useEffect(() => {
    if (!numPages) return

    const renderVisible = (): void => {
      for (const pageNumber of visibleRef.current) {
        enqueueThumbnail(pageNumber)
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
  }, [enqueueThumbnail, numPages])

  const currentExtractionPreviewState: ExtractionPreviewState =
    extractionPreviewPath === file?.path ? extractionPreviewState : { status: 'idle' }
  const extractionPreview =
    currentExtractionPreviewState.status === 'ready' ? currentExtractionPreviewState.data : null
  const selectedDiagnosticPage = extractionPreview?.pages.find((page) => page.index === selectedPreviewPage)
    ?? extractionPreview?.pages[0]
  const selectedDiagnosticPagePosition = selectedDiagnosticPage && extractionPreview
    ? extractionPreview.pages.indexOf(selectedDiagnosticPage)
    : -1
  const selectedDiagnosticParagraphs = extractionPreview && selectedDiagnosticPage
    ? extractionPreview.paragraphs.filter((paragraph) => paragraph.startPage === selectedDiagnosticPage.index)
    : []
  const diagnosticImageKey = file && selectedDiagnosticPage
    ? JSON.stringify([file.path, selectedDiagnosticPage.index + 1])
    : null
  diagnosticImageKeyRef.current = diagnosticImageKey
  const currentDiagnosticImageState = diagnosticImageKey &&
    diagnosticImageState.status !== 'idle' &&
    diagnosticImageState.key === diagnosticImageKey
    ? diagnosticImageState
    : null

  useEffect(() => {
    if (!numPages || !extractionPreview || !selectedDiagnosticPage) return
    enqueueThumbnail(selectedDiagnosticPage.index + 1)
  }, [enqueueThumbnail, extractionPreview, numPages, selectedDiagnosticPage])

  useEffect(() => {
    const imageKey = diagnosticImageKey
    if (!imageKey || !selectedDiagnosticPage) {
      setDiagnosticImageState({ status: 'idle' })
      return
    }

    if (pdfLoadState === 'loading') {
      setDiagnosticImageState({ status: 'loading', key: imageKey })
      return
    }
    if (pdfLoadState === 'failed') {
      setDiagnosticImageState({
        status: 'failed',
        key: imageKey,
        message: 'Não foi possível carregar o PDF para gerar a imagem.'
      })
      return
    }

    const doc = docRef.current
    const pageNumber = selectedDiagnosticPage.index + 1
    if (!doc || !numPages || pageNumber > numPages) {
      setDiagnosticImageState({
        status: 'failed',
        key: imageKey,
        message: 'A página não está disponível para renderização.'
      })
      return
    }

    const requestId = ++diagnosticRenderRequestRef.current
    let cancelled = false
    let cancelRender: (() => void) | null = null
    setDiagnosticImageState({ status: 'loading', key: imageKey })

    const isCurrentRequest = (): boolean =>
      !cancelled &&
      diagnosticRenderRequestRef.current === requestId &&
      diagnosticImageKeyRef.current === imageKey &&
      docRef.current === doc

    const renderSelectedPage = async (): Promise<void> => {
      let canvas: HTMLCanvasElement | null = null
      try {
        const page = await doc.getPage(pageNumber)
        if (!isCurrentRequest()) return

        const baseViewport = page.getViewport({ scale: 1 })
        if (!(baseViewport.width > 0) || !(baseViewport.height > 0)) {
          throw new Error('Dimensões da página inválidas.')
        }
        const viewport = page.getViewport({ scale: DIAGNOSTIC_RENDER_WIDTH / baseViewport.width })
        canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('canvas indisponível')

        const renderTask = page.render({ canvasContext: context, viewport })
        let renderCancelled = false
        cancelRender = (): void => {
          if (renderCancelled) return
          renderCancelled = true
          renderTask.cancel()
        }
        diagnosticRenderCancelRef.current = cancelRender
        await renderTask.promise
        if (!isCurrentRequest()) return

        setDiagnosticImageState({
          status: 'ready',
          key: imageKey,
          dataUrl: canvas.toDataURL('image/png')
        })
      } catch (err) {
        if (!isCurrentRequest()) return
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Falha ao renderizar a página ${pageNumber} em alta resolução:`, err)
        setDiagnosticImageState({ status: 'failed', key: imageKey, message })
      } finally {
        if (canvas) {
          canvas.width = 0
          canvas.height = 0
        }
        if (cancelRender && diagnosticRenderCancelRef.current === cancelRender) {
          diagnosticRenderCancelRef.current = null
        }
        cancelRender = null
      }
    }

    void renderSelectedPage()
    return () => {
      cancelled = true
      if (diagnosticRenderRequestRef.current === requestId) {
        diagnosticRenderRequestRef.current++
      }
      cancelRender?.()
      if (cancelRender && diagnosticRenderCancelRef.current === cancelRender) {
        diagnosticRenderCancelRef.current = null
      }
    }
  }, [diagnosticImageKey, numPages, pdfLoadState, selectedDiagnosticPage?.index])

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

  const runExtractionPreview = async (): Promise<void> => {
    if (!file || activePreviewRequestRef.current) return

    previewRequestNumberRef.current++
    const requestId = `${Date.now()}-${previewRequestNumberRef.current}`
    activePreviewRequestRef.current = requestId
    setExtractionPreviewPath(file.path)
    setExtractionPreviewState({ status: 'loading' })

    try {
      const result = await window.converterAPI.previewExtraction(file.path, requestId)
      if (activePreviewRequestRef.current !== requestId) return
      const firstPageWithText = result.pages.find((page) => page.lines.length > 0)
      setSelectedPreviewPage(firstPageWithText?.index ?? result.pages[0]?.index ?? 0)
      setExtractionPreviewState({ status: 'ready', data: result })
    } catch (err) {
      if (activePreviewRequestRef.current !== requestId) return
      setExtractionPreviewState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (activePreviewRequestRef.current === requestId) {
        activePreviewRequestRef.current = null
      }
    }
  }

  const changeDiagnosticPage = (offset: number): void => {
    if (!extractionPreview || selectedDiagnosticPagePosition < 0) return
    const nextPage = extractionPreview.pages[selectedDiagnosticPagePosition + offset]
    if (nextPage) setSelectedPreviewPage(nextPage.index)
  }

  const handleDiagnosticPageChange = (pageIndex: number): void => {
    setSelectedPreviewPage(pageIndex)
  }

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

      <section className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-700">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="font-medium text-neutral-900 dark:text-neutral-100">Diagnóstico da extração</h4>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              Analisa localmente a ordem das linhas e o texto após sanitização.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runExtractionPreview()}
            disabled={currentExtractionPreviewState.status === 'loading'}
            className="shrink-0 rounded-lg border border-blue-600 px-4 py-2 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-wait disabled:opacity-60 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/40"
          >
            {currentExtractionPreviewState.status === 'loading'
              ? 'A analisar…'
              : 'Pré-visualizar texto extraído'}
          </button>
        </div>

        {currentExtractionPreviewState.status === 'loading' && (
          <div role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            A analisar o PDF num processo local…
          </div>
        )}

        {currentExtractionPreviewState.status === 'error' && (
          <div role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {currentExtractionPreviewState.message}
          </div>
        )}

        {extractionPreview && (
          <div className="mt-4 space-y-4">
            <div className="space-y-1 rounded-lg border border-neutral-200 bg-white/70 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-300">
              <p>
                {extractionPreview.mode === 'image-only'
                  ? 'O PDF parece ser digitalizado. Esta pré-visualização não executa OCR, por isso as linhas podem estar vazias; a conversão poderá reconhecer texto por OCR.'
                  : 'São mostradas as linhas da camada de texto do PDF. O OCR de páginas esparsas ou digitalizadas usado durante a conversão não está incluído.'}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {extractionPreview.pages.length} de {extractionPreview.pageCount} páginas disponíveis para inspeção.
              </p>
              {extractionPreview.truncated && (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  O diagnóstico foi limitado para manter a resposta leve; algumas páginas, linhas ou textos podem estar incompletos.
                </p>
              )}
            </div>

            {selectedDiagnosticPage ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label="Página anterior na pré-visualização"
                    disabled={selectedDiagnosticPagePosition <= 0}
                    onClick={() => changeDiagnosticPage(-1)}
                    className="rounded-lg border border-neutral-300 p-2 text-neutral-700 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Página
                    <select
                      aria-label="Selecionar página para diagnóstico"
                      value={selectedDiagnosticPage.index}
                      onChange={(event) => handleDiagnosticPageChange(Number(event.target.value))}
                      className="max-w-[min(60vw,20rem)] rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                    >
                      {extractionPreview.pages.map((page) => (
                        <option key={page.index} value={page.index}>
                          {page.index + 1} — {page.lines.length} linhas
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label="Página seguinte na pré-visualização"
                    disabled={selectedDiagnosticPagePosition >= extractionPreview.pages.length - 1}
                    onClick={() => changeDiagnosticPage(1)}
                    className="rounded-lg border border-neutral-300 p-2 text-neutral-700 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid items-start gap-4 lg:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)]">
                  <div>
                    <div
                      className="relative mx-auto w-full max-w-xs overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-sm dark:border-neutral-600 dark:bg-neutral-700"
                      style={{
                        aspectRatio: `${Math.max(1, selectedDiagnosticPage.width)} / ${Math.max(1, selectedDiagnosticPage.height)}`
                      }}
                    >
                      {currentDiagnosticImageState?.status === 'ready' ? (
                        <img
                          src={currentDiagnosticImageState.dataUrl}
                          alt={`Página ${selectedDiagnosticPage.index + 1} em alta resolução`}
                          className="absolute inset-0 h-full w-full object-fill"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-neutral-200 dark:bg-neutral-600" aria-hidden="true" />
                      )}
                      <div className="absolute inset-0" aria-hidden="true">
                        {selectedDiagnosticPage.lines.map((line, lineIndex) => {
                          const pageWidth = Math.max(1, selectedDiagnosticPage.width)
                          const pageHeight = Math.max(1, selectedDiagnosticPage.height)
                          const left = Math.max(0, Math.min(100, (line.x / pageWidth) * 100))
                          const boxWidth = Math.max(
                            0,
                            Math.min(100 - left, Math.max(1.5, (line.width / pageWidth) * 100))
                          )
                          const boxHeight = Math.max(1, Math.min(8, (line.fontSize / pageHeight) * 100))
                          const top = Math.max(
                            0,
                            Math.min(100 - boxHeight, 100 - (line.y / pageHeight) * 100 - boxHeight)
                          )
                          return (
                            <div
                              key={`${selectedDiagnosticPage.index}-${lineIndex}`}
                              title={`${lineIndex + 1}. ${line.text}`}
                              className="absolute border border-blue-600 bg-sky-400/20 dark:border-sky-300"
                              style={{
                                left: `${left}%`,
                                top: `${top}%`,
                                width: `${boxWidth}%`,
                                height: `${boxHeight}%`
                              }}
                            >
                              <span className="absolute left-0 top-0 rounded-br bg-blue-700 px-0.5 text-[8px] font-bold leading-3 text-white">
                                {lineIndex + 1}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        Página {selectedDiagnosticPage.index + 1}
                      </span>
                    </div>
                    {currentDiagnosticImageState?.status === 'failed' ? (
                      <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
                        Não foi possível gerar a imagem de alta resolução: {currentDiagnosticImageState.message}
                      </p>
                    ) : currentDiagnosticImageState?.status !== 'ready' ? (
                      <p role="status" aria-live="polite" className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        A gerar a imagem de alta resolução ({DIAGNOSTIC_RENDER_WIDTH}px)…
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                      Caixas numeradas na ordem de leitura. Coordenadas em unidades PDF: x desde a esquerda e y desde a margem inferior.
                    </p>
                  </div>

                  <div className="min-w-0">
                    <h5 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      Linhas extraídas ({selectedDiagnosticPage.lines.length})
                    </h5>
                    {selectedDiagnosticPage.lines.length > 0 ? (
                      <ol className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                        {selectedDiagnosticPage.lines.map((line, lineIndex) => (
                          <li
                            key={`${selectedDiagnosticPage.index}-line-${lineIndex}`}
                            className="flex min-w-0 gap-2 rounded-md bg-white/70 px-2 py-1.5 dark:bg-neutral-900/40"
                          >
                            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-blue-600 px-1 text-[10px] font-bold text-white">
                              {lineIndex + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="break-words text-sm text-neutral-900 dark:text-neutral-100">{line.text}</p>
                              <p className="mt-0.5 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                                x {line.x.toFixed(1)} · y {line.y.toFixed(1)} · largura {line.width.toFixed(1)} · fonte {line.fontSize.toFixed(1)} · {line.bold ? 'negrito' : 'normal'}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="rounded-md bg-white/70 px-3 py-3 text-sm text-neutral-500 dark:bg-neutral-900/40 dark:text-neutral-400">
                        Não foram encontradas linhas na camada de texto desta página.
                      </p>
                    )}
                  </div>
                </div>

                <section className="border-t border-neutral-200 pt-4 dark:border-neutral-700">
                  <h5 className="font-semibold text-neutral-900 dark:text-neutral-100">
                    Parágrafos após sanitização — página {selectedDiagnosticPage.index + 1}
                  </h5>
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {selectedDiagnosticParagraphs.length > 0 ? (
                      selectedDiagnosticParagraphs.map((paragraph, paragraphIndex) => (
                        <article
                          key={`${paragraph.startPage}-${paragraphIndex}`}
                          className="rounded-lg bg-white/70 px-3 py-2 dark:bg-neutral-900/40"
                        >
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                            Começa na página {paragraph.startPage + 1}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                            {paragraph.text}
                          </p>
                        </article>
                      ))
                    ) : (
                      <p className="rounded-lg bg-white/70 px-3 py-2 text-sm text-neutral-500 dark:bg-neutral-900/40 dark:text-neutral-400">
                        Nenhum parágrafo começa nesta página. Um parágrafo iniciado antes pode continuar aqui.
                      </p>
                    )}
                  </div>
                </section>
              </>
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Não há páginas disponíveis para mostrar nesta pré-visualização.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
