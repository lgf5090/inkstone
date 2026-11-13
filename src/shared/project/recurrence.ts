/**
 * Recurring cards: the rule and the next date, as pure functions.
 *
 * A card carries a rule instead of a redundant "is recurring" flag. Completing it consumes the rule
 * once and spawns the next instance with its date advanced. The arithmetic runs on the calendar's
 * year/month/day through UTC so a DST switch cannot move the day, and monthly/yearly clamp to the
 * month's last day (1/31 → 2/28) rather than overflowing into the next month.
 */
import type { ProjectRecurrence, ProjectRecurrenceFreq } from './model'

const FREQS: readonly ProjectRecurrenceFreq[] = ['daily', 'weekly', 'monthly', 'yearly']
const MAX_INTERVAL = 365

function normalizeInterval(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_INTERVAL, Math.floor(n)) : 1
}

function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const set = new Set<number>()
  for (const entry of value) {
    const n = typeof entry === 'number' ? entry : Number.parseInt(String(entry), 10)
    if (Number.isFinite(n) && n >= 0 && n <= 6) set.add(Math.floor(n))
  }
  return [...set].sort((a, b) => a - b)
}

/** Read a stored rule, dropping anything malformed; null means an ordinary, non-recurring card. */
export function parseProjectRecurrence(raw: string | null | undefined): ProjectRecurrence | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as { freq?: unknown, interval?: unknown, byWeekday?: unknown, anchor?: unknown }
  const freq = FREQS.includes(record.freq as ProjectRecurrenceFreq) ? (record.freq as ProjectRecurrenceFreq) : 'daily'
  const rule: ProjectRecurrence = { freq, interval: normalizeInterval(record.interval) }
  if (typeof record.anchor === 'number' && Number.isFinite(record.anchor)) rule.anchor = Math.floor(record.anchor)
  if (freq === 'weekly') {
    const weekdays = normalizeWeekdays(record.byWeekday)
    if (weekdays.length > 0) rule.byWeekday = weekdays
  }
  return rule
}

export function serializeProjectRecurrence(rule: ProjectRecurrence): string {
  return JSON.stringify(rule)
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate()
}

function clampedDay(year: number, monthIndex0: number, day: number): Date {
  const max = daysInMonth(year, monthIndex0)
  return new Date(year, monthIndex0, Math.min(Math.max(1, day), max))
}

const DAY_MS = 86_400_000

function civilStamp(day: Date): number {
  return Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((civilStamp(to) - civilStamp(from)) / DAY_MS)
}

function addDays(day: Date, count: number): Date {
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  next.setDate(next.getDate() + count)
  return next
}

export function projectDayIndex(day: Date): number {
  return Math.round(civilStamp(day) / DAY_MS)
}

export function projectDayFromIndex(index: number): Date {
  return new Date(1970, 0, 1 + index)
}

function advanceFromAnchor(day: Date, rule: ProjectRecurrence, anchor: Date): Date {
  const interval = normalizeInterval(rule.interval)
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  switch (rule.freq) {
    case 'daily': {
      const step = Math.max(1, Math.floor(daysBetween(start, day) / interval) + 1)
      return addDays(start, step * interval)
    }
    case 'weekly': {
      const weekdays = normalizeWeekdays(rule.byWeekday)
      const anchorWeek = addDays(start, -start.getDay())
      const weekSpan = 7 * interval
      if (weekdays.length === 0) {
        const step = Math.max(1, Math.floor(daysBetween(anchorWeek, day) / weekSpan) + 1)
        return addDays(start, step * weekSpan)
      }
      const startStep = Math.max(0, Math.floor(daysBetween(anchorWeek, day) / weekSpan))
      const candidates: Date[] = []
      for (let step = Math.max(0, startStep - 1); step <= startStep + 2; step += 1) {
        const week = addDays(anchorWeek, step * weekSpan)
        for (const weekday of weekdays) candidates.push(addDays(week, weekday))
      }
      candidates.sort((left, right) => civilStamp(left) - civilStamp(right))
      return candidates.find((candidate) => civilStamp(candidate) > civilStamp(day))
        ?? addDays(anchorWeek, (startStep + 3) * weekSpan + weekdays[0]!)
    }
    case 'monthly': {
      const months = (day.getFullYear() - start.getFullYear()) * 12 + day.getMonth() - start.getMonth()
      const step = Math.max(1, Math.floor(months / interval) + 1)
      const totalMonth = start.getMonth() + step * interval
      return clampedDay(start.getFullYear() + Math.floor(totalMonth / 12), ((totalMonth % 12) + 12) % 12, start.getDate())
    }
    case 'yearly': {
      const step = Math.max(1, Math.floor((day.getFullYear() - start.getFullYear()) / interval) + 1)
      return clampedDay(start.getFullYear() + step * interval, start.getMonth(), start.getDate())
    }
    default:
      return new Date(day.getFullYear(), day.getMonth(), day.getDate())
  }
}

/**
 * The next calendar day after `day` under the rule. `day` is the local midnight the reader sees;
 * the returned Date is likewise a local midnight, ready for the date writer to store.
 */
export function advanceProjectDay(day: Date, rule: ProjectRecurrence, anchor?: Date): Date {
  if (anchor) return advanceFromAnchor(day, rule, anchor)
  const year = day.getFullYear()
  const month = day.getMonth()
  const date = day.getDate()
  const interval = normalizeInterval(rule.interval)
  switch (rule.freq) {
    case 'daily': {
      const next = new Date(year, month, date)
      next.setDate(next.getDate() + interval)
      return next
    }
    case 'weekly': {
      const weekdays = normalizeWeekdays(rule.byWeekday)
      const next = new Date(year, month, date)
      if (weekdays.length === 0) {
        next.setDate(next.getDate() + 7 * interval)
        return next
      }
      const dow = next.getDay()
      const sameWeek = weekdays.find((weekday) => weekday > dow)
      if (sameWeek !== undefined) {
        next.setDate(next.getDate() + (sameWeek - dow))
        return next
      }
      // Jump to the first selected weekday of the next interval-week, counting weeks from Sunday.
      next.setDate(next.getDate() - dow + 7 * interval + weekdays[0]!)
      return next
    }
    case 'monthly': {
      const totalMonth = month + interval
      return clampedDay(year + Math.floor(totalMonth / 12), ((totalMonth % 12) + 12) % 12, date)
    }
    case 'yearly':
      return clampedDay(year + interval, month, date)
    default:
      return new Date(year, month, date)
  }
}