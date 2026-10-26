/**
 * The read-only ICS rendering of the to-do list — a pure string builder with no database, no request
 * and no clock it reads for itself, so every branch of it can be pinned by a unit test.
 *
 * A subscriber (Google Calendar, Apple, Outlook) polls this and never writes back; there is no
 * two-way sync here on purpose. Because of that, the whole job is to describe the account's *open,
 * dated* tasks as calendar events without ever stating a sequence the app itself would not produce.
 *
 * ## What a capped read owes the subscriber
 *
 * The feed's query carries a `LIMIT` it must not exceed — a public, unauthenticated address that reads
 * an account's whole table on every poll is a denial-of-service handle otherwise — so a subscriber whose
 * owner holds more dated open tasks than the ceiling receives a partial calendar that looks complete.
 * Nothing in the protocol lets a client see that, which is why the document states it itself, in calendar
 * level properties, whenever it arrives holding the ceiling's worth of events. See
 * {@link truncationLines}.
 *
 * ## The time representation
 *
 * Every value is emitted in UTC (`Z`): `DTSTAMP` because RFC 5545 requires it to be UTC, and
 * `DTSTART`/`DTEND` because a UTC instant is unambiguous without a `VTIMEZONE` block this module
 * would otherwise have to compute and keep correct. A task has no duration of its own, so `DTEND` is
 * `DTSTART` plus a fixed, named span — the event is a reminder window, not a meeting room booking.
 *
 * ## Which recurrences become an `RRULE`, and which degrade
 *
 * `RepeatRule` carries only `freq` + `interval`, so it is mapped to `FREQ=<...>;INTERVAL=<n>` and
 * nothing more — never a `BYDAY`, `BYSETPOS` or `WKST` the app does not actually honour. But even
 * that narrow shape is only faithful when two things hold, and when they do not we export the single
 * next occurrence rather than a series the calendar would expand wrongly:
 *
 *   1. the account's timezone keeps a constant UTC offset across the horizon (a `Z`-anchored `RRULE`
 *      advances by fixed periods in UTC, while the app's `nextOccurrence` advances wall-clock parts,
 *      so a DST transition would drift them apart); and
 *   2. the rule's day-of-month survives every period by the app's *clamping* (Jan 31 -> Feb 28),
 *      which differs from `RRULE`'s *skipping* (Jan 31 never lands in a short February). Monthly
 *      rules anchored on the 29th-31st and yearly rules on 29 February therefore degrade.
 *
 * A degraded event simply omits `RRULE`: the reader sees the occurrence the app is currently holding,
 * and the next poll after they complete it shows the one the app filed next. Losing the future series
 * beats shipping a wrong one.
 */

import type { TaskPriority } from '@shared/assistant'
import { getZonedParts, timeZoneOffsetMs } from '@shared/assistant-schedule'
import { MAX_TASKS_PER_QUERY, type RepeatRule } from '@shared/todos/model'

/** One open task, reduced to the fields a calendar may be shown. Nothing else is reachable here. */
export interface IcsTask {
  id: string
  title: string
  description: string
  priority: TaskPriority
  /** The current occurrence's due instant, in UTC milliseconds. */
  dueAt: number
  /** The already-parsed rule, or null when the task does not repeat. */
  repeat: RepeatRule | null
}

export interface IcsCalendarOptions {
  /** The instant stamped on every `DTSTAMP`; injected so the builder stays a pure function. */
  now: number
  /** The account's IANA timezone — it decides whether a recurrence can be exported as an `RRULE`. */
  timezone: string
  /** How far the subscriber's calendar may expand the series; used only to test for DST drift. */
  horizonMs: number
  prodId?: string
  /**
   * How many events the read that produced these tasks may carry at most.
   *
   * Defaults to {@link MAX_TASKS_PER_QUERY}, the ceiling `todos/feeds.ts` binds its `LIMIT` to and the
   * same number the task listing caps at — one spelling, read by both sides. A document that arrives with
   * the ceiling reached is therefore a *partial* view of the account, and a calendar client cannot tell:
   * it shows its owner fifty tasks and reports "nothing else is due", which is a wrong fact rather than a
   * short answer. So the builder says so inside the document. A caller that caps somewhere else names its
   * own number here.
   */
  taskLimit?: number
}

/** A task is a point in time, not a meeting; the event spans this fixed window ending after the due instant. */
export const ICS_EVENT_DURATION_MS = 30 * 60_000

/** The domain half of every `UID`, so ids from another calendar can never collide with ours. */
const UID_DOMAIN = 'todo.inkstone'

/** RFC 5545 `PRIORITY` runs 1 (highest) to 9 (lowest); this maps the app's four words onto it. */
const PRIORITY_TO_IC: Record<TaskPriority, number> = { urgent: 1, high: 3, medium: 5, low: 9 }

const FREQ_TO_IC: Record<RepeatRule['freq'], string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

