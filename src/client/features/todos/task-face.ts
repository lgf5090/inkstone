/**
 * The face a task wears.
 *
 * A task's colour and icon are both optional, and "not set" means "wear the list's" — the same face
 * every row showed before a task could carry one of its own. The calendar and the card are the two
 * surfaces that paint a task's colour, and before this module they answered that question twice over
 * (the calendar drew the inbox neutral, the card drew it in the accent), which is how one task came
 * to wear two faces on two screens. The answer lives here once.
 */

import type { TaskList, TodoTask } from '@shared/todos/model'

/**
 * The colour a task wears: its own, else its list's, else the caller's neutral.
 *
 * The fallback is a parameter because the two surfaces that ask disagree about the inbox on purpose:
 * a calendar chip sits beside other days' work and reads as nobody's row, while a card's checkbox is
 * the row's own identity and keeps the accent it has always had. A task naming a list that has since
 * been deleted falls back the same way an inbox task does — there is no list left to ask.
 */
export function taskColorOf(task: TodoTask, lists: readonly TaskList[], fallback = 'var(--text-tertiary)'): string {
  if (task.color) return task.color
  const list = task.listId === null ? null : lists.find((entry) => entry.id === task.listId) ?? null
  return list?.color ?? fallback
}
