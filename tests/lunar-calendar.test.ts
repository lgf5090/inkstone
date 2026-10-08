import { describe, expect, it } from 'vitest'
import { almanacOf, festivalCellName } from '../src/client/lib/lunar/festivals'
import { dayOfYear, daysInYear, isoWeekOrdinal, weekOrdinal } from '../src/client/lib/time'
import { lunarOf, lunarYearStart, solarTermOf, solarTermsOfYear } from '../src/client/lib/lunar/lunar-calendar'
import { lunarDayName, lunarMonthName } from '../src/client/lib/lunar/lunar-data'

// Each row is an almanac fact checked against a published source, not against this table: the
// 2027 spring festival moved a day between the tabulated calendar and a purely computed one, and
// 2033 is the year a rule set that ignores the winter-solstice inclusion gets the leap month wrong.
const LUNAR_ALMANAC_FIXTURES: [string, string][] = [
  ['1900-01-31', '庚子正月-初一'],
  ['1984-02-02', '甲子正月-初一'],
  ['2020-05-23', '庚子闰四月-初一'],
  ['2023-03-22', '癸卯闰二月-初一'],
  ['2024-02-10', '甲辰正月-初一'],
  ['2025-01-29', '乙巳正月-初一'],
  ['2025-07-25', '乙巳闰六月-初一'],
  ['2026-02-17', '丙午正月-初一'],
  ['2026-10-08', '丙午八月-廿八'],
  ['2033-12-21', '癸丑冬月-三十'],
  ['2033-12-22', '癸丑闰冬月-初一'],
  ['2046-02-19', '丙寅正月-十四'],
]

const LUNAR_TERM_FIXTURES: [string, string][] = [
  ['2026-02-04', '立春'],
  ['2026-04-05', '清明'],
  ['2026-06-21', '夏至'],
  ['2026-12-22', '冬至'],
  ['2025-12-21', '冬至'],
  ['2024-03-20', '春分'],
]

const LUNAR_DAY_NAME_FIXTURES: [number, string][] = [
  [1, '初一'], [10, '初十'], [11, '十一'], [19, '十九'],
  [20, '二十'], [21, '廿一'], [29, '廿九'], [30, '三十'],
]

const LUNAR_MONTH_NAME_FIXTURES: [number, boolean, string][] = [
  [1, false, '正月'], [8, false, '八月'], [11, false, '冬月'], [12, false, '腊月'],
  [6, true, '闰六月'], [13, false, ''], [0, false, ''],
]

const LUNAR_SHORT_NAME_FIXTURES: [string, string][] = [
  ['2026-10-08', '廿八'],
  ['2026-12-09', '冬月'],
  ['2026-02-17', '正月'],
  // The first day of a repeated month is the only lunar label that would need three characters.
  ['2025-07-25', '闰六'],
]

const FESTIVAL_CELL_FIXTURES: [string, string][] = [
  ['国庆节', '国庆'],
  ['重阳节', '重阳'],
  ['国家宪法日', '宪法'],
  ['龙抬头', '龙头'],
  ['公祭日', '公祭'],
  ['情人节', '情人'],
  ['春节', '春节'],
  ['清明', '清明'],
  ['小年', '小年'],
]

const LUNAR_FESTIVAL_FIXTURES: [string, string | null][] = [
  ['2027-02-05', '除夕'],
  ['2027-02-06', '春节'],
  ['2026-09-25', '中秋节'],
  ['2026-06-19', '端午节'],
  ['2025-08-29', '七夕'],
  ['2025-07-25', null],
  ['2026-04-05', '清明'],
  ['2026-05-21', null],
  ['2026-12-22', '冬至'],
  // The last day of a middle month is a month end, not the year end: only the twelfth month
  // closes the lunar year, and a month of thirty days must not be read as New Year's Eve.
  ['2025-07-24', null],
  ['2026-09-10', '教师节'],
  // 2023 repeated its second month, and the second day of that month falls inside the repeat. The
  // repeat is not the month it repeats, so the dragon-head raising belongs to the ordinary one only.
  ['2023-03-23', null],
  ['2023-02-21', '龙抬头'],
  ['2020-06-25', '端午节'],
]

const at = (key: string) => new Date(`${key}T12:00:00`)

function lunarText(key: string): string | null {
  const lunar = lunarOf(at(key))
  return lunar ? `${lunar.ganzhi}${lunar.monthName}-${lunar.dayName}` : null
}

