/**
 * The date-format half of the QuickAdd token language.
 *
 * The reference plugin hands these patterns to Moment. Inkstone ships no date library, so this is
 * the slice of Moment's table that a note template can actually reach, written against `Date` and
 * `Intl`: calendar fields, ISO and locale week numbers, quarter tokens, meridian, offsets and the
 * `[literal]` escape. An unrecognised run is copied through verbatim, the way Moment prints an
 * unknown token, so a typo in a saved format shows up as the typo rather than as a blank note.
 */
import { localeTag } from '../i18n'
import { weekStartFor } from '../time'

export interface DateFormatOptions {
  /** BCP 47 tag for month/day names and the first day of the week. */
  locale?: string
  now?: Date
}

const DAY_NAMES_CACHE = new Map<string, string[]>()
const ABBREVIATED_DAY_NAMES_CACHE = new Map<string, string[]>()
const MONTH_NAMES_CACHE = new Map<string, string[]>()
const ABBREVIATED_MONTH_NAMES_CACHE = new Map<string, string[]>()


function names<T>(cache: Map<string, T>, locale: string, build: () => T): T {
  const known = cache.get(locale)
  if (known !== undefined) return known
  const value = build()
  cache.set(locale, value)
  return value
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    return new Intl.DateTimeFormat('en-US', options)
  }
}

function dayNames(locale: string, style: 'long' | 'short'): string[] {
  const cache = style === 'long' ? DAY_NAMES_CACHE : ABBREVIATED_DAY_NAMES_CACHE
  return names(cache, locale, () => {
    // Monday of a known week: 2024-01-08 was a Monday, so index 0 is Monday.
    const base = Date.UTC(2024, 0, 8)
    const format = formatter(locale, { weekday: style, timeZone: 'UTC' })
    return Array.from({ length: 7 }, (_, index) => format.format(new Date(base + index * 86_400_000)))
  })
}

function monthNames(locale: string, style: 'long' | 'short'): string[] {
  const cache = style === 'long' ? MONTH_NAMES_CACHE : ABBREVIATED_MONTH_NAMES_CACHE
  return names(cache, locale, () => {
    const format = formatter(locale, { month: style, timeZone: 'UTC' })
    return Array.from({ length: 12 }, (_, index) => format.format(new Date(Date.UTC(2024, index, 15))))
  })
}

function pad(value: number, length: number): string {
  return String(Math.trunc(Math.abs(value))).padStart(length, '0')
}

function isoYearWeek(date: Date): { year: number; week: number } {
  const shift = new Date(date.getTime())
  shift.setHours(12, 0, 0, 0)
  const day = (shift.getDay() + 6) % 7
  shift.setDate(shift.getDate() - day + 3)
  const year = shift.getFullYear()
  const firstThursday = new Date(year, 0, 4)
  firstThursday.setHours(12, 0, 0, 0)
  const firstDay = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDay)
  return { year, week: 1 + Math.round((shift.getTime() - firstThursday.getTime()) / (7 * 86_400_000)) }
}

/**
 * The week number the locale's own first weekday implies (`w` / `ww`).
 *
 * Week 1 is the week that contains 1 January, counted from that week's first day. That is the rule a
 * wall calendar drawn in the reader's locale shows, and unlike Moment's `w` it needs no `doy` table:
 * the only locale input here is which weekday the week starts on.
 */
function localeWeek(date: Date, locale: string): number {
  // The app's one week-start derivation, so a `{{DATE:w}}` numbers its weeks the way the month grid
  // draws its columns.
  const firstDay = weekStartFor(locale)
  const weekStartOf = (value: Date): Date => {
    const day = (value.getDay() - firstDay + 7) % 7
    return new Date(value.getFullYear(), value.getMonth(), value.getDate() - day)
  }
  const startOfYear = weekStartOf(new Date(date.getFullYear(), 0, 1))
  return 1 + Math.floor((weekStartOf(date).getTime() - startOfYear.getTime()) / (7 * 86_400_000))
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1)
  return 1 + Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - start.getTime()) / 86_400_000)
}

