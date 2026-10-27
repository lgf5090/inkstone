/**
 * Table sorting, in the one shape every Cloudflare table uses.
 *
 * Clicking a header walks original → ascending → descending → original, because the original order is
 * the one the server chose (newest first, usually) and a reader needs a way back to it without a
 * reload. The comparison is a cached numeric collator, so "note 2" sorts before "note 10".
 */
import { useCallback, useState } from 'react'
import { numericCollator } from '../../../lib/collator'
import { getLocale } from '../../../lib/i18n'

export type SortDir = 'asc' | 'desc' | null

export interface SortState {
  key: string | null
  dir: SortDir
}

export function nextSortDir(dir: SortDir): SortDir {
  if (dir === 'asc') return 'desc'
  if (dir === 'desc') return null
  return 'asc'
}

/** Numbers compare as numbers; everything else as text; a missing value always sorts last. */
export function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return numericCollator(getLocale()).compare(String(a), String(b))
}

export function sortRows<T>(rows: readonly T[], state: SortState, accessor: (row: T) => unknown): T[] {
  if (!state.key || !state.dir) return [...rows]
  const direction = state.dir
  return [...rows].sort((left, right) => {
    const compared = compareValues(accessor(left), accessor(right))
    return direction === 'asc' ? compared : -compared
  })
}

export function useSort<T>() {
  const [state, setState] = useState<SortState>({ key: null, dir: null })

  const toggle = useCallback((key: string) => {
    setState((previous) => (previous.key === key
      ? { key, dir: nextSortDir(previous.dir) }
      : { key, dir: 'asc' }))
  }, [])

  const sorted = useCallback(
    (rows: readonly T[], accessor?: (row: T) => unknown): T[] =>
      sortRows(rows, state, accessor ?? ((row) => (row as Record<string, unknown>)[state.key ?? ''])),
    [state],
  )

  return { state, toggle, sorted }
}
