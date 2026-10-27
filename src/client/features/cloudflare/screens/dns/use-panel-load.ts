/**
 * One fetch per panel, with the three states the panels draw.
 *
 * The caller passes a key naming what the request depends on. `loader` is deliberately not a
 * dependency: every caller writes an inline closure, and depending on its identity would refetch on
 * every render. `reload` asks for the same request again.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { cfErrorText } from '../../api/client'

export interface PanelLoad<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
  setData: Dispatch<SetStateAction<T | null>>
}

export function usePanelLoad<T>(loader: () => Promise<T>, key: string): PanelLoad<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loader()
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(cfErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [key, nonce])

  return { data, loading, error, reload, setData }
}
