/**
 * The duration grammar the to-do app speaks: the words on a row, and the words a reader types back.
 *
 * Two surfaces each needed ninety minutes printed as `1h 30m`, and the temptation is to write the
 * ladder twice. Formatting therefore *delegates* to {@link formatDurationAbbreviated}, the shared
 * abbreviated duration the note properties already print, rather than restating a second set of units:
 * the task face and the property face of the same number must not diverge, and the memory of "same
 * value, two languages, one screen" is why this file is in `shared/` at all.
 *
 * Parsing lives beside it because the quick-add line and the editor's custom estimate field ask the
 * same question — `1h20m` — and two grammars would eventually disagree about what `90` means.
 */
import { formatDurationAbbreviated } from '../property-formats'

/** One hour and one minute, in milliseconds: the only two units this grammar speaks. */
const HOUR_MS = 60 * 60_000
const MINUTE_MS = 60_000

/**
 * What a duration reads as, and what the estimate field accepts: `45m`, `1h`, `1h20m`, `1h 20m`.
 *
 * Hours and minutes only. Days are left out on purpose — `3d` would eat the `3D` of a title about a
 * printer, and an estimate measured in days is a project, not a task. The unit must be followed by a
 * non-letter, so `5min` and `1hour` stay prose rather than being cut in half; a bare number is read as
 * minutes by {@link parseTaskDuration} alone, never matched here, because `30` on its own is as likely
 * to be a page count as a duration.
 */
export const TASK_DURATION_PATTERN = String.raw`\d+\s*h(?:\s?\d+\s*m)?|\d+\s*m`

/** What a reader who has logged nothing has spent. `formatDurationAbbreviated` prints that as `0ms`. */
const ZERO_DURATION = '0m'

/**
 * A duration as the task face shows it: `1h 30m`, `45m`, `0m`.
 *
 * Not a translated string: the compact unit letters are what the custom field parses back in, and a
 * screen that printed a localised word beside a field that only accepts `1h` would be two languages
 * for one number.
 */
export function formatTaskDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ZERO_DURATION
  return formatDurationAbbreviated(ms)
}

/**
 * A written duration read back as milliseconds, or null when the words are not one.
 *
 * A bare number is minutes, which is the shape a reader types when the field's own label has already
 * said what the unit is. Anything else must be the abbreviated ladder; `soon`, `-5m` and `1h x` answer
 * null rather than a plausible-looking zero, because a refused estimate is one the reader can fix while
 * a silently-zeroed one is a task that looks unestimated.
 */
export function parseTaskDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * MINUTE_MS
  const full = new RegExp(`^(?:${TASK_DURATION_PATTERN})$`, 'i').exec(trimmed)
  if (!full) return null
  let total = 0
  for (const part of trimmed.matchAll(/(\d+)\s*(h|m)/gi)) {
    total += part[2]!.toLowerCase() === 'h' ? Number(part[1]) * HOUR_MS : Number(part[1]) * MINUTE_MS
  }
  return total > 0 ? total : null
}
