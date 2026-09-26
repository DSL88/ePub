import { isChapterMarker, type SanitizedParagraph } from './textSanitizer'
import type { PdfPageContent } from './pdfInspector'

export type BoundaryDecision = 'join' | 'break' | 'chapter'

export type PageQualityLevel = 'good' | 'fair' | 'poor'

export interface PageQuality {
  /** 0-based index da página PDF */
  pageIndex: number
  level: PageQualityLevel
  /** caracteres de corpo (sem cabeçalho/rodapé, que já vêm excluídos) */
  chars: number
  reason: string
}

export interface BoundarySuggestion {
  /** 0-based: página de origem */
  fromPage: number
  /** 0-based: página seguinte (= fromPage + 1) */
  toPage: number
  suggestion: BoundaryDecision
  reason: string
  /** até 3 últimas linhas não vazias da página de origem */
  tail: string[]
  /** até 3 primeiras linhas não vazias da página seguinte */
  head: string[]
  /** a primeira linha da página seguinte está em negrito (provável título) */
  headIsTitle: boolean
}

/** Overrides manuais do utilizador, indexados pela página de destino (0-based). */
export type BoundaryOverrides = Record<number, BoundaryDecision>

const SENTENCE_END_RE = /[.!?…]["»'”’)]?$/
const PHYSICAL_HYPHEN_RE = /[-\u2010]$/

function bodyLineTexts(page: PdfPageContent): string[] {
  const fromLines = (page.lines ?? []).map((line) => line.text.trim()).filter(Boolean)
  if (fromLines.length > 0) {
    return fromLines
  }
  if (typeof page.text === 'string' && page.text.trim()) {
    return page.text.split('\n').map((line) => line.trim()).filter(Boolean)
  }
  return []
}

function bodyChars(page: PdfPageContent): number {
  return bodyLineTexts(page).join(' ').length
}

/**
 * Classificação rápida e barata da qualidade visual/textual por página.
 * NÃO corre OCR: usa apenas a camada de texto + flags visuais do inspect
 * (imageOnly/hasVisual/sparse). O OCR completo continua a ser lazy, na
 * conversão, só nas páginas que precisam.
 */
export function assessPageQuality(pages: PdfPageContent[]): PageQuality[] {
  return pages.map((page, index) => {
    const chars = bodyChars(page)
    const pageIndex = page.index ?? index

    if (page.imageOnly) {
      return {
        pageIndex,
        level: 'poor',
        chars,
        reason: 'Só-imagem (mapa/gravura) — vai rasterizar'
      }
    }
    if (chars === 0) {
      return {
        pageIndex,
        level: 'poor',
        chars,
        reason: page.hasVisual
          ? 'Sem texto legível + visual — provável figura/scan fraco'
          : 'Sem texto — vazia ou digitalizada (precisa OCR)'
      }
    }
    if (chars < 80 || page.sparse) {
      return {
        pageIndex,
        level: 'fair',
        chars,
        reason: page.hasVisual || page.illustration
          ? 'Pouco texto + imagem — ilustração'
          : 'Pouco texto — possível título ou scan fraco'
      }
    }
    if (page.hasVisual || page.illustration) {
      return { pageIndex, level: 'fair', chars, reason: 'Texto denso com imagem' }
    }
    return { pageIndex, level: 'good', chars, reason: 'Texto corrido' }
  })
}

/**
 * Sugestão automática por fronteira (N-1 decisões, não palavra-a-palavra).
 * Espelha a regra de junção do sanitizer: hífen + minúscula ou frase sem
 * pontuação terminal COM o fragmento a chegar ao fundo da página = continua;
 * marcador de capítulo = novo capítulo; caso contrário = novo parágrafo.
 * Páginas vazias/ilustração nunca juntam.
 */
export function suggestBoundaries(pages: PdfPageContent[]): BoundarySuggestion[] {
  const suggestions: BoundarySuggestion[] = []
  for (let i = 0; i < pages.length - 1; i++) {
    const current = pages[i]
    const next = pages[i + 1]
    const currentLines = (current.lines ?? []).filter((line) => line.text.trim())
    const nextLines = (next.lines ?? []).filter((line) => line.text.trim())
    const tail = bodyLineTexts(current).slice(-3)
    const head = bodyLineTexts(next).slice(0, 3)
    const fromPage = current.index ?? i
    const toPage = next.index ?? i + 1
    // Negrito na primeira linha da página seguinte = provável título. Só a
    // camada de texto traz peso de fonte; no OCR vem sempre false.
    const headIsTitle = nextLines.length > 0 && nextLines[0].bold === true

    if (tail.length === 0 || head.length === 0 || current.imageOnly || next.imageOnly) {
      suggestions.push({
        fromPage,
        toPage,
        suggestion: 'break',
        reason: 'Página ilustração/vazia — não juntar',
        tail,
        head,
        headIsTitle
      })
      continue
    }

    const lastLine = tail[tail.length - 1].trim()
    const firstLine = head[0].trim()

    if (isChapterMarker(firstLine)) {
      suggestions.push({
        fromPage,
        toPage,
        suggestion: 'chapter',
        reason: 'Marcador de capítulo no topo da página seguinte',
        tail,
        head,
        headIsTitle
      })
      continue
    }

    const hyphenContinuation =
      PHYSICAL_HYPHEN_RE.test(lastLine.trimEnd()) && /^[a-zà-öø-ÿ]/.test(firstLine.trimStart())
    if (hyphenContinuation) {
      suggestions.push({
        fromPage,
        toPage,
        suggestion: 'join',
        reason: 'Palavra partida com hífen',
        tail,
        head,
        headIsTitle
      })
      continue
    }

    // Com geometria, um fragmento inacabado a meio da página é ambíguo
    // (fim de coluna/bloco, não viragem) — tal como no sanitizer, só sugere
    // "continua" se chegar à zona inferior. Hífen já tratado acima.
    const height = current.height ?? 0
    const lastLineY = currentLines.length > 0 ? currentLines[currentLines.length - 1].y : NaN
    const reachesBottom = !(height > 0 && Number.isFinite(lastLineY)) || lastLineY <= height * 0.25
    if (!SENTENCE_END_RE.test(lastLine.trimEnd())) {
      if (reachesBottom) {
        suggestions.push({
          fromPage,
          toPage,
          suggestion: 'join',
          reason: 'Frase continua na página seguinte',
          tail,
          head,
          headIsTitle
        })
      } else {
        suggestions.push({
          fromPage,
          toPage,
          suggestion: 'break',
          reason: 'Fragmento longe do fundo — provável novo bloco',
          tail,
          head,
          headIsTitle
        })
      }
      continue
    }

    suggestions.push({
      fromPage,
      toPage,
      suggestion: 'break',
      reason: 'Frase terminada — novo parágrafo',
      tail,
      head,
      headIsTitle
    })
  }
  return suggestions
}

/** Normaliza overrides vindos do IPC (chaves string → número, valores válidos). */
export function normalizeBoundaryOverrides(value: unknown): BoundaryOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: BoundaryOverrides = {}
  for (const [key, decision] of Object.entries(value as Record<string, unknown>)) {
    const pageIndex = Number(key)
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100_000) {
      continue
    }
    if (decision === 'join' || decision === 'break' || decision === 'chapter') {
      out[pageIndex] = decision
    }
  }
  return out
}

/**
 * Marca de capítulo (1-based, como espera detectChapters) derivada dos
 * overrides 'chapter' + marcas manuais por página do utilizador.
 */
export function boundaryChaptersToMarks(overrides: BoundaryOverrides): number[] {
  return Object.entries(overrides)
    .filter(([, decision]) => decision === 'chapter')
    .map(([toPage]) => Number(toPage) + 1)
    .filter((mark) => Number.isInteger(mark) && mark >= 1)
    .sort((a, b) => a - b)
}

export type { SanitizedParagraph }
