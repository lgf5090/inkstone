/**
 * The readings the views share: how a set of tasks splits into groups, and in what order.
 *
 * These are pure functions over a page the server already scoped, so the grouping rules are the only
 * thing here — no fetching, no state. The day boundaries come in from the server (`dayEnd` is the end
 * of the reader's own day), which is why nothing in this file calls `Date.now()` for "today".
 */

import { localDate, toLocalMinute } from '@shared/assistant-time'
import { UPCOMING_DAYS, type TaskList, type TaskPriority, type TaskStatus, type TodoTask } from '@shared/todos/model'
import { isTaskDone, isTaskOpen } from '@shared/todos/status'

export type PlanGroupKey = 'overdue' | 'today' | 'upcoming' | 'later' | 'none'

/** The three reasons a row is in "today", which is also the order the screen reads them in. */
export type TodayGroupKey = 'planned' | 'today' | 'overdue'

export interface TaskGroup<K extends string = string> {
  key: K
  tasks: TodoTask[]
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

const DAY = 24 * 60 * 60 * 1000

/**
 * The local minute that means "the reader wrote a day, not an hour".
 *
 * A date without a clock time is stored at the day's 23:59 across every screen (`dueLabel`,
 * the calendar and the board all test for this same suffix), so the today screen's later bucket has
 * to recognise it the same way rather than invent a fourth reading.
 */
const END_OF_DAY_MINUTE = 'T23:59'

/** Overdue first, then by due time, then by priority, then oldest first. */
export function compareTasks(a: TodoTask, b: TodoTask): number {
  if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt
  if (a.dueAt !== null && b.dueAt === null) return -1
  if (a.dueAt === null && b.dueAt !== null) return 1
  const priority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  if (priority !== 0) return priority
  return a.createdAt - b.createdAt
}

/**
 * The four groups the plan view shows.
 *
 * An in-progress task with no due date sits in "today" on purpose: the reader started it, so it is
 * on them now, and a task that disappears into "no date" is one they will forget.
 *
 * The two future groups read the day the task starts, falling back to its due date when it never
 * named one: a task that cannot be begun until next month is a later task even when it is owed this
 * week, and one that starts tomorrow belongs to the week being planned. Overdue and today stay due
 * based — a start date does not make work late.
 */
export function groupByPlan(tasks: readonly TodoTask[], bounds: { dayEnd: number; now: number }): TaskGroup<PlanGroupKey>[] {
  const upcomingEnd = bounds.dayEnd + UPCOMING_DAYS * DAY
  const groups: Record<PlanGroupKey, TodoTask[]> = { overdue: [], today: [], upcoming: [], later: [], none: [] }
  for (const task of tasks) {
    // Only work still owed is placed on the plan. A row that already stopped being owed — finished or
    // abandoned — is not planned work; skipping on the open set (rather than "not done") is what keeps an
    // abandoned task out of "upcoming" and "today" instead of resurfacing it as something still to do.
    if (!isTaskOpen(task.status)) continue
    const startAt = task.startAt ?? null
    if (task.dueAt === null) {
      if (startAt === null) {
        if (task.status === 'in_progress') groups.today.push(task)
        else groups.none.push(task)
        continue
      }
      // A task that named only a start is work from that day: started already is today, ahead is the
      // same two future buckets, and a start that has not come is not "no date".
      if (startAt < bounds.now) groups.today.push(task)
      else if (startAt < upcomingEnd) groups.upcoming.push(task)
      else groups.later.push(task)
      continue
    }
    if (task.dueAt < bounds.now) groups.overdue.push(task)
    else if (task.dueAt < bounds.dayEnd) groups.today.push(task)
    else if ((startAt ?? task.dueAt) < upcomingEnd) groups.upcoming.push(task)
    else groups.later.push(task)
  }
  return (['overdue', 'today', 'upcoming', 'later', 'none'] as const)
    .map((key) => ({ key, tasks: groups[key].sort(compareTasks) }))
    .filter((group) => group.tasks.length > 0)
}

/**
 * The today screen's three groups.
 *
 * A row is filed under the first reason it is here: picked for today, then due today (or an
 * in-progress task with no date, which the server also counts as today), then overdue. Planned comes
 * first on purpose — that group is the one whose rows carry "remove from today", and a task that was
 * both picked and due today belongs with the pick so removing it moves it to the due group rather
 * than leaving it in place under a button that did nothing.
 */
export function groupToday(
  tasks: readonly TodoTask[],
  bounds: { dayEnd: number; now: number; today: string; timezone: string },
): TaskGroup<TodayGroupKey>[] {
  const groups: Record<TodayGroupKey, TodoTask[]> = { planned: [], today: [], overdue: [] }
  for (const task of tasks) {
    // The today screen lists what is owed; a row that stopped being owed — finished or abandoned — has
    // no place on it, so the skip reads the open set rather than "not done".
    if (!isTaskOpen(task.status)) continue
    if (task.plannedFor === bounds.today) groups.planned.push(task)
    // "Overdue" here means the day the row was owed on has already passed, not merely that its hour
    // has. This group carries the banner that offers to push a missed day into today, and a row due at
    // 14:00 is not a day the reader missed at 16:00 — filing it there would have the screen declare a
    // failure for the rest of the afternoon, and the batch would offer to postpone the reader's own
    // today onto itself. A late hour is still shown: the row keeps its red time in the main list,
    // which sorts it to the front. The sidebar's overdue badge answers a different question — how many
    // rows are past the instant they named — and keeps the server's `due_at < now`, deliberately.
    else if (task.dueAt !== null && localDate(task.dueAt, bounds.timezone) < bounds.today) groups.overdue.push(task)
    else groups.today.push(task)
  }
  return (['planned', 'today', 'overdue'] as const)
    .map((key) => ({ key, tasks: groups[key].sort(compareTasks) }))
    .filter((group) => group.tasks.length > 0)
}

/**
 * Whether a row is owed today but has not reached its hour yet.
 *
 * Three conditions, each ruling out a row that must not vanish into the collapsed section:
 * the due instant lies between `now` and the end of the day, and it carries a clock time —
 * a day written without one is stored as the local 23:59 the whole app already hides behind the
 * words "today" (see `dueLabel`), and filing that under "later" would hide half the screen.
 * `startAt` is deliberately not consulted: the today screen groups by `dueAt` alone (see
 * `groupToday`), and the two readings of `startAt` — event start in the calendar, future filing
 * in the lists — are not reconciled yet. A row's due hour, not a hypothetical earliest-start,
 * is what says "not yet".
 */
function isLaterToday(task: TodoTask, bounds: { now: number; dayEnd: number; timezone: string }): boolean {
  if (task.dueAt === null || task.dueAt <= bounds.now || task.dueAt >= bounds.dayEnd) return false
  return !toLocalMinute(task.dueAt, bounds.timezone).endsWith(END_OF_DAY_MINUTE)
}

/**
 * Pull the not-yet rows out of the today screen's buckets for the screen's collapsed "later" section.
 *
 * Only the due-today bucket can hold one: a picked row is here for the pick and keeps its place in
 * the planned bucket, and an overdue row has by definition passed its hour. The rest of the today
 * buckets are returned exactly as given — this splits what is drawn, never what `groupToday` decided,
 * so the three buckets keep one rule and one owner. The keys read as plain strings because a page
 * that chose its own server order arrives through `inServerOrder`, which hands back the unkeyed
 * group shape.
 */
export function splitTodayLater(
  groups: readonly TaskGroup[],
  bounds: { now: number; dayEnd: number; timezone: string },
): { groups: TaskGroup[]; later: TodoTask[] } {
  const later: TodoTask[] = []
  const kept = groups
    .map((group) => {
      if (group.key !== 'today') return group
      const rest: TodoTask[] = []
      for (const task of group.tasks) {
        if (isLaterToday(task, bounds)) later.push(task)
        else rest.push(task)
      }
      return { key: group.key, tasks: rest }
    })
    .filter((group) => group.tasks.length > 0)
  return { groups: kept, later }
}

/**
 * The tasks of one list, in the order a list is read: open first, finished last.
 *
 * Open rows keep the page's own order. That order is the server's answer — the reader's stored places
 * first, then the view's default sort — and sorting again here would overrule a drag or a move that
 * the server had just accepted. The finished rows are not moved by the reader, so they read newest
 * first.
 */
export function groupByList(tasks: readonly TodoTask[]): TaskGroup<'open' | 'done'>[] {
  const open = tasks.filter((task) => isTaskOpen(task.status))
  const done = tasks.filter((task) => isTaskDone(task.status)).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  return [
    ...(open.length ? [{ key: 'open' as const, tasks: open }] : []),
    ...(done.length ? [{ key: 'done' as const, tasks: done }] : []),
  ]
}

/**
 * Finished tasks by the day they were finished, newest day first.
 *
 * Grouped in the reader's timezone rather than the browser's: the app's "today" is already that
 * span, and a reader travelling would otherwise see yesterday's work filed under today.
 */
export function groupCompleted(tasks: readonly TodoTask[], timezone: string): TaskGroup[] {
  const byDay = new Map<string, TodoTask[]>()
  for (const task of tasks) {
    if (!isTaskDone(task.status)) continue
    const day = localDate(task.completedAt ?? task.updatedAt, timezone)
    const bucket = byDay.get(day) ?? []
    bucket.push(task)
    byDay.set(day, bucket)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, entries]) => ({
      key,
      tasks: entries.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    }))
}

