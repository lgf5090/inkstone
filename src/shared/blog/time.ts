/** Calendar-day helpers for the blog's archive, always in the site's zone rather than UTC. */
import { getZonedParts, isValidTimeZone, zonedTimeToUtc } from '../assistant-schedule'

/** The zone a blog uses when its stored setting is absent or not an IANA name. */
export const BLOG_DEFAULT_TIME_ZONE = 'UTC'

export function normalizeBlogTimeZone(value: unknown): string {
  return typeof value === 'string' && isValidTimeZone(value) ? value : BLOG_DEFAULT_TIME_ZONE
}

/** The `YYYY` / `MM` a published instant belongs to on the site's calendar. */
export function archiveBucket(instant: number, timeZone: string): { year: string; month: string } {
  const parts = getZonedParts(new Date(instant), normalizeBlogTimeZone(timeZone))
  return {
    year: String(parts.year),
    month: String(parts.month).padStart(2, '0'),
  }
}

/**
 * The half-open instant range `[start, end)` covering a whole calendar year in `timeZone`.
 *
 * A post published at 2025-12-31T16:00Z is already 2026-01-01 in Asia/Shanghai, and the filter has
 * to answer with the same year the archive grouped it under. Computing the two wall-clock
 * boundaries through the shared DST-aware conversion keeps that true even in zones that shift.
 */
export function zonedYearRange(year: number, timeZone: string): { start: number; end: number } {
  const zone = normalizeBlogTimeZone(timeZone)
  return {
    start: zonedTimeToUtc(year, 1, 1, 0, 0, zone).getTime(),
    end: zonedTimeToUtc(year + 1, 1, 1, 0, 0, zone).getTime(),
  }
}
