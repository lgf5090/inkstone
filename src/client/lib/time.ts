import { localeTag, t } from './i18n'


const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function dateKey(date: Date): string {
  // Four digits always, and never `NaN`: `999-12-31`, `10000-01-01` and `NaN-NaN-NaN` all break
  // the string comparisons every range in the calendar layer relies on.
  const local = Number.isFinite(date.getTime()) ? date : new Date(0)
  const year = Math.min(9999, Math.max(1, local.getFullYear()))
  return `${String(year).padStart(4, '0')}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

/** A `YYYY-MM-DD` that names a real day: what the store will accept as a filter bound. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1)
    return false
  const back = new Date(year!, month! - 1, day!)
  // The Date constructor maps a two digit year onto 1900-1999, which would reject `0042-01-01`.
  back.setFullYear(year!)
  return back.getFullYear() === year && back.getMonth() === month! - 1 && back.getDate() === day
}

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Day-key arithmetic: the key `delta` days after (or before) `key`. */
export function addDaysKey(key: string, delta: number): string {
  const date = parseDateKey(key)
  date.setDate(date.getDate() + delta)
  return dateKey(date)
}

/** Whole days from `a` to `b` (negative when `b` is earlier), using UTC day math to stay DST-safe. */
export function daysBetweenKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/**
 * The weekday that opens a week grid, as a JS `getDay()` number. Not `0 | 1`: CLDR gives whole
 * calendars that open on Saturday, and every grid here takes this same 0-based index.
 */
export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** A civil day with no clock and no zone: every week rule below counts these, never instants. */
function civilUtc(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

/** The first day of the week row `date` sits in, as a fresh local-midnight `Date`. */
export function startOfWeek(date: Date, weekStart: WeekStartDay): Date {
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  out.setDate(out.getDate() - ((out.getDay() - weekStart + 7) % 7))
  return out
}

export interface WeekOrdinal {
  week: number
  /** The year the count restarts in, which is not the calendar year at either end of one. */
  year: number
}

/** ISO-8601: weeks open on Monday and week 1 is the row holding this year's first Thursday. */
export function isoWeekOrdinal(date: Date): WeekOrdinal {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const thursday = new Date(local)
  thursday.setDate(local.getDate() - ((local.getDay() + 6) % 7) + 3)
  const weekYear = thursday.getFullYear()
  const jan4 = new Date(weekYear, 0, 4)
  const week1Thursday = new Date(jan4)
  week1Thursday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + 3)
  return {
    week: Math.round((civilUtc(thursday) - civilUtc(week1Thursday)) / (7 * 86_400_000)) + 1,
    year: weekYear,
  }
}

function rowsInRowYear(year: number, weekStart: WeekStartDay): number {
  const first = civilUtc(startOfWeek(new Date(year, 0, 1), weekStart))
  const next = civilUtc(startOfWeek(new Date(year + 1, 0, 1), weekStart))
  return Math.round((next - first) / (7 * 86_400_000))
}

/**
 * Which numbered week a day belongs to, on the same rule as the grid drawing it.
 *
 * A Monday grid answers in ISO-8601, because that is the number a Chinese almanac prints and the
 * number an `YYYY-[W]ww` filename carries; every other opening day counts rows from the one holding
 * January 1st, which is what those readers' printed calendars do. The reference calendar kept a
 * single ISO count beside a grid that could open on any day, so its week column disagreed with its
 * own rows whenever the week start was not Monday.
 */
export function weekOrdinal(date: Date, weekStart: WeekStartDay): WeekOrdinal {
  if (weekStart === 1)
    return isoWeekOrdinal(date)
  const year = date.getFullYear()
  const firstRow = civilUtc(startOfWeek(new Date(year, 0, 1), weekStart))
  const ordinal = Math.round((civilUtc(startOfWeek(date, weekStart)) - firstRow) / (7 * 86_400_000)) + 1
  const rows = rowsInRowYear(year, weekStart)
  if (ordinal > rows)
    return { week: ordinal - rows, year: year + 1 }
  if (ordinal < 1)
    return { week: rowsInRowYear(year - 1, weekStart) + ordinal, year: year - 1 }
  return { week: ordinal, year }
}

/** How many days this civil year has. */
export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365
}

/** This day's position in its year, 1-based. */
export function dayOfYear(date: Date): number {
  return Math.round((civilUtc(date) - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000) + 1
}

/**
 * Which weekday opens a reader's calendar is locale data, so it is read off `Intl` rather than off
 * the languages this app ships. `firstDay` is ISO-numbered (Monday = 1 … Sunday = 7) while the
 * grids index JS `getDay()`, where Sunday is 0 — hence the modulo. Runtimes without `getWeekInfo`
 * get the answer these calendars shipped with before the API existed: `weekStartFor` is called on
 * every render of the sidebar and the appearance preview, so the answer is kept per locale tag —
 * the set is this app's handful of locales, and `Intl.Locale` construction is the cost being saved.
 */
const weekStartCache = new Map<string, WeekStartDay>()

export function weekStartFor(locale: string): WeekStartDay {
  const cached = weekStartCache.get(locale)
  if (cached !== undefined)
    return cached
  const withWeekInfo = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay?: number }
    weekInfo?: { firstDay?: number }
  }
  // `getWeekInfo` is the Stage-3 form; `weekInfo` is the same data as a getter, which engines
  // shipped earlier. Asking for both leaves the fallback below reachable only where neither exists.
  const firstDay = withWeekInfo.getWeekInfo?.()?.firstDay ?? withWeekInfo.weekInfo?.firstDay
  const start = typeof firstDay === 'number' ? (firstDay % 7) as WeekStartDay : (locale === 'zh-CN' ? 1 : 0)
  weekStartCache.set(locale, start)
  return start
}

/** The seven column labels of a grid, in the same order as that grid's columns. */
export function narrowWeekdayLabels(locale: string, weekStart: WeekStartDay): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  // 2024-01-07 is a Sunday, so the offset alone selects the weekday.
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(2024, 0, 7 + ((weekStart + index) % 7))),
  )
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function previousDay(date: Date): Date {
  const previous = new Date(date)
  previous.setDate(previous.getDate() - 1)
  return previous
}

function dateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(localeTag(), options)
}


/** A day as reader-facing text: `Sep 3`, gaining the year when the date is not in this one. */
export function formatDate(ts: number, now = new Date()): string {
  if (!Number.isFinite(ts) || !ts) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const parts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (date.getFullYear() !== now.getFullYear()) parts.year = 'numeric'
  return dateTimeFormat(parts).format(date)
}

/**
 * A stored day key as reader-facing text. Rich-media blocks persist `YYYY-MM-DD` because that is
 * what round-trips into a note body, so every surface that prints one goes through here instead of
 * showing the key.
 */
export function formatDateKey(key: string, now = new Date()): string {
  if (!key) return ''
  const date = parseDateKey(key)
  if (Number.isNaN(date.getTime())) return key
  return formatDate(date.getTime(), now) || key
}


export function shortTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || !ts) return ''
  const date = new Date(ts)
  const today = new Date(now)
  const diff = now - ts
  const distance = Math.abs(diff)

  if (distance < MINUTE) return t("time.just_now")
  if (diff < 0 && -diff < HOUR) return relative(Math.ceil(-diff / MINUTE), 'minute')
  if (diff >= 0 && diff < HOUR) return relative(-Math.floor(diff / MINUTE), 'minute')
  if (isSameDay(date, today)) {
    return dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(date)
  }
  if (diff >= 0 && isSameDay(date, previousDay(today))) return t("time.yesterday")
  if (distance < 7 * DAY) return dateTimeFormat({ weekday: 'short' }).format(date)
  if (date.getFullYear() === today.getFullYear()) {
    return dateTimeFormat({ month: 'short', day: 'numeric' }).format(date)
  }
  return dateTimeFormat({ year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}


export function fullTime(ts: number): string {
  if (!Number.isFinite(ts) || !ts) return '—'
  return dateTimeFormat({
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}


/**
 * How long ago, as a compact duration rather than a sentence: `5 min`, `2 hr`, `3 days`.
 *
 * A list column has no room for a full "3 days ago" beside every row, and the reader already
 * knows the number counts backwards because the column sits under the note's title. Same
 * thresholds as `relativeTime`, so the two never disagree about which unit a moment is worth.
 */
export function shortSince(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || !ts || !Number.isFinite(now)) return '—'
  const distance = Math.abs(now - ts)
  if (distance < MINUTE) return t("time.just_now")
  const unit = distance < HOUR ? ['minute', MINUTE] as const
    : distance < DAY ? ['hour', HOUR] as const
      : distance < 30 * DAY ? ['day', DAY] as const
        : distance < 365 * DAY ? ['month', 30 * DAY] as const
          : ['year', 365 * DAY] as const
  return new Intl.NumberFormat(localeTag(), {
    style: 'unit',
    unit: unit[0],
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  }).format(Math.floor(distance / unit[1]))
}


export function relativeTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || !ts) return '—'
  const diff = now - ts
  const distance = Math.abs(diff)
  if (distance < MINUTE) return t("time.just_now")
  const direction = diff < 0 ? 1 : -1
  const rounded = (unit: number) => direction * (direction > 0
    ? Math.ceil(distance / unit)
    : Math.floor(distance / unit))
  if (distance < HOUR) return relative(rounded(MINUTE), 'minute')
  if (distance < DAY) return relative(rounded(HOUR), 'hour')
  if (distance < 30 * DAY) return relative(rounded(DAY), 'day')
  if (distance < 365 * DAY) return relative(rounded(30 * DAY), 'month')
  return relative(rounded(365 * DAY), 'year')
}


export function groupLabel(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || !ts) return '—'
  const date = new Date(ts)
  const today = new Date(now)
  const diff = now - ts
  if (isSameDay(date, today)) return t("time.today")
  if (diff >= 0 && isSameDay(date, previousDay(today))) return t("time.yesterday")
  if (diff >= 0 && diff < 7 * DAY) return t("time.this_week")
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) {
    return t("time.this_month")
  }
  if (date.getFullYear() === today.getFullYear()) {
    return dateTimeFormat({ month: 'long' }).format(date)
  }
  return dateTimeFormat({ year: 'numeric', month: 'long' }).format(date)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export function formatDuration(ms: number): string {
  const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (duration < 1000) return formatUnit(Math.round(duration), 'millisecond')
  const totalSeconds = Math.round(duration / 1000)
  if (totalSeconds < 60) return formatUnit(Number((duration / 1000).toFixed(1)), 'second')
  return `${formatUnit(Math.floor(totalSeconds / 60), 'minute')} ${formatUnit(totalSeconds % 60, 'second')}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(localeTag()).format(n)
}

function formatUnit(value: number, unit: 'millisecond' | 'second' | 'minute'): string {
  return new Intl.NumberFormat(localeTag(), {
    style: 'unit',
    unit,
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(value)
}

function relative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(localeTag(), { numeric: 'always' }).format(value, unit)
}
