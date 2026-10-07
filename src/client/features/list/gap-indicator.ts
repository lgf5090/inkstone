import type { DateRangeFilter } from '@shared/types'
import { daysBetweenKeys } from '../../lib/time'

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
