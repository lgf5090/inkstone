export const CALENDAR_STORAGE_PREFIX = 'inkstone.calendar.'

export function calendarStorageKey(scope: string, userId?: string): string {
  return `${CALENDAR_STORAGE_PREFIX}${scope}${userId === undefined ? '' : `:${userId}`}`
}
