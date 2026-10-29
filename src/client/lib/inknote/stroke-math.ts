/**
 * Stroke quantities shared by the live canvas and the thumbnail renderer.
 *
 * The formulas are the reference's: a low-pass pressure filter, a pen width derived from the stroke's
 * average pressure with tapered ends, and the highlighter's fixed width and transparency. Nothing here
 * touches a canvas; callers pass a small path sink so the same trace can drive rendering and tests.
 */
import type { InknotePenStyle } from '@shared/inknote/types'

export type InknoteStrokeTool = 'pen' | 'ballpen' | 'highlighter'

/** The subset of a 2D path context the trace helpers need. */
export interface StrokePathSink {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
}

export const HIGHLIGHTER_ALPHA = 0.45
export const HIGHLIGHTER_WIDTH_FACTOR = 2.2
export const PEN_MIN_WIDTH = 1.6
export const PEN_MIN_DRAW_WIDTH = 0.8
export const PEN_TAPER_START = 0.12
export const PEN_TAPER_END = 0.88
export const PEN_TAPER_DEPTH = 0.35

/** Low-pass filter applied to each new pen sample: mostly the new reading, partly the last one. */
export function pressureFilter(raw: number, last: number): number {
  return raw * 0.55 + last * 0.45
}

/** Pen base width from the stroke's average pressure, with the reference's 0.3..1 clamp. */
export function strokeBaseWidth(width: number, averagePressure: number): number {
  const pressure = Math.max(0.3, Math.min(1, averagePressure))
  return Math.max(PEN_MIN_WIDTH, width * (0.45 + 0.55 * pressure))
}

/** The end taper factor for a 0..1 position along a pen stroke. */
export function penTaper(progress: number): number {
  if (progress < PEN_TAPER_START) return PEN_TAPER_DEPTH + (1 - PEN_TAPER_DEPTH) * (progress / PEN_TAPER_START)
  if (progress > PEN_TAPER_END) {
    return PEN_TAPER_DEPTH + (1 - PEN_TAPER_DEPTH) * ((1 - progress) / (1 - PEN_TAPER_END))
  }
  return 1
}

/** Width of one pen segment at `progress`, including its local pressure and the 0.8 floor. */
export function strokeWidthAt(baseWidth: number, progress: number, pressure = 1): number {
  return Math.max(PEN_MIN_DRAW_WIDTH, baseWidth * penTaper(progress) * (0.8 + 0.2 * pressure))
}

/**
 * Alpha a tool paints with. Pencil and brush apply further layers while drawing, so this is the base
 * pass only: the reference draws those styles as several strokes at different alphas.
 */
export function strokeAlpha(tool: InknoteStrokeTool, style: InknotePenStyle): number {
  if (tool === 'highlighter') return HIGHLIGHTER_ALPHA
  if (style === 'pencil') return 0.5
  if (style === 'brush') return 0.92
  return 1
}

/** Midpoint-quadratic smoothing used by ballpen, pen and every non-highlighter style. */
export function traceSmoothPath(sink: StrokePathSink, points: readonly { x: number; y: number }[]): void {
  if (points.length < 2) return
  sink.beginPath()
  sink.moveTo(points[0]!.x, points[0]!.y)
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i]!
    const next = points[i + 1]!
    sink.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
  }
  const last = points[points.length - 1]!
  sink.lineTo(last.x, last.y)
}

/** Highlighter trace: straight joins between successive midpoints, ending on the final sample. */
export function traceHighlighterPath(sink: StrokePathSink, points: readonly { x: number; y: number }[]): void {
  if (points.length < 2) return
  sink.beginPath()
  sink.moveTo(points[0]!.x, points[0]!.y)
  for (let i = 1; i < points.length; i++) {
    const current = points[i]!
    const previous = points[i - 1]!
    sink.lineTo((previous.x + current.x) / 2, (previous.y + current.y) / 2)
    if (i === points.length - 1) sink.lineTo(current.x, current.y)
  }
}
