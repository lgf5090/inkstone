/**
 * The readings the views share: how a set of tasks splits into groups, and in what order.
 *
 * These are pure functions over a page the server already scoped, so the grouping rules are the only
 * thing here — no fetching, no state. The day boundaries come in from the server (`dayEnd` is the end
 * of the reader's own day), which is why nothing in this file calls `Date.now()` for "today".
 */

import { localDate } from '@shared/assistant-time'
import { UPCOMING_DAYS, type TaskList, type TaskPriority, type TaskStatus, type TodoTask } from '@shared/todos/model'

export type PlanGroupKey = 'overdue' | 'today' | 'upcoming' | 'later' | 'none'

/** The three reasons a row is in "today", which is also the order the screen reads them in. */
export type TodayGroupKey = 'planned' | 'today' | 'overdue'

export interface TaskGroup<K extends string = string> {
  key: K
  tasks: TodoTask[]
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

const DAY = 24 * 60 * 60 * 1000

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
    if (task.status === 'done') continue
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
  bounds: { dayEnd: number; now: number; today: string },
): TaskGroup<TodayGroupKey>[] {
  const groups: Record<TodayGroupKey, TodoTask[]> = { planned: [], today: [], overdue: [] }
  for (const task of tasks) {
    if (task.status === 'done') continue
    if (task.plannedFor === bounds.today) groups.planned.push(task)
    else if (task.dueAt !== null && task.dueAt < bounds.now) groups.overdue.push(task)
    else groups.today.push(task)
  }
  return (['planned', 'today', 'overdue'] as const)
    .map((key) => ({ key, tasks: groups[key].sort(compareTasks) }))
    .filter((group) => group.tasks.length > 0)
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
  const open = tasks.filter((task) => task.status !== 'done')
  const done = tasks.filter((task) => task.status === 'done').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
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
    if (task.status !== 'done') continue
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
