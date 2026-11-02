import { DATE_MAX_YEAR, DATE_MIN_YEAR } from '../contract'
import type { DateDifferenceResult } from '../types'

export type CalendarSystem = 'gregory' | 'japanese' | 'islamic-umalqura'

const DAY_MS = 86_400_000

export interface PlainDateParts {
  year: number
  month: number
  day: number
}

export function parseIsoDate(value: string): PlainDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

export function toIsoDate(parts: PlainDateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function dateToUtc(parts: PlainDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

export function utcToDate(value: number): PlainDateParts {
  const date = new Date(value)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

export function daysBetween(start: PlainDateParts, end: PlainDateParts): number {
  return Math.round((dateToUtc(end) - dateToUtc(start)) / DAY_MS)
}

export function compareDates(left: PlainDateParts, right: PlainDateParts): number {
  const a = dateToUtc(left)
  const b = dateToUtc(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export function addYears(parts: PlainDateParts, years: number): PlainDateParts {
  const year = parts.year + years
  const day = Math.min(parts.day, daysInMonth(year, parts.month))
  return { year, month: parts.month, day }
}

export function addMonths(parts: PlainDateParts, months: number): PlainDateParts {
  const total = parts.year * 12 + (parts.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12 + 12) % 12 + 1
  const day = Math.min(parts.day, daysInMonth(year, month))
  return { year, month, day }
}

export function addDays(parts: PlainDateParts, days: number): PlainDateParts {
  return utcToDate(dateToUtc(parts) + days * DAY_MS)
}

export function inSupportedRange(parts: PlainDateParts): boolean {
  return parts.year >= DATE_MIN_YEAR && parts.year <= DATE_MAX_YEAR
}

export interface CalendarParts {
  year: number
  month: number
  day: number
  era?: string
}

function calendarTag(calendar: CalendarSystem): string {
  return calendar === 'gregory' ? 'en-US' : `en-US-u-ca-${calendar}`
}

export function calendarParts(iso: string, calendar: CalendarSystem = 'gregory'): CalendarParts | null {
  const parts = parseIsoDate(iso)
  if (!parts) return null
  if (calendar === 'gregory') return { year: parts.year, month: parts.month, day: parts.day }
  const formatter = new Intl.DateTimeFormat(calendarTag(calendar), { year: 'numeric', month: 'numeric', day: 'numeric', era: 'short', timeZone: 'UTC' })
  const fields = formatter.formatToParts(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)))
  const read = (type: string) => fields.find((field) => field.type === type)?.value ?? ''
  const year = Number(read('year'))
  const month = Number(read('month'))
  const day = Number(read('day'))
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  return { year, month, day, era: read('era') || undefined }
}

function calendarPartsAtUtc(value: number, calendar: CalendarSystem): CalendarParts | null {
  return calendarParts(utcToDate(value) ? toIsoDate(utcToDate(value)) : '', calendar)
}

function findGregorianForCalendarParts(year: number, month: number, day: number, calendar: CalendarSystem): PlainDateParts | null {
  const min = dateToUtc({ year: DATE_MIN_YEAR, month: 1, day: 1 })
  const max = dateToUtc({ year: DATE_MAX_YEAR, month: 12, day: 31 })
  let low = Math.floor(min / DAY_MS)
  let high = Math.floor(max / DAY_MS)
  const target = `${year}-${month}-${day}`
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const parts = calendarPartsAtUtc(middle * DAY_MS, calendar)
    if (!parts) return null
    const candidate = `${parts.year}-${parts.month}-${parts.day}`
    if (candidate === target) return utcToDate(middle * DAY_MS)
    const candidateKey = parts.year * 10000 + parts.month * 100 + parts.day
    const targetKey = year * 10000 + month * 100 + day
    if (candidateKey < targetKey) low = middle + 1
    else high = middle - 1
  }
  return null
}

function calendarMonthLength(year: number, month: number, calendar: CalendarSystem): number {
  for (let day = 30; day >= 28; day--) {
    if (findGregorianForCalendarParts(year, month, day, calendar)) return day
  }
  return 28
}

function addCalendarMonths(parts: CalendarParts, months: number, calendar: CalendarSystem): CalendarParts {
  const total = parts.year * 12 + (parts.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12 + 12) % 12 + 1
  const day = Math.min(parts.day, calendarMonthLength(year, month, calendar))
  return { year, month, day }
}

function addCalendarYears(parts: CalendarParts, years: number, calendar: CalendarSystem): CalendarParts {
  const year = parts.year + years
  const day = Math.min(parts.day, calendarMonthLength(year, parts.month, calendar))
  return { year, month: parts.month, day }
}

function calendarToIso(parts: CalendarParts, calendar: CalendarSystem): string | null {
  if (calendar === 'gregory') return inSupportedRange(parts) ? toIsoDate(parts) : null
  if (calendar === 'japanese') return null
  const gregorian = findGregorianForCalendarParts(parts.year, parts.month, parts.day, calendar)
  return gregorian ? toIsoDate(gregorian) : null
}

export function difference(from: string, to: string, calendar: CalendarSystem = 'gregory'): DateDifferenceResult | null {
  const fromParts = parseIsoDate(from)
  const toParts = parseIsoDate(to)
  if (!fromParts || !toParts) return null
  const start = compareDates(fromParts, toParts) <= 0 ? fromParts : toParts
  const end = compareDates(fromParts, toParts) <= 0 ? toParts : fromParts
  const totalDays = daysBetween(start, end)
  if (calendar === 'gregory' || calendar === 'japanese') {
    let years = end.year - start.year
    let cursor = addYears(start, years)
    if (compareDates(cursor, end) > 0) {
      years -= 1
      cursor = addYears(start, years)
    }
    let months = 0
    while (true) {
      const next = addMonths(cursor, months + 1)
      if (compareDates(next, end) > 0) break
      months += 1
    }
    cursor = addMonths(cursor, months)
    const days = daysBetween(cursor, end)
    return { years, months, days, totalDays, sameDate: totalDays === 0 }
  }
  const startCalendar = calendarParts(toIsoDate(start), calendar)
  const endCalendar = calendarParts(toIsoDate(end), calendar)
  if (!startCalendar || !endCalendar) return null
  let years = endCalendar.year - startCalendar.year
  let cursorParts = addCalendarYears(startCalendar, years, calendar)
  let cursorIso = calendarToIso(cursorParts, calendar)
  while (!cursorIso || (parseIsoDate(cursorIso) && dateToUtc(parseIsoDate(cursorIso)!) > dateToUtc(end))) {
    years -= 1
    cursorParts = addCalendarYears(startCalendar, years, calendar)
    cursorIso = calendarToIso(cursorParts, calendar)
  }
  let months = 0
  while (true) {
    const nextParts = addCalendarMonths(cursorParts, months + 1, calendar)
    const nextIso = calendarToIso(nextParts, calendar)
    if (!nextIso || dateToUtc(parseIsoDate(nextIso)!) > dateToUtc(end)) break
    months += 1
  }
  cursorParts = addCalendarMonths(cursorParts, months, calendar)
  cursorIso = calendarToIso(cursorParts, calendar)
  if (!cursorIso) return null
  const days = daysBetween(parseIsoDate(cursorIso)!, end)
  return { years, months, days, totalDays, sameDate: totalDays === 0 }
}

export function addDuration(start: string, years: number, months: number, days: number, calendar: CalendarSystem = 'gregory'): string | null {
  const parts = parseIsoDate(start)
  if (!parts) return null
  if (calendar === 'gregory' || calendar === 'japanese') {
    let result = addYears(parts, years)
    result = addMonths(result, months)
    result = addDays(result, days)
    return inSupportedRange(result) ? toIsoDate(result) : null
  }
  const calendarStart = calendarParts(start, calendar)
  if (!calendarStart) return null
  const afterYears = addCalendarYears(calendarStart, years, calendar)
  const afterMonths = addCalendarMonths(afterYears, months, calendar)
  const baseIso = calendarToIso(afterMonths, calendar)
  if (!baseIso) return null
  const result = addDays(parseIsoDate(baseIso)!, days)
  return inSupportedRange(result) ? toIsoDate(result) : null
}

export function subtractDuration(start: string, years: number, months: number, days: number, calendar: CalendarSystem = 'gregory'): string | null {
  const parts = parseIsoDate(start)
  if (!parts) return null
  if (calendar === 'gregory' || calendar === 'japanese') {
    // The reference subtracts smaller units first; the order changes month-end results.
    let result = addDays(parts, -days)
    result = addMonths(result, -months)
    result = addYears(result, -years)
    return inSupportedRange(result) ? toIsoDate(result) : null
  }
  const afterDays = addDays(parts, -days)
  const calendarStart = calendarParts(toIsoDate(afterDays), calendar)
  if (!calendarStart) return null
  const afterMonths = addCalendarMonths(calendarStart, -months, calendar)
  const afterYears = addCalendarYears(afterMonths, -years, calendar)
  return calendarToIso(afterYears, calendar)
}

export function formatDate(iso: string, locale: string, calendar: CalendarSystem = 'gregory'): string {
  const parts = parseIsoDate(iso)
  if (!parts) return iso
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const tag = `${locale === 'zh-CN' ? 'zh-CN' : 'en-US'}-u-ca-${calendar}`
  return new Intl.DateTimeFormat(tag, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export function todayIso(): string {
  const now = new Date()
  const pad = (value: number) => (value < 10 ? `0${value}` : `${value}`)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function formatDuration(years: number, months: number, days: number, locale: string): string {
  const tag = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  const unit = (value: number, name: 'year' | 'month' | 'day'): string =>
    new Intl.NumberFormat(tag, { style: 'unit', unit: name, unitDisplay: 'long' }).format(value)
  const parts: string[] = []
  if (years) parts.push(unit(years, 'year'))
  if (months) parts.push(unit(months, 'month'))
  if (days) parts.push(unit(days, 'day'))
  return parts.length ? parts.join(' ') : unit(0, 'day')
}
