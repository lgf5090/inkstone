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

/** How long a reminder may be set before the due time. */
export const REMIND_OFFSETS = ['none', 'due', '15m', '1h', '1d'] as const
export type RemindOffset = (typeof REMIND_OFFSETS)[number]

export const MAX_LIST_NAME_CHARS = 60
export const MAX_TAG_NAME_CHARS = 40
export const MAX_TAGS_PER_TASK = 8
export const MAX_STEPS_PER_TASK = 50
export const MAX_STEP_TEXT_CHARS = 200
/** The most a single listing answers with. The board reads the open set once and slices it. */
export const MAX_TASKS_PER_QUERY = 500
/** A completed list is history: the newest page is enough to answer "what did I finish". */
export const COMPLETED_PAGE_SIZE = 200

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
  remindAt: number | null
  remindedAt: number | null
  noteId: string | null
  conversationId: string | null
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
  byTag: Record<string, number>
}

/** What one page of tasks answers with, so the client never has to compute "today" itself. */
export interface TaskPage {
  tasks: TodoTask[]
  total: number
  counts: TaskCounts
  /** End of the reader's local day, in UTC milliseconds. */
  dayEnd: number
}

export function isTaskView(value: unknown): value is TaskView {
  return typeof value === 'string' && (TASK_VIEWS as readonly string[]).includes(value)
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
