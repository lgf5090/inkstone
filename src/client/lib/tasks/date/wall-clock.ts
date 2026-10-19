/**
 * Wall-clock day transport between local time and UTC.
 *
 * `rrule` iterates over UTC instants and knows nothing about time zones, while a task's due date is
 * a civil day in the reader's calendar. Re-tagging the fields carries a day into `rrule`'s world and
 * back without ever letting an offset shift it onto the neighbouring day — which is the whole reason
 * a due date must not be stored as an instant.
 */

/** A local civil day and clock, re-expressed as the same wall-clock fields in UTC. */
export function asUtcWallClock(date: Date): Date {
  return new Date(Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ))
}

/** The inverse of {@link asUtcWallClock}: UTC wall-clock fields, re-expressed as local ones. */
export function asLocalWallClock(date: Date): Date {
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
}

/** Whole days in UTC space, where a fixed 24 hours really is one calendar day. */
export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}
