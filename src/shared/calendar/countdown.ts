/**
 * Countdowns: a date worth counting towards, kept apart from the calendar's event rows.
 *
 * A countdown is not a meeting. It has no duration, no attendees and no colour on the grid, and a
 * reader editing one must not be able to move it onto a calendar or drag it into a time slot. It
 * therefore lives in its own table and arrives on screen as a strip above the month and a card in the
 * sidebar, never as a DayFlow event.
 *
 * The rules that decide "the next occurrence" are pure and shared, because the same question is asked
 * by the strip, the month marker and a test: a yearly birthday on 29 February has no 29 February in an
 * ordinary year, and a lunar birthday has neither a 30th day in every month nor a leap month in most
 * years. Both are answered here once, with the fallback stated rather than left to a component.
 */

import { Temporal } from 'temporal-polyfill'
import { leapMonth, lunar2solar, solar2lunar } from '../subscriptions/lunar'

export const COUNTDOWN_REPEATS = ['none', 'yearly', 'lunar'] as const
export type CountdownRepeat = (typeof COUNTDOWN_REPEATS)[number]

export const MAX_COUNTDOWN_TITLE = 120
export const MAX_COUNTDOWN_NOTE = 2000
export const MAX_COUNTDOWNS = 200

/** A countdown as the API hands it over. `date` is always the *solar* day it started from. */
export interface CalendarCountdownDto {
  id: string
  title: string
  /** `YYYY-MM-DD`, the first (or only) occurrence. */
  date: string
  repeat: CountdownRepeat
  /** Lunar month (1–12) when `repeat` is lunar; null otherwise. */
  lunarMonth: number | null
  /** Lunar day (1–30) when `repeat` is lunar; null otherwise. */
  lunarDay: number | null
  lunarLeap: boolean
  note: string
  color: string
  pinned: boolean
  rev: number
}

export interface CalendarCountdownInput {
  id?: string
  title: string
  date: string
  repeat?: CountdownRepeat
  note?: string
  color?: string
  pinned?: boolean
  rev?: number
}

/** What a countdown's next occurrence is, from one day's point of view. */
export interface CountdownOccurrence {
  /** The occurrence the strip counts towards. */
  date: Temporal.PlainDate
  /** Whole days from `today`; 0 is today. */
  days: number
  /** 1-based ordinal of the year the occurrence falls in, as in "the 3rd". */
  ordinal: number
  /** True when the occurrence had to move a day backwards to exist (29 February, lunar 30th). */
  clamped: boolean
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isCountdownDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  try {
    return Temporal.PlainDate.from(value).toString() === value
  } catch {
    // 2026-02-30 matches the shape and not the calendar; the answer is the same either way.
    return false
  }
}

export function isCountdownRepeat(value: unknown): value is CountdownRepeat {
  return typeof value === 'string' && (COUNTDOWN_REPEATS as readonly string[]).includes(value)
}

function dayOf(value: string): Temporal.PlainDate {
  return Temporal.PlainDate.from(value)
}

function withYear(date: Temporal.PlainDate, year: number): Temporal.PlainDate {
  try {
    return date.with({ year })
  } catch {
    // Only 29 February can land here: the year has no such day, and a birthday that falls on a
    // missing date is kept on the 28th rather than skipped altogether.
    return date.with({ year, day: 28 })
  }
}

/** The solar day a lunar month/day names in one lunar year, clamping down when the day is missing. */
function lunarDayInYear(
  year: number,
  month: number,
  day: number,
  isLeap: boolean,
): { date: Temporal.PlainDate; clamped: boolean } | null {
  const leap = leapMonth(year)
  // A leap-month birthday in a year without that leap month is kept on the ordinary month: the reader
  // means "my birthday", and a year that silently drops it is the one behaviour nobody accepts.
  const useLeap = isLeap && leap === month
  for (let candidate = day; candidate >= Math.max(1, day - 2); candidate--) {
    const solar = lunar2solar({ year, month, day: candidate, isLeap: useLeap })
    if (solar) {
      return { date: Temporal.PlainDate.from(solar), clamped: candidate !== day }
    }
  }
  return null
}

