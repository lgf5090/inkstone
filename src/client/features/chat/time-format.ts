/**
 * Instants in the assistant's own timezone.
 *
 * The reader's browser and the assistant's configured zone are usually the same, but the whole point of
 * the setting is that they need not be: a reminder set for 09:00 in Shanghai has to read as 09:00 in
 * the list even when the laptop is in Berlin. The notebook's own date helpers deliberately follow the
 * browser, so this surface keeps its own two formatters rather than changing theirs.
 */

import { getLocale } from '../../lib/i18n'

export function formatInZone(ms: number | null | undefined, timeZone?: string, options: { dateOnly?: boolean } = {}): string {
  if (ms === null || ms === undefined) return ''
  const date = new Date(ms)
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      ...(timeZone ? { timeZone } : {}),
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
      ...(options.dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

/**
 * Whether a stored instant means "by the end of that day".
 *
 * A due date typed as a bare date is saved at 23:59 local, and printing the time on it reads as a
 * deadline an hour before the day is over.
 */
export function isEndOfDay(ms: number, timeZone?: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const hour = parts.find((part) => part.type === 'hour')?.value
  const minute = parts.find((part) => part.type === 'minute')?.value
  return hour === '23' && minute === '59'
}

export function formatDue(ms: number | null | undefined, timeZone?: string): string {
  if (ms === null || ms === undefined) return ''
  return formatInZone(ms, timeZone, { dateOnly: isEndOfDay(ms, timeZone) })
}
