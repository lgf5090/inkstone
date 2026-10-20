/**
 * The readings the views share: how a set of tasks splits into groups, and in what order.
 *
 * These are pure functions over a page the server already scoped, so the grouping rules are the only
 * thing here — no fetching, no state. The day boundaries come in from the server (`dayEnd` is the end
 * of the reader's own day), which is why nothing in this file calls `Date.now()` for "today".
 */

import { localDate } from '@shared/assistant-time'
import { UPCOMING_DAYS, type TaskPriority, type TodoTask } from '@shared/todos/model'

export type PlanGroupKey = 'overdue' | 'today' | 'upcoming' | 'later' | 'none'

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
 */
export function groupByPlan(tasks: readonly TodoTask[], bounds: { dayEnd: number; now: number }): TaskGroup<PlanGroupKey>[] {
  const upcomingEnd = bounds.dayEnd + UPCOMING_DAYS * DAY
  const groups: Record<PlanGroupKey, TodoTask[]> = { overdue: [], today: [], upcoming: [], later: [], none: [] }
  for (const task of tasks) {
    if (task.status === 'done') continue
    if (task.dueAt === null) {
      if (task.status === 'in_progress') groups.today.push(task)
      else groups.none.push(task)
      continue
    }
    if (task.dueAt < bounds.now) groups.overdue.push(task)
    else if (task.dueAt < bounds.dayEnd) groups.today.push(task)
    else if (task.dueAt < upcomingEnd) groups.upcoming.push(task)
    else groups.later.push(task)
  }
  return (['overdue', 'today', 'upcoming', 'later', 'none'] as const)
    .map((key) => ({ key, tasks: groups[key].sort(compareTasks) }))
    .filter((group) => group.tasks.length > 0)
}

/** The tasks of one list, in the order a list is read: open first, finished last. */
export function groupByList(tasks: readonly TodoTask[]): TaskGroup<'open' | 'done'>[] {
  const open = tasks.filter((task) => task.status !== 'done').sort(compareTasks)
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

/** How many of a list's tasks are open, for the card's progress line. */
export function openCountOf(tasks: readonly TodoTask[], listId: string): number {
  return tasks.filter((task) => task.listId === listId && task.status !== 'done').length
}
