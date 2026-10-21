import { MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { dateKey, type WeekStartDay } from '../../lib/time'
import type { MemoCalendarDate } from './route'

const DEFAULT_TIME_ZONE = 'UTC'
const SECONDS_PER_HOUR = 3600
const NOON_SECONDS = 12 * SECONDS_PER_HOUR
const HEAT_LEVELS = 4
const MAX_DAY_START_STEPS = 8
const TIME_ZONE_PROBE = 0

export interface MemoCalendarSelection {
  year: number
  month: number
  day: number
}

export interface ResolvedMemoCalendarSelection extends MemoCalendarSelection {
  invalidDay: boolean
}

export interface MemoMonthCell {
  key: string
  day: number
  inMonth: boolean
  today: boolean
}

export interface MemoMonthRange {
  start: number
  end: number
  timeZone: string
}

export interface MemoCalendarPathDate {
  year: number
  month: number
  day?: number | null
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>()
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayFormatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  dayFormatterCache.set(timeZone, formatter)
  return formatter
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = offsetFormatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  offsetFormatterCache.set(timeZone, formatter)
  return formatter
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value
  return value === undefined ? 0 : Number(value)
}

export function daysInMemoMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function resolveMemoCalendarDate(
  date: MemoCalendarDate | null,
  now: Date,
): ResolvedMemoCalendarSelection {
  const year = date?.year ?? now.getFullYear()
  const month = date?.month ?? (date ? 1 : now.getMonth() + 1)
  const lastDay = daysInMemoMonth(year, month)
  const fallbackDay = year === now.getFullYear() && month === now.getMonth() + 1
    ? now.getDate()
    : 1
  const requested = date?.day
  if (requested === undefined) {
    return { year, month, day: fallbackDay, invalidDay: false }
  }
  const day = Math.min(lastDay, Math.max(1, Math.floor(requested)))
  return { year, month, day, invalidDay: day !== requested }
}

export function memoCalendarDateKey(date: MemoCalendarSelection): string {
  return dateKey(new Date(date.year, date.month - 1, date.day))
}

export function buildMemoMonthCells(
  year: number,
  month: number,
  weekStart: WeekStartDay,
  todayKey: string,
): MemoMonthCell[] {
  const lastDay = daysInMemoMonth(year, month)
  const offset = (new Date(year, month - 1, 1).getDay() - weekStart + 7) % 7
  const rows = Math.ceil((offset + lastDay) / 7)
  return Array.from({ length: rows * 7 }, (_, index) => {
    const day = index - offset + 1
    const cellDate = new Date(year, month - 1, day)
    const key = dateKey(cellDate)
    return {
      key,
      day: cellDate.getDate(),
      inMonth: day >= 1 && day <= lastDay,
      today: key === todayKey,
    }
  })
}

export function memoMonthGridRows(cells: readonly MemoMonthCell[]): MemoMonthCell[][] {
  const rows: MemoMonthCell[][] = []
  for (let index = 0; index < cells.length; index += 7) {
    rows.push(cells.slice(index, index + 7))
  }
  return rows
}

export function addMemoCalendarDays(date: MemoCalendarSelection, delta: number): MemoCalendarSelection {
  const next = new Date(date.year, date.month - 1, date.day)
  next.setDate(next.getDate() + delta)
  return { year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate() }
}

export function shiftMemoCalendarMonth(
  date: MemoCalendarSelection,
  delta: number,
): MemoCalendarSelection {
  const total = date.year * 12 + (date.month - 1) + delta
  const year = Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12 + 1
  return { year, month, day: Math.min(date.day, daysInMemoMonth(year, month)) }
}

export function memoCalendarPath(spaceId: string | null, date: MemoCalendarPathDate): string {
  const base = spaceId
    ? `${MEMOS_APP_PATH}/spaces/${encodeURIComponent(spaceId)}/calendar`
    : `${MEMOS_APP_PATH}/calendar`
  const day = date.day ? `/${date.day}` : ''
  return `${base}/${date.year}/${date.month}${day}`
}

export function resolveMemoTimeZone(candidate?: string | null): string {
  const timeZone = candidate?.trim()
  if (!timeZone) return DEFAULT_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(TIME_ZONE_PROBE)
    return timeZone
  } catch (error) {
    console.warn('[inkstone] Falling back to UTC for an unknown time zone', timeZone, error)
    return DEFAULT_TIME_ZONE
  }
}

