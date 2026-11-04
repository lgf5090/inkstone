import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { cellLabel, constellationOf, dayAlmanac, gridAlmanac, monthAlmanac, monthWindow } from './almanac'
import { weekOrdinal } from '../../lib/time'

describe('dayAlmanac', () => {
  it('names the Spring Festival on its lunar day', () => {
    const info = dayAlmanac(new Date(2024, 1, 10))
    expect(info.lunar?.month).toBe(1)
    expect(info.lunar?.day).toBe(1)
    expect(info.festival).toBe('春节')
  })

  it('marks a leap month as the leap month in the lunar date it reports', () => {
    // 2023-03-22 is the first day of the leap second month, which is not the second month itself.
    const info = dayAlmanac(new Date(2023, 2, 22))
    expect(info.lunar?.isLeap).toBe(true)
    expect(info.lunar?.month).toBe(2)
    expect(info.festival).toBeNull()
  })

  it('names the solar term on the day it falls', () => {
    expect(dayAlmanac(new Date(2024, 3, 4)).solarTerm).toBe('清明')
    expect(dayAlmanac(new Date(2024, 11, 21)).solarTerm).toBe('冬至')
    expect(dayAlmanac(new Date(2024, 3, 5)).solarTerm).toBeNull()
  })

  it('carries the statutory answer beside the lunar one', () => {
    const info = dayAlmanac(new Date(2026, 1, 15))
    expect(info.holiday.off).toBe(true)
    expect(info.holiday.source).toBe('calendar.holidays.notice_2026')
  })

  it('falls back to the lunar day when nothing names the date', () => {
    const info = dayAlmanac(new Date(2026, 10, 4))
    expect(info.festival).toBeNull()
    expect(cellLabel(info, true)).toBe(info.short)
  })
})

describe('constellationOf', () => {
  it('uses the conventional boundaries', () => {
    expect(constellationOf(1, 19)).toBe('calendar.almanac.constellation.capricorn')
    expect(constellationOf(1, 20)).toBe('calendar.almanac.constellation.aquarius')
    expect(constellationOf(12, 21)).toBe('calendar.almanac.constellation.sagittarius')
    expect(constellationOf(12, 22)).toBe('calendar.almanac.constellation.capricorn')
  })
})

describe('week column', () => {
  it('numbers the ISO week from the Monday that opens it', () => {
    expect(weekOrdinal(new Date(2025, 11, 29), 1)).toEqual({ week: 1, year: 2026 })
    expect(weekOrdinal(new Date(2026, 10, 2), 1)).toEqual({ week: 45, year: 2026 })
    expect(weekOrdinal(new Date(2024, 11, 30), 1)).toEqual({ week: 1, year: 2025 })
  })

  it('follows the reader when the week starts on Sunday', () => {
    // With a Sunday start the week that opens on 2026-11-01 is still the year's 45th row.
    expect(weekOrdinal(new Date(2026, 10, 1), 0)).toEqual({ week: 45, year: 2026 })
  })

  it('keeps every row of a six-week grid on one week number', () => {
    const start = Temporal.PlainDate.from('2026-10-26')
    for (let row = 0; row < 6; row++) {
      const date = start.add({ days: row * 7 })
      expect(weekOrdinal(new Date(date.year, date.month - 1, date.day), 1).week).toBe(44 + row)
    }
  })
})

describe('monthWindow and monthAlmanac', () => {
  it('resolves all forty-two cells once and reuses the map afterwards', () => {
    const window = monthWindow(2024, 2, 1)
    expect(window).toHaveLength(42)
    expect(window[0]!.toString()).toBe('2024-01-29')
    const first = monthAlmanac(2024, 2, 1)
    expect(first.size).toBe(42)
    expect(monthAlmanac(2024, 2, 1)).toBe(first)
  })

  it('labels every one of the forty-two cells, including the weeks either side of the month', () => {
    // November 2026 opens on Monday 26 October and closes on Sunday 6 December.
    const map = gridAlmanac(Temporal.PlainDate.from('2026-10-26'), 1)
    expect(map.size).toBe(42)
    const labels = [...map.values()].map(info => cellLabel(info, true))
    expect(labels.filter(label => label === null || label === '')).toEqual([])
    expect(map.get('2026-10-26')?.short).toBe('十七')
    expect(map.get('2026-12-06')?.short).toBeTruthy()
  })

  it('prints the lunar month name on the first day of a lunar month', () => {
    // 2026-11-09 is the first day of the tenth lunar month.
    const map = monthAlmanac(2026, 11, 1)
    expect(map.get('2026-11-09')?.short).toBe('十月')
    // 2026-11-04 is an ordinary lunar day in the same month.
    expect(map.get('2026-11-04')?.short).toBe('廿六')
  })

  it('prints a leap month as its own name on its first day', () => {
    const map = monthAlmanac(2023, 3, 1)
    expect(map.get('2023-03-22')?.lunar?.isLeap).toBe(true)
    expect(map.get('2023-03-22')?.short).toBe('闰二')
  })

  it('prefers a festival over the lunar day, and a term over the lunar day too', () => {
    expect(cellLabel(monthAlmanac(2024, 2, 1).get('2024-02-10')!, true)).toBe('春节')
    const terms = monthAlmanac(2026, 11, 1)
    expect(terms.get('2026-11-07')?.solarTerm).toBe('立冬')
    expect(cellLabel(terms.get('2026-11-07')!, true)).toBe('立冬')
    expect(cellLabel(monthAlmanac(2024, 4, 1).get('2024-04-04')!, true)).toBe('清明')
  })

  it('keeps the window continuous across the new year', () => {
    const map = gridAlmanac(Temporal.PlainDate.from('2025-12-29'), 1)
    expect(map.get('2025-12-29')?.short).toBe('初十')
    expect(map.get('2026-01-01')?.short).toBe('十三')
    expect(map.size).toBe(42)
  })

  it('covers every rendered row when continuous scrolling draws more than six weeks', () => {
    // The month view renders ten rows in scroll mode; each of them must carry a lunar date.
    const map = gridAlmanac(Temporal.PlainDate.from('2026-10-12'), 1, 70)
    expect(map.size).toBe(70)
    expect(map.get('2026-12-20')?.short).toBeTruthy()
    expect([...map.values()].every(info => cellLabel(info, true) !== null)).toBe(true)
  })

  it('opens the window on a different day when the week starts on Sunday', () => {
    expect(monthWindow(2024, 2, 0)[0]!.toString()).toBe('2024-01-28')
    expect(monthAlmanac(2024, 2, 0)).not.toBe(monthAlmanac(2024, 2, 1))
  })

  it('keeps the lunar date on the first day of a lunar month', () => {
    // 2024-02-10 is the first day of the first lunar month, so its cell prints the month name.
    const map = monthAlmanac(2024, 2, 1)
    const info = map.get('2024-02-10')
    expect(info?.festivalShort).toBe('春节')
  })
})
