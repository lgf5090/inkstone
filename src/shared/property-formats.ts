import { parsePropertyValueDate } from './property-values'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  millis: 1,
  s: SECOND,
  sec: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: 7 * DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
  mon: 30 * DAY,
  month: 30 * DAY,
  months: 30 * DAY,
  y: 365 * DAY,
  year: 365 * DAY,
  years: 365 * DAY,
}

const DATE_TOKENS = [
  'YYYY',
  'YY',
  'MMMM',
  'MMM',
  'MM',
  'M',
  'DD',
  'D',
  'HH',
  'H',
  'hh',
  'h',
  'mm',
  'm',
  'ss',
  's',
  'SSS',
  'A',
  'a',
  'ZZ',
  'Z',
] as const

const DURATION_REMAINDER_TOKENS = [
  'DD',
  'HH',
  'hh',
  'h',
  'mm',
  'm',
  'ss',
  's',
] as const

const MAX_PATTERN_LENGTH = 120
const MAX_MONTH_NAMES = 64

const monthNameCache = new Map<string, { narrow: string[], short: string[], long: string[] }>()

export function isSupportedDateFormat(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_PATTERN_LENGTH
}


export function formatDateStamp(stamp: number, pattern: string, locale: string): string {
  if (!Number.isFinite(stamp) || !pattern)
    return ''
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime()))
    return ''
  const names = monthNamesFor(locale)
  const hours24 = date.getHours()
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const meridiem = hours24 < 12 ? 'AM' : 'PM'
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const offsetMinutesText = String(absolute % 60).padStart(2, '0')
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MMMM: names.long[date.getMonth()] ?? '',
    MMM: names.short[date.getMonth()] ?? '',
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    M: String(date.getMonth() + 1),
    DD: String(date.getDate()).padStart(2, '0'),
    D: String(date.getDate()),
    HH: String(hours24).padStart(2, '0'),
    H: String(hours24),
    hh: String(hours12).padStart(2, '0'),
    h: String(hours12),
    mm: String(date.getMinutes()).padStart(2, '0'),
    m: String(date.getMinutes()),
    ss: String(date.getSeconds()).padStart(2, '0'),
    s: String(date.getSeconds()),
    SSS: String(date.getMilliseconds()).padStart(3, '0'),
    A: meridiem,
    a: meridiem.toLocaleLowerCase(),
    ZZ: `${sign}${offsetHours}${offsetMinutesText}`,
    Z: `${sign}${offsetHours}:${offsetMinutesText}`,
  }
  return fillPattern(pattern, values, DATE_TOKENS)
}

export function formatDurationStamp(ms: number, pattern: string): string {
  if (!Number.isFinite(ms) || !pattern)
    return ''
  const absolute = Math.abs(Math.trunc(ms))
  const days = Math.floor(absolute / DAY)
  const hours = Math.floor((absolute % DAY) / HOUR)
  const minutes = Math.floor((absolute % HOUR) / MINUTE)
  const seconds = Math.floor((absolute % MINUTE) / SECOND)
  const totals: Record<string, number> = {
    DD: Math.floor(absolute / DAY),
    HH: Math.floor(absolute / HOUR),
    mm: Math.floor(absolute / MINUTE),
    ss: Math.floor(absolute / SECOND),
  }
  const remainders: Record<string, string> = {
    DD: String(days).padStart(2, '0'),
    HH: String(hours).padStart(2, '0'),
    hh: String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, '0'),
    h: String(hours),
    mm: String(minutes).padStart(2, '0'),
    m: String(minutes),
    ss: String(seconds).padStart(2, '0'),
    s: String(seconds),
  }
  let out = ''
  let index = 0
  let guard = 0
  while (index < pattern.length && guard++ < 4096) {
    if (pattern[index] === '[') {
      const end = pattern.indexOf(']', index)
      if (end > index) {
        const inner = pattern.slice(index + 1, end)
        if (inner in totals) {
          out += String(totals[inner]!).padStart(inner.length, '0')
          index = end + 1
          continue
        }
      }
    }
    let matched = ''
    for (const token of DURATION_REMAINDER_TOKENS) {
      if (pattern.startsWith(token, index)) {
        matched = token
        break
      }
    }
    if (matched) {
      out += remainders[matched] ?? matched
      index += matched.length
      continue
    }
    out += pattern[index]
    index += 1
  }
  return out
}

