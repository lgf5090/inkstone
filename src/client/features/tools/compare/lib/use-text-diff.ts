/**
 * The comparison the text view draws, computed in place for small inputs and in a worker for large
 * ones. The decision is by size, not by preference: below the threshold the synchronous answer is
 * already faster than a round trip, above it the round trip is what keeps the tab alive.
 */
import { useEffect, useRef, useState } from 'react'
import { computeTextDiff } from '@shared/tools/compare/engine'
import { TEXT_LIMITS, type TextCompareOptions, type TextDiffResult } from '@shared/tools/compare/types'

export interface TextDiffState {
  diff: TextDiffResult | null
  pending: boolean
  error: string | null
}

interface WorkerAnswer {
  ok: boolean
  result?: TextDiffResult
  error?: string
}

function approximateBytes(left: string, right: string): number {
  // `length` counts UTF-16 units; three bytes per unit is well above the real average for prose and
  // code, which is all this threshold needs to be conservative about.
  return (left.length + right.length) * 3
}

export function useTextDiff(left: string, right: string, options: TextCompareOptions): TextDiffState {
  const [state, setState] = useState<TextDiffState>({ diff: null, pending: false, error: null })
  const workerRef = useRef<Worker | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    const id = ++requestId.current
    const settle = (result: TextDiffResult | null, error: string | null) => {
      if (requestId.current !== id) return
      setState({ diff: result, pending: false, error })
    }

    if (approximateBytes(left, right) <= TEXT_LIMITS.workerBytes) {
      try {
        settle(computeTextDiff(left, right, options), null)
      } catch (error) {
        settle(null, error instanceof Error ? error.message : 'diff-failed')
      }
      return
    }

    setState((previous) => ({ ...previous, pending: true, error: null }))
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./diff-worker.ts', import.meta.url), { type: 'module' })
    }
    const worker = workerRef.current
    const onMessage = (event: MessageEvent<WorkerAnswer>) => {
      worker.removeEventListener('message', onMessage)
      if (requestId.current !== id) return
      if (!event.data.ok || !event.data.result) settle(null, event.data.error ?? 'diff-failed')
      else settle(event.data.result, null)
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ left, right, options })
    return () => worker.removeEventListener('message', onMessage)
  }, [left, right, options])

  useEffect(() => () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  return state
}
