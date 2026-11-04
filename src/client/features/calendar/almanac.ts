/**
 * One month's almanac, computed once and handed to the grid as a lookup.
 *
 * The calendar grid asks about forty-two cells per month, and the library re-renders that grid on
 * every event mutation. Computing each cell where it is drawn would run the lunar table and the term
 * table on every one of those passes; instead the month is resolved up front into a map keyed by
 * `YYYY-MM-DD`, kept for the last few months a reader actually looked at.
 *
 * The lunar date, the solar term and the festival rank already exist in `lib/lunar`, which the
 * sidebar calendar uses. This module adds what only the full calendar needs: the statutory holiday
 * table (verified against the State Council's notices), the Western constellation, and the month-wide
 * window the grid draws, so a cell's answer costs one map lookup.
 */

import { Temporal } from 'temporal-polyfill'
import { holidayDay, type HolidayDay } from '@shared/calendar/holidays'
import { almanacOf } from '../../lib/lunar/festivals'
import { lunarOf, solarTermOf, type LunarDate } from '../../lib/lunar/lunar-calendar'
import type { MessageKey } from '@shared/locales/en-US'

export interface CalendarDayAlmanac {
  key: string
  lunar: LunarDate | null
  /** Two-character lunar cell text, or the term on the days that carry one. */
  short: string
  /** The whole lunar date as the sidebar prints it. */
  long: string
  /** The one feast worth naming that day, as a proper noun. */
  festival: string | null
  festivalShort: string | null
  solarTerm: string | null
  zodiac: string
  constellation: MessageKey
  holiday: HolidayDay
}

const CONSTELLATIONS: readonly { until: readonly [number, number]; key: MessageKey }[] = [
  { until: [1, 19], key: 'calendar.almanac.constellation.capricorn' },
  { until: [2, 18], key: 'calendar.almanac.constellation.aquarius' },
  { until: [3, 20], key: 'calendar.almanac.constellation.pisces' },
  { until: [4, 19], key: 'calendar.almanac.constellation.aries' },
  { until: [5, 20], key: 'calendar.almanac.constellation.taurus' },
  { until: [6, 21], key: 'calendar.almanac.constellation.gemini' },
  { until: [7, 22], key: 'calendar.almanac.constellation.cancer' },
  { until: [8, 22], key: 'calendar.almanac.constellation.leo' },
  { until: [9, 22], key: 'calendar.almanac.constellation.virgo' },
  { until: [10, 23], key: 'calendar.almanac.constellation.libra' },
  { until: [11, 22], key: 'calendar.almanac.constellation.scorpio' },
  { until: [12, 21], key: 'calendar.almanac.constellation.sagittarius' },
]

/**
 * The Western sign for a Gregorian day.
 *
 * Boundaries are the conventional dates, not astronomical ingress, which is what every consumer
 * calendar prints. The last entry is the one that wraps: 22 December opens Capricorn.
 */
export function constellationOf(month: number, day: number): MessageKey {
  for (const entry of CONSTELLATIONS) {
    if (month < entry.until[0] || (month === entry.until[0] && day <= entry.until[1])) return entry.key
  }
  // Past 21 December the cycle wraps back to the sign that opened the list.
  return CONSTELLATIONS[0]!.key
}

function localDate(date: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() })
}

/** One day's almanac, from a Date the grid already holds. */
export function dayAlmanac(date: Date): CalendarDayAlmanac {
  const base = almanacOf(date)
  const lunar = lunarOf(date)
  const term = solarTermOf(date)
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return {
    key,
    lunar,
    short: base?.short || term || '',
    long: base?.long ?? '',
    festival: base?.highlight ?? null,
    festivalShort: base?.highlightShort ?? null,
    solarTerm: term,
    zodiac: lunar?.zodiac ?? '',
    constellation: constellationOf(date.getMonth() + 1, date.getDate()),
    holiday: holidayDay(key),
  }
}

/** The cells a month grid draws: six weeks from the weekday the grid opens on. */
export function monthWindow(year: number, month: number, weekStart: number): Temporal.PlainDate[] {
  const first = Temporal.PlainDate.from({ year, month, day: 1 })
  const offset = (first.dayOfWeek - weekStart + 7) % 7
  const start = first.subtract({ days: offset })
  return Array.from({ length: 42 }, (_, index) => start.add({ days: index }))
}

const WINDOW_CACHE_LIMIT = 24
const windowCache = new Map<string, ReadonlyMap<string, CalendarDayAlmanac>>()

/**
 * The days a grid actually draws, resolved once.
 *
 * The grid opens on a day in the *previous* month whenever the first of the month is not the
 * reader's week start, so the window has to be counted from the cell the grid opens with rather
 * than from the month's first day. Deriving it from the month is what left the tail of a six-week
 * grid without almanac labels: the last week belonged to the next month and was never computed.
 *
 * `days` is the number of rendered cells rather than a fixed forty-two: continuous month scrolling
 * draws the neighbouring weeks too, and every cell on screen has to carry its own date.
 */
export function gridAlmanac(
  start: Temporal.PlainDate,
  weekStart: number,
  days = 42,
): ReadonlyMap<string, CalendarDayAlmanac> {
  const cacheKey = `${weekStart}:${start.toString()}:${days}`
  const hit = windowCache.get(cacheKey)
  if (hit) return hit
  const map = new Map<string, CalendarDayAlmanac>()
  for (let index = 0; index < days; index++) {
    const date = start.add({ days: index })
    const info = dayAlmanac(new Date(date.year, date.month - 1, date.day))
    map.set(info.key, info)
  }
  if (windowCache.size >= WINDOW_CACHE_LIMIT) windowCache.clear()
  windowCache.set(cacheKey, map)
  return map
}

/**
 * All forty-two cells of a month in the reader's week layout.
 *
 * The cache key carries the week start because that is what decides which six weeks the grid is
 * showing: the same month drawn from a Sunday opens two days earlier than from a Monday.
 */
export function monthAlmanac(year: number, month: number, weekStart: number): ReadonlyMap<string, CalendarDayAlmanac> {
  return gridAlmanac(monthWindow(year, month, weekStart)[0]!, weekStart)
}

/** The almanac of one day of a month already resolved; null outside the window a grid draws. */
export function almanacOfKey(
  map: ReadonlyMap<string, CalendarDayAlmanac>,
  date: Date,
): CalendarDayAlmanac | null {
  return map.get(localDate(date).toString()) ?? null
}

/**
 * What a month cell prints under its number.
 *
 * A feast outranks a term, and a term outranks the lunar day, because a reader scanning the month is
 * looking for the named days; the lunar day is what a cell falls back to, and it is never blank —
 * every one of the forty-two cells has a lunar date to show, including the cells of the months on
 * either side of the one being drawn.
 */
export function cellLabel(info: CalendarDayAlmanac, showFestivals: boolean): string | null {
  if (showFestivals && info.festivalShort) return info.festivalShort
  if (info.solarTerm) return info.solarTerm
  return info.short || null
}
