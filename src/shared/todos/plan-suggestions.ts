/**
 * Which open tasks belong in today, and why.
 *
 * One rule, two callers: the Today screen's own plan and the assistant's `plan_today` tool both ask
 * it. They were two copies of the same three passes — overdue, then starred and due this week, then
 * what has no plan at all — with a comment promising they agreed and nothing making them. The screen
 * asks the shelf itself and the tool reads a page of it, but the *decision* is the same decision, so
 * it lives here where both can be held to it.
 *
 * The order matters more than the categories: a row that qualifies twice — starred and overdue — is
 * named once, under the more urgent reason, which is what makes the answer read as a plan rather than
 * as three lists glued together.
 *
 * This is a rule, not a model: it is deterministic, offline and instant, which is why it can run on
 * every keystroke of a screen. Anything smarter belongs to a caller that pays for a model call.
 */

import { UPCOMING_DAYS, type TodoTask } from './model'
import { isTaskOpen } from './status'

/** Why a row is on the plan, in the order the three passes take them: the more urgent reason wins. */
export type PlanReason = 'overdue' | 'starred_due' | 'unscheduled'

export interface PlanSuggestion {
  id: string
  title: string
  reason: PlanReason
}

/** How many open rows one plan reads before choosing; a page of the shelf, not the whole of it. */
export const MAX_PLAN_TODAY_CANDIDATES = 200

/** How many suggestions one call answers with when the caller does not say. */
export const DEFAULT_PLAN_TODAY_SUGGESTIONS = 5

/** The most suggestions one plan offers: a day holds a handful of tasks, not a page of them. */
export const MAX_PLAN_TODAY_SUGGESTIONS = 8

/**
 * The rows a plan may offer, in the order they are offered.
 *
 * `dayEnd` is the end of the reader's own today and `now` the instant the plan was asked for; both
 * come from the caller because the screen already holds them and the tool reads them from the turn.
 * A row already on today — planned, due, or in progress with no date — is already the screen's answer
 * rather than a suggestion for it, and a row that stopped being owed never becomes a suggestion by
 * not being finished.
 */
export function planSuggestions(
  tasks: readonly TodoTask[],
  options: { today: string, dayEnd: number, now: number, limit?: number },
): PlanSuggestion[] {
  const { today, dayEnd, now, limit = DEFAULT_PLAN_TODAY_SUGGESTIONS } = options
  const upcomingEnd = dayEnd + UPCOMING_DAYS * 24 * 60 * 60 * 1000
  const live = tasks.filter((task) => isTaskOpen(task.status) && task.deletedAt == null)
  const out: PlanSuggestion[] = []
  const taken = new Set<string>()
  const offer = (task: TodoTask, reason: PlanReason): void => {
    if (taken.has(task.id)) return
    taken.add(task.id)
    out.push({ id: task.id, title: task.title, reason })
  }
  for (const task of live) {
    if (task.dueAt !== null && task.dueAt < now) offer(task, 'overdue')
  }
  for (const task of live) {
    // The coming week, starting after today: a starred task due today is already on the screen.
    if (task.starred && task.dueAt !== null && task.dueAt >= dayEnd && task.dueAt < upcomingEnd) {
      if (task.plannedFor !== today) offer(task, 'starred_due')
    }
  }
  for (const task of live) {
    const plannedAhead = task.plannedFor !== null && task.plannedFor >= today
    const dueToday = task.dueAt !== null && task.dueAt < dayEnd
    // The server counts an in-progress task with no date as today, so the plan does not offer it.
    const inProgressToday = task.dueAt === null && task.status === 'in_progress'
    if (plannedAhead || dueToday || inProgressToday) continue
    offer(task, 'unscheduled')
  }
  return out.slice(0, limit)
}
