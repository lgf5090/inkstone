/**
 * Adding up what the reader actually spent.
 *
 * The library stores time per book and per day, because a reader asks two different questions: how long
 * was I in *this* book, and did I keep the habit. Both are derived here rather than stored, so a day can
 * never be counted twice or lost when a book is deleted while its log survives.
 */
import type { BookStats } from './types'

export interface ReadingDay {
  day: string
  seconds: number
}

export interface ReadingSummary {
  totalSeconds: number
  todaySeconds: number
  streakDays: number
  daysRead: number
  best: ReadingDay | null
  averagePerDay: number
  /** The last fortnight, oldest first, which is what a bar of habit needs to line up against. */
  recent: ReadingDay[]
  /** Seconds per book, busiest first, with the books that were opened but never read left out. */
  perBook: { bookId: string; seconds: number }[]
}

/** Move a `YYYY-MM-DD` key by whole days. Anchored at noon UTC so no calendar or timezone can skip one. */
export function shiftDayKey(key: string, days: number): string {
  const anchor = new Date(`${key}T12:00:00Z`)
  if (Number.isNaN(anchor.getTime())) return key
  anchor.setUTCDate(anchor.getUTCDate() + days)
  return anchor.toISOString().slice(0, 10)
}

/** Consecutive days read, counting back from today — or from yesterday if today has not started yet. */
export function readingStreak(log: Record<string, number>, today: string): number {
  const read = (day: string): boolean => (log[day] ?? 0) > 0
  let cursor = read(today) ? today : shiftDayKey(today, -1)
  let streak = 0
  while (streak < 4000 && read(cursor)) {
    streak += 1
    cursor = shiftDayKey(cursor, -1)
  }
  return streak
}

/** Merge every book's day log into one day → seconds map. */
export function dayLog(stats: Record<string, BookStats>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const book of Object.values(stats)) {
    if (!book?.days) continue
    for (const [day, seconds] of Object.entries(book.days)) {
      if (!Number.isFinite(seconds) || seconds <= 0) continue
      out[day] = (out[day] ?? 0) + seconds
    }
  }
  return out
}

export function summariseStats(stats: Record<string, BookStats>, today: string): ReadingSummary {
  const log = dayLog(stats)
  const days = Object.keys(log)
  let total = 0
  let daysRead = 0
  let best: ReadingDay | null = null
  for (const day of days) {
    const seconds = log[day] ?? 0
    total += seconds
    if (seconds > 0) daysRead += 1
    if (!best || seconds > best.seconds) best = { day, seconds }
  }
  const recent: ReadingDay[] = []
  for (let index = 13; index >= 0; index -= 1) {
    const day = shiftDayKey(today, -index)
    recent.push({ day, seconds: log[day] ?? 0 })
  }
  const perBook = Object.values(stats)
    .map((one) => ({ bookId: one?.bookId ?? '', seconds: Math.max(0, one?.seconds ?? 0) }))
    .filter((one) => one.bookId && one.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
  return {
    totalSeconds: total,
    todaySeconds: log[today] ?? 0,
    streakDays: readingStreak(log, today),
    daysRead,
    best,
    averagePerDay: daysRead ? Math.round(total / daysRead) : 0,
    recent,
    perBook,
  }
}