function fillPattern(pattern: string, values: Record<string, string>, tokens: readonly string[]): string {
  let out = ''
  let index = 0
  let guard = 0
  while (index < pattern.length && guard++ < 4096) {
    const char = pattern[index]!
    if (char === '[') {
      const end = pattern.indexOf(']', index)
      if (end < 0) {
        out += pattern.slice(index)
        break
      }
      out += pattern.slice(index + 1, end)
      index = end + 1
      continue
    }
    if (char === '\\' && index + 1 < pattern.length) {
      out += pattern[index + 1]
      index += 2
      continue
    }
    let matched = ''
    for (const token of tokens) {
      if (pattern.startsWith(token, index)) {
        matched = token
        break
      }
    }
    if (matched) {
      out += values[matched] ?? matched
      index += matched.length
      continue
    }
    out += char
    index += 1
  }
  return out
}


export function formatDateString(value: string, pattern: string, locale: string): string {
  const parsed = parsePropertyValueDate(value)
  if (!parsed)
    return value
  return formatDateStamp(parsed.time, pattern, locale) || value
}


export function durationUnitMs(unit: string): number | null {
  const key = unit.trim().toLocaleLowerCase()
  if (!key)
    return null
  return UNIT_MS[key] ?? null
}


export function durationToMs(value: number, unit: string): number | null {
  if (!Number.isFinite(value))
    return null
  const size = durationUnitMs(unit)
  if (size === null)
    return null
  const ms = value * size
  return Number.isFinite(ms) ? ms : null
}

export function formatDurationAbbreviated(ms: number): string {
  if (!Number.isFinite(ms))
    return ''
  let rest = Math.abs(Math.trunc(ms))
  const take = (size: number): number => {
    const amount = Math.floor(rest / size)
    rest -= amount * size
    return amount
  }
  const parts: Array<[number, string]> = [
    [take(365 * DAY), 'y'],
    [take(30 * DAY), 'mo'],
    [take(7 * DAY), 'w'],
    [take(DAY), 'd'],
    [take(HOUR), 'h'],
    [take(MINUTE), 'm'],
    [take(SECOND), 's'],
  ]
  const shown = parts.filter(([amount]) => amount > 0)
    .map(([amount, unit]) => `${amount}${unit}`)
  return shown.length ? shown.join(' ') : `${rest}ms`
}

export type DurationHumanStyle = 'relative' | 'plain'

const HUMANS: Array<[string, number]> = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
]

export function formatDurationHuman(ms: number, style: DurationHumanStyle, locale: string): string {
  if (!Number.isFinite(ms))
    return ''
  const absolute = Math.abs(ms)
  const past = ms < 0
  let unit = 'second'
  let size = SECOND
  for (const [candidate, candidateSize] of HUMANS) {
    if (absolute >= sizeThreshold(candidateSize)) {
      unit = candidate
      size = candidateSize
      break
    }
  }
  const amount = roundDiv(absolute, size)
  if (style === 'plain')
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(amount)
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return relative.format(past ? -amount : amount, unit as Intl.RelativeTimeFormatUnit)
}

function sizeThreshold(size: number): number {
  return size * 0.75
}

function roundDiv(value: number, size: number): number {
  return Math.max(1, Math.round(value / size))
}


export function monthNamesFor(locale: string): { narrow: string[], short: string[], long: string[] } {
  const cached = monthNameCache.get(locale)
  if (cached)
    return cached
  if (monthNameCache.size > MAX_MONTH_NAMES)
    monthNameCache.clear()
  const build = (style: 'narrow' | 'short' | 'long'): string[] => {
    const formatter = new Intl.DateTimeFormat(locale, { month: style })
    return Array.from({ length: 12 }, (_, index) => formatter.format(new Date(2024, index, 10)))
  }
  const entry = { narrow: build('narrow'), short: build('short'), long: build('long') }
  monthNameCache.set(locale, entry)
  return entry
}
