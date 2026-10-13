import { describe, expect, it } from 'vitest'
import { dayLog, readingStreak, shiftDayKey, summariseStats } from '../src/client/features/reading/reading-stats'
import type { BookStats } from '../src/client/features/reading/types'

const TODAY = '2026-10-13'

function book(bookId: string, days: Record<string, number>): BookStats {
  return { bookId, seconds: Object.values(days).reduce((sum, one) => sum + one, 0), days }
}

describe('day keys', () => {
  it('move by whole days across a month, a year and a leap day', () => {
    expect(shiftDayKey(TODAY, -1)).toBe('2026-10-12')
    expect(shiftDayKey('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDayKey('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDayKey(TODAY, 0)).toBe(TODAY)
  })

  it('leaves something it cannot read alone', () => {
    expect(shiftDayKey('not-a-day', 3)).toBe('not-a-day')
  })
})

describe('the reading streak', () => {
  it('counts today and the days before it', () => {
    expect(readingStreak({ [TODAY]: 60, '2026-10-12': 120, '2026-10-11': 30 }, TODAY)).toBe(3)
  })

  it('survives a day that has not been read yet', () => {
    expect(readingStreak({ '2026-10-12': 120, '2026-10-11': 30 }, TODAY)).toBe(2)
  })

  it('stops at the first missed day', () => {
    expect(readingStreak({ [TODAY]: 60, '2026-10-12': 0, '2026-10-11': 300 }, TODAY)).toBe(1)
  })

  it('is zero when nothing was read', () => {
    expect(readingStreak({}, TODAY)).toBe(0)
  })
})

describe('the day log', () => {
  it('adds the same day across books and drops what is not time', () => {
    const log = dayLog({
      a: book('a', { [TODAY]: 100, '2026-10-12': 0, 'bad': -5 }),
      b: book('b', { [TODAY]: 50, '2026-10-09': 10 }),
    })
    expect(log).toEqual({ [TODAY]: 150, '2026-10-09': 10 })
  })
})

describe('the summary', () => {
  const stats = {
    a: book('a', { [TODAY]: 600, '2026-10-12': 1800, '2026-10-05': 3600 }),
    b: book('b', { [TODAY]: 60 }),
    c: book('c', {}),
  }

  it('adds up the habit', () => {
    const summary = summariseStats(stats, TODAY)
    expect(summary.totalSeconds).toBe(6060)
    expect(summary.todaySeconds).toBe(660)
    expect(summary.daysRead).toBe(3)
    expect(summary.streakDays).toBe(2)
    expect(summary.best).toEqual({ day: '2026-10-05', seconds: 3600 })
    expect(summary.averagePerDay).toBe(2020)
  })

  it('draws a fortnight that ends today', () => {
    const { recent } = summariseStats(stats, TODAY)
    expect(recent).toHaveLength(14)
    expect(recent[13]!.day).toBe(TODAY)
    expect(recent[0]!.day).toBe(shiftDayKey(TODAY, -13))
    expect(recent.find((one) => one.day === '2026-10-05')?.seconds).toBe(3600)
    expect(recent.filter((one) => one.seconds === 0).length).toBe(11)
  })

  it('lists the books that were actually read, busiest first', () => {
    expect(summariseStats(stats, TODAY).perBook).toEqual([
      { bookId: 'a', seconds: 6000 },
      { bookId: 'b', seconds: 60 },
    ])
  })

  it('survives an empty library', () => {
    const summary = summariseStats({}, TODAY)
    expect(summary.totalSeconds).toBe(0)
    expect(summary.averagePerDay).toBe(0)
    expect(summary.best).toBeNull()
    expect(summary.recent.at(-1)).toEqual({ day: TODAY, seconds: 0 })
  })
})
