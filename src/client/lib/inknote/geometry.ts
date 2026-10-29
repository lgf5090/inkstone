/**
 * Geometry shared by the Inknote engine and its document helpers.
 *
 * Strokes store points in content coordinates (the note's fixed content canvas), while selection boxes
 * and pointer deltas are expressed in display coordinates (the paper the engine paints). The two
 * conversion helpers below are the only place that mapping is applied; text and image boxes are stored
 * normalized and are multiplied by the same metrics.
 */
import type { InknoteImage, InknotePageContent, InknoteStroke, InknoteTextBox } from '@shared/inknote/types'

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

/** The paper size and the content canvas it renders, both in page units. */
export interface ContentMetrics {
  width: number
  height: number
  contentWidth: number
  contentHeight: number
}

const TEXT_SELECTION_PREFIX = 't:'
const IMAGE_SELECTION_PREFIX = 'i:'

/** A selected page item. Text and images keep their reference prefixes in selection ids. */
export type SelectionTarget =
  | { kind: 'stroke'; stroke: InknoteStroke }
  | { kind: 'text'; text: InknoteTextBox }
  | { kind: 'image'; image: InknoteImage }

/** The padded box drawn around a selection, matching the reference's 8 px margin. */
export const SELECTION_PADDING = 8

/** Smallest axis-aligned box containing every point, or null when there is nothing to measure. */
export function boundsOf(points: readonly Point[]): Bounds | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Union of two boxes; either side may be missing. The result is always a new object. */
export function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

/** Whether two boxes overlap or touch. A zero-width box inside another still counts. */
export function boxIntersects(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

/**
 * Ray-casting point-in-polygon test. Points on an edge are inside, because a lasso finish and a
 * selection hit test should not disagree about a stroke that lies exactly on the lasso path.
 */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!
    const b = polygon[i]!
    if (segmentDistance(point.x, point.y, a.x, a.y, b.x, b.y) <= 1e-9) return true
    if ((b.y > point.y) !== (a.y > point.y)
      && point.x < (a.x - b.x) * (point.y - b.y) / (a.y - b.y) + b.x) {
      inside = !inside
    }
  }
  return inside
}

/** Shortest distance from a point to a line segment. */
export function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Resolve selection ids to page items. Text and image ids may be prefixed with `t:` / `i:`, which is
 * how the reference keeps the three collections apart; a plain id is matched against strokes, then
 * texts, then images. Unknown ids are dropped and duplicates are resolved once.
 */
export function resolveSelection(page: InknotePageContent, ids: readonly string[]): SelectionTarget[] {
  const strokes = new Map(page.strokes.map((stroke) => [stroke.id, stroke]))
  const texts = new Map(page.texts.map((text) => [text.id, text]))
  const images = new Map(page.images.map((image) => [image.id, image]))
  const out: SelectionTarget[] = []

  for (const id of new Set(ids)) {
    if (id.startsWith(TEXT_SELECTION_PREFIX)) {
      const text = texts.get(id.slice(TEXT_SELECTION_PREFIX.length))
      if (text) out.push({ kind: 'text', text })
      continue
    }
    if (id.startsWith(IMAGE_SELECTION_PREFIX)) {
      const image = images.get(id.slice(IMAGE_SELECTION_PREFIX.length))
      if (image) out.push({ kind: 'image', image })
      continue
    }
    const stroke = strokes.get(id)
    if (stroke) {
      out.push({ kind: 'stroke', stroke })
      continue
    }
    const text = texts.get(id)
    if (text) {
      out.push({ kind: 'text', text })
      continue
    }
    const image = images.get(id)
    if (image) out.push({ kind: 'image', image })
  }

  return out
}

/**
 * Bounding box of the given selection ids in display coordinates.
 *
 * Unknown ids are ignored, and an empty selection has no box.
 */
export function selectionBounds(
  page: InknotePageContent,
  ids: readonly string[],
  metrics: ContentMetrics,
): Bounds | null {
  let box: Bounds | null = null
  for (const target of resolveSelection(page, ids)) {
    if (target.kind === 'stroke') {
      const points = target.stroke.points.map((point) => fromContentPoint(point, metrics))
      box = mergeBounds(box, boundsOf(points))
    } else {
      box = mergeBounds(box, normalizedBounds(target.kind === 'text' ? target.text : target.image, metrics))
    }
  }
  return box
}

/** Expand a raw selection box into the box the engine draws and hit-tests. */
export function computeSelectionBox(bounds: Bounds | null, padding: number = SELECTION_PADDING): Bounds | null {
  if (!bounds) return null
  const margin = Math.max(0, padding)
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    w: bounds.w + margin * 2,
    h: bounds.h + margin * 2,
  }
}

/** Content coordinates to display coordinates. Extra point fields such as pressure are preserved. */
export function fromContentPoint<T extends Point>(point: T, metrics: ContentMetrics): T {
  return {
    ...point,
    x: point.x * axisRatio(metrics.width, metrics.contentWidth),
    y: point.y * axisRatio(metrics.height, metrics.contentHeight),
  }
}

/** Display coordinates back to content coordinates. Extra point fields such as pressure are preserved. */
export function toContentPoint<T extends Point>(point: T, metrics: ContentMetrics): T {
  return {
    ...point,
    x: point.x * axisRatio(metrics.contentWidth, metrics.width),
    y: point.y * axisRatio(metrics.contentHeight, metrics.height),
  }
}

function axisRatio(target: number, source: number): number {
  return Number.isFinite(target) && Number.isFinite(source) && source > 0 ? target / source : 1
}

function normalizedBounds(item: { x: number; y: number; w: number; h: number }, metrics: ContentMetrics): Bounds {
  return {
    x: item.x * metrics.width,
    y: item.y * metrics.height,
    w: item.w * metrics.width,
    h: item.h * metrics.height,
  }
}
