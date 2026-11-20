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

describe('advancing from a recurring anchor', () => {
  it('keeps the original month day after a month-end clamp', () => {
    const anchor = day(2026, 1, 31)
    const rule = { freq: 'monthly' as const, interval: 1 }
    const clamped = advanceProjectDay(anchor, rule, anchor)
    expect(ymd(clamped)).toBe('2026-2-28')
    expect(ymd(advanceProjectDay(clamped, rule, anchor))).toBe('2026-3-31')
  })

  it('recovers a leap day instead of drifting to the 28th forever', () => {
    const anchor = day(2024, 2, 29)
    const rule = { freq: 'yearly' as const, interval: 1 }
    const y2025 = advanceProjectDay(anchor, rule, anchor)
    const y2026 = advanceProjectDay(y2025, rule, anchor)
    const y2027 = advanceProjectDay(y2026, rule, anchor)
    const y2028 = advanceProjectDay(y2027, rule, anchor)
    expect(ymd(y2025)).toBe('2025-2-28')
    expect(ymd(y2028)).toBe('2028-2-29')
  })

  it('advances a weekly interval rule through every chosen weekday of a period', () => {
    const anchor = day(2026, 1, 5)
    const rule = { freq: 'weekly' as const, interval: 2, byWeekday: [1, 5] }
    expect(ymd(advanceProjectDay(anchor, rule, anchor))).toBe('2026-1-9')
    expect(ymd(advanceProjectDay(day(2026, 1, 9), rule, anchor))).toBe('2026-1-19')
    expect(ymd(advanceProjectDay(day(2026, 1, 19), rule, anchor))).toBe('2026-1-23')
    expect(ymd(advanceProjectDay(day(2026, 1, 23), rule, anchor))).toBe('2026-2-2')
  })

  it('does not skip a period when the last instance moved off the rule week', () => {
    const anchor = day(2026, 1, 5)
    const rule = { freq: 'weekly' as const, interval: 2, byWeekday: [1] }
    expect(ymd(advanceProjectDay(day(2026, 1, 12), rule, anchor))).toBe('2026-1-19')
  })

  it('keeps a daily interval aligned to the anchor', () => {
    const anchor = day(2026, 1, 1)
    const rule = { freq: 'daily' as const, interval: 3 }
    expect(ymd(advanceProjectDay(day(2026, 1, 2), rule, anchor))).toBe('2026-1-4')
  })
})