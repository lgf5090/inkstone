/**
 * Durations the reader sees.
 *
 * `Intl` formats the numbers and the unit words come from the locale catalog, because the two languages
 * say the same duration differently and only one of them can live in a component.
 */
import { t } from '../../lib/i18n'

/** Hours and minutes only: a reading session is never going to need seconds on screen. */
export function formatReadingSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return t('reading.seconds_short', { value0: total })
  const minutes = Math.round(total / 60)
  if (minutes < 60) return t('reading.minutes_short', { value0: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest
    ? t('reading.hours_minutes', { value0: hours, value1: rest })
    : t('reading.hours_short', { value0: hours })
}

/** A relative "last read" line, which is what a shelf actually answers: did I read this recently? */
export function formatLastRead(at: number | undefined, now = Date.now()): string {
  if (!at) return ''
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return t('reading.today')
  if (days === 1) return t('reading.yesterday')
  if (days < 7) return t('reading.days_ago', { value0: days })
  if (days < 30) return t('reading.weeks_ago', { value0: Math.floor(days / 7) })
  if (days < 365) return t('reading.months_ago', { value0: Math.floor(days / 30) })
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short' }).format(at)
}

/** Day key a reading log is filed under, in the reader's own calendar rather than UTC. */
export function dayKey(at: number = Date.now()): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
