import { describe, expect, it } from 'vitest'
import { cellLabel, constellationOf, dayAlmanac, monthAlmanac, monthWindow } from './almanac'

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

describe('monthWindow and monthAlmanac', () => {
  it('resolves all forty-two cells once and reuses the map afterwards', () => {
    const window = monthWindow(2024, 2, 1)
    expect(window).toHaveLength(42)
    expect(window[0]!.toString()).toBe('2024-01-29')
    const first = monthAlmanac(2024, 2, 1)
    expect(first.size).toBe(42)
    expect(monthAlmanac(2024, 2, 1)).toBe(first)
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