/**
 * The rows the completed page shows, split into the two sections it draws side by side.
 *
 * Finished and abandoned are both work that left the plate, but they are not the same statement about
 * the reader, so they never share a bucket: the finished rows keep the by-the-day grouping a done list
 * has always had, and the abandoned rows form their own single section beneath it. The split reads the
 * status sets rather than "not open", so a stray value joins neither section.
 */
export function groupCompletedAndAbandoned(
  tasks: readonly TodoTask[],
  timezone: string,
): { done: TaskGroup[]; abandoned: TodoTask[] } {
  const abandoned = tasks.filter((task) => task.status === 'cancelled')
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
  return { done: groupCompleted(tasks, timezone), abandoned }
}

/**
 * The columns a board draws.
 *
 * `status` files a row under the state it is in, `list` under the collection that holds it, `priority`
 * under how urgent it is. One of the three is the column at a time, and the column is a reading of the
 * row rather than a second place it is kept: there is no table behind these, which is the whole point of
 * cutting a page into columns instead of storing the cut.
 */
export type BoardDimension = 'status' | 'list' | 'priority'

/** The dimensions the switch offers, in the order a reader meets them. */
export const BOARD_DIMENSIONS: readonly BoardDimension[] = ['status', 'list', 'priority']

/** The three states a task can be in, in the order the columns are read. */
export const BOARD_STATUS_COLUMNS: readonly TaskStatus[] = ['todo', 'in_progress', 'done']

