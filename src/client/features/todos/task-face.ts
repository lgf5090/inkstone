/**
 * The face a task wears.
 *
 * A task's colour and icon are both optional, and "not set" means "wear the list's". The card and the
 * calendar are the two surfaces that paint it, and before this module they answered that question twice
 * over — the calendar drew the inbox neutral, the card drew it in the accent — which is how one task came
 * to wear two faces on two screens.
 *
 * The card's accent answer is now gone rather than kept as an override, because it collided with a fact
 * the same row prints: an overdue date is painted `--danger`, and the default accent is `oklch(54% .15 30)`
 * against that `oklch(53% .19 22)` — the two reds measure 1.07:1 against each other, which is to say they
 * are the same colour to the eye. So "this row belongs to nobody's list" and "this row is late" arrived on
 * one line as one red saying two contradictory things. One neutral fallback for every surface, and no
 * parameter through which a third surface can reintroduce the disagreement.
 */

import type { TaskList, TodoTask } from '@shared/todos/model'

/** The colour a task wears: its own, else its list's, else the neutral every surface already agrees on. */
export function taskColorOf(task: TodoTask, lists: readonly TaskList[]): string {
  if (task.color) return task.color
  const list = task.listId === null ? null : lists.find((entry) => entry.id === task.listId) ?? null
  return list?.color ?? 'var(--text-tertiary)'
}
