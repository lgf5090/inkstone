/**
 * The todo module's vocabulary, shared by the worker, the client and the tests.
 *
 * A task itself is the assistant's `Task` — the tool layer has written that shape since the chat
 * could create one — and this module only adds the fields the to-do app needs on top of it. Keeping
 * the extension here rather than widening `Task` means a backup, a shared conversation or an old
 * answer version never has to learn about lists and tags it does not carry.
 */

import type { Task, TaskPriority, TaskStatus } from '../assistant'
import { daysInMonth, getZonedParts, zonedTimeToUtc } from '../assistant-schedule'
import { ORGANIZER_COLORS } from '../organizer-colors'

export const REPEAT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number]

/**
 * How often a task comes back.
 *
 * `interval` is in units of `freq` — every 2 weeks is `{ freq: 'weekly', interval: 2 }` — and the
 * next occurrence is counted from the due date rather than from the moment the reader ticked it,
 * so finishing a weekly report on Thursday does not move it to Thursday for good.
 */
export interface RepeatRule {
  freq: RepeatFrequency
  interval: number
}

export const MIN_REPEAT_INTERVAL = 1
export const MAX_REPEAT_INTERVAL = 99

/** The views the server can answer in one query. */
export const TASK_VIEWS = ['inbox', 'today', 'upcoming', 'overdue', 'open', 'completed', 'starred', 'all'] as const
export type TaskView = (typeof TASK_VIEWS)[number]

/**
 * How far ahead "upcoming" reaches.
 *
 * A week is what a reader can still plan around; anything further is a list they will look at when
 * it gets closer, and putting it in the same view makes that view unusable.
 */
export const UPCOMING_DAYS = 7

/**
 * The orders a listing can be asked to answer in.
 *
 * A named key rather than a column, because the caller is choosing a reading order and not a SQL
 * expression: the store decides what each key means, including the tiebreaker that keeps two pages
 * of the same query from disagreeing about rows that share a value.
 */
export const TASK_SORTS = ['due', 'priority', 'created', 'completed'] as const
export type TaskSort = (typeof TASK_SORTS)[number]

/** How long a reminder may be set before the due time. Presets are a form shortcut, not a stored unit. */
export const REMIND_OFFSETS = ['none', 'due', '15m', '1h', '1d'] as const
export type RemindOffset = (typeof REMIND_OFFSETS)[number]

/** The most reminders one task may carry. Five is what the reference app's paid tier offers. */
export const MAX_REMINDERS_PER_TASK = 5

/**
 * The durations a "remind me again" press offers, in minutes: ten minutes, an hour, nine hours
 * ("tonight") and a day ("tomorrow morning"). Deliberately durations rather than wall-clock times:
 * a snooze must work the same whatever zone the account is in or however close to midnight it is.
 */
export const SNOOZE_MINUTES = [10, 60, 540, 1440] as const
export type SnoozeMinutes = (typeof SNOOZE_MINUTES)[number]

export function isSnoozeMinutes(value: unknown): value is SnoozeMinutes {
  return typeof value === 'number' && (SNOOZE_MINUTES as readonly number[]).includes(value)
}

export const MAX_LIST_NAME_CHARS = 60
export const MAX_TAG_NAME_CHARS = 40
export const MAX_TAGS_PER_TASK = 8
export const MAX_STEPS_PER_TASK = 50
export const MAX_STEP_TEXT_CHARS = 200
/** The longest task note a person may write through the to-do app's own HTTP form. */
export const MAX_TASK_DESCRIPTION_CHARS = 10_000
/** The longest substring a task listing searches for; the HTTP `q` and both task tool surfaces share it. */
export const MAX_TASK_QUERY_CHARS = 200
/** The most a single listing answers with; a page smaller than this is what a caller normally asks for. */
export const MAX_TASKS_PER_QUERY = 500
/** A completed list is history: the newest page is enough to answer "what did I finish". */
export const COMPLETED_PAGE_SIZE = 200
/** One page of the trash: a holding area, not a shelf, so its pages are smaller than the listing's. */
export const TRASH_PAGE_SIZE = 50

/**
 * The most tasks one batch may name.
 *
 * A batch is a gesture over a selection a person made on screen, and a hundred rows is more than one
 * screen holds. The ceiling is also what keeps the request body inside the route's usual limit and the
 * work behind one press bounded: a client that needs to change more than this is scripting, and a
 * script can send two batches.
 */
export const MAX_BATCH_TASKS = 100

