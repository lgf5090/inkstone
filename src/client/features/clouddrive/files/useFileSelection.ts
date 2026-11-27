import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CloudDriveEntry, CloudDriveListing } from '@shared/clouddrive/model'
import type { SelectMode } from './types'

export function useFileSelection(entries: CloudDriveEntry[], listing: CloudDriveListing | null) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)

  useEffect(() => {
    if (!listing) return
    const ids = new Set(entries.map((entry) => entry.id))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
    setFocusedId((current) => (current && ids.has(current) ? current : entries[0]?.id ?? null))
    setAnchorId((current) => (current && ids.has(current) ? current : null))
  }, [listing, entries])

  const selectedEntries = useMemo(() => entries.filter((entry) => selected.has(entry.id)), [entries, selected])
  const selectEntry = useCallback((entry: CloudDriveEntry, mode: SelectMode) => {
    setSelected((current) => {
      if (mode === 'toggle') {
        const next = new Set(current)
        if (next.has(entry.id)) next.delete(entry.id)
        else next.add(entry.id)
        return next
      }
      if (mode === 'range' && anchorId) {
        const from = entries.findIndex((item) => item.id === anchorId)
        const to = entries.findIndex((item) => item.id === entry.id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from]
          return new Set(entries.slice(start, end + 1).map((item) => item.id))
        }
      }
      return new Set([entry.id])
    })
    if (mode !== 'range') setAnchorId(entry.id)
    setFocusedId(entry.id)
  }, [anchorId, entries])
  const selectAll = useCallback(() => {
    setSelected(new Set(entries.map((entry) => entry.id)))
    setAnchorId(entries[0]?.id ?? null)
  }, [entries])
  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setAnchorId(null)
  }, [])
  const focusFirstEntry = useCallback(() => {
    window.requestAnimationFrame(() => {
      const root = document.querySelector<HTMLElement>('[data-clouddrive-files]')
      const target = root?.querySelector<HTMLElement>('[data-cd-entry]') ?? root?.querySelector<HTMLElement>('[role="region"]')
      target?.focus({ preventScroll: true })
    })
  }, [])
  const targetsFor = useCallback((entry: CloudDriveEntry) => (
    selected.has(entry.id) ? entries.filter((item) => selected.has(item.id)) : [entry]
  ), [entries, selected])

  return {
    selected, setSelected, anchorId, setAnchorId, focusedId, setFocusedId, selectedEntries,
    selectEntry, selectAll, clearSelection, focusFirstEntry, targetsFor,
  }
}
