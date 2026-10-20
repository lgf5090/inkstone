/**
 * The windows a model's time-of-day price is judged by.
 *
 * A window is matched against the assistant's own timezone, not the browser's and not UTC: the reader
 * sets the account clock once and every usage row is filed under that day already, so using a second
 * clock here would put a turn on a different day than the one its tokens are recorded under.
 *
 * The parser is deliberately forgiving: a stored row written by an older build, or a hand-edited
 * backup, must read as "no period" rather than fail the whole model list. The route rejects an invalid
 * edit before it reaches the column; this is the read side that has to survive anything already there.
 */
import {
  MAX_PRICE_PERIODS,
  MAX_PRICE_PERIOD_LABEL_CHARS,
  type AssistantPricePeriod,
} from './assistant'

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
const PERIOD_ID = /^[A-Za-z0-9_-]{1,26}$/
const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function priceValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.min(numeric, 1_000_000) : null
}

function dayValue(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const days = new Set<number>()
  for (const entry of value) {
    if (Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 7) days.add(Number(entry))
  }
  return [...days].sort((left, right) => left - right)
}

/** The windows a stored value carries, with anything malformed left out. */
export function parsePricePeriods(value: unknown): AssistantPricePeriod[] {
  if (!Array.isArray(value)) return []
  const out: AssistantPricePeriod[] = []
  const ids = new Set<string>()
  for (const entry of value.slice(0, MAX_PRICE_PERIODS)) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const start = typeof raw.start === 'string' ? raw.start.trim() : ''
    const end = typeof raw.end === 'string' ? raw.end.trim() : ''
    // A window with no length is not a window. `start === end` is rejected rather than read as a full
    // day: a full day belongs in the base price, and the two readings would otherwise be one edit apart.
    if (!WALL_CLOCK.test(start) || !WALL_CLOCK.test(end) || start === end) continue
    let id = typeof raw.id === 'string' && PERIOD_ID.test(raw.id) ? raw.id : `p${out.length + 1}`
    while (ids.has(id)) id = `${id}_${out.length + 1}`.slice(0, 26)
    ids.add(id)
    out.push({
      id,
      label: typeof raw.label === 'string' ? raw.label.trim().slice(0, MAX_PRICE_PERIOD_LABEL_CHARS) : '',
      days: dayValue(raw.days),
      start,
      end,
      inputPrice: priceValue(raw.inputPrice),
      outputPrice: priceValue(raw.outputPrice),
    })
  }
  return out
}

function minutesOfDay(time: string): number {
  const [hour, minute] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

function localClock(date: Date, timeZone: string): { weekday: number, minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date)
  }
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekday = WEEKDAYS[value('weekday')] ?? 1
  return { weekday, minutes: Number(value('hour')) * 60 + Number(value('minute')) }
}

function periodMatches(period: AssistantPricePeriod, weekday: number, minutes: number): boolean {
  const days = period.days.length ? period.days : [1, 2, 3, 4, 5, 6, 7]
  const start = minutesOfDay(period.start)
  const end = minutesOfDay(period.end)
  if (start < end) return days.includes(weekday) && minutes >= start && minutes < end
  // An overnight window's after-midnight half belongs to the weekday it started on.
  const previous = weekday === 1 ? 7 : weekday - 1
  return (days.includes(weekday) && minutes >= start) || (days.includes(previous) && minutes < end)
}

/**
 * The window in force at `date`, or null when the base price applies.
 *
 * The first matching window wins. Overlaps are allowed rather than refused because a reader building a
 * schedule out of several named windows is the normal case, and reordering is a smaller cost than a
 * save that refuses work they already did. A window with neither side priced still matches; it just
 * cannot change the cost, which is the same result as no window and is left to the caller to skip.
 */
export function activePricePeriod(
  periods: readonly AssistantPricePeriod[],
  date: Date,
  timeZone: string,
): AssistantPricePeriod | null {
  if (!periods.length) return null
  const clock = localClock(date, timeZone)
  return periods.find((period) => periodMatches(period, clock.weekday, clock.minutes)) ?? null
}
