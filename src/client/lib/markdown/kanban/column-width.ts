/**
 * The rules behind a column's width, kept free of the DOM so both the writer that stores a width in
 * the fence and the renderer that draws it answer from the same numbers. Which classes a column is
 * drawn with stays with the renderer.
 */
import type { KanbanProperty } from './types'

// The narrowest column the table already draws by default is the checkbox at `w-[var(--sp-16)]`, so a resize
// never offers a width the layout would not have accepted on its own.
export const KANBAN_COLUMN_MIN_WIDTH = 64

// Past this a column is wider than the board it sits in, and the rest of the fence stops being
// readable next to it: a document is not an infinite canvas.
export const KANBAN_COLUMN_MAX_WIDTH = 960

export const KANBAN_COLUMN_WIDTH_STEP = 16
export const KANBAN_COLUMN_COARSE_STEP = 64

/** A whole number of pixels inside the range the table is willing to draw. */
export function clampKanbanColumnWidth(px: number): number {
  return Math.min(KANBAN_COLUMN_MAX_WIDTH, Math.max(KANBAN_COLUMN_MIN_WIDTH, Math.round(px)))
}

// A hand-written or imported fence can carry anything under `width`. A value that is not a count of
// pixels is dropped rather than trusted, so it reads as the type default instead of a broken layout.
export function kanbanColumnWidthPx(column: KanbanProperty): number | undefined {
  const stored = column.width
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return undefined
  return clampKanbanColumnWidth(stored)
}

/** A drag in progress: where the pointer was taken and how wide the column was then. */
export interface KanbanColumnDrag {
  fromX: number
  startPx: number
}

/** How wide the column is where the pointer now is, measured from where the drag began. */
export function kanbanDragWidth(drag: KanbanColumnDrag, clientX: number): number {
  return clampKanbanColumnWidth(drag.startPx + (clientX - drag.fromX))
}

export type KanbanResizeCommand =
  | { kind: 'step'; width: number }
  | { kind: 'commit' }
  | { kind: 'discard' }
  | { kind: 'reset' }
  | { kind: 'ignore' }

/**
 * What one key asks of the splitter. Putting the answer here keeps the range, the two step sizes and
 * which keys need a draft in one place with the numbers they use.
 */
export function kanbanResizeCommand(
  key: string,
  shiftKey: boolean,
  current: number,
  hasDraft: boolean,
): KanbanResizeCommand {
  const step = shiftKey ? KANBAN_COLUMN_COARSE_STEP : KANBAN_COLUMN_WIDTH_STEP
  if (key === 'ArrowRight') return { kind: 'step', width: clampKanbanColumnWidth(current + step) }
  if (key === 'ArrowLeft') return { kind: 'step', width: clampKanbanColumnWidth(current - step) }
  if (key === 'Home') return { kind: 'step', width: KANBAN_COLUMN_MIN_WIDTH }
  if (key === 'End') return { kind: 'step', width: KANBAN_COLUMN_MAX_WIDTH }
  // Going back to the type default needs no draft: it undoes a width the document already has.
  if (key === 'Delete' || key === 'Backspace') return { kind: 'reset' }
  if (!hasDraft) return { kind: 'ignore' }
  if (key === 'Enter') return { kind: 'commit' }
  if (key === 'Escape') return { kind: 'discard' }
  return { kind: 'ignore' }
}