describe('lunar calendar table', () => {
  it.each(LUNAR_ALMANAC_FIXTURES)('reads %s as %s', (key, expected) => {
    expect(lunarText(key)).toBe(expected)
  })

  it('marks the turn of the lunar year at both ends', () => {
    expect(lunarOf(at('2027-02-05'))?.isYearEnd).toBe(true)
    expect(lunarOf(at('2027-02-06'))?.isYearStart).toBe(true)
    expect(lunarOf(at('2027-02-04'))?.isYearEnd).toBe(false)
  })

  it('refuses a date off the table rather than guessing', () => {
    expect(lunarOf(at('1899-12-31'))).toBeNull()
    expect(lunarOf(at('2101-06-01'))).toBeNull()
    expect(solarTermOf(at('1899-12-31'))).toBeNull()
    expect(lunarYearStart(1899)).toBeNull()
  })

  it('walks the whole range with each month running 29 or 30 days', () => {
    let previous = lunarOf(at('1901-01-01'))!
    for (let ms = Date.UTC(1901, 0, 2); ms < Date.UTC(2099, 11, 31); ms += 86_400_000) {
      const date = new Date(ms)
      const current = lunarOf(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
      expect(current).not.toBeNull()
      if (current!.day === previous.day + 1) {
        expect(current!.month).toBe(previous.month)
        expect(current!.isLeap).toBe(previous.isLeap)
        expect(current!.year).toBe(previous.year)
      }
      else {
        expect(current!.day).toBe(1)
        expect(previous.day === 29 || previous.day === 30).toBe(true)
      }
      previous = current!
    }
  })

  it('counts each lunar year into the length range every almanac uses', () => {
    let checked = 0
    for (let year = 1901; year <= 2099; year++) {
      const start = lunarYearStart(year)
      const next = lunarYearStart(year + 1)
      if (!start || !next)
        continue
      const days = Math.round((next.getTime() - start.getTime()) / 86_400_000)
      expect(days).toBeGreaterThanOrEqual(353)
      expect(days).toBeLessThanOrEqual(385)
      checked++
    }
    expect(checked).toBeGreaterThan(150)
  })
})

describe('solar terms', () => {
  it.each(LUNAR_TERM_FIXTURES)('places %s at %s', (key, expected) => {
    expect(solarTermOf(at(key))).toBe(expected)
  })

  it('lists all twenty-four terms of a year, two to a month', () => {
    const terms = solarTermsOfYear(2026)
    expect(terms).toHaveLength(24)
    terms.forEach((term, index) => expect(term.date.getUTCMonth()).toBe(index >> 1))
  })

  it('returns nothing for a year off the table', () => {
    expect(solarTermsOfYear(1899)).toEqual([])
    expect(solarTermsOfYear(2101)).toEqual([])
  })
})

describe('almanac naming', () => {
  it.each(LUNAR_DAY_NAME_FIXTURES)('day %i reads %s', (day, expected) => {
    expect(lunarDayName(day)).toBe(expected)
  })

  it.each(LUNAR_MONTH_NAME_FIXTURES)('month %i leap=%s reads %s', (month, isLeap, expected) => {
    expect(lunarMonthName(month, isLeap)).toBe(expected)
  })
})

describe('festival resolution', () => {
  it.each(LUNAR_FESTIVAL_FIXTURES)('%s is named %s', (key, expected) => {
    expect(almanacOf(at(key))?.highlight).toBe(expected)
  })

  it('flags which highlights come from the sun rather than the moon', () => {
    expect(almanacOf(at('2026-04-05'))?.isTerm).toBe(true)
    expect(almanacOf(at('2026-09-25'))?.isTerm).toBe(false)
  })

  it.each(LUNAR_SHORT_NAME_FIXTURES)('the cell for %s reads %s', (key, expected) => {
    expect(almanacOf(at(key))?.short).toBe(expected)
  })

  it.each(FESTIVAL_CELL_FIXTURES)('%s fits a cell as %s', (name, expected) => {
    expect(festivalCellName(name)).toBe(expected)
    expect(expected.length).toBeLessThanOrEqual(2)
  })
})

describe('week numbering', () => {
  it.each([
    ['2021-01-04', 1, 2021],
    ['2021-01-03', 53, 2020],
    ['2026-01-01', 1, 2026],
    ['2026-12-31', 53, 2026],
    ['2024-01-01', 1, 2024],
    // 2026 opens on a Thursday, which is what makes it a 53-week ISO year: the row of 28 December
    // sits exactly 52 weeks after the row that opened the year.
    ['2026-12-28', 53, 2026],
    ['2027-01-01', 53, 2026],
    ['2027-01-04', 1, 2027],
  ] as [string, number, number][])('ISO week of %s is %i of %i', (key, week, year) => {
    expect(isoWeekOrdinal(at(key))).toEqual({ week, year })
  })

  it('follows ISO only for a Monday grid', () => {
    expect(weekOrdinal(at('2021-01-03'), 1)).toEqual({ week: 53, year: 2020 })
    // 2021 opened on a Friday, so a Sunday grid is already on its second row by the 3rd.
    expect(weekOrdinal(at('2021-01-03'), 0)).toEqual({ week: 2, year: 2021 })
  })

  it('numbers a Sunday grid by the row holding January 1st', () => {
    expect(weekOrdinal(at('2026-01-03'), 0)).toEqual({ week: 1, year: 2026 })
    expect(weekOrdinal(at('2026-01-04'), 0)).toEqual({ week: 2, year: 2026 })
    expect(weekOrdinal(at('2026-10-08'), 0)).toEqual({ week: 41, year: 2026 })
  })

  it('agrees with the published number for a Monday grid all year', () => {
    for (let day = 0; day < 370; day++) {
      const date = new Date(2026, 0, 1 + day)
      expect(weekOrdinal(date, 1)).toEqual(isoWeekOrdinal(date))
    }
  })

  it('never numbers a row zero or past the year', () => {
    for (let year = 1990; year <= 2060; year++) {
      for (const weekStart of [0, 1, 6] as const) {
        for (let month = 0; month < 12; month++) {
          const ordinal = weekOrdinal(new Date(year, month, 15), weekStart)
          expect(ordinal.week).toBeGreaterThanOrEqual(1)
          expect(ordinal.week).toBeLessThanOrEqual(53)
          expect(Math.abs(ordinal.year - year)).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('year position', () => {
  it('counts days and knows its leap years', () => {
    expect(dayOfYear(at('2026-01-01'))).toBe(1)
    expect(dayOfYear(at('2026-12-31'))).toBe(365)
    expect(dayOfYear(at('2024-12-31'))).toBe(366)
    expect(daysInYear(1900)).toBe(365)
    expect(daysInYear(2000)).toBe(366)
    expect(daysInYear(2026)).toBe(365)
  })
})
