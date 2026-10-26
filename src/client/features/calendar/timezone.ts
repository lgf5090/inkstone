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

export function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone').slice().sort((a, b) => a.localeCompare(b))
  } catch {
    // Older engines without `supportedValuesOf` still get the zone the account is already using.
    return ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean)
  }
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
