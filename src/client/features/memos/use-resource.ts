import { useCallback, useEffect, useRef, useState } from 'react'
import { memoErrorMessage, memoIsAbortError } from './errors'

export type MemoResourceStatus = 'loading' | 'ready' | 'error'

export interface MemoResource<T> {
  data: T | null
  status: MemoResourceStatus
  error: string | null
  reload: () => void
}

interface ResourceState<T> {
  data: T | null
  status: MemoResourceStatus
  error: string | null
}

export function useMemoResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): MemoResource<T> {
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const [ticket, setTicket] = useState(0)
  const [state, setState] = useState<ResourceState<T>>({ data: null, status: 'loading', error: null })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState((current) => ({ ...current, status: 'loading', error: null }))
    loaderRef.current(controller.signal)
      .then((data) => {
        if (active) setState({ data, status: 'ready', error: null })
      })
      .catch((error: unknown) => {
        if (!active || memoIsAbortError(error)) return
        setState((current) => ({ ...current, status: 'error', error: memoErrorMessage(error) }))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [...deps, ticket])

  const reload = useCallback(() => setTicket((value) => value + 1), [])
  return { ...state, reload }
}
