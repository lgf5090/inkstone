/**
 * The calendar arithmetic behind the due-window presets.
 *
 * A due bound is a wall-clock reading the route parses in the reader's timezone
 * (`YYYY-MM-DDTHH:MM`), and the route's upper bound is exclusive (`due_at < dueTo`). Every window
 * here is therefore `[start of a day, start of the day after)`, and a custom end day is turned into
 * the midnight after it so the day the reader picked is included whole rather than cut at 00:00.
 *
 * Pure day-string arithmetic: "today" is handed in from the server's clock and timezone, never read
 * from `Date.now()` here, so the presets cannot drift from the day boundaries the count uses.
 */

export type DueRangePreset = 'any' | 'today' | 'week' | 'next30' | 'custom'
export type DuePreset = Exclude<DueRangePreset, 'any' | 'custom'>

const PRESETS: readonly DuePreset[] = ['today', 'week', 'next30']

/** A calendar day moved by whole days, with no timezone in the answer. */
export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

/** The Monday of the week a day is in; the app's calendars read weeks from Monday too. */
export function weekStart(day: string): string {
  const sundayFirst = new Date(`${day}T00:00:00Z`).getUTCDay()
  return shiftDay(day, -((sundayFirst + 6) % 7))
}

/** The half-open wall-clock bounds one preset means, as the route reads them. */
export function presetRange(preset: DuePreset, today: string): { from: string; to: string } {
  if (preset === 'today') return { from: `${today}T00:00`, to: `${shiftDay(today, 1)}T00:00` }
  if (preset === 'week') {
    const monday = weekStart(today)
    return { from: `${monday}T00:00`, to: `${shiftDay(monday, 7)}T00:00` }
  }
  return { from: `${today}T00:00`, to: `${shiftDay(today, 30)}T00:00` }
}

/** Which preset the address's bounds spell, which is what the control shows. */
export function presetOf(from: string | null, to: string | null, today: string): DueRangePreset {
  if (!from && !to) return 'any'
  for (const preset of PRESETS) {
    const range = presetRange(preset, today)
    if (from === range.from && to === range.to) return preset
  }
  return 'custom'
}

/** The calendar day a bound starts on, for a date input's value. */
export function boundDay(bound: string | null): string {
  return bound ? bound.slice(0, 10) : ''
}

/** The inclusive end day a half-open upper bound names, for a date input's value. */
export function endDayOf(bound: string | null): string {
  return bound ? shiftDay(boundDay(bound), -1) : ''
}

/** The bounds two date inputs name, with the upper one moved past the day it shows. */
export function daysToRange(fromDay: string, toDay: string): { from: string | null; to: string | null } {
  return {
    from: fromDay ? `${fromDay}T00:00` : null,
    to: toDay ? `${shiftDay(toDay, 1)}T00:00` : null,
  }
}