export function memoTimeZone(): string {
  try {
    return resolveMemoTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch (error) {
    console.warn('[inkstone] Could not read the browser time zone', error)
    return DEFAULT_TIME_ZONE
  }
}

export function memoDayKeyInTimeZone(seconds: number, timeZone: string): string {
  const zone = resolveMemoTimeZone(timeZone)
  const parts = dayFormatter(zone).formatToParts(new Date(seconds * 1000))
  const year = String(partValue(parts, 'year')).padStart(4, '0')
  const month = String(partValue(parts, 'month')).padStart(2, '0')
  const day = String(partValue(parts, 'day')).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function offsetMillisecondsAt(seconds: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(seconds * 1000))
  const asUtc = Date.UTC(
    partValue(parts, 'year'),
    partValue(parts, 'month') - 1,
    partValue(parts, 'day'),
    partValue(parts, 'hour'),
    partValue(parts, 'minute'),
    partValue(parts, 'second'),
  )
  return asUtc - seconds * 1000
}

export function memoDayStartSeconds(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const zone = resolveMemoTimeZone(timeZone)
  const civilUtc = Date.UTC(year, month - 1, day)
  const targetKey = dateKey(new Date(year, month - 1, day))
  const noonOffset = offsetMillisecondsAt(Math.floor(civilUtc / 1000) + NOON_SECONDS, zone)
  let seconds = Math.floor((civilUtc - noonOffset) / 1000)
  for (
    let step = 0;
    step < MAX_DAY_START_STEPS && memoDayKeyInTimeZone(seconds, zone) < targetKey;
    step += 1
  ) {
    seconds += SECONDS_PER_HOUR
  }
  for (
    let step = 0;
    step < MAX_DAY_START_STEPS && memoDayKeyInTimeZone(seconds, zone) > targetKey;
    step += 1
  ) {
    seconds -= SECONDS_PER_HOUR
  }
  return seconds
}

export function memoMonthRangeSeconds(
  year: number,
  month: number,
  timeZone: string,
): MemoMonthRange {
  const zone = resolveMemoTimeZone(timeZone)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    start: memoDayStartSeconds(year, month, 1, zone),
    end: memoDayStartSeconds(nextYear, nextMonth, 1, zone),
    timeZone: zone,
  }
}

export function groupMemosByDay(
  memos: readonly Memo[],
  timeZone: string,
): Map<string, Memo[]> {
  const zone = resolveMemoTimeZone(timeZone)
  const groups = new Map<string, Memo[]>()
  for (const memo of memos) {
    const key = memoDayKeyInTimeZone(memo.createdAt, zone)
    const bucket = groups.get(key)
    if (bucket) bucket.push(memo)
    else groups.set(key, [memo])
  }
  return groups
}

export function memoMonthHeatLevels(
  dayCounts: Readonly<Record<string, number>>,
  keys: readonly string[],
): Map<string, number> {
  let max = 0
  for (const key of keys) {
    max = Math.max(max, dayCounts[key] ?? 0)
  }
  const levels = new Map<string, number>()
  for (const key of keys) {
    const count = dayCounts[key] ?? 0
    const level = count <= 0 || max <= 0
      ? 0
      : Math.min(HEAT_LEVELS, Math.max(1, Math.round((HEAT_LEVELS * count) / max)))
    levels.set(key, level)
  }
  return levels
}