/** The lunar year a solar date falls in, so a lunar birthday is counted in lunar years. */
function lunarYearOf(date: Temporal.PlainDate): number {
  const lunar = solar2lunar(date.year, date.month, date.day)
  return lunar?.year ?? date.year
}

/**
 * The next occurrence on or after `today`.
 *
 * A repeating countdown never reads as "passed": once its day is gone it rolls to the next year, which
 * is what makes it a countdown rather than an anniversary log. A one-off keeps its signed distance,
 * because "passed 3 days ago" is the answer that matters for it.
 */
export function countdownOccurrence(
  item: Pick<CalendarCountdownDto, 'date' | 'repeat' | 'lunarMonth' | 'lunarDay' | 'lunarLeap'>,
  today: Temporal.PlainDate,
): CountdownOccurrence {
  const first = dayOf(item.date)
  if (item.repeat === 'none') {
    return { date: first, days: first.since(today).days, ordinal: 1, clamped: false }
  }

  if (item.repeat === 'lunar' && item.lunarMonth && item.lunarDay) {
    const month = item.lunarMonth
    const day = item.lunarDay
    const isLeap = item.lunarLeap
    let year = lunarYearOf(today)
    let ordinal = Math.max(1, year - lunarYearOf(first) + 1)
    for (let guard = 0; guard < 3; guard++) {
      const found = lunarDayInYear(year, month, day, isLeap)
      if (found) {
        const days = found.date.since(today).days
        if (days >= 0) {
          return { date: found.date, days, ordinal: Math.max(1, year - lunarYearOf(first) + 1), clamped: found.clamped }
        }
      }
      year += 1
      ordinal += 1
    }
    // A lunar day that resolves nowhere in three years is a table problem, not a reader problem;
    // falling back to the first date keeps the card readable instead of throwing in a render pass.
    return { date: first, days: first.since(today).days, ordinal: 1, clamped: false }
  }

  let date = withYear(first, today.year)
  if (date.since(today).days < 0) date = withYear(first, today.year + 1)
  return {
    date,
    days: date.since(today).days,
    ordinal: Math.max(1, date.year - first.year + 1),
    clamped: date.month !== first.month || date.day !== first.day,
  }
}

/**
 * Pinned first, then the nearest day, then the title.
 *
 * The same order on both surfaces: a strip that reordered itself between the sidebar and the month
 * would make the reader look for the same row twice.
 */
export function sortCountdowns(items: readonly CalendarCountdownDto[], today: Temporal.PlainDate): CalendarCountdownDto[] {
  const rows = items.map(item => ({ item, occurrence: countdownOccurrence(item, today) }))
  rows.sort((left, right) => {
    if (left.item.pinned !== right.item.pinned) return left.item.pinned ? -1 : 1
    if (left.occurrence.days !== right.occurrence.days) return left.occurrence.days - right.occurrence.days
    return left.item.title.localeCompare(right.item.title)
  })
  return rows.map(row => row.item)
}

/** Whether an occurrence falls inside a window, used by the month marker and the day panel. */
export function countdownFallsOn(
  item: Pick<CalendarCountdownDto, 'date' | 'repeat' | 'lunarMonth' | 'lunarDay' | 'lunarLeap'>,
  date: Temporal.PlainDate,
): boolean {
  const first = dayOf(item.date)
  if (item.repeat === 'none') return Temporal.PlainDate.compare(first, date) === 0
  if (item.repeat === 'lunar' && item.lunarMonth && item.lunarDay) {
    const lunar = lunarDayInYear(lunarYearOf(date), item.lunarMonth, item.lunarDay, item.lunarLeap)
    return lunar !== null && Temporal.PlainDate.compare(lunar.date, date) === 0
  }
  const candidate = withYear(first, date.year)
  return Temporal.PlainDate.compare(candidate, date) === 0
}

/** How many years a repeat has run, shown as an ordinal beside the distance. */
export function countdownOrdinal(item: Pick<CalendarCountdownDto, 'date' | 'repeat' | 'lunarMonth' | 'lunarDay' | 'lunarLeap'>, occurrence: CountdownOccurrence): number {
  return item.repeat === 'none' ? 1 : occurrence.ordinal
}
