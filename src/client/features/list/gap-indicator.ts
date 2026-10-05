import type { DateRangeFilter } from '@shared/types'
import { dateKey, daysBetweenKeys } from '../../lib/time'

/** Latest non-deleted note's edit date key (null when there are no notes). */
export function computeLatestEditKey(notes: Readonly<Record<string, { updatedAt: number; deletedAt: number | null }>>): string | null {
  let latest = 0
  for (const note of Object.values(notes)) {
    if (note.deletedAt !== null)
      continue
    if (note.updatedAt > latest)
      latest = note.updatedAt
  }
  return latest === 0 ? null : dateKey(new Date(latest))
}

// The heatmap's gap banner and the list header both ask for the newest edit after every
// derived commit; memoizing by map identity makes one commit cost one O(n) scan, and the
// entry dies with the replaced map so nothing is retained strongly.
const latestEditKeyCache = new WeakMap<object, string | null>()

export function memoLatestEditKey(
  notes: Readonly<Record<string, { updatedAt: number; deletedAt: number | null }>>,
): string | null {
  let key = latestEditKeyCache.get(notes)
  if (key === undefined) {
    key = computeLatestEditKey(notes)
    latestEditKeyCache.set(notes, key)
  }
  return key
}

/** Newest edit key with whole days it sits outside the selected window (null when it is inside or the inputs are empty). */
export function latestEditOutsideWindow(selectedRange: DateRangeFilter | null | undefined, latestEditKey: string | null | undefined): { key: string; days: number; ahead: boolean } | null {
  if (!selectedRange || !latestEditKey)
    return null
  if (latestEditKey >= selectedRange.start && latestEditKey <= selectedRange.end)
    return null
  const ahead = latestEditKey > selectedRange.end
  const edge = ahead ? selectedRange.end : selectedRange.start
  return { key: latestEditKey, days: Math.abs(daysBetweenKeys(latestEditKey, edge)), ahead }
}
