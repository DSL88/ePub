import { useCallback, useEffect, useState } from 'react'
import type { ConversionProgress, Metadata } from '../types'

export type ConversionStatus = 'idle' | 'converting' | 'done' | 'error'

export interface UseConversionState {
  status: ConversionStatus
  progress: ConversionProgress
  outputPath: string | null
  error: string | null
}

export interface UseConversionResult extends UseConversionState {
  start: (
    file: { path: string },
    metadata: Metadata,
    options: Record<string, unknown>
  ) => void
  reset: () => void
}

const initialState: UseConversionState = {
  status: 'idle',
  progress: { stage: '', percent: 0 },
  outputPath: null,
  error: null
}

export function useConversion(): UseConversionResult {
  const [state, setState] = useState<UseConversionState>(initialState)

  useEffect(() => {
    const offProgress = window.converterAPI.onProgress((data) => {
      setState((prev) => ({
        ...prev,
        progress: { stage: data.stage, percent: data.percent }
      }))
    })
    const offDone = window.converterAPI.onDone((data) => {
      setState((prev) => ({
        ...prev,
        status: 'done',
        outputPath: data.outputPath,
        progress: { ...prev.progress, percent: 100 }
      }))
    })
    const offError = window.converterAPI.onError((data) => {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: data.message
      }))
    })
    return () => {
      offProgress()
      offDone()
      offError()
    }
  }, [])

  const start = useCallback(
    (
      file: { path: string },
      metadata: Metadata,
      options: Record<string, unknown>
    ) => {
      setState({ ...initialState, status: 'converting' })
      void window.converterAPI.startConversion({
        filePath: file.path,
        metadata,
        options
      })
    },
    []
  )

  const reset = useCallback(() => {
    setState(initialState)
  }, [])

  return { ...state, start, reset }
}
