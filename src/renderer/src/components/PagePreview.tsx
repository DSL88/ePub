import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { BoundaryDecision, BoundaryOverrides, ExtractionPreview, ExtractionPreviewLine, LineMark, ManualAnchor, ManualLine, PageLineOrder } from '../types'

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
  onBoundaryOverrides?: (overrides: BoundaryOverrides) => void
  onLineMarks?: (marks: LineMark[]) => void
  onManualLines?: (lines: ManualLine[]) => void
  onLineOrder?: (orders: PageLineOrder[]) => void
  onOcrPsm?: (psm: Record<number, string>) => void
}

const BOUNDARY_LABELS: Record<BoundaryDecision, string> = {
  join: 'Continua',
  break: 'Novo parágrafo',
  chapter: 'Fim de capítulo'
}

const LINE_MARK_LABELS: Record<LineMark['level'], string> = {
  chapter: 'Capítulo',
  subchapter: 'Subcapítulo',
  ignore: 'Ignorar'
}

const LINE_MARK_CHIP: Record<LineMark['level'], string> = {
  chapter: 'bg-purple-600',
  subchapter: 'bg-teal-600',
  ignore: 'bg-rose-600'
}

const LOW_OCR_CONFIDENCE = 65

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

export default function PagePreview({ file, onChapterMarks, onBoundaryOverrides, onLineMarks, onManualLines, onLineOrder, onOcrPsm }: PagePreviewProps) {
  const [thumbs, setThumbs] = useState<Record<number, ThumbState>>({})
  const [numPages, setNumPages] = useState(0)
  const [marks, setMarks] = useState<number[]>([])
  const [boundaryOverrides, setBoundaryOverrides] = useState<BoundaryOverrides>({})
  const [lineMarks, setLineMarks] = useState<LineMark[]>([])
  const [ocrByPage, setOcrByPage] = useState<Record<number, { lines: ExtractionPreviewLine[]; meanConfidence: number; truncated: boolean; psm: string }>>({})
  const [ocrPsmByPage, setOcrPsmByPage] = useState<Record<number, string>>({})
  const [manualByPage, setManualByPage] = useState<Record<number, Array<{ text: string; anchor: ManualAnchor }>>>({})
  const [orderByPage, setOrderByPage] = useState<Record<number, string[]>>({})
  const [manualText, setManualText] = useState('')
  const [manualAnchor, setManualAnchor] = useState<ManualAnchor>('start')
  const [ocrLoadingPage, setOcrLoadingPage] = useState<number | null>(null)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [extractionPreviewState, setExtractionPreviewState] = useState<ExtractionPreviewState>({ status: 'idle' })
  const [extractionPreviewPath, setExtractionPreviewPath] = useState<string | null>(null)
  const [selectedPreviewPage, setSelectedPreviewPage] = useState(0)
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
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
      setBoundaryOverrides({})
      setLineMarks([])
      setOcrByPage({})
      setOcrPsmByPage({})
      setManualByPage({})
      setOrderByPage({})
      setManualText('')
      setOcrLoadingPage(null)
      setOcrError(null)
      setNumPages(0)
      setPdfLoadState('loading')
      setDiagnosticImageState({ status: 'idle' })
      setExtractionPreviewState({ status: 'idle' })
      setExtractionPreviewPath(null)
      setSelectedPreviewPage(0)
      setSelectedLine(null)
      onChapterMarks([])
      onBoundaryOverrides?.({})
      onLineMarks?.([])
      onManualLines?.([])
      onLineOrder?.([])
      onOcrPsm?.({})
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

  const setBoundaryDecision = (toPage: number, decision: BoundaryDecision): void => {
    setBoundaryOverrides((prev) => {
      const current = prev[toPage]
      const next = { ...prev }
      if (current === decision) {
        delete next[toPage]
      } else {
        next[toPage] = decision
      }
      onBoundaryOverrides?.(next)
      return next
    })
  }

  // Mudar de página limpa a linha destacada.
  useEffect(() => {
    setSelectedLine(null)
  }, [selectedDiagnosticPage?.index])

  const selectLine = (lineIndex: number): void => {
    const pageIndex = selectedDiagnosticPage?.index
    if (pageIndex === undefined || pageIndex === null) return
    const next = selectedLine === lineIndex ? null : lineIndex
    setSelectedLine(next)
    if (next !== null) {
      requestAnimationFrame(() => {
        document
          .getElementById(`diag-line-${pageIndex}-${next}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
  }

  const qualityByPage = new Map(
    (extractionPreview?.qualities ?? []).map((quality) => [quality.pageIndex, quality])
  )
  const boundaries = extractionPreview?.boundaries ?? []
  // Fronteira de entrada da página selecionada (a anterior -> esta).
  const incomingBoundary = selectedDiagnosticPage
    ? boundaries.find((boundary) => boundary.toPage === selectedDiagnosticPage.index)
    : undefined
  const incomingOverride = selectedDiagnosticPage ? boundaryOverrides[selectedDiagnosticPage.index] : undefined
  const previousPage = selectedDiagnosticPage
    ? extractionPreview?.pages.find((page) => page.index === selectedDiagnosticPage.index - 1)
    : undefined
  const previousTail = previousPage
    ? ((selectedDiagnosticPage && ocrByPage[previousPage.index]?.lines) ?? previousPage.lines).slice(-2)
    : []

  const normalizeLineText = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

  // Linhas ignoradas não aparecem no contexto da abertura (tal como já não
  // contam na conversão). A lista de linhas mantém-nas para se poder reverter.
  const previousIgnored = new Set<string>()
  if (selectedDiagnosticPage) {
    for (const mark of lineMarks) {
      if (mark.pageIndex === selectedDiagnosticPage.index - 1 && mark.level === 'ignore') {
        const norm = normalizeLineText(mark.lineText)
        if (norm) {
          previousIgnored.add(norm)
        }
      }
    }
  }
  const visiblePreviousTail = previousTail.filter((line) => {
    const norm = normalizeLineText(line.text)
    return !norm || !previousIgnored.has(norm)
  })

  /** Aplica a ordem escolhida pelo utilizador (igual ao worker da conversão). */
  const applyLineOrder = (lines: ExtractionPreviewLine[], wanted: string[] | undefined): ExtractionPreviewLine[] => {
    if (!wanted || wanted.length < 2) {
      return lines
    }
    const remaining = [...lines]
    const out: ExtractionPreviewLine[] = []
    for (const text of wanted) {
      const at = remaining.findIndex((line) => normalizeLineText(line.text) === normalizeLineText(text))
      if (at >= 0) {
        out.push(...remaining.splice(at, 1))
      }
    }
    out.push(...remaining)
    return out
  }

  /** Coordenadas sintéticas para linhas manuais (mesma fórmula da conversão). */
  const synthesizeManualLine = (
    text: string,
    anchor: ManualAnchor,
    neighbor: ExtractionPreviewLine | undefined,
    pageWidth: number,
    pageHeight: number
  ): ExtractionPreviewLine => ({
    text,
    x: neighbor?.x ?? 50,
    y: anchor === 'start' ? pageHeight * 0.94 : pageHeight * 0.06,
    width: Math.max(0, neighbor?.width ?? pageWidth * 0.8),
    fontSize: (neighbor && neighbor.fontSize > 0 ? neighbor.fontSize : 0) || 12,
    bold: false
  })

  // Linhas efetivas da página selecionada: camada de texto ou OCR on-demand,
  // depois ordem do utilizador, depois linhas manuais (início + fim).
  const baseDiagnosticLines: ExtractionPreviewLine[] =
    (selectedDiagnosticPage && ocrByPage[selectedDiagnosticPage.index]?.lines) ??
    selectedDiagnosticPage?.lines ??
    []
  const orderedBaseLines = selectedDiagnosticPage
    ? applyLineOrder(baseDiagnosticLines, orderByPage[selectedDiagnosticPage.index])
    : baseDiagnosticLines
  const manualStarts = selectedDiagnosticPage ? (manualByPage[selectedDiagnosticPage.index] ?? []).filter((entry) => entry.anchor === 'start') : []
  const manualEnds = selectedDiagnosticPage ? (manualByPage[selectedDiagnosticPage.index] ?? []).filter((entry) => entry.anchor === 'end') : []
  const firstBase = orderedBaseLines.find((line) => line.text.trim())
  const lastBase = [...orderedBaseLines].reverse().find((line) => line.text.trim())
  const pageWidthForManual = Math.max(1, selectedDiagnosticPage?.width ?? 600)
  const pageHeightForManual = Math.max(1, selectedDiagnosticPage?.height ?? 800)
  const effectiveLines: ExtractionPreviewLine[] = [
    ...manualStarts.map((entry) => synthesizeManualLine(entry.text, 'start', firstBase, pageWidthForManual, pageHeightForManual)),
    ...orderedBaseLines,
    ...manualEnds.map((entry) => synthesizeManualLine(entry.text, 'end', lastBase, pageWidthForManual, pageHeightForManual))
  ]
  /** índices de effectiveLines que são linhas manuais */
  const isManualIndex = (lineIndex: number): boolean =>
    lineIndex < manualStarts.length || lineIndex >= manualStarts.length + orderedBaseLines.length
  const ocrInfo = selectedDiagnosticPage ? ocrByPage[selectedDiagnosticPage.index] : undefined
  const pagePsm = selectedDiagnosticPage ? (ocrPsmByPage[selectedDiagnosticPage.index] ?? '3') : '3'

  const runPageOcr = async (pageIndex: number, psm?: string): Promise<void> => {
    if (!file || ocrLoadingPage !== null) return
    const mode = psm ?? ocrPsmByPage[pageIndex] ?? '3'
    setOcrLoadingPage(pageIndex)
    setOcrError(null)
    try {
      const result = await window.converterAPI.previewPageOcr(file.path, pageIndex, mode)
      setOcrByPage((prev) => ({
        ...prev,
        [result.pageIndex]: {
          lines: result.lines,
          meanConfidence: result.meanConfidence,
          truncated: result.truncated,
          psm: result.psm
        }
      }))
      setOcrPsmByPage((prev) => {
        const next = { ...prev, [result.pageIndex]: result.psm }
        onOcrPsm?.(next)
        return next
      })
      setSelectedLine(null)
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrLoadingPage(null)
    }
  }

  const changePagePsm = (pageIndex: number, psm: string): void => {
    setOcrPsmByPage((prev) => {
      const next = { ...prev, [pageIndex]: psm }
      onOcrPsm?.(next)
      return next
    })
    void runPageOcr(pageIndex, psm)
  }

  const moveSelectedLine = (direction: -1 | 1): void => {
    const pageIndex = selectedDiagnosticPage?.index
    if (pageIndex === undefined || selectedLine === null) return
    if (isManualIndex(selectedLine)) return
    const target = selectedLine + direction
    if (target < 0 || target >= effectiveLines.length || isManualIndex(target)) return
    const reordered = [...orderedBaseLines]
    const from = selectedLine - manualStarts.length
    const to = target - manualStarts.length
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    const orderedTexts = reordered.map((line) => line.text)
    setOrderByPage((prev) => ({ ...prev, [pageIndex]: orderedTexts }))
    onLineOrder?.(
      Object.entries({ ...orderByPage, [pageIndex]: orderedTexts }).map(([key, value]) => ({
        pageIndex: Number(key),
        orderedTexts: value
      }))
    )
    setSelectedLine(target)
  }

  const addManualLine = (): void => {
    const pageIndex = selectedDiagnosticPage?.index
    const text = manualText.replace(/\s+/g, ' ').trim()
    if (pageIndex === undefined || !text) return
    setManualByPage((prev) => {
      const next = { ...prev, [pageIndex]: [...(prev[pageIndex] ?? []), { text, anchor: manualAnchor }] }
      onManualLines?.(
        Object.entries(next).flatMap(([key, entries]) =>
          entries.map((entry) => ({ pageIndex: Number(key), anchor: entry.anchor, text: entry.text }))
        )
      )
      return next
    })
    setManualText('')
  }

  const removeManualLine = (lineIndex: number): void => {
    const pageIndex = selectedDiagnosticPage?.index
    if (pageIndex === undefined || !isManualIndex(lineIndex)) return
    // effectiveLines = [starts..., base..., ends...]: localizar a n-ésima
    // entrada da âncora correspondente no array de inserção.
    const anchor: ManualAnchor = lineIndex < manualStarts.length ? 'start' : 'end'
    const nth = anchor === 'start'
      ? lineIndex
      : lineIndex - (manualStarts.length + orderedBaseLines.length)
    setManualByPage((prev) => {
      const entries = [...(prev[pageIndex] ?? [])]
      let seen = -1
      const at = entries.findIndex((entry) => {
        if (entry.anchor !== anchor) return false
        seen++
        return seen === nth
      })
      if (at < 0) return prev
      entries.splice(at, 1)
      const next = { ...prev, [pageIndex]: entries }
      onManualLines?.(
        Object.entries(next).flatMap(([key, list]) =>
          list.map((entry) => ({ pageIndex: Number(key), anchor: entry.anchor, text: entry.text }))
        )
      )
      return next
    })
    setSelectedLine(null)
  }

  const markForLine = (pageIndex: number, lineText: string): LineMark | undefined =>
    lineMarks.find((mark) => mark.pageIndex === pageIndex && mark.lineText === lineText)

  const toggleLineMark = (level: LineMark['level']): void => {
    const pageIndex = selectedDiagnosticPage?.index
    const line = selectedLine !== null ? effectiveLines[selectedLine] : undefined
    if (pageIndex === undefined || !line) return
    setLineMarks((prev) => {
      const same = (mark: LineMark): boolean => mark.pageIndex === pageIndex && mark.lineText === line.text
      const existing = prev.find(same)
      const next =
        existing?.level === level
          ? prev.filter((mark) => mark !== existing)
          : [...prev.filter((mark) => !same(mark)), { pageIndex, lineIndex: selectedLine as number, lineText: line.text, level }]
      onLineMarks?.(next)
      return next
    })
  }

  const removeLineMark = (mark: LineMark): void => {
    setLineMarks((prev) => {
      const next = prev.filter((item) => item !== mark)
      onLineMarks?.(next)
      return next
    })
  }

  const clearLineMarks = (): void => {
    setLineMarks([])
    onLineMarks?.([])
  }

  const selectedWordCount = effectiveLines.reduce(
    (acc, line) => acc + line.text.split(/\s+/).filter(Boolean).length,
    0
  )
  const selectedBoldCount = effectiveLines.filter((line) => line.bold).length
  const selectedLineMark =
    selectedDiagnosticPage && selectedLine !== null && effectiveLines[selectedLine]
      ? markForLine(selectedDiagnosticPage.index, effectiveLines[selectedLine].text)
      : undefined

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
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">1</span>
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
          const quality = qualityByPage.get(page - 1)
          const qualityColor =
            quality?.level === 'good'
              ? 'bg-emerald-500'
              : quality?.level === 'fair'
                ? 'bg-amber-500'
                : quality?.level === 'poor'
                  ? 'bg-red-500'
                  : 'bg-neutral-400'
          return (
            <button
              key={page}
              data-page-tile
              data-page={page}
              type="button"
              onClick={() => toggleMark(page)}
              title={
                quality
                  ? `${marked ? 'Remover marca de capítulo' : 'Marcar como início de capítulo'} — ${quality.reason} (${quality.chars} car.)`
                  : (marked ? 'Remover marca de capítulo' : 'Marcar como início de capítulo')
              }
              className={`relative min-h-[160px] overflow-hidden rounded-xl border-2 bg-neutral-100 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-white/5 ${
                marked
                  ? 'border-blue-500 shadow-md shadow-blue-600/20 ring-1 ring-blue-500'
                  : 'border-transparent hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-md dark:hover:border-white/20'
              }`}
            >
              {thumb?.dataUrl && (
                <img src={thumb.dataUrl} alt={`Página ${page}`} className="block w-full" />
              )}
              {quality && (
                <span
                  title={`${quality.reason} (${quality.chars} car.)`}
                  className={`absolute left-1 top-1 h-2.5 w-2.5 rounded-full ${qualityColor} ring-1 ring-white/70`}
                />
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
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />texto bom</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />duvidoso</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" />mau / só-imagem</span>
        <span className="ml-auto hidden sm:inline">clica numa miniatura para marcar início de capítulo</span>
      </div>

      <section className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="flex items-center gap-2 font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">2</span>
              Diagnóstico da extração
            </h4>
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
            <div className="space-y-1 rounded-xl border border-blue-200/70 bg-blue-50/60 px-3 py-2 text-sm text-neutral-700 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-neutral-300">
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
                      {extractionPreview.pages.map((page) => {
                        const lineCount = ocrByPage[page.index]?.lines.length ?? page.lines.length
                        return (
                          <option key={page.index} value={page.index}>
                            {page.index + 1} — {lineCount} linhas{ocrByPage[page.index] ? ' (OCR)' : ''}
                          </option>
                        )
                      })}
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

                {selectedDiagnosticPage && selectedDiagnosticPage.index > 0 && incomingBoundary && (
                  <div className="rounded-xl border border-neutral-200/70 bg-neutral-50 px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                        Abertura da pág. {selectedDiagnosticPage.index + 1}
                        <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
                          auto: {BOUNDARY_LABELS[incomingBoundary.suggestion]} — {incomingBoundary.reason}
                        </span>
                        {incomingBoundary.headIsTitle && (
                          <span
                            title="A primeira linha desta página está em negrito — provável título"
                            className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                          >
                            título
                          </span>
                        )}
                        {incomingOverride && (
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                            MANUAL
                          </span>
                        )}
                      </p>
                    </div>
                    {previousTail.length > 0 && (
                      <div className="mt-1.5 rounded-lg bg-white px-2 py-1.5 text-xs leading-relaxed dark:bg-black/20">
                        <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                          Final da pág. {selectedDiagnosticPage.index}
                        </p>
                        {visiblePreviousTail.length > 0 ? (
                          visiblePreviousTail.map((line, i) => (
                            <p key={i} className="break-words text-neutral-700 dark:text-neutral-300">
                              {line.text}
                            </p>
                          ))
                        ) : (
                          <p className="italic text-neutral-400">Linhas ignoradas — não contam.</p>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Abertura da página ${selectedDiagnosticPage.index + 1}`}>
                      {(Object.keys(BOUNDARY_LABELS) as BoundaryDecision[]).map((decision) => {
                        const effective = incomingOverride ?? incomingBoundary.suggestion
                        return (
                          <button
                            key={decision}
                            type="button"
                            onClick={() => setBoundaryDecision(selectedDiagnosticPage.index, decision)}
                            title={decision === effective ? 'Clique outra vez para voltar ao automático' : undefined}
                            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              effective === decision
                                ? decision === 'join'
                                  ? 'border-emerald-600 bg-emerald-600 text-white'
                                  : decision === 'chapter'
                                    ? 'border-purple-600 bg-purple-600 text-white'
                                    : 'border-blue-600 bg-blue-600 text-white'
                                : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/10'
                            }`}
                          >
                            {BOUNDARY_LABELS[decision]}
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      “Continua” junta ao parágrafo anterior, “Novo parágrafo” separa e “Fim de capítulo” cria capítulo.
                    </p>
                  </div>
                )}

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
                      <div className="absolute inset-0">
                        {effectiveLines.map((line, lineIndex) => {
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
                            <button
                              key={`${selectedDiagnosticPage.index}-${lineIndex}`}
                              type="button"
                              onClick={() => selectLine(lineIndex)}
                              title={markForLine(selectedDiagnosticPage.index, line.text)?.level === 'ignore' ? `Linha ${lineIndex + 1} (ignorada): ${line.text}` : `Linha ${lineIndex + 1}: ${line.text}`}
                              aria-label={`Linha ${lineIndex + 1}: ${line.text}`}
                              aria-pressed={selectedLine === lineIndex}
                              className={`absolute border focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                                selectedLine === lineIndex
                                  ? 'border-amber-500 bg-amber-400/30 dark:border-amber-300'
                                  : markForLine(selectedDiagnosticPage.index, line.text)?.level === 'ignore'
                                    ? 'border-rose-500/70 bg-rose-400/10 opacity-60 dark:border-rose-400/70'
                                    : isManualIndex(lineIndex)
                                      ? 'border-dashed border-slate-500 bg-slate-400/20 dark:border-slate-400'
                                      : 'border-blue-600 bg-sky-400/20 dark:border-sky-300'
                              }`}
                              style={{
                                left: `${left}%`,
                                top: `${top}%`,
                                width: `${boxWidth}%`,
                                height: `${boxHeight}%`
                              }}
                            >
                              <span className={`absolute left-0 top-0 rounded-br px-0.5 text-[8px] font-bold leading-3 text-white ${
                                selectedLine === lineIndex ? 'bg-amber-600' : 'bg-blue-700'
                              }`}>
                                {lineIndex + 1}
                              </span>
                            </button>
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
                      Caixas numeradas na ordem de leitura — clica numa caixa ou numa linha para destacar. Coordenadas em unidades PDF: x desde a esquerda e y desde a margem inferior.
                    </p>
                  </div>

                  <div className="min-w-0">
                    <h5 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      Linhas extraídas — {effectiveLines.length} linhas · {selectedWordCount} palavras · {selectedBoldCount} em negrito
                    </h5>
                    {selectedDiagnosticPage && (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                          OCR
                          <select
                            aria-label="Modo de segmentação do OCR"
                            value={pagePsm}
                            disabled={ocrLoadingPage !== null}
                            onChange={(event) => changePagePsm(selectedDiagnosticPage.index, event.target.value)}
                            className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs font-medium text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-neutral-200"
                          >
                            <option value="3">Auto</option>
                            <option value="6">Bloco uniforme</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => void runPageOcr(selectedDiagnosticPage.index)}
                          disabled={ocrLoadingPage !== null}
                          title="Corre o OCR desta página outra vez (útil quando faltam linhas)"
                          className="rounded-lg border border-blue-600 px-2 py-1 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-wait disabled:opacity-60 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/40"
                        >
                          {ocrLoadingPage === selectedDiagnosticPage.index ? 'A reconhecer…' : 'Repetir OCR'}
                        </button>
                        {ocrInfo && (
                          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                            {ocrInfo.meanConfidence}% conf. · modo {ocrInfo.psm}
                          </span>
                        )}
                      </div>
                    )}
                    {selectedDiagnosticPage && (
                      <form
                        className="mb-2 flex flex-wrap items-center gap-1.5"
                        onSubmit={(event) => {
                          event.preventDefault()
                          addManualLine()
                        }}
                      >
                        <input
                          type="text"
                          value={manualText}
                          onChange={(event) => setManualText(event.target.value)}
                          placeholder="Linha em falta (ex.: 1ª linha cortada)…"
                          aria-label="Texto da linha em falta"
                          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/15 dark:bg-white/5 dark:text-neutral-100 dark:placeholder-neutral-500"
                        />
                        <select
                          aria-label="Posição da linha manual"
                          value={manualAnchor}
                          onChange={(event) => setManualAnchor(event.target.value as ManualAnchor)}
                          className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs font-medium text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/15 dark:bg-white/5 dark:text-neutral-200"
                        >
                          <option value="start">No início</option>
                          <option value="end">No fim</option>
                        </select>
                        <button
                          type="submit"
                          disabled={!manualText.trim()}
                          className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/10"
                        >
                          Adicionar linha
                        </button>
                      </form>
                    )}
                    {lineMarks.length > 0 && (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        {lineMarks.map((mark, i) => (
                          <span
                            key={`${mark.pageIndex}-${mark.lineIndex}-${i}`}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              mark.level === 'chapter'
                                ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200'
                                : mark.level === 'subchapter'
                                  ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200'
                                  : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200'
                            }`}
                            title={`Pág. ${mark.pageIndex + 1}, linha ${mark.lineIndex + 1}: ${mark.lineText}`}
                          >
                            Pág. {mark.pageIndex + 1} · L{mark.lineIndex + 1} · {LINE_MARK_LABELS[mark.level]}
                            <button
                              type="button"
                              onClick={() => removeLineMark(mark)}
                              aria-label={`Remover marca ${LINE_MARK_LABELS[mark.level]} da página ${mark.pageIndex + 1}`}
                              className="ml-0.5 rounded-full px-1 font-bold hover:bg-black/10"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={clearLineMarks}
                          className="text-[10px] font-semibold text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400"
                        >
                          Limpar marcas
                        </button>
                      </div>
                    )}
                    {selectedLine !== null && effectiveLines[selectedLine] && selectedDiagnosticPage && (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/30">
                        <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                          Linha {selectedLine + 1}
                          {selectedDiagnosticPage && isManualIndex(selectedLine) ? ' · manual' : ''}
                          {selectedLineMark ? ` · ${LINE_MARK_LABELS[selectedLineMark.level]}` : ''}:
                        </span>
                        {selectedDiagnosticPage && isManualIndex(selectedLine) ? (
                          <button
                            key="remove-manual"
                            type="button"
                            onClick={() => removeManualLine(selectedLine as number)}
                            className="rounded-lg border border-rose-600 bg-rose-600 px-2 py-1 text-xs font-semibold text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            Remover linha manual
                          </button>
                        ) : (
                          <>
                            {(Object.keys(LINE_MARK_LABELS) as LineMark['level'][]).map((level) => (
                              <button
                                key={level}
                                type="button"
                                onClick={() => toggleLineMark(level)}
                                aria-pressed={selectedLineMark?.level === level}
                                title={selectedLineMark?.level === level ? 'Clique outra vez para remover' : `Marcar como ${LINE_MARK_LABELS[level].toLowerCase()}`}
                                className={`rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                                  selectedLineMark?.level === level
                                    ? level === 'chapter'
                                      ? 'border-purple-600 bg-purple-600 text-white'
                                      : level === 'subchapter'
                                        ? 'border-teal-600 bg-teal-600 text-white'
                                        : 'border-rose-600 bg-rose-600 text-white'
                                    : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/10'
                                }`}
                              >
                                {LINE_MARK_LABELS[level]}
                              </button>
                            ))}
                            <span className="inline-flex gap-1" role="group" aria-label="Reordenar linha">
                              <button
                                type="button"
                                onClick={() => moveSelectedLine(-1)}
                                aria-label="Mover linha para cima"
                                title="Mover linha para cima"
                                className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-bold text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/10"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                onClick={() => moveSelectedLine(1)}
                                aria-label="Mover linha para baixo"
                                title="Mover linha para baixo"
                                className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-bold text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/10"
                              >
                                ↓
                              </button>
                            </span>
                          </>
                        )}
                      </div>
                    )}
                    {effectiveLines.length > 0 ? (
                      <ol className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                        {effectiveLines.map((line, lineIndex) => (
                          <li
                            key={`${selectedDiagnosticPage.index}-line-${lineIndex}`}
                            id={`diag-line-${selectedDiagnosticPage.index}-${lineIndex}`}
                            className={`min-w-0 scroll-mt-2 rounded-md focus-within:ring-2 focus-within:ring-amber-500 ${
                              selectedLine === lineIndex
                                ? 'ring-2 ring-amber-500'
                                : ''
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => selectLine(lineIndex)}
                              aria-pressed={selectedLine === lineIndex}
                              className="flex w-full min-w-0 gap-2 rounded-xl bg-neutral-100 px-2.5 py-2 text-left transition-colors hover:bg-neutral-200/70 focus:outline-none dark:bg-white/5 dark:hover:bg-white/10"
                            >
                            <span className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[10px] font-bold text-white ${
                              selectedLine === lineIndex ? 'bg-amber-600' : 'bg-blue-600'
                            }`}>
                              {lineIndex + 1}
                            </span>
                            {selectedDiagnosticPage &&
                              (() => {
                                if (isManualIndex(lineIndex)) {
                                  return (
                                    <span className="flex h-5 shrink-0 items-center rounded bg-slate-500 px-1 text-[10px] font-bold text-white">
                                      Manual
                                    </span>
                                  )
                                }
                                const mark = markForLine(selectedDiagnosticPage.index, line.text)
                                return mark ? (
                                  <span
                                    className={`flex h-5 shrink-0 items-center rounded px-1 text-[10px] font-bold text-white ${LINE_MARK_CHIP[mark.level]}`}
                                  >
                                    {mark.level === 'chapter' ? 'Cap.' : mark.level === 'subchapter' ? 'Sub' : 'Ign.'}
                                  </span>
                                ) : null
                              })()}
                            <div className="min-w-0">
                              <p className={`break-words text-sm text-neutral-900 dark:text-neutral-100 ${
                                selectedDiagnosticPage && markForLine(selectedDiagnosticPage.index, line.text)?.level === 'ignore'
                                  ? 'opacity-50 line-through'
                                  : ''
                              }`}>{line.text}</p>
                              <p className="mt-0.5 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                                x {line.x.toFixed(1)} · y {line.y.toFixed(1)} · largura {line.width.toFixed(1)} · fonte {line.fontSize.toFixed(1)} · {line.bold ? 'negrito' : 'normal'}
                              </p>
                            </div>
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <div className="rounded-xl border border-neutral-200/70 bg-neutral-50 px-3 py-3 dark:border-white/10 dark:bg-white/5">
                        <p className="text-sm text-neutral-500 dark:text-neutral-400">
                          Não foram encontradas linhas na camada de texto desta página.
                          {extractionPreview?.mode === 'image-only'
                            ? ' O PDF parece digitalizado — corre o OCR só desta página para veres as linhas.'
                            : ' Pode ser página ilustrada ou vazia — o OCR pode não trazer nada útil.'}
                        </p>
                        {selectedDiagnosticPage && (
                          <button
                            type="button"
                            onClick={() => void runPageOcr(selectedDiagnosticPage.index)}
                            disabled={ocrLoadingPage !== null}
                            className="mt-2 rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-wait disabled:opacity-60 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          >
                            {ocrLoadingPage === selectedDiagnosticPage.index
                              ? 'A reconhecer texto…'
                              : `Reconhecer texto da pág. ${selectedDiagnosticPage.index + 1} (OCR)`}
                          </button>
                        )}
                        {ocrError && (
                          <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">
                            {ocrError}
                          </p>
                        )}
                      </div>
                    )}
                    {ocrInfo && (
                      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                        Texto via OCR — confiança média {ocrInfo.meanConfidence}%.
                        O negrito não é detetado por OCR.
                        {ocrInfo.meanConfidence < LOW_OCR_CONFIDENCE && (
                          <> Atenção: texto pouco fiável — na conversão esta página pode sair como imagem.</>
                        )}
                        {ocrInfo.truncated && <> Mostradas as primeiras linhas.</>}
                      </p>
                    )}
                  </div>
                </div>

                <section className="border-t border-neutral-200 pt-5 dark:border-white/10">
                  <h5 className="font-semibold text-neutral-900 dark:text-neutral-100">
                    Parágrafos após sanitização — página {selectedDiagnosticPage.index + 1}
                  </h5>
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {selectedDiagnosticParagraphs.length > 0 ? (
                      selectedDiagnosticParagraphs.map((paragraph, paragraphIndex) => (
                        <article
                          key={`${paragraph.startPage}-${paragraphIndex}`}
                          className="rounded-xl border border-neutral-200/70 bg-neutral-50 px-3 py-2 dark:border-white/10 dark:bg-white/5"
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
                      <p className="rounded-xl border border-neutral-200/70 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-white/10 dark:bg-white/5 dark:text-neutral-400">
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
