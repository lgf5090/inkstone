import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import {
  countdownFallsOn,
  countdownOccurrence,
  countdownOrdinal,
  isCountdownDate,
  sortCountdowns,
  type CalendarCountdownDto,
} from './countdown'

function item(overrides: Partial<CalendarCountdownDto>): CalendarCountdownDto {
  return {
    id: 'c1',
    title: '生日',
    date: '2024-06-01',
    repeat: 'none',
    lunarMonth: null,
    lunarDay: null,
    lunarLeap: false,
    note: '',
    color: '',
    pinned: false,
    rev: 1,
    ...overrides,
  }
}

const today = Temporal.PlainDate.from('2026-11-04')

describe('countdownOccurrence', () => {
  it('counts down to a one-off date and reports a past one as negative', () => {
    expect(countdownOccurrence(item({ date: '2026-12-25' }), today).days).toBe(51)
    expect(countdownOccurrence(item({ date: '2026-11-01' }), today).days).toBe(-3)
  })

  it('treats today as day zero', () => {
    const occurrence = countdownOccurrence(item({ date: '2026-11-04' }), today)
    expect(occurrence.days).toBe(0)
    expect(occurrence.date.toString()).toBe('2026-11-04')
  })

  it('rolls a yearly date forward once it has passed', () => {
    const occurrence = countdownOccurrence(item({ date: '2024-03-08', repeat: 'yearly' }), today)
    expect(occurrence.date.toString()).toBe('2027-03-08')
    expect(occurrence.days).toBe(Temporal.PlainDate.from('2027-03-08').since(today).days)
    expect(occurrence.ordinal).toBe(4)
  })

  it('keeps a 29 February birthday on the 28th in an ordinary year', () => {
    const occurrence = countdownOccurrence(
      item({ date: '2024-02-29', repeat: 'yearly' }),
      Temporal.PlainDate.from('2025-02-01'),
    )
    expect(occurrence.date.toString()).toBe('2025-02-28')
    expect(occurrence.clamped).toBe(true)
  })

  it('keeps 29 February on the 29th in a leap year', () => {
    const occurrence = countdownOccurrence(
      item({ date: '2024-02-29', repeat: 'yearly' }),
      Temporal.PlainDate.from('2027-03-01'),
    )
    expect(occurrence.date.toString()).toBe('2028-02-29')
    expect(occurrence.clamped).toBe(false)
  })

  it('resolves a leap-month lunar birthday to the ordinary month when that leap month is absent', () => {
    // The first day of the leap second month 2023 is 2023-03-22; 2024 has no such leap month, so the
    // day lands on the first day of the ordinary second month.
    const occurrence = countdownOccurrence(
      item({ date: '2023-03-22', repeat: 'lunar', lunarMonth: 2, lunarDay: 1, lunarLeap: true }),
      Temporal.PlainDate.from('2024-01-01'),
    )
    expect(occurrence.date.toString()).toBe('2024-03-10')
    expect(occurrence.ordinal).toBe(2)
  })

  it('clamps a lunar 30th into a 29-day month', () => {
    // The ordinary second month of 2026 has 29 days, so a 30th falls back to the 29th (2026-04-16)
    // rather than disappearing.
    const occurrence = countdownOccurrence(
      item({ date: '2024-03-10', repeat: 'lunar', lunarMonth: 2, lunarDay: 30 }),
      Temporal.PlainDate.from('2026-03-01'),
    )
    expect(occurrence.date.toString()).toBe('2026-04-16')
    expect(occurrence.clamped).toBe(true)
  })

  it('counts lunar years, not solar ones, in the ordinal', () => {
    const occurrence = countdownOccurrence(
      item({ date: '2020-01-25', repeat: 'lunar', lunarMonth: 1, lunarDay: 1 }),
      Temporal.PlainDate.from('2026-01-10'),
    )
    expect(occurrence.date.toString()).toBe('2026-02-17')
    expect(countdownOrdinal(item({ date: '2020-01-25', repeat: 'lunar', lunarMonth: 1, lunarDay: 1 }), occurrence)).toBe(7)
  })
})

describe('countdownFallsOn', () => {
  it('marks the yearly date in every year after the first', () => {
    const yearly = item({ date: '2020-10-01', repeat: 'yearly' })
    expect(countdownFallsOn(yearly, Temporal.PlainDate.from('2026-10-01'))).toBe(true)
    expect(countdownFallsOn(yearly, Temporal.PlainDate.from('2026-10-02'))).toBe(false)
  })

  it('marks a lunar anniversary on its lunar day', () => {
    const lunar = item({ date: '2024-09-17', repeat: 'lunar', lunarMonth: 8, lunarDay: 15 })
    expect(countdownFallsOn(lunar, Temporal.PlainDate.from('2025-10-06'))).toBe(true)
  })
})

describe('sortCountdowns', () => {
  it('puts pinned rows first and then the nearest day', () => {
    const rows = [
      item({ id: 'far', title: 'far', date: '2027-01-01', repeat: 'yearly' }),
      item({ id: 'near', title: 'near', date: '2026-12-01' }),
      item({ id: 'pinned', title: 'pinned', date: '2027-06-01', repeat: 'yearly', pinned: true }),
    ]
    expect(sortCountdowns(rows, today).map(row => row.id)).toEqual(['pinned', 'near', 'far'])
  })
})

describe('isCountdownDate', () => {
  it('accepts only a real calendar day', () => {
    expect(isCountdownDate('2026-02-29')).toBe(false)
    expect(isCountdownDate('2026-02-30')).toBe(false)
    expect(isCountdownDate('2026-02-28')).toBe(true)
    expect(isCountdownDate('2026-2-8')).toBe(false)
  })
})
