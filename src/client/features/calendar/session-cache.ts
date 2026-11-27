/**
 * Calendar snapshots that belong to the account, not to the browser.
 *
 * The range cache and first-paint metadata hold event titles and preferences so the next visit can
 * paint before the network answers. That is exactly why they must not outlive a sign-out: on a
 * shared browser the next person would be able to read the previous account's day.
 */
import { CALENDAR_STORAGE_PREFIX } from '../../lib/calendar-storage'

export const CALENDAR_CACHE_PREFIXES = [
  `${CALENDAR_STORAGE_PREFIX}first-paint.`,
  `${CALENDAR_STORAGE_PREFIX}range.`,
  `${CALENDAR_STORAGE_PREFIX}outbox.`,
  `${CALENDAR_STORAGE_PREFIX}hidden-shared.`,
  'inkstone:calendar:outbox:',
  'inkstone:calendar:hidden-shared',
] as const

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function clearCalendarSessionCaches(storage: Storage | null = readStorage()): void {
  if (!storage) return
  try {
    const doomed: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key && CALENDAR_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) doomed.push(key)
    }
    for (const key of doomed) storage.removeItem(key)
  } catch {
    // A browser that refuses reads or writes will also refuse the data; there is nothing to clear.
  }
}
