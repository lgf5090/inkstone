/**
 * Whether a task is still owed, spelled once for the to-do domain.
 *
 * Every surface that reads a task used to answer this with a literal: `status != 'done'` in a SQL
 * fragment, `task.status === 'done'` in TypeScript. While `done` was the only way a task could end,
 * "not done" and "still open" were the same question, so spelling it inline cost nothing. It stops
 * being free as soon as the enum gains a second terminal state — a reader who marks a task
 * "not going to do it" has not left it open, and a surface that filters by `!= 'done'` would start
 * listing that work as owed, count it in the open badge and offer it to the reminder sweep.
 *
 * So the two answers live here as named sets rather than as one inline negation:
 * `TASK_OPEN_STATUSES` is the work a reader still has, `TASK_DONE_STATUSES` is the work they finished.
 * Adding a terminal state is then one deliberate edit per set instead of a hunt through every query,
 * and a set left untouched is a visible decision rather than an oversight.
 *
 * Two things this module deliberately does not own:
 *
 * - The notes board and the chat's task surface share the `Task` type but answer a two-state
 *   question with no terminal state to add. They read `TASK_DONE_STATUSES_LEGACY` from
 *   `shared/assistant`, so widening the sets here cannot quietly move a notebook UI.
 * - Whether a *string* is a known status at all. That is `TASK_STATUSES`' question, not this module's,
 *   and it belongs to the request validators — spelling it as "open or done" would make a new status
 *   refused by the sync merge the moment it stopped appearing in either set here.
 *
 * The statistics page has its own rule on top of these sets: `completionRate` stays finished over
 * finished-plus-open, because a task that was abandoned is neither the work done nor the work owed.
 * That denominator is decided where the ratios are computed (`worker/todos/stats.ts`), not here.
 */

import type { TaskStatus } from '../assistant'

/** The statuses that mean the reader still owes the task: it is listed, counted and reminded about. */
export const TASK_OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress']

/** The statuses that mean the reader finished the task, and the work counts as done. */
export const TASK_DONE_STATUSES: readonly TaskStatus[] = ['done']

/**
 * A status written as text, or absent: a decoded row, a patch field, an event's `from_status`.
 *
 * Anything that is not one of the sets answers false — a missing status is neither open nor finished,
 * which is what the literals it replaced (`=== 'done'`) already said about `null` and `undefined`.
 */
type StatusLike = string | null | undefined

function inSet(status: StatusLike, set: readonly TaskStatus[]): boolean {
  return status !== null && status !== undefined && (set as readonly string[]).includes(status)
}

/** Whether the task is still owed. */
export function isTaskOpen(status: StatusLike): boolean {
  return inSet(status, TASK_OPEN_STATUSES)
}

/** Whether the task was finished. */
export function isTaskDone(status: StatusLike): boolean {
  return inSet(status, TASK_DONE_STATUSES)
}

/**
 * An `IN` list over a status column, as SQL text.
 *
 * The sets are constants, so the values are inlined rather than bound: the statement carries no
 * parameter that a caller could confuse with a user-supplied one, and an inlined list keeps the
 * placeholder numbering of the surrounding query unchanged. `column` names the expression to test,
 * because the same rule is read off `todos_tasks` (aliased `t`), a second copy of the table in a
 * self-join (`k`) and the status columns of `todos_task_events` (`e.from_status`, `d.to_status`).
 */
function sqlIn(column: string, set: readonly TaskStatus[]): string {
  return `${column} IN (${set.map((status) => `'${status}'`).join(', ')})`
}

/** The SQL half of `isTaskOpen`, for a statement that names the bare `status` column. */
export const SQL_TASK_OPEN = sqlIn('status', TASK_OPEN_STATUSES)

/** The SQL half of `isTaskDone`, for a statement that names the bare `status` column. */
export const SQL_TASK_DONE = sqlIn('status', TASK_DONE_STATUSES)

/** The same rule for a statement that gives the table an alias. */
export function sqlTaskOpen(column = 'status'): string {
  return sqlIn(column, TASK_OPEN_STATUSES)
}

/** The same rule for a statement that gives the table an alias. */
export function sqlTaskDone(column = 'status'): string {
  return sqlIn(column, TASK_DONE_STATUSES)
}