/** RFC 5545 forbids raw control characters and folds on `, ; : \` and newline; this is the TEXT escaper. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n|\r|\u2028|\u2029/g, '\n')
    // eslint-disable-next-line no-control-regex -- the point is to strip exactly the control codes RFC 5545 disallows
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * Fold one logical property line to the 75-octet ceiling RFC 5545 imposes, splitting only on code
 * point boundaries so a multi-byte character is never torn in half across the fold.
 */
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const physical: string[] = []
  let current = ''
  let used = 0
  let limit = 75
  for (const char of line) {
    const size = encoder.encode(char).length
    if (used + size > limit) {
      physical.push(current)
      current = ` ${char}`
      used = 1 + size
      limit = 75
    } else {
      current += char
      used += size
    }
  }
  physical.push(current)
  return physical.join('\r\n')
}

function toIcsUtc(instant: number): string {
  const date = new Date(instant)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * Whether the offset of `timezone` stays flat across `[dueAt, dueAt+horizon]`.
 *
 * Probed at five points rather than just the endpoints: a zone that shifts and shifts back inside a
 * long horizon would otherwise read as flat. Anything but an identical offset at every probe is
 * treated as a DST-bearing zone, because the safe answer when the probe is uncertain is to degrade.
 */
function offsetStableAcrossWindow(dueAt: number, horizonMs: number, timezone: string): boolean {
  const first = timeZoneOffsetMs(dueAt, timezone)
  for (let step = 1; step <= 4; step += 1) {
    if (timeZoneOffsetMs(dueAt + (horizonMs * step) / 4, timezone) !== first) return false
  }
  return true
}

/** Whether the day-of-month this rule anchors on survives every period without the clamp/skip split. */
function clampsAcrossPeriods(rule: RepeatRule, dueAt: number, timezone: string): boolean {
  const parts = getZonedParts(new Date(dueAt), timezone)
  if (rule.freq === 'monthly') return parts.day <= 28
  if (rule.freq === 'yearly') return !(parts.month === 2 && parts.day === 29)
  return true
}

/**
 * The `RRULE` value for a task, or null when exporting the series would be wrong.
 *
 * Both fidelity conditions are checked against the *same* semantics the app expands with: constant
 * offset across the window, and a day-of-month that clamps the way `nextOccurrence` clamps.
 */
export function rruleFor(task: IcsTask, options: IcsCalendarOptions): string | null {
  const rule = task.repeat
  if (!rule) return null
  if (!offsetStableAcrossWindow(task.dueAt, options.horizonMs, options.timezone)) return null
  if (!clampsAcrossPeriods(rule, task.dueAt, options.timezone)) return null
  const interval = rule.interval > 1 ? `;INTERVAL=${rule.interval}` : ''
  return `FREQ=${FREQ_TO_IC[rule.freq]}${interval}`
}

function eventLines(task: IcsTask, options: IcsCalendarOptions): string[] {
  const uid = `${task.id}@${UID_DOMAIN}`
  const stamp = toIcsUtc(options.now)
  const start = toIcsUtc(task.dueAt)
  const end = toIcsUtc(task.dueAt + ICS_EVENT_DURATION_MS)
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(task.title)}`,
    `STATUS:CONFIRMED`,
    `PRIORITY:${PRIORITY_TO_IC[task.priority]}`,
  ]
  if (task.description.trim()) lines.push(`DESCRIPTION:${escapeIcsText(task.description)}`)
  const rrule = rruleFor(task, options)
  if (rrule) lines.push(`RRULE:${rrule}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * The lines that tell a subscriber its calendar is looking at part of an account.
 *
 * A full document is the only shape a capped read can return, so reaching the ceiling is a fact the
 * builder can state rather than a warning it has to guess at: the nearest `limit` dated open tasks are
 * here and the rest of the account is not. `X-WR-CALDESC` is the description Google, Apple and Fastmail
 * show for a subscribed calendar; the numeric companion is for a client that would rather read the ceiling
 * than parse a sentence. Both sit at calendar level, before the first event, and an unknown `X-` property
 * is one RFC 5545 tells clients to ignore.
 */
function truncationLines(limit: number, shown: number): string[] {
  const sentence =
    `Inkstone to-do feed: one subscription lists at most ${limit} open tasks with a due date, ` +
    `and this document holds ${shown} of them. A full document is a partial view of the account: the ` +
    'tasks past that ceiling are absent here, not finished.'
  return [
    `X-WR-CALDESC:${escapeIcsText(sentence)}`,
    `X-INKSTONE-FEED-LIMIT:${limit}`,
  ]
}

/** Render a set of open, dated tasks as a complete `text/calendar` document, earliest due first. */
export function buildIcsCalendar(tasks: readonly IcsTask[], options: IcsCalendarOptions): string {
  const ordered = [...tasks].sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
  const limit = options.taskLimit ?? MAX_TASKS_PER_QUERY
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeIcsText(options.prodId ?? '-//Inkstone//Todo Feed//EN')}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // The read caps at `limit`, so a document that came back full is the truncation and says so.
    ...(ordered.length >= limit ? truncationLines(limit, ordered.length) : []),
    ...ordered.flatMap((task) => eventLines(task, options)),
    'END:VCALENDAR',
  ]
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`
}
