import type { DateRangeFilter, NoteSummary } from '@shared/types'
import { dateKey, daysBetweenKeys } from '../../lib/time'
import { isActivityNote } from '../../lib/calendar-activity'

type EditableNote = Pick<NoteSummary, 'updatedAt' | 'deletedAt' | 'isArchived'>

// The whole-vault scan the projection's maintained `latestEditKey` is tested against.
// Nothing on a render path calls it: the calendar reads the projection instead, because
// this scan costs one pass over every note per commit. It stays exported so
// `calendar-activity.test.ts` can hold the fast answer against this slow oracle.
/** The newest edit the note list could actually show (archived and deleted are out); null when nothing qualifies. */
export function computeLatestEditKey(notes: Readonly<Record<string, EditableNote>>): string | null {
  let latest = 0
  for (const note of Object.values(notes)) {
    if (!isActivityNote(note))
      continue
    if (note.updatedAt > latest)
      latest = note.updatedAt
  }
  return latest === 0 ? null : dateKey(new Date(latest))
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
