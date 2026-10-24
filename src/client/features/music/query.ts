/** One small async-state hook for music pages; the project does not use a query library. */
import { useCallback, useEffect, useState } from 'react'

export type MusicQueryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MusicQueryState<T> {
  data: T | null
  status: MusicQueryStatus
  error: string | null
  reload: () => void
}

export interface MusicQueryOptions {
  enabled?: boolean
}

/**
 * Run `loader` whenever `deps` change. The loader is deliberately not a dependency: callers pass an
 * inline closure over the same values, and requiring a memoized function would only add noise.
 * A previous answer stays visible while a reload is in flight.
 */
export function useMusicQuery<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: MusicQueryOptions = {},
): MusicQueryState<T> {
  const enabled = options.enabled ?? true
  const [data, setData] = useState<T | null>(null)
  const [status, setStatus] = useState<MusicQueryStatus>(enabled ? 'loading' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      return
    }
    const controller = new AbortController()
    let active = true
    setStatus('loading')
    setError(null)
    loader(controller.signal)
      .then((value) => {
        if (!active || controller.signal.aborted) return
        setData(value)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
      })
    return () => {
      active = false
      controller.abort()
    }
    // The caller owns the dependency list; the loader is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reloadKey, ...deps])

  return { data, status, error, reload }
}
