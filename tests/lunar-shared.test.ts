import { describe, expect, it, vi } from 'vitest'
import { Solar } from 'lunar-typescript'
import {
  lunar2solar,
  lunarOf,
  lunarYearStart,
  solar2lunar,
  solarTermOf,
  solarTermsOfYear,
} from '../src/shared/calendar/lunar'
import { lunarOf as clientLunarOf } from '../src/client/lib/lunar/lunar-calendar'
import { LUNAR_YEAR_TABLE as clientLunarYearTable } from '../src/client/lib/lunar/lunar-data'
import { LUNAR_YEAR_TABLE } from '../src/shared/calendar/lunar'

vi.setConfig({ testTimeout: 120_000 })

const MS_PER_DAY = 86_400_000
const PARITY_START = Date.UTC(1900, 0, 31)
const PARITY_END = Date.UTC(2100, 11, 31)

function dateOf(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}

function keyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

const LUNAR_ANCHORS: [string, number, number, number, boolean][] = [
  ['1933-07-22', 1933, 5, 30, true],
  ['2052-08-24', 2052, 8, 1, false],
  ['2033-12-22', 2033, 11, 1, true],
  ['2027-02-06', 2027, 1, 1, false],
]

describe('shared lunar conversion', () => {
  it.each(LUNAR_ANCHORS)('resolves the almanac anchor %s', (key, year, month, day, isLeap) => {
    const [solarYear, solarMonth, solarDay] = key.split('-').map(Number) as [number, number, number]
    expect(lunarOf(dateOf(key))).toMatchObject({ year, month, day, isLeap })
    expect(solar2lunar(solarYear, solarMonth, solarDay)).toMatchObject({ year, month, day, isLeap })
  })

  it('keeps both endpoints of the compact table inclusive', () => {
    expect(solar2lunar(1900, 1, 31)).toMatchObject({ year: 1900, month: 1, day: 1, isLeap: false })
    expect(solar2lunar(2101, 1, 28)).toMatchObject({ year: 2100, month: 12, day: 29, isLeap: false })
    expect(lunar2solar({ year: 2100, month: 12, day: 29, isLeap: false })).toEqual({ year: 2101, month: 1, day: 28 })
    expect(lunarYearStart(1900)?.getTime()).toBe(new Date(1900, 0, 31).getTime())
    expect(lunarYearStart(2101)).toBeNull()
    expect(solar2lunar(1899, 12, 31)).toBeNull()
    expect(solar2lunar(2101, 1, 29)).toBeNull()
    expect(lunarOf(dateOf('2101-01-29'))).toBeNull()
  })

  it('rejects impossible civil dates instead of normalising them into another day', () => {
    expect(solar2lunar(2026, 2, 29)).toBeNull()
    expect(solar2lunar(2026, 13, 1)).toBeNull()
    expect(solar2lunar(2026, 1, 0)).toBeNull()
    expect(solar2lunar(2026, 1, 1.5)).toBeNull()
  })

  it('makes the client calendar a wrapper over the shared implementation', () => {
    expect(clientLunarOf).toBe(lunarOf)
    expect(clientLunarYearTable).toBe(LUNAR_YEAR_TABLE)
  })

  it('matches lunar-typescript on all 73,384 evidenced conversions', () => {
    const mismatches: string[] = []
    let checked = 0
    for (let utc = PARITY_START; utc <= PARITY_END; utc += MS_PER_DAY) {
      const key = keyOf(new Date(utc))
      const expected = Solar.fromYmd(...key.split('-').map(Number) as [number, number, number]).getLunar()
      const actual = lunarOf(dateOf(key))
      const wanted = {
        year: expected.getYear(),
        month: Math.abs(expected.getMonth()),
        day: expected.getDay(),
        isLeap: expected.getMonth() < 0,
        ganzhi: expected.getYearInGanZhi(),
      }
      if (!actual || actual.year !== wanted.year || actual.month !== wanted.month || actual.day !== wanted.day
        || actual.isLeap !== wanted.isLeap || actual.ganzhi !== wanted.ganzhi)
        mismatches.push(`${key}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`)
      checked++
    }
    expect(checked).toBe(73_384)
    expect(mismatches.slice(0, 5)).toEqual([])
  })

  it('round-trips all 73,384 evidenced solar days through the inverse conversion', () => {
    const mismatches: string[] = []
    let checked = 0
    for (let utc = PARITY_START; utc <= PARITY_END; utc += MS_PER_DAY) {
      const solar = new Date(utc)
      const lunar = solar2lunar(solar.getUTCFullYear(), solar.getUTCMonth() + 1, solar.getUTCDate())
      const back = lunar ? lunar2solar(lunar) : null
      if (!back || back.year !== solar.getUTCFullYear() || back.month !== solar.getUTCMonth() + 1 || back.day !== solar.getUTCDate())
        mismatches.push(`${keyOf(solar)} -> ${JSON.stringify(lunar)} -> ${JSON.stringify(back)}`)
      checked++
    }
    expect(checked).toBe(73_384)
    expect(mismatches.slice(0, 5)).toEqual([])
  })
})

describe('shared Beijing solar terms', () => {
  it('matches lunar-typescript on all 4,824 civil-term dates', () => {
    const mismatches: string[] = []
    let checked = 0
    for (let year = 1900; year <= 2100; year++) {
      const table = Solar.fromYmd(year, 1, 1).getLunar().getJieQiTable()
      const expected = new Map<string, { year: number; month: number; day: number }>()
      for (const [name, solar] of Object.entries(table)) {
        if (solar.getYear() === year && name.length === 2)
          expected.set(name, { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay() })
      }
      const termNames = Object.keys(table).filter(name => name.length === 2)
      const missingName = termNames.find(name => !expected.has(name))!
      const winterSolstice = Object.entries(table).find(([name, solar]) => name.length > 2 && solar.getYear() === year)!
      expected.set(missingName, {
        year: winterSolstice[1].getYear(),
        month: winterSolstice[1].getMonth(),
        day: winterSolstice[1].getDay(),
      })
      const terms = solarTermsOfYear(year)
      const actual = new Map(terms.map(term => [term.name, {
        year: term.date.getUTCFullYear(),
        month: term.date.getUTCMonth() + 1,
        day: term.date.getUTCDate(),
      }]))
      expect(actual.size).toBe(24)
      for (const [name, date] of expected) {
        const found = actual.get(name)
        if (!found || found.year !== date.year || found.month !== date.month || found.day !== date.day)
          mismatches.push(`${year} ${name}: ${JSON.stringify(found)} != ${JSON.stringify(date)}`)
        const solar = terms.find(term => term.name === name)!
        expect(solarTermOf(dateOf(keyOf(solar.date)))).toBe(name)
        checked++
      }
    }
    expect(checked).toBe(4_824)
    expect(mismatches.slice(0, 5)).toEqual([])
  })

  it('keeps the term table inside its Gregorian range', () => {
    expect(solarTermOf(dateOf('1899-12-31'))).toBeNull()
    expect(solarTermOf(dateOf('2101-01-01'))).toBeNull()
    expect(solarTermsOfYear(1899)).toEqual([])
    expect(solarTermsOfYear(2101)).toEqual([])
  })
})