/** The changes a batch can make. One operation for the whole batch, so a mixed request has no order to guess. */
export const TASK_BATCH_OPS = ['complete', 'delete', 'move', 'priority', 'star', 'tag'] as const
export type TaskBatchOp = (typeof TASK_BATCH_OPS)[number]

export function isTaskBatchOp(value: unknown): value is TaskBatchOp {
  return typeof value === 'string' && (TASK_BATCH_OPS as readonly string[]).includes(value)
}

/** One task a batch could not change, and the reason it was left as it was. */
export interface TaskBatchFailure {
  id: string
  reason: string
}

/**
 * What a batch answers with.
 *
 * Both lists are always present, because a batch is allowed to be partly true: the rows that changed
 * are named, the rows that did not are named with their reason, and the status stays 200 either way —
 * one account's bad id is not a server failure of the other ninety-nine. An id that names no task of
 * this account is `not found`, exactly as the single-task routes answer it, so a refusal never tells
 * the caller whether an id exists somewhere else.
 */
export interface TaskBatchResult {
  done: string[]
  failed: TaskBatchFailure[]
}

export interface TaskList {
  id: string
  name: string
  /** A lucide icon name or one emoji, stored as the reader picked it. */
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number
  openCount: number
  doneCount: number
}

export interface TaskTag {
  id: string
  name: string
  color: string | null
  createdAt: number
  updatedAt: number
  openCount: number
}

export interface TaskStep {
  id: string
  taskId: string
  text: string
  done: boolean
  position: number
  createdAt: number
}

export interface TodoTask extends Task {
  listId: string | null
  tags: TaskTag[]
  starred: boolean
  repeat: RepeatRule | null
  /**
   * The task's pending reminders, as absolute instants in ascending order. Up to
   * `MAX_REMINDERS_PER_TASK`; fired ones are delivery history and are not listed.
   */
  reminders?: number[]
  /**
   * The earliest pending reminder, derived from {@link reminders}. Kept as its own field because the
   * quick-add preview and the assistant's task output speak one instant, not a list.
   */
  remindAt: number | null
  /**
   * @deprecated A delivery fact now lives on each `todos_reminders` row (`fired_at`) and is not part of
   * the task. Always null; kept until the old `todos_tasks` columns are dropped so older clients and
   * fixtures keep one shape to read.
   */
  remindedAt: number | null
  /**
   * The account-zone day (`YYYY-MM-DD`) the reader picked this task into "today", or null when it
   * was never picked. Orthogonal to `dueAt`: a task can be planned for today while being due next
   * week, and a task due today is in today without a plan. A stored day rather than a flag is what
   * lets yesterday's plan lapse at midnight with no sweep.
   */
  plannedFor: string | null
  noteId: string | null
  conversationId: string | null
  /**
   * The row's version, moved on by every write. A caller editing a task names the revision it read;
   * a write naming an older one is refused with a 409 rather than replacing an edit it never saw.
   */
  rev?: number
  /**
   * When the task was moved to the trash, or null while it is live. Only the trash page answers with a
   * stamp; every other read filters trashed rows out, so this is null there.
   */
  deletedAt?: number | null
  stepTotal: number
  stepDone: number
}

export interface TaskCounts {
  inbox: number
  today: number
  upcoming: number
  overdue: number
  all: number
  completed: number
  starred: number
  byList: Record<string, { open: number; done: number }>
  /** A tag carries both numbers for the same reason a list does: its view shows the finished rows too. */
  byTag: Record<string, { open: number; done: number }>
}

/** What one page of tasks answers with, so the client never has to compute "today" itself. */
export interface TaskPage {
  tasks: TodoTask[]
  /** How many tasks the filter on this page matches, whatever the page itself carries. */
  total: number
  counts: TaskCounts
  /** End of the reader's local day, in UTC milliseconds. */
  dayEnd: number
  /** The zone `dayEnd` was measured in, so the client reads the same calendar the server did. */
  timezone: string
}

/** The spans the statistics may bucket a range into. */
export const TASK_STATS_BUCKETS = ['day', 'week', 'month'] as const
export type TaskStatsBucket = (typeof TASK_STATS_BUCKETS)[number]

/**
 * What the statistics answer with.
 *
 * The range is echoed because every number below is measured in the account's own days: a reader who
 * changes zone sees new days from then on, and the answer has to say which calendar it used. Rates are
 * fractions (0–1) rather than percentages, so a client can format them in its own locale without
 * parsing a rounded string back into a number.
 */
export interface TaskStatsRange {
  /** First day counted, `YYYY-MM-DD` in the account's zone. */
  from: string
  /** Last day counted, inclusive. */
  to: string
  bucket: TaskStatsBucket
  timezone: string
}

