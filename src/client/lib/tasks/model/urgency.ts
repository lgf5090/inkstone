import { startOfDay } from '../../../lib/time'
import { Priority } from './priority'
import type { Task } from './task'

const MILLIS_PER_DAY = 86_400_000
const DUE_COEFFICIENT = 12
const SCHEDULED_COEFFICIENT = 5
const STARTED_COEFFICIENT = -3
const PRIORITY_COEFFICIENT = 6

/** How much a due date is worth, by how far it has slipped. */
function dueScore(daysOverdue: number): number {
  if (daysOverdue >= 7) return 1
  if (daysOverdue >= -14) return ((daysOverdue + 14) * 0.8) / 21 + 0.2
  return 0.2
}

const PRIORITY_MULTIPLIER: Record<Priority, number> = {
  [Priority.Highest]: 1.5,
  [Priority.High]: 1,
  [Priority.Medium]: 0.65,
  [Priority.None]: 0.325,
  [Priority.Low]: 0,
  [Priority.Lowest]: -0.3,
}

/**
 * How loudly a task should ask to be done, as a single number.
 *
 * A heuristic rather than a rule, and deliberately the same one the reference plugin uses: readers
 * move vaults between the two, and a different score would reorder their lists for no reason they
 * could name. `sort by urgency` is the default order for a reason — it puts the overdue thing in
 * front of the merely important one.
 */
export function urgencyOf(task: Task, now: Date): number {
  const today = startOfDay(now)
  let score = 0

  const due = task.fields.dueDate
  if (due !== null && Number.isFinite(due.getTime())) {
    const daysOverdue = Math.round((today.getTime() - startOfDay(due).getTime()) / MILLIS_PER_DAY)
    score += dueScore(daysOverdue) * DUE_COEFFICIENT
  }

  const scheduled = task.fields.scheduledDate
  if (scheduled !== null && Number.isFinite(scheduled.getTime()) && today >= startOfDay(scheduled)) {
    score += SCHEDULED_COEFFICIENT
  }

  const start = task.fields.startDate
  if (start !== null && Number.isFinite(start.getTime()) && today < startOfDay(start)) {
    score += STARTED_COEFFICIENT
  }

  score += PRIORITY_MULTIPLIER[task.fields.priority] * PRIORITY_COEFFICIENT
  return score
}
