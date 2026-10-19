/**
 * How wide the canvas dock may be.
 *
 * The floor keeps the editor from becoming a column of one word per line, and the ceiling keeps the
 * thread usable on a small laptop: a panel may take at most sixty percent of the window. The arithmetic
 * is pure so the drag and the keyboard can share one answer.
 */
export const CANVAS_MIN_DOCK_WIDTH = 320
export const CANVAS_MAX_DOCK_WIDTH = 720
export const CANVAS_DEFAULT_WIDTH = 420
export const CANVAS_WIDTH_KEY = 'inkstone.canvas.width'

export function clampCanvasWidth(width: number, viewport: number): number {
  const ceiling = Math.max(CANVAS_MIN_DOCK_WIDTH, Math.min(CANVAS_MAX_DOCK_WIDTH, viewport * 0.6))
  return Math.round(Math.min(Math.max(width, CANVAS_MIN_DOCK_WIDTH), ceiling))
}

export function stepCanvasWidth(width: number, delta: number, viewport: number): number {
  return clampCanvasWidth(width + delta, viewport)
}
