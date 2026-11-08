/**
 * Per-event time zones.
 *
 * A stored value already carries its own zone (`…+08:00[Asia/Shanghai]`), and the server keeps it on
 * the row, so what an event needs is a way to *move* it: the reader picks the zone the appointment
 * actually happens in and the wall clock they typed stays put while the instant moves. Whole days have
 * no zone to speak of, so they are left alone.
 */
import { Temporal } from 'temporal-polyfill'
import type { TemporalValue } from '@shared/calendar/model'

let cachedTimeZones: string[] | null = null

export function supportedTimeZones(): string[] {
  if (cachedTimeZones) return cachedTimeZones
  try {
    cachedTimeZones = Intl.supportedValuesOf('timeZone').slice().sort((a, b) => a.localeCompare(b))
  } catch {
    // Older engines without `supportedValuesOf` still get the zone the account is already using.
    cachedTimeZones = ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean)
  }
  return cachedTimeZones
}

/** The zone an event happens in, or null when it is a whole day. */
export function eventTimeZone(value: TemporalValue, fallback: string): string | null {
  if (value.type === 'date') return null
  if (value.type === 'zoned') return value.timeZone ?? fallback
  return fallback
}

/** Keep the wall clock, change the zone it is read in. */
export function reanchorValue(value: TemporalValue, zone: string): TemporalValue {
  if (value.type === 'date') return value
  const wall = value.type === 'zoned'
    ? Temporal.ZonedDateTime.from(value.value).toPlainDateTime()
    : Temporal.PlainDateTime.from(value.value)
  const moved = wall.toZonedDateTime(zone)
  return {
    value: moved.toString({ smallestUnit: 'second' }),
    type: 'zoned',
    timeZone: moved.timeZoneId,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The wall clock a grid instant shows in the account's zone.
 *
 * A click on the grid hands React a browser-local `Date`; reading it with `getHours()` puts a
 * Shanghai calendar an hour or two off for a reader sitting in Berlin. Every date and time field in
 * the editor is wall clock in the account's zone, so the conversion belongs here.
 */
export function wallClockInZone(instant: Date, timeZone: string): { date: string; time: string } {
  const zoned = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(timeZone)
  return {
    date: `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`,
    time: `${pad(zoned.hour)}:${pad(zoned.minute)}`,
  }
}

/** A wall-clock minute count added in the account's zone; DST gaps and overlaps follow Temporal. */
export function addWallMinutes(date: string, time: string, minutes: number, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const moved = Temporal.ZonedDateTime.from({
    timeZone,
    year,
    month,
    day,
    hour,
    minute,
  }).add({ minutes })
  return `${moved.year}-${pad(moved.month)}-${pad(moved.day)}T${pad(moved.hour)}:${pad(moved.minute)}`
}

/** Move a stored value by whole days, keeping the wall clock in the zone it already names. */
export function shiftTemporalValue(value: TemporalValue, days: number): TemporalValue {
  if (value.type === 'date') {
    const date = Temporal.PlainDate.from(value.value).add({ days })
    return { value: date.toString(), type: 'date' }
  }
  if (value.type === 'zoned') {
    const moved = Temporal.ZonedDateTime.from(value.value).add({ days })
    return { value: moved.toString({ smallestUnit: 'second' }), type: 'zoned', timeZone: moved.timeZoneId }
  }
  const moved = Temporal.PlainDateTime.from(value.value).add({ days })
  return { value: moved.toString(), type: 'datetime' }
}
