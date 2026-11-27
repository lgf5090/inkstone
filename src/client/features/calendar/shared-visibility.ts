import { calendarStorageKey } from '../../lib/calendar-storage'

export function readHiddenShared(userId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(calendarStorageKey('hidden-shared', userId)) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch (cause) {
    console.debug('[inkstone] Hidden shared-calendar visibility could not be read; showing all shared calendars.', cause)
    return new Set()
  }
}

export function writeHiddenShared(userId: string, ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(calendarStorageKey('hidden-shared', userId), JSON.stringify([...ids]))
  } catch (cause) {
    console.debug('[inkstone] Hidden shared-calendar visibility could not be saved.', cause)
  }
}
