/**
 * Moving a task's own date later, without moving any other field.
 *
 * A postponement is measured from the day the task already names — unless that day is already past,
 * in which case it is measured from today. Counting six days from a due date three weeks overdue
 * leaves the task overdue, which is the opposite of what the click was for; the reference plugin
 * arrived at the same rule and it is kept here.
 */
import { addUnits, startOfDay } from '../../time'
import type { Task } from '../model/task'
import type { TaskFields } from '../serializer/index'
import { isInvalidTaskDate } from './date-tools'

/** The three dates a task happens on, in the order a postponement picks between them. */
export type HappensDate = 'dueDate' | 'scheduledDate' | 'startDate'

/** Due first: it is the day a reader is late for, and the one a list sorts by. */
const FIELD_ORDER: readonly HappensDate[] = ['dueDate', 'scheduledDate', 'startDate']

/** The steps the menu offers, and the unit a row counts. */
export type PostponeUnit = 'day' | 'week' | 'month'

/** Whether a row counts from the day the task names or from today. */
export type PostponeMode = 'from-date' | 'from-today'

/**
 * Which date the click would move: the first one the task has.
 *
 * Null means the task carries no date to move, and then there is nothing for the button to do.
 */
export function getDateFieldToPostpone(fields: TaskFields): HappensDate | null {
  for (const field of FIELD_ORDER) {
    const date = fields[field]
    if (date !== null && !isInvalidTaskDate(date)) return field
  }
  return null
}

/** Offer the button only where a click would land: not finished, not broken, and with a date to move. */
export function shouldShowPostponeButton(task: Task): boolean {
  if (task.status.isDone) return false
  if (Object.keys(task.fields.invalidDates).length > 0) return false
  return getDateFieldToPostpone(task.fields) !== null
}

/**
 * The day a postponement of `amount` units lands on, or null when the field names no day to move.
 *
 * `from-today` is what the "today" and "tomorrow" rows ask for: they name a day rather than an offset,
 * so an overdue task is brought to today instead of staying on the day it should already have happened.
 */
export function postponeDate(
  fields: TaskFields,
  field: HappensDate,
  amount: number,
  unit: PostponeUnit,
  mode: PostponeMode,
  now: Date,
): Date | null {
  const current = fields[field]
  if (current === null || isInvalidTaskDate(current)) return null
  const today = startOfDay(now)
  if (mode === 'from-today') return addUnits(today, amount, unit)
  // An overdue date counts from today, not from itself: see the note at the top of this file.
  return addUnits(startOfDay(current.getTime() < today.getTime() ? today : current), amount, unit)
}