/** The four priorities, most urgent first — the order a page is scanned in. */
export const BOARD_PRIORITY_COLUMNS: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low']

/**
 * The key of the inbox column.
 *
 * The inbox is a collection with no row behind it, so it needs a name of its own the way the store's
 * `listId` does; the app's existing sentinel for it is `inbox`, and reusing it keeps one word for one
 * thing across the address, the sidebar and this board.
 */
export const BOARD_INBOX_COLUMN = 'inbox'

/**
 * The columns of one dimension, with the rows of the page filed under each.
 *
 * A column is drawn even when nothing is in it: an empty one is still somewhere a task can be dropped,
 * and a board that lost its last row into another column would take the door away while the reader is
 * still holding it. Rows keep the order the page arrived in — the server's — because a column that
 * sorted again would quietly overrule a move or a drag that had just been accepted.
 */
export function boardColumns(
  dimension: BoardDimension,
  tasks: readonly TodoTask[],
  lists: readonly TaskList[],
): TaskGroup[] {
  const keys: string[] = dimension === 'status'
    ? [...BOARD_STATUS_COLUMNS]
    : dimension === 'priority'
      ? [...BOARD_PRIORITY_COLUMNS]
      : [BOARD_INBOX_COLUMN, ...lists.map((list) => list.id)]
  return keys.map((key) => ({ key, tasks: tasks.filter((task) => boardColumnKey(dimension, task) === key) }))
}

/** Which column of one dimension a row belongs to. */
export function boardColumnKey(dimension: BoardDimension, task: TodoTask): string {
  if (dimension === 'status') return task.status
  if (dimension === 'priority') return task.priority
  return task.listId ?? BOARD_INBOX_COLUMN
}
