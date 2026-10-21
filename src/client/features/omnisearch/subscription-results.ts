/**
 * Subscriptions as a category of the global search.
 *
 * The prompt's index is built from notes and attachment files, so the money a reader tracks is invisible
 * to it even though it answers the same question — "where did I write down Netflix". Nothing is copied
 * into the index for this: one call to the app's own search endpoint, which matches a name, a type, a
 * category or a note against the live rows, is the whole mechanism.
 *
 * A deleted plan is deliberately absent. The trash is reachable from the app's rail, and a search result
 * that opens an erased subscription reads like the app lost it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { SUBSCRIPTION_SEARCH_LIMIT } from '@shared/subscriptions/search'
import { api } from '../../lib/api'

export interface SubscriptionSearchState {
  items: SubscriptionItem[]
  loading: boolean
  /** Why the last answer is missing, in the reader's language. A refusal is never an empty result. */
  error: string | null
  retry: () => void
}

interface SubscriptionResult {
  items: SubscriptionItem[]
  loading: boolean
  error: string | null
}

const idle: SubscriptionResult = { items: [], loading: false, error: null }

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The server's subscription matches for `text`, for as long as the prompt is open.
 *
 * Independent of the conversation half: two categories answering out of order must not overwrite each
 * other, and each side only has to guard against being overtaken by its own newer query.
 */
export function useSubscriptionSearch(text: string, enabled: boolean): SubscriptionSearchState {
  const [result, setResult] = useState<SubscriptionResult>(idle)
  const [attempt, setAttempt] = useState(0)
  const run = useRef(0)
  const query = enabled ? text.trim() : ''
  useEffect(() => {
    const request = ++run.current
    if (!query) {
      setResult(idle)
      return
    }
    setResult((current) => ({ ...current, loading: true, error: null }))
    void api.subscriptions
      .search(query, SUBSCRIPTION_SEARCH_LIMIT)
      .then((answer) => {
        if (request !== run.current) return
        setResult({ items: answer.items, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (request !== run.current) return
        setResult({ items: [], loading: false, error: failure(error) })
      })
  }, [attempt, query])
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  return { items: result.items, loading: result.loading, error: result.error, retry }
}