/**
 * The ordinal suffix a day, month or quarter is written with.
 *
 * Only a handful of languages have ordinal forms at all, and this fork's date patterns are written
 * in the two the interface offers plus whatever a reader copies out of a note. French is the one
 * whose suffix actually changes what is read back — `1er` — so it is spelled out here; a language
 * with no ordinal rule keeps the bare number, which is what its own almanac does.
 */
function ordinal(value: number, locale: string): string {
  const language = locale.toLowerCase().split(/[-_]/)[0]
  if (language === 'fr') {
    return value === 1 ? '1er' : `${value}e`
  }
  if (language !== 'en') return String(value)
  const lastTwo = value % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`
  return `${value}${['th', 'st', 'nd', 'rd'][value % 10] ?? 'th'}`
}

function offsetText(date: Date, withColon: boolean): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = Math.floor(absolute / 60)
  const rest = absolute % 60
  return `${sign}${pad(hours, 2)}${withColon ? ':' : ''}${pad(rest, 2)}`
}

function monthLabel(month: number, locale: string, style: 'long' | 'short'): string {
  return monthNames(locale, style)[month] ?? String(month + 1)
}

function dayLabel(weekday: number, locale: string, style: 'long' | 'short'): string {
  const list = dayNames(locale, style)
  // dayNames is Monday-first; `getDay()` is Sunday-first.
  return list[(weekday + 6) % 7] ?? String(weekday)
}

/**
 * Render one instant with a Moment-style pattern. `pattern` is read left to right; a `[...]` run
 * and a backslash escape are copied literally, and a run no token starts with is copied as itself.
 */
export function formatDatePattern(date: Date, pattern: string, options: DateFormatOptions = {}): string {
  const locale = options.locale ?? localeTag()
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]!
    if (char === '[') {
      const close = pattern.indexOf(']', index)
      if (close === -1) {
        out += pattern.slice(index)
        break
      }
      out += pattern.slice(index + 1, close)
      index = close + 1
      continue
    }
    if (char === '\\' && index + 1 < pattern.length) {
      out += pattern[index + 1]
      index += 2
      continue
    }
    const run = pattern.slice(index)
    const token = matchToken(run, locale, date)
    if (token === null) {
      out += char
      index += 1
      continue
    }
    out += token.text
    index += token.length
  }
  return out
}

/**
 * The token table, longest run first within each letter family: `dddd` has to win over `ddd`, or a
 * long weekday name would render as a short one plus a stray `d`.
 */
const TOKENS: readonly (readonly [RegExp, string])[] = [
  [/^YYYY/, 'year'],
  [/^YY/, 'year2'],
  [/^GGGG/, 'isoYear'],
  [/^gg/, 'isoYear2'],
  [/^Qo/, 'quarterOrd'],
  [/^Q/, 'quarter'],
  [/^q/, 'quarter'],
  [/^MMMM/, 'monthLong'],
  [/^MMM/, 'monthShort'],
  [/^MM/, 'month2'],
  [/^Mo/, 'monthOrd'],
  [/^M/, 'month'],
  [/^DDD/, 'yearDay3'],
  [/^DD/, 'day2'],
  [/^Do/, 'dayOrd'],
  [/^D/, 'day'],
  [/^dddd/, 'weekdayLong'],
  [/^ddd/, 'weekdayShort'],
  [/^dd/, 'weekdayMin'],
  [/^d/, 'weekday'],
  [/^WW/, 'isoWeek2'],
  [/^W/, 'isoWeek'],
  [/^ww/, 'week2'],
  [/^w/, 'week'],
  [/^E/, 'isoWeekday'],
  [/^A/, 'meridianUpper'],
  [/^a/, 'meridianLower'],
  [/^HH/, 'hour2'],
  [/^H/, 'hour'],
  [/^hh/, 'hour12_2'],
  [/^h/, 'hour12'],
  [/^mm/, 'minute2'],
  [/^m/, 'minute'],
  [/^ss/, 'second2'],
  [/^s/, 'second'],
  [/^SSS/, 'millisecond'],
  [/^ZZ/, 'offsetCompact'],
  [/^Z/, 'offset'],
  [/^X/, 'epochSeconds'],
  [/^x/, 'epochMillis'],
]

function matchToken(run: string, locale: string, date: Date): { text: string; length: number } | null {
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = date.getSeconds()
  const weekday = date.getDay()
  const iso = isoYearWeek(date)
  const twelve = hours % 12 === 0 ? 12 : hours % 12
  const quarter = Math.floor(month / 3) + 1

  for (const [pattern, kind] of TOKENS) {
    const matched = pattern.exec(run)
    if (!matched) continue
    const value = tokenValue(kind, {
      year, month, day, hours, minutes, seconds, weekday, isoYear: iso.year, isoWeek: iso.week,
      quarter, twelve, locale, date,
    })
    if (value === null) continue
    return { text: value, length: matched[0].length }
  }
  return null
}

interface TokenFields {
  year: number
  month: number
  day: number
  hours: number
  minutes: number
  seconds: number
  weekday: number
  isoYear: number
  isoWeek: number
  quarter: number
  twelve: number
  locale: string
  date: Date
}

function tokenValue(kind: string, f: TokenFields): string | null {
  switch (kind) {
    case 'year': return pad(f.year, 4)
    case 'year2': return pad(f.year % 100, 2)
    case 'isoYear': return pad(f.isoYear, 4)
    case 'isoWeek2': return pad(f.isoWeek, 2)
    case 'isoWeek': return String(f.isoWeek)
    case 'isoYear2': return pad(f.isoYear % 100, 2)
    case 'quarterOrd': return ordinal(f.quarter, f.locale)
    case 'quarter': return String(f.quarter)
    case 'monthLong': return monthLabel(f.month, f.locale, 'long')
    case 'monthShort': return monthLabel(f.month, f.locale, 'short')
    case 'month2': return pad(f.month + 1, 2)
    case 'monthOrd': return ordinal(f.month + 1, f.locale)
    case 'month': return String(f.month + 1)
    case 'day2': return pad(f.day, 2)
    case 'dayOrd': return ordinal(f.day, f.locale)
    case 'yearDay3': return pad(dayOfYear(f.date), 3)
    case 'day': return String(f.day)
    case 'weekdayLong': return dayLabel(f.weekday, f.locale, 'long')
    case 'weekdayShort': return dayLabel(f.weekday, f.locale, 'short')
    case 'weekdayMin': return dayLabel(f.weekday, f.locale, 'short').slice(0, 2)
    case 'weekday': return String(f.weekday)
    case 'week2': return pad(localeWeek(f.date, f.locale), 2)
    case 'week': return String(localeWeek(f.date, f.locale))
    case 'isoWeekday': return String((f.weekday + 6) % 7 + 1)
    case 'meridianUpper': return f.hours < 12 ? 'AM' : 'PM'
    case 'meridianLower': return f.hours < 12 ? 'am' : 'pm'
    case 'hour2': return pad(f.hours, 2)
    case 'hour': return String(f.hours)
    case 'hour12_2': return pad(f.twelve, 2)
    case 'hour12': return String(f.twelve)
    case 'minute2': return pad(f.minutes, 2)
    case 'minute': return String(f.minutes)
    case 'second2': return pad(f.seconds, 2)
    case 'second': return String(f.seconds)
    case 'millisecond': return pad(f.date.getMilliseconds(), 3)
    case 'offsetCompact': return offsetText(f.date, false)
    case 'offset': return offsetText(f.date, true)
    case 'epochSeconds': return String(Math.floor(f.date.getTime() / 1000))
    case 'epochMillis': return String(f.date.getTime())
    default: return null
  }
}

/** The token kind starting `run`, longest first — the same walk that writes it. */
function tokenKindAt(run: string): string | null {
  for (const [expression, kind] of TOKENS) {
    if (expression.test(run)) return kind
  }
  return null
}

/** The format tokens this app can read back, and what their text looks like. A week, quarter,
 * weekday or offset token has no inverse: it does not name a day on its own. */
const READABLE_TOKENS: Readonly<Record<string, { field: string; source: string }>> = {
  year: { field: 'year', source: '\\d{4}' },
  year2: { field: 'year2', source: '\\d{2}' },
  isoYear: { field: 'year', source: '\\d{4}' },
  month: { field: 'month', source: '\\d{1,2}' },
  month2: { field: 'month', source: '\\d{2}' },
  monthLong: { field: 'monthName', source: '[^\\s.,;]+' },
  monthShort: { field: 'monthName', source: '[^\\s.,;]+' },
  day: { field: 'day', source: '\\d{1,2}' },
  day2: { field: 'day', source: '\\d{2}' },
  hour: { field: 'hour', source: '\\d{1,2}' },
  hour2: { field: 'hour', source: '\\d{2}' },
  minute: { field: 'minute', source: '\\d{1,2}' },
  minute2: { field: 'minute', source: '\\d{2}' },
  second: { field: 'second', source: '\\d{1,2}' },
  second2: { field: 'second', source: '\\d{2}' },
}

/**
 * The instant a title written with `pattern` names, or null when the text does not fit it.
 *
 * An ordered capture has to compare the headings already in the note, and a heading whose year, month
 * and day are split by the reader's own calendar glyphs is a date only the pattern can find —
 * `Date.parse` knows ISO and a handful of English forms. A format built
 * from tokens with no inverse says "unreadable" rather than inventing a day, which is also what the
 * ordering rule wants: an unreadable heading sinks to the bottom instead of sorting by a guess.
 */
export function parseDatePattern(text: string, pattern: string, locale: string = localeTag()): number | null {
  if (!pattern) return null
  const groups: string[] = []
  const fields: Partial<Record<string, number>> = {}
  let source = ''
  let rest = pattern
  while (rest.length > 0) {
    if (rest[0] === '[') {
      const close = rest.indexOf(']')
      if (close === -1) return null
      source += escapeLiteral(rest.slice(1, close))
      rest = rest.slice(close + 1)
      continue
    }
    const kind = tokenKindAt(rest)
    if (kind) {
      const readable = READABLE_TOKENS[kind]
      // A token with no inverse (a week, a quarter, a weekday, an offset) means this format cannot
      // name a day, so the whole pattern is unreadable rather than half-read.
      if (!readable) return null
      if (fields[readable.field] === undefined) {
        fields[readable.field] = groups.length
        groups.push(readable.field)
        source += `(${readable.source})`
      }
      else source += `(?:${readable.source})`
      rest = rest.slice(matchedTokenLength(kind))
      continue
    }
    source += escapeLiteral(rest[0]!)
    rest = rest.slice(1)
  }
  if (fields.year === undefined && fields.year2 === undefined) return null
  const matched = new RegExp(`^${source}`).exec(text.trim())
  if (!matched) return null
  const read = (field: string): number => {
    const at = fields[field]
    if (at === undefined) return 0
    const value = matched[at + 1]
    return value === undefined ? 0 : Number(value)
  }
  let year = read('year')
  const twoDigit = read('year2')
  if (fields.year === undefined && fields.year2 !== undefined) year = twoDigit <= 68 ? 2000 + twoDigit : 1900 + twoDigit
  let month = fields.month === undefined ? 1 : read('month')
  if (fields.monthName !== undefined) {
    const name = matched[(fields.monthName ?? 0) + 1] ?? ''
    const at = monthIndexOf(name, locale)
    if (at === null) return null
    month = at
  }
  const day = fields.day === undefined ? 1 : read('day')
  const date = new Date(year, month - 1, day, read('hour'), read('minute'), read('second'))
  // `2026-13-01` is not a day. Rejecting it keeps such a heading unparseable rather than sorting it
  // by a date the reader never wrote.
  if (Number.isNaN(date.getTime())) return null
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

/** How many pattern characters the token `kind` occupies, from the same table that prints it. */
function matchedTokenLength(kind: string): number {
  for (const [expression, entry] of TOKENS) {
    if (entry === kind) return expression.source.slice(1).length
  }
  return 0
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function monthIndexOf(name: string, locale: string): number | null {
  const needle = name.trim().toLowerCase()
  for (const style of ['long', 'short'] as const) {
    const at = monthNames(locale, style).findIndex((entry) => entry.toLowerCase() === needle)
    if (at !== -1) return at + 1
  }
  return null
}
