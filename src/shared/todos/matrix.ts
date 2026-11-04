/**
 * The Eisenhower matrix: which of the four cells a task belongs in.
 *
 * A task carries two nullable flags. When a flag is null the reader never classified that dimension,
 * so it is derived from the fields the task already has: importance from the priority ladder and
 * urgency from the due date. Dragging a row into a cell writes both flags, which freezes its cell until
 * the reader asks for automatic classification again.
 */
import type { TodoTask } from './model'

export const MATRIX_QUADRANTS = ['do', 'schedule', 'delegate', 'drop'] as const
export type MatrixQuadrant = (typeof MATRIX_QUADRANTS)[number]

/** How close a due date has to be before a task counts as urgent on its own. */
export const MATRIX_URGENT_WINDOW_MS = 48 * 60 * 60_000

export interface MatrixCell {
  important: boolean
  urgent: boolean
}

export interface MatrixAxes {
  important: boolean
  urgent: boolean
}

export function matrixQuadrant(cell: MatrixCell): MatrixQuadrant {
  if (cell.important && cell.urgent) return 'do'
  if (cell.important) return 'schedule'
  if (cell.urgent) return 'delegate'
  return 'drop'
}

export function quadrantCell(quadrant: MatrixQuadrant): MatrixCell {
  return {
    important: quadrant === 'do' || quadrant === 'schedule',
    urgent: quadrant === 'do' || quadrant === 'delegate',
  }
}

/**
 * The two axes a row is drawn on.
 *
 * Priority is the ladder the rest of the app already sorts by, so an urgent-priority row is both
 * important and urgent, a high-priority row is important, and a due date inside the urgency window
 * makes any row urgent. A stored flag always wins over the derivation for its own axis.
 */
export function matrixAxesOf(task: Pick<TodoTask, 'priority' | 'dueAt' | 'important' | 'urgent'>, now: number): MatrixAxes {
  const important = task.important ?? (task.priority === 'high' || task.priority === 'urgent')
  const dueSoon = task.dueAt !== null && task.dueAt !== undefined && task.dueAt <= now + MATRIX_URGENT_WINDOW_MS
  const urgent = task.urgent ?? (task.priority === 'urgent' || dueSoon)
  return { important, urgent }
}

export function matrixQuadrantOf(task: Parameters<typeof matrixAxesOf>[0], now: number): MatrixQuadrant {
  return matrixQuadrant(matrixAxesOf(task, now))
}
