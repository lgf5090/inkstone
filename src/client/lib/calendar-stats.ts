import { addDaysKey, dateKey, daysInYear, daysBetweenKeys } from './time'

export interface CalendarStreak {
  /** Consecutive days with at least one note, running back from today. */
  current: number
  /** The longest such run anywhere in the vault. */
  best: number
  /** The most recent day that holds a note, which is not today once a reader skips a day. */
  lastActiveKey: string | null
}

export interface MonthTotals {
  total: number
  activeDays: number
  busiestKey: string | null
  busiestCount: number
  /** Share of the month's days that hold at least one note, 0-100. */
  coverage: number
}

/**
 * A run is measured against the day the reader last wrote, not against the clock: at 00:05 the
 * streak would otherwise drop to zero for someone who wrote all of yesterday and means to write
 * today too. Today only breaks a run once it has been passed.
 */
export function streaksOf(counts: ReadonlyMap<string, number>, todayKey: string): CalendarStreak {
  const keys: string[] = []
  for (const [key, count] of counts) {
    if (count > 0)
      keys.push(key)
  }
  keys.sort()
  let best = 0
  let run = 0
  let previous: string | null = null
  for (const key of keys) {
    run = previous !== null && daysBetweenKeys(previous, key) === 1 ? run + 1 : 1
    if (run > best)
      best = run
    previous = key
  }
  const lastActiveKey = keys.length > 0 ? keys[keys.length - 1]! : null
  if (lastActiveKey === null)
    return { current: 0, best, lastActiveKey: null }
  if (daysBetweenKeys(lastActiveKey, todayKey) > 1)
    return { current: 0, best, lastActiveKey }
  let cursor = lastActiveKey
  let current = 0
  while ((counts.get(cursor) ?? 0) > 0) {
    current++
    const next = addDaysKey(cursor, -1)
    if ((counts.get(next) ?? 0) <= 0)
      break
    cursor = next
  }
  return { current, best, lastActiveKey }
}

/** Everything the calendar knows about one calendar month, in one pass over its days. */
export function monthTotalsOf(counts: ReadonlyMap<string, number>, year: number, month: number): MonthTotals {
  const first = dateKey(new Date(year, month, 1))
  const length = new Date(year, month + 1, 0).getDate()
  let total = 0
  let activeDays = 0
  let busiestKey: string | null = null
  let busiestCount = 0
  for (let day = 0; day < length; day++) {
    const key = addDaysKey(first, day)
    const count = counts.get(key) ?? 0
    if (count <= 0)
      continue
    total += count
    activeDays++
    if (count > busiestCount) {
      busiestCount = count
      busiestKey = key
    }
  }
  return {
    total,
    activeDays,
    busiestKey,
    busiestCount,
    coverage: length === 0 ? 0 : Math.round((100 * activeDays) / length),
  }
}

/** This year's progress, so a reader can see how much of it is left. */
export function yearProgress(today: Date): { day: number; total: number; remaining: number } {
  const total = daysInYear(today.getFullYear())
  const day = daysBetweenKeys(dateKey(new Date(today.getFullYear(), 0, 1)), dateKey(today)) + 1
  return { day, total, remaining: total - day }
}
