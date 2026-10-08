/**
 * The date surface the lint rules need, without a date library.
 *
 * The reference plugin hands its timestamps to Moment. Inkstone already owns a Moment-pattern
 * formatter and parser (the one QuickAdd date tokens use), so a lint date is a `Date` plus the two
 * things Moment carried around with it: the locale used for names, and whether the value is read
 * and written as UTC. A UTC date is kept as the instant it is and rendered with the offset applied,
 * which is what `moment(x).utc().format()` prints.
 */
import parseFormat from 'moment-parseformat'
import { formatDatePattern, parseDatePattern } from '../../quickadd/date-pattern'
import { localeTag } from '../../i18n'

export type LintDate = {
  date: Date,
  utc: boolean,
  locale: string,
}

type ParseOptions = {
  pattern?: string,
  locale?: string,
  utc?: boolean,
}

export function isValidDate(value: LintDate | null | undefined): value is LintDate {
  return value !== null && value !== undefined && !Number.isNaN(value.date.getTime())
}

export function lintDateFrom(value: string | number | Date, options: ParseOptions = {}): LintDate | null {
  const locale = options.locale ?? localeTag()
  const utc = options.utc ?? false
  const pattern = options.pattern

  if (pattern) {
    const parsed = parseDatePattern(String(value), pattern, locale)
    if (parsed === null) {
      return null
    }

    // `parseDatePattern` reads the fields as wall-clock time in the machine's zone. For a UTC
    // reading, the same wall clock has to name the instant that zone would show.
    const local = new Date(parsed)

    return { date: utc ? shiftToUtcInstant(local) : local, utc, locale }
  }

  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'number' ? new Date(value) : isoOrNative(String(value))

  return isValidDate({ date, utc, locale }) ? { date, utc, locale } : null
}

export function withLocale(value: LintDate, locale: string): LintDate {
  return { ...value, locale: locale || value.locale }
}

export function asUTC(value: LintDate): LintDate {
  return { ...value, utc: true }
}

export function formatDate(value: LintDate, pattern: string): string {
  return formatDatePattern(shiftToLocalWallClock(value), pattern.trimEnd(), { locale: value.locale })
}

export function diffSeconds(a: LintDate, b: LintDate): number {
  return (a.date.getTime() - b.date.getTime()) / 1000
}

/** The instant a wall-clock reading of a UTC-formatted string refers to. */
export function shiftToUtcInstant(wallClock: Date): Date {
  return new Date(wallClock.getTime() - wallClock.getTimezoneOffset() * 60_000)
}

/**
 * The same instant shown as the wall clock a UTC reading would print, or as the machine's local
 * wall clock when the value is not a UTC one. `formatDatePattern` always reads local fields, so a
 * UTC date is rendered by handing it the shifted date.
 */
function shiftToLocalWallClock(value: LintDate): Date {
  if (!value.utc) {
    return value.date
  }

  return new Date(value.date.getTime() + value.date.getTimezoneOffset() * 60_000)
}

/** Guess the pattern a timestamp was written with, as Moment's parseFormat does. */
export function detectDatePattern(text: string): string {
  return parseFormat(text)
}

function isoOrNative(text: string): Date {
  const parsed = new Date(text)

  return parsed
}

export function currentLintDate(locale?: string): LintDate {
  return { date: new Date(), utc: false, locale: locale || localeTag() }
}
