/**
 * Subscription-facing lunar conversion and period arithmetic.
 *
 * The calendar owns the compact conversion tables; this module adapts their result to the names a
 * renewal form and notification show, and adds the period rules subscriptions need.
 */

import {
  ALMANAC_TEXT as CALENDAR_ALMANAC_TEXT,
  GANZI_VOCABULARY as CALENDAR_GANZI_VOCABULARY,
  LUNAR_DAY_NAMES as CALENDAR_LUNAR_DAY_NAMES,
  LUNAR_MONTH_NAMES as CALENDAR_LUNAR_MONTH_NAMES,
  LUNAR_RANGE_END,
  LUNAR_RANGE_START,
  leapDays,
  leapMonth,
  lunar2solar as calendarLunar2solar,
  monthDays,
  solar2lunar as calendarSolar2lunar,
  type LunarDate as CalendarLunarDate,
} from '../calendar/lunar'

export {
  ALMANAC_TEXT,
  LUNAR_DAY_NAMES,
  LUNAR_RANGE_END,
  LUNAR_RANGE_START,
  leapDays,
  leapMonth,
  lunarYearDays,
  monthDays,
} from '../calendar/lunar'

/** The sexagenary cycle, kept as one value so the gate that reads vocabulary sees a single table. */
export const GANZI_VOCABULARY = {
  gan: CALENDAR_GANZI_VOCABULARY.stems,
  zhi: CALENDAR_GANZI_VOCABULARY.branches,
}

export const LUNAR_MONTH_NAMES = CALENDAR_LUNAR_MONTH_NAMES.map(name => name.slice(0, -1))

export interface LunarDate extends CalendarLunarDate {
  yearStr: string
  monthStr: string
  dayStr: string
  fullStr: string
}

/**
 * The month and day names in the language the interface is actually wearing.
 *
 * The tables above are the almanac's own vocabulary and stay for a Chinese reader; an English interface
 * that renders those glyphs names a thing the reader cannot read, which is the same failure the rest of
 * this app has to avoid. The number is always there, because that is what a renewal date is counted in.
 */
export function lunarMonthLabel(index: number, locale: string): string {
  return locale === 'zh-CN' ? `${LUNAR_MONTH_NAMES[index] ?? ''}${CALENDAR_ALMANAC_TEXT.month}` : `Month ${index + 1}`
}

/** The same month with the leap marker the calendar carries. */
export function lunarLeapMonthLabel(index: number, locale: string): string {
  return locale === 'zh-CN' ? `${CALENDAR_ALMANAC_TEXT.leap}${LUNAR_MONTH_NAMES[index] ?? ''}${CALENDAR_ALMANAC_TEXT.month}` : `Leap month ${index + 1}`
}

export function lunarDayLabel(day: number, locale: string): string {
  return locale === 'zh-CN' ? CALENDAR_LUNAR_DAY_NAMES[day - 1] ?? '' : `Day ${day}`
}

/** Solar calendar fields to the lunar date they name, or null outside 1900-2100. */
export function solar2lunar(year: number, month: number, day: number): LunarDate | null {
  const lunar = calendarSolar2lunar(year, month, day)
  if (!lunar)
    return null
  const yearStr = `${lunar.ganzhi}${CALENDAR_ALMANAC_TEXT.year}`
  const monthStr = `${lunar.monthName}${CALENDAR_ALMANAC_TEXT.month}`
  const dayStr = lunar.dayName
  return { ...lunar, yearStr, monthStr, dayStr, fullStr: `${yearStr}${monthStr}${dayStr}` }
}

/** Lunar date to solar calendar fields, or null when the date does not exist. */
export function lunar2solar(lunar: Parameters<typeof calendarLunar2solar>[0]): ReturnType<typeof calendarLunar2solar> {
  return calendarLunar2solar(lunar)
}

/**
 * Advance a lunar date by a period, clamping the day into the target month.
 *
 * A lunar month is 29 or 30 days, so "the 30th, three months later" may not exist; the reference
 * project walks the day down until the combination resolves, which is what a reader means by "same
 * day next quarter" when the day is missing.
 */
export function addLunarPeriod(
  lunar: Pick<LunarDate, 'year' | 'month' | 'day' | 'isLeap'>,
  periodValue: number,
  periodUnit: 'day' | 'month' | 'year',
): Pick<LunarDate, 'year' | 'month' | 'day' | 'isLeap'> {
  let { year, month, day, isLeap } = lunar
  const amount = Math.trunc(periodValue)
  if (!Number.isFinite(amount) || amount === 0) return { year, month, day, isLeap }

  if (periodUnit === 'day') {
    const solar = lunar2solar({ year, month, day, isLeap })
    if (!solar) return { year, month, day, isLeap }
    const shifted = new Date(Date.UTC(solar.year, solar.month - 1, solar.day + amount))
    const next = solar2lunar(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
    return next ?? { year, month, day, isLeap }
  }

  if (periodUnit === 'year') {
    year += amount
    const leap = leapMonth(year)
    isLeap = isLeap && leap === month
  } else {
    const total = (year - LUNAR_RANGE_START) * 12 + (month - 1) + amount
    year = Math.floor(total / 12) + LUNAR_RANGE_START
    month = (total % 12) + 1
    const leap = leapMonth(year)
    isLeap = isLeap && leap === month
  }

  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END) return { year, month, day, isLeap }
  const ceiling = isLeap ? leapDays(year) : monthDays(year, month)
  return { year, month, day: Math.min(day, ceiling), isLeap }
}

/** The lunar date an instant falls on, read in the given calendar fields' zone. */
export function lunarOfSolarFields(parts: { year: number; month: number; day: number }): LunarDate | null {
  return solar2lunar(parts.year, parts.month, parts.day)
}
