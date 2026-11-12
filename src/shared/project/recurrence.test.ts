import { describe, expect, it } from 'vitest'
import { advanceProjectDay, parseProjectRecurrence, serializeProjectRecurrence } from './recurrence'

const day = (y: number, m: number, d: number): Date => new Date(y, m - 1, d)
const ymd = (date: Date): string => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`

describe('reading a recurrence rule', () => {
  it('returns null for an ordinary card', () => {
    expect(parseProjectRecurrence(null)).toBeNull()
    expect(parseProjectRecurrence('')).toBeNull()
    expect(parseProjectRecurrence('not json')).toBeNull()
  })

  it('normalizes the interval and weekdays, dropping malformed fields', () => {
    expect(parseProjectRecurrence('{"freq":"weekly","interval":0,"byWeekday":[3,1,1,9]}')).toEqual({ freq: 'weekly', interval: 1, byWeekday: [1, 3] })
    expect(parseProjectRecurrence('{"freq":"bogus"}')).toEqual({ freq: 'daily', interval: 1 })
    expect(parseProjectRecurrence('{"freq":"monthly","interval":2}')).toEqual({ freq: 'monthly', interval: 2 })
  })

  it('round-trips through serialize', () => {
    const rule = { freq: 'weekly' as const, interval: 2, byWeekday: [1, 5] }
    expect(parseProjectRecurrence(serializeProjectRecurrence(rule))).toEqual(rule)
  })
})

describe('advancing the date', () => {
  it('adds days for a daily rule', () => {
    expect(ymd(advanceProjectDay(day(2026, 1, 30), { freq: 'daily', interval: 3 }))).toBe('2026-2-2')
  })

  it('adds weeks when no weekday is chosen', () => {
    expect(ymd(advanceProjectDay(day(2026, 1, 5), { freq: 'weekly', interval: 2 }))).toBe('2026-1-19')
  })

  it('takes the next chosen weekday in the same week when one is later', () => {
    // 2026-01-05 is a Monday (1); the next chosen weekday is Friday (5).
    expect(ymd(advanceProjectDay(day(2026, 1, 5), { freq: 'weekly', interval: 1, byWeekday: [1, 5] }))).toBe('2026-1-9')
  })

  it('jumps interval weeks to the first chosen weekday when none is later this week', () => {
    // Friday (5) with weekdays [1,3]: next is Monday of the week after next (interval 2).
    expect(ymd(advanceProjectDay(day(2026, 1, 9), { freq: 'weekly', interval: 2, byWeekday: [1, 3] }))).toBe('2026-1-19')
  })

  it('clamps a monthly rule to the month end instead of overflowing', () => {
    expect(ymd(advanceProjectDay(day(2026, 1, 31), { freq: 'monthly', interval: 1 }))).toBe('2026-2-28')
    expect(ymd(advanceProjectDay(day(2026, 12, 15), { freq: 'monthly', interval: 1 }))).toBe('2027-1-15')
  })

  it('clamps a yearly leap day to the 28th in a common year', () => {
    expect(ymd(advanceProjectDay(day(2024, 2, 29), { freq: 'yearly', interval: 1 }))).toBe('2025-2-28')
    expect(ymd(advanceProjectDay(day(2024, 2, 29), { freq: 'yearly', interval: 4 }))).toBe('2028-2-29')
  })
})