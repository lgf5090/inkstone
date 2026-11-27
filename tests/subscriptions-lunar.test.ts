import { describe, expect, it } from 'vitest'
import {
  addLunarPeriod,
  leapDays,
  leapMonth,
  lunar2solar,
  lunarDayLabel,
  lunarLeapMonthLabel,
  lunarMonthLabel,
  lunarYearDays,
  monthDays,
  solar2lunar,
} from '../src/shared/subscriptions/lunar'

describe('the lunar table', () => {
  it('knows the leap months of well-known years', () => {
    expect(leapMonth(2023)).toBe(2)
    expect(leapMonth(2024)).toBe(0)
    expect(leapMonth(2025)).toBe(6)
  })

  it('agrees with itself about year lengths', () => {
    for (const year of [1900, 1950, 2000, 2023, 2025, 2100]) {
      const months = Array.from({ length: 12 }, (_, index) => monthDays(year, index + 1))
      expect(lunarYearDays(year)).toBe(months.reduce((total, days) => total + days, 0) + leapDays(year))
    }
  })
})

describe('solar to lunar', () => {
  it('places the 2024 new year on the first day of the first month', () => {
    const date = solar2lunar(2024, 2, 10)
    expect(date).toMatchObject({ year: 2024, month: 1, day: 1, isLeap: false })
  })

  it('names a leap month', () => {
    const date = solar2lunar(2023, 3, 22)
    expect(date?.isLeap).toBe(true)
    expect(date?.month).toBe(2)
  })

  it.each([
    [1933, 7, 22, 1933, 5, 30, true],
    [2052, 8, 24, 2052, 8, 1, false],
    [2033, 12, 22, 2033, 11, 1, true],
    [2027, 2, 6, 2027, 1, 1, false],
  ] as const)('resolves %i-%i-%i from the shared table', (year, month, day, lunarYear, lunarMonth, lunarDay, isLeap) => {
    expect(solar2lunar(year, month, day)).toMatchObject({ year: lunarYear, month: lunarMonth, day: lunarDay, isLeap })
  })

  it('keeps the endpoint and refuses the day beyond it', () => {
    expect(solar2lunar(2101, 1, 28)).toMatchObject({ year: 2100, month: 12, day: 29, isLeap: false })
    expect(lunar2solar({ year: 2100, month: 12, day: 29, isLeap: false })).toEqual({ year: 2101, month: 1, day: 28 })
    expect(solar2lunar(1899, 12, 31)).toBeNull()
    expect(solar2lunar(2101, 1, 29)).toBeNull()
  })
})

describe('lunar to solar', () => {
  it('round-trips every day of representative years', () => {
    const samples: Array<[number, number, number]> = [
      [1900, 1, 31], [1950, 6, 15], [2000, 2, 5], [2023, 3, 22],
      [2024, 2, 10], [2025, 1, 29], [2033, 12, 22], [2100, 12, 31],
    ]
    for (const [year, month, day] of samples) {
      const lunar = solar2lunar(year, month, day)
      expect(lunar).not.toBeNull()
      expect(lunar2solar(lunar!)).toEqual({ year, month, day })
    }
  })

  it('round-trips every day of one solar year', () => {
    for (let month = 1; month <= 12; month++) {
      const ceiling = new Date(Date.UTC(2024, month, 0)).getUTCDate()
      for (let day = 1; day <= ceiling; day++) {
        const lunar = solar2lunar(2024, month, day)
        expect(lunar).not.toBeNull()
        expect(lunar2solar(lunar!)).toEqual({ year: 2024, month, day })
      }
    }
  })

  it('round-trips a whole lunar year, leap month included', () => {
    for (let month = 1; month <= 12; month++) {
      for (const isLeap of [false, true]) {
        if (isLeap && leapMonth(2023) !== month) continue
        const ceiling = isLeap ? leapDays(2023) : monthDays(2023, month)
        for (let day = 1; day <= ceiling; day++) {
          const solar = lunar2solar({ year: 2023, month, day, isLeap })
          expect(solar).not.toBeNull()
          const back = solar2lunar(solar!.year, solar!.month, solar!.day)
          expect(back).toMatchObject({ year: 2023, month, day, isLeap })
        }
      }
    }
  })

  it('refuses a day the month does not have', () => {
    expect(lunar2solar({ year: 2023, month: 1, day: 30, isLeap: false })).toBeNull()
    expect(lunar2solar({ year: 2023, month: 3, day: 1, isLeap: true })).toBeNull()
  })
})

describe('advancing by a lunar period', () => {
  it('adds a year to the same lunar day', () => {
    const start = { year: 2024, month: 1, day: 1, isLeap: false }
    expect(addLunarPeriod(start, 1, 'year')).toMatchObject({ year: 2025, month: 1, day: 1, isLeap: false })
  })

  it('adds months across a year boundary', () => {
    const start = { year: 2024, month: 11, day: 5, isLeap: false }
    expect(addLunarPeriod(start, 3, 'month')).toMatchObject({ year: 2025, month: 2, day: 5 })
  })

  it('clamps a missing thirtieth into a 29-day month', () => {
    const start = { year: 2024, month: 1, day: 30, isLeap: false }
    const next = addLunarPeriod(start, 1, 'month')
    expect(next.day).toBeLessThanOrEqual(30)
    expect(next.month).toBe(2)
  })

  it('adds days through the solar calendar', () => {
    const start = { year: 2024, month: 1, day: 1, isLeap: false }
    expect(addLunarPeriod(start, 1, 'day')).toMatchObject({ year: 2024, month: 1, day: 2 })
  })
})

describe('the names a lunar picker shows', () => {
  it('keeps the almanac vocabulary for a Chinese interface', () => {
    expect(lunarMonthLabel(0, 'zh-CN')).toBe('正月')
    expect(lunarLeapMonthLabel(1, 'zh-CN')).toBe('闰二月')
    expect(lunarDayLabel(12, 'zh-CN')).toBe('十二')
  })

  it('spells the same months and days for an English interface', () => {
    expect(lunarMonthLabel(0, 'en-US')).toBe('Month 1')
    expect(lunarLeapMonthLabel(1, 'en-US')).toBe('Leap month 2')
    expect(lunarDayLabel(12, 'en-US')).toBe('Day 12')
  })
})
