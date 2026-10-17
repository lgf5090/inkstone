/**
 * Conversations as a category of the global search.
 *
 * The prompt's index holds notes and nothing else, so a thread the reader has already had is invisible to
 * it. This does not copy that content anywhere: it asks the one endpoint the chat's own list already
 * uses — `GET /api/assistant/conversations?q=…`, which matches the title and the message bodies on the
 * server — and keeps the page it answers with.
 *
 * The two searches are independent state, so neither can overwrite the other's rows when the network
 * answers them out of order; each half only guards against being overtaken by its own newer query.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantConversation } from '@shared/assistant'
import { api } from '../../lib/api'

/** Rows the prompt can show before the list stops being worth walking with the arrows. */
export const CONVERSATION_RESULT_LIMIT = 8

export interface ConversationSearchState {
  items: AssistantConversation[]
  loading: boolean
  /** Why the last answer is missing, in the reader's language. A refusal is never an empty result. */
  error: string | null
  /** Ask again for the text already searched, after a refusal. */
  retry: () => void
}

interface ConversationResult {
  items: AssistantConversation[]
  loading: boolean
  error: string | null
}

const idle: ConversationResult = { items: [], loading: false, error: null }

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The server's conversation matches for `text`, for as long as the prompt is open.
 *
 * `enabled` is the caller's scope question, not this hook's: an in-file search is about one note, and the
 * thread list has nothing to add to it.
 */
export function useConversationSearch(text: string, enabled: boolean): ConversationSearchState {
  const [result, setResult] = useState<ConversationResult>(idle)
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
    void api.assistant
      .conversations({ q: query, limit: String(CONVERSATION_RESULT_LIMIT) })
      .then((answer) => {
        // The reader may have typed over this ask in the time the server took to answer it.
        if (request !== run.current) return
        setResult({ items: answer.conversations, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (request !== run.current) return
        setResult({ items: [], loading: false, error: failure(error) })
      })
  }, [attempt, query])
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  return { items: result.items, loading: result.loading, error: result.error, retry }
}
