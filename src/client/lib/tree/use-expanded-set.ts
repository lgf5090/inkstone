import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export interface ExpandedSet {
  expanded: ReadonlySet<string>
  setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>
  toggle: (id: string) => void
  setMany: (ids: readonly string[], open: boolean) => void
}

/**
 * Expand/collapse state for a tree that owns it locally, keyed by node id or path.
 *
 * The sidebar keeps its expansion in the UI store because other panels reach for it; a tree with no
 * cross-panel reach — the tag tree — kept a fourth hand-rolled shape for the same idea. This is that
 * shape, once. `setExpanded` is exposed alongside `toggle`/`setMany` because a rename or a move has
 * to replay a whole set against a changed key, not flip one entry.
 */
export function useExpandedSet(initial?: Iterable<string>): ExpandedSet {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initial))
  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const setMany = useCallback((ids: readonly string[], open: boolean) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (open) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])
  return { expanded, setExpanded, toggle, setMany }
}
