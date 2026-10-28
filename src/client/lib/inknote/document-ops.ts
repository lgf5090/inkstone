/**
 * Document edits that need no canvas: pixel erasing, and moving or scaling a selection.
 *
 * These functions mutate the page they are given, because the engine owns that page and calls the
 * selection transforms on every pointer move; allocating a fresh page per frame would copy every
 * stroke on the page. Callers that need a snapshot take one before the gesture starts.
 */
import type { InknotePageContent, InknoteStroke } from '@shared/inknote/types'
import {
  resolveSelection,
  segmentDistance,
  toContentPoint,
  type Bounds,
  type ContentMetrics,
  type Point,
} from './geometry'

export type ScaleCorner = 'nw' | 'ne' | 'sw' | 'se'

/** The smallest selection box a scale gesture may produce, in display units. */
export const MIN_SELECTION_SIZE = 16

/** Extra hit area around a shape's bounding box for the pixel eraser. */
const SHAPE_ERASE_PADDING = 12

/**
 * Split strokes around a pixel-eraser path.
 *
 * Returns null when nothing was hit, otherwise a new stroke array. Untouched strokes keep their
 * identity; erased runs become new strokes that preserve tool, style, shape, colour and width (the
 * reference dropped style and shape), with ids from the injected factory.
 */
export function pixelErase(
  page: { strokes: readonly InknoteStroke[] },
  path: readonly Point[],
  radius: number,
  newId: () => string,
): InknoteStroke[] | null {
  const segments = pathSegments(path)
  if (segments.length === 0) return null
  const keepRadius = Math.max(0, radius)
  let changed = false
  const out: InknoteStroke[] = []

  for (const stroke of page.strokes) {
    if (stroke.shape) {
      if (shapeHit(stroke, segments, keepRadius)) {        changed = true
        continue
      }
      out.push(stroke)
      continue
    }

    const keep = stroke.points.map((point) => !segments.some(([a, b]) =>
      segmentDistance(point.x, point.y, a.x, a.y, b.x, b.y) <= keepRadius + stroke.width / 2))
    if (keep.every(Boolean)) {
      out.push(stroke)
      continue
    }

    changed = true
    let run: InknoteStroke['points'] = []
    const flush = (): void => {
      if (run.length >= 2) out.push({ ...stroke, id: newId(), points: run })
      run = []
    }
    for (let i = 0; i < stroke.points.length; i++) {
      if (keep[i]) run.push(stroke.points[i]!)
      else flush()
    }
    flush()
  }

  return changed ? out : null
}

/**
 * Translate selected items by a display-space delta.
 *
 * Stroke points are converted through the metrics so the delta lands in content units; text and image
 * boxes are normalized, so the same delta is divided by the paper size.
 */
export function moveSelection(
  page: InknotePageContent,
  ids: readonly string[],
  dx: number,
  dy: number,
  metrics: ContentMetrics,
): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  if (!(metrics.width > 0) || !(metrics.height > 0)) return
  const contentDx = dx * (metrics.contentWidth / metrics.width)
  const contentDy = dy * (metrics.contentHeight / metrics.height)
  const normalizedDx = dx / metrics.width
  const normalizedDy = dy / metrics.height

  for (const target of resolveSelection(page, ids)) {
    if (target.kind === 'stroke') {
      for (const point of target.stroke.points) {
        point.x += contentDx
        point.y += contentDy
      }
    } else if (target.kind === 'text') {
      target.text.x += normalizedDx
      target.text.y += normalizedDy
    } else {
      target.image.x += normalizedDx
      target.image.y += normalizedDy
    }
  }
}

/**
 * Scale selected items around the corner opposite the dragged one.
 *
 * `box` and `point` are display coordinates; the anchor is converted into each item's own space
 * (content units for strokes, normalized units for text and images). The returned box is the new
 * selection box the engine should draw.
 */
export function scaleSelection(
  page: InknotePageContent,
  ids: readonly string[],
  box: Bounds,
  corner: ScaleCorner,
  point: Point,
  metrics: ContentMetrics,
): Bounds {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ...box }
  const anchorX = corner === 'se' || corner === 'ne' ? box.x : box.x + box.w
  const anchorY = corner === 'se' || corner === 'sw' ? box.y : box.y + box.h
  const nextX = Math.min(anchorX, point.x)
  const nextY = Math.min(anchorY, point.y)
  const nextW = Math.max(MIN_SELECTION_SIZE, Math.abs(point.x - anchorX))
  const nextH = Math.max(MIN_SELECTION_SIZE, Math.abs(point.y - anchorY))
  const nextBox: Bounds = { x: nextX, y: nextY, w: nextW, h: nextH }

  const scaleX = box.w > 0 ? nextW / box.w : 1
  const scaleY = box.h > 0 ? nextH / box.h : 1
  const contentAnchor = toContentPoint({ x: anchorX, y: anchorY }, metrics)
  const normalizedAnchorX = metrics.width > 0 ? anchorX / metrics.width : 0
  const normalizedAnchorY = metrics.height > 0 ? anchorY / metrics.height : 0

  for (const target of resolveSelection(page, ids)) {
    if (target.kind === 'stroke') {
      for (const strokePoint of target.stroke.points) {
        strokePoint.x = (strokePoint.x - contentAnchor.x) * scaleX + contentAnchor.x
        strokePoint.y = (strokePoint.y - contentAnchor.y) * scaleY + contentAnchor.y
      }
    } else if (target.kind === 'text') {
      target.text.x = (target.text.x - normalizedAnchorX) * scaleX + normalizedAnchorX
      target.text.y = (target.text.y - normalizedAnchorY) * scaleY + normalizedAnchorY
      target.text.w *= scaleX
      target.text.h *= scaleY
    } else {
      target.image.x = (target.image.x - normalizedAnchorX) * scaleX + normalizedAnchorX
      target.image.y = (target.image.y - normalizedAnchorY) * scaleY + normalizedAnchorY
      target.image.w *= scaleX
      target.image.h *= scaleY
    }
  }

  return nextBox
}

function pathSegments(path: readonly Point[]): Array<readonly [Point, Point]> {
  if (path.length === 1) return [[path[0]!, path[0]!]]
  const segments: Array<readonly [Point, Point]> = []
  for (let i = 0; i < path.length - 1; i++) segments.push([path[i]!, path[i + 1]!])
  return segments
}

function shapeHit(stroke: InknoteStroke, segments: ReadonlyArray<readonly [Point, Point]>, radius: number): boolean {
  if (stroke.points.length < 2) return false
  const a = stroke.points[0]!
  const b = stroke.points[stroke.points.length - 1]!
  const padding = SHAPE_ERASE_PADDING + radius
  const box: Bounds = {
    x: Math.min(a.x, b.x) - padding,
    y: Math.min(a.y, b.y) - padding,
    w: Math.abs(b.x - a.x) + padding * 2,
    h: Math.abs(b.y - a.y) + padding * 2,
  }
  for (const [start, end] of segments) {
    if (pointInBox(start, box) || pointInBox(end, box)) return true
    if (segmentCrossesBox(start, end, box)) return true
  }
  return false
}

function pointInBox(point: Point, box: Bounds): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
}

function segmentCrossesBox(a: Point, b: Point, box: Bounds): boolean {
  const corners: readonly Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i]!
    const d = corners[(i + 1) % corners.length]!
    if (segmentsIntersect(a, b, c, d)) return true
  }
  return false
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(denominator) < 1e-9) return false
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}