export interface TaskStatsSummary {
  /** Finish events in the range: a repeated task counts once per completion, not once per task id. */
  completed: number
  /** Rows created in the range, whatever their status is now. */
  created: number
  /** `completed - created`; positive means the range retired more than it filed. */
  net: number
  /** Tasks still open when the statistics ran, the "unfinished" half of the completion rate. */
  open: number
  /** `completed / (completed + open)`, or 0 when there is nothing either way. */
  completionRate: number
  /** Finished in the range, by their own due date. */
  onTime: number
  /** Finished in the range that carried a due date: the on-time rate's denominator. */
  onTimeDue: number
  /** `onTime / onTimeDue`, or 0 when no finished task had a due date. */
  onTimeRate: number
  /** Median `created_at → completed_at` in milliseconds; null when nothing finished. */
  medianLeadTimeMs: number | null
  /** Consecutive days with a completion ending at the range's last day (or the day before, if it is still open). */
  currentStreak: number
  /** Longest run of consecutive completion days inside the range. */
  longestStreak: number
  /** Open tasks whose due date is already in the past. */
  overdue: number
}

/** One point of the trend: a day, a week (its Monday), or a month (its first day). */
export interface TaskStatsPoint {
  day: string
  completed: number
  created: number
}

/**
 * One slice of a distribution. `id` and `name` are null for the inbox, which has no row to name it:
 * the client already has a translation for the collection every unfiled task lands in.
 */
export interface TaskStatsNamedCount {
  id: string | null
  name: string | null
  completed: number
  /** Share of the range's completions; tag shares may sum past 1 because a task can carry several. */
  share: number
}

export interface TaskStatsPriorityCount {
  priority: TaskPriority
  completed: number
  share: number
}

/** Completions by the account-zone weekday (0 = Sunday) and hour (0–23) of `completed_at`. */
export interface TaskStatsWeekdayCount {
  weekday: number
  completed: number
}

export interface TaskStatsHourCount {
  hour: number
  completed: number
}

export interface TaskStatsDistributions {
  byList: TaskStatsNamedCount[]
  byTag: TaskStatsNamedCount[]
  byPriority: TaskStatsPriorityCount[]
  byWeekday: TaskStatsWeekdayCount[]
  byHour: TaskStatsHourCount[]
}

export interface TaskStatsPriorityLead {
  priority: TaskPriority
  /** How many finished rows the average is measured over; 0 means `averageMs` is null. */
  count: number
  averageMs: number | null
}

export interface TaskStatsLeadTime {
  /** Median and 90th percentile of `created_at → completed_at`, in milliseconds. */
  p50: number | null
  p90: number | null
  byPriority: TaskStatsPriorityLead[]
}

/**
 * How old the open workload is, aged from the due date when there is one and from the day it was
 * filed otherwise. `none` is the row that carries neither a usable due date nor a creation time: it
 * cannot be placed on that axis and is kept visible rather than dropped.
 */
export interface TaskStatsBacklog {
  /** Less than 7 days old, including tasks not yet due. */
  under7: number
  /** 7 to 30 days old, both ends included. */
  days7to30: number
  /** More than 30 days old. */
  over30: number
  /** No due date and no creation time to age it by. */
  none: number
}

export interface TodoStats {
  range: TaskStatsRange
  summary: TaskStatsSummary
  series: TaskStatsPoint[]
  distributions: TaskStatsDistributions
  leadTime: TaskStatsLeadTime
  backlog: TaskStatsBacklog
}

export function isTaskStatsBucket(value: unknown): value is TaskStatsBucket {
  return typeof value === 'string' && (TASK_STATS_BUCKETS as readonly string[]).includes(value)
}

export function isTaskView(value: unknown): value is TaskView {
  return typeof value === 'string' && (TASK_VIEWS as readonly string[]).includes(value)
}

export function isTaskSort(value: unknown): value is TaskSort {
  return typeof value === 'string' && (TASK_SORTS as readonly string[]).includes(value)
}

export function isRepeatFrequency(value: unknown): value is RepeatFrequency {
  return typeof value === 'string' && (REPEAT_FREQUENCIES as readonly string[]).includes(value)
}

/**
 * Reads a stored repeat rule.
 *
 * Returns null rather than throwing: a row written by an older build, or by a hand-edited backup,
 * must not take the whole listing down with it. An unknown shape simply means "does not repeat".
 */
export function parseRepeatRule(value: unknown): RepeatRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isRepeatFrequency(raw.freq)) return null
  const interval = typeof raw.interval === 'number' && Number.isFinite(raw.interval)
    ? Math.trunc(raw.interval)
    : 1
  if (interval < MIN_REPEAT_INTERVAL || interval > MAX_REPEAT_INTERVAL) return null
  return { freq: raw.freq, interval }
}

function shiftDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const cursor = new Date(Date.UTC(year, month - 1, day))
  cursor.setUTCDate(cursor.getUTCDate() + days)
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() }
}

function shiftMonths(year: number, month: number, day: number, months: number): { year: number; month: number; day: number } {
  const total = year * 12 + (month - 1) + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = ((total % 12) + 12) % 12 + 1
  return { year: nextYear, month: nextMonth, day: Math.min(day, daysInMonth(nextYear, nextMonth)) }
}

/**
 * The due time of the next occurrence, in the reader's own calendar.
 *
 * The arithmetic happens on wall-clock parts and goes back through `zonedTimeToUtc`, so a weekly
 * task due at 09:00 stays at 09:00 across a daylight-saving change instead of drifting to 08:00.
 * A month that lacks the day (the 31st, or 29 February) clamps to its last day.
 */
export function nextOccurrence(dueAt: number, rule: RepeatRule, timeZone: string): number {
  const parts = getZonedParts(new Date(dueAt), timeZone)
  const interval = Math.min(MAX_REPEAT_INTERVAL, Math.max(MIN_REPEAT_INTERVAL, Math.trunc(rule.interval)))
  const next = rule.freq === 'daily'
    ? shiftDays(parts.year, parts.month, parts.day, interval)
    : rule.freq === 'weekly'
      ? shiftDays(parts.year, parts.month, parts.day, interval * 7)
      : rule.freq === 'monthly'
        ? shiftMonths(parts.year, parts.month, parts.day, interval)
        : shiftMonths(parts.year, parts.month, parts.day, interval * 12)
  return zonedTimeToUtc(next.year, next.month, next.day, parts.hour, parts.minute, timeZone).getTime()
}

/**
 * When to remind the reader, as an absolute instant.
 *
 * Stored as a time rather than an offset because the sweep has to answer "is it due" without
 * knowing which offset the reader chose, and because a reminder set for "1 day before" must not
 * move when the due date is later edited by hand.
 */
export function remindAtFor(dueAt: number | null, offset: RemindOffset): number | null {
  if (dueAt === null || offset === 'none') return null
  switch (offset) {
    case 'due': return dueAt
    case '15m': return dueAt - 15 * 60_000
    case '1h': return dueAt - 60 * 60_000
    case '1d': return dueAt - 24 * 60 * 60_000
    default: return null
  }
}

/**
 * The reminder instants a caller asked for, as this app stores them.
 *
 * Absolute UTC milliseconds, ascending and deduplicated, and never more than five: two form rows that
 * name the same minute are one reminder, and a caller that sends six is held to the same ceiling the
 * route states. A value that is not a finite number is dropped rather than turned into `NaN`, which
 * would make every comparison false and park the row outside every sweep.
 */
export function normalizeReminderTimes(values: readonly number[]): number[] {
  const unique = new Set<number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    unique.add(Math.trunc(value))
  }
  return [...unique].sort((a, b) => a - b).slice(0, MAX_REMINDERS_PER_TASK)
}

/**
 * The tag names a caller asked for, as this app stores them.
 *
 * A leading `#` is how a reader writes a tag and not part of its name; duplicates differ only by
 * case, so `Work` and `work` are one tag. Order is kept, because the list is also what the reader
 * sees on the task.
 */
export function normalizeTagNames(input: unknown): string[] {
  const source = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(',') : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const name = entry.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_NAME_CHARS)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_TAGS_PER_TASK) break
  }
  return out
}

/**
 * The colour a list or tag gets when its reader did not pick one.
 *
 * Derived from the name so two devices that create the same list independently agree, and so the
 * colour survives a restore that dropped the column. The palette is the one folders and note tags
 * already use: a second set of colours would be a second vocabulary for the same idea.
 */
export function defaultColorFor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return ORGANIZER_COLORS[hash % ORGANIZER_COLORS.length]!
}

/** The `done / total` a list card shows. A list with no tasks reads as `0 / 0`. */
export function taskListProgress(list: { openCount: number; doneCount: number }): { done: number; total: number } {
  return { done: list.doneCount, total: list.openCount + list.doneCount }
}

/** The status a task moves to when its checkbox is pressed. */
export function toggledStatus(status: TaskStatus): TaskStatus {
  return status === 'done' ? 'todo' : 'done'
}

/** The priorities, ordered as the app shows them. Re-exported so callers need one import. */
export type { TaskPriority, TaskStatus }
