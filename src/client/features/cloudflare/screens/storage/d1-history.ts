/**
 * The D1 execution history, kept in localStorage beside the editor.
 *
 * This is a convenience list, not a record of truth: a browser that refuses storage loses it without
 * affecting the query that was already run. Entries are newest first and deduplicated by SQL text.
 */

export interface D1HistoryEntry {
  sql: string
  ts: number
}

const HISTORY_KEY = 'cloudflare:storage:d1-history'
const HISTORY_LIMIT_KEY = 'cloudflare:storage:d1-history-limit'
const DEFAULT_LIMIT = 50
const MIN_LIMIT = 5
const MAX_LIMIT = 500

export function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(value)))
}

export function readHistoryLimit(): number {
  try {
    const raw = localStorage.getItem(HISTORY_LIMIT_KEY)
    if (raw === null) return DEFAULT_LIMIT
    return clampHistoryLimit(Number(raw))
  } catch (error) {
    console.warn('[inkstone] D1 history limit could not be read:', error)
    return DEFAULT_LIMIT
  }
}

export function writeHistoryLimit(limit: number): void {
  try {
    localStorage.setItem(HISTORY_LIMIT_KEY, String(clampHistoryLimit(limit)))
  } catch (error) {
    // Storage may be full or disabled; the limit still applies in memory for this visit.
    console.warn('[inkstone] D1 history limit could not be stored:', error)
  }
}

export function readHistory(): D1HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is D1HistoryEntry => (
      Boolean(entry)
      && typeof entry === 'object'
      && typeof (entry as D1HistoryEntry).sql === 'string'
      && typeof (entry as D1HistoryEntry).ts === 'number'
    ))
  } catch (error) {
    console.warn('[inkstone] D1 history could not be read:', error)
    return []
  }
}

export function writeHistory(entries: readonly D1HistoryEntry[], limit: number): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, clampHistoryLimit(limit))))
  } catch (error) {
    // Best-effort: the query result is already on screen, and a full quota must not hide it.
    console.warn('[inkstone] D1 history could not be stored:', error)
  }
}

export function pushHistory(
  entries: readonly D1HistoryEntry[],
  sql: string,
  limit: number,
): D1HistoryEntry[] {
  const next = [
    { sql, ts: Date.now() },
    ...entries.filter((entry) => entry.sql !== sql),
  ].slice(0, clampHistoryLimit(limit))
  return next
}

export function filterHistory(entries: readonly D1HistoryEntry[], query: string): D1HistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...entries]
  return entries.filter((entry) => entry.sql.toLowerCase().includes(needle))
}
