/**
 * Search history, ten queries deep, most recent first. An empty entry at the head means the reader
 * typed and closed without executing, which is how the reference plugin decides to open with a blank
 * field next time.
 */
import { localDb } from '../../lib/db'

export const OMNISEARCH_HISTORY_MAX = 10

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export async function loadHistory(): Promise<string[]> {
  const value = await localDb.loadOmnisearchHistory()
  if (!isStringArray(value)) return []
  return value.slice(0, OMNISEARCH_HISTORY_MAX).map((item) => item.slice(0, 512))
}

export async function pushHistory(query: string): Promise<string[]> {
  const trimmed = query.trim().slice(0, 512)
  const previous = await loadHistory()
  if (!trimmed) {
    // Only the marker moves: a half-typed query must not drop the one the reader actually ran.
    if (previous[0] === '') return previous
    const next = ['', ...previous.filter((item) => item)].slice(0, OMNISEARCH_HISTORY_MAX)
    await localDb.saveOmnisearchHistory(next)
    return next
  }
  const next = [trimmed, ...previous.filter((item) => item && item !== trimmed)].slice(0, OMNISEARCH_HISTORY_MAX)
  await localDb.saveOmnisearchHistory(next)
  return next
}

export async function clearHistory(): Promise<string[]> {
  await localDb.saveOmnisearchHistory([])
  return []
}

/** The query to pre-fill the field with, honouring the blank-marker rule and the setting. */
export function initialQueryOf(history: readonly string[], showPrevious: boolean): string {
  if (!history.length) return ''
  if (!showPrevious) return ''
  return history[0] ?? ''
}
