/**
 * Shape recognition for the pen and ballpen.
 *
 * Ported from the reference `detectShape` pipeline: a line fit rejects an open stroke that already is a
 * line, closed strokes are tried as a rectangle, then as a polygon, then as an ellipse, and an open
 * stroke that curves enough becomes a freehand curve. The result is plain geometry; the engine decides
 * which stroke fields to build from it.
 */
import { SHAPE_SNAP_SIZE } from '@shared/inknote/constants'
import type { InknoteShapeKind } from '@shared/inknote/types'
import { segmentDistance, type Point } from './geometry'

export interface DetectedShape {
  kind: InknoteShapeKind
  points: Point[]
}

const MIN_SHAPE_POINTS = 5
const CLOSED_RATIO = 0.18
const LINE_DEV_RATIO = 0.09
const CURVE_DEV_RATIO = 0.45
const RECT_DEV_RATIO = 0.1
const RECT_CORNER_RATIO = 0.085
const POLYGON_EPS_RATIO = 0.08
const POLYGON_FIT_RATIO = 0.08
const CIRCLE_DEV_RATIO = 0.14
const SQUARE_ASPECT = 1.15
const MIN_POLYGON_CORNERS = 3
const MAX_POLYGON_CORNERS = 8

/** Classify a sampled stroke. Fewer than five samples never become a shape. */
export function detectShape(points: readonly Point[]): DetectedShape | null {
  if (points.length < MIN_SHAPE_POINTS) return null
  const n = points.length
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const diagonal = Math.hypot(width, height)
  const start = points[0]!
  const end = points[n - 1]!
  const closed = Math.hypot(end.x - start.x, end.y - start.y) < diagonal * CLOSED_RATIO
  const lineFit = fitLine(points)
  if (!closed && lineFit.maxDev < diagonal * LINE_DEV_RATIO) {
    return { kind: 'line', points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }] }
  }
  if (closed) {
    if (rectFitOk(points, minX, minY, width, height, diagonal)) {
      const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height))
      return {
        kind: aspect < SQUARE_ASPECT ? 'square' : 'rect',
        points: [{ x: minX, y: minY }, { x: maxX, y: maxY }],
      }
    }
    const corners = rdp(points, diagonal * POLYGON_EPS_RATIO)
    if (corners.length >= MIN_POLYGON_CORNERS
      && corners.length <= MAX_POLYGON_CORNERS
      && polyFitOk(points, corners, diagonal)) {
      return { kind: 'polygon', points: corners }
    }
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    let radiusSum = 0
    for (const point of points) radiusSum += Math.hypot(point.x - centerX, point.y - centerY)
    const averageRadius = radiusSum / points.length
    let maxDeviation = 0
    for (const point of points) {
      maxDeviation = Math.max(maxDeviation, Math.abs(Math.hypot(point.x - centerX, point.y - centerY) - averageRadius))
    }
    if (maxDeviation < diagonal * CIRCLE_DEV_RATIO) {
      const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height))
      return {
        kind: aspect < SQUARE_ASPECT ? 'circle' : 'ellipse',
        points: [{ x: minX, y: minY }, { x: maxX, y: maxY }],
      }
    }
  }
  if (!closed && lineFit.maxDev < diagonal * CURVE_DEV_RATIO) {
    return { kind: 'curve', points: points.map((point) => ({ x: point.x, y: point.y })) }
  }
  return null
}

/**
 * Least-squares line fit returning the largest perpendicular deviation. A vertical line has an
 * infinite slope and is measured as a horizontal distance instead, as in the reference.
 */
export function fitLine(points: readonly Point[]): { maxDev: number } {
  const n = points.length
  if (n === 0) return { maxDev: 0 }
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  for (const point of points) {
    sumX += point.x
    sumY += point.y
    sumXX += point.x * point.x
    sumXY += point.x * point.y
  }
  const denominator = n * sumXX - sumX * sumX
  let slope: number
  let intercept: number
  if (Math.abs(denominator) > 1e-6) {
    slope = (n * sumXY - sumX * sumY) / denominator
    intercept = (sumY - slope * sumX) / n
  } else {
    slope = Infinity
    intercept = sumX / n
  }
  let maxDev = 0
  for (const point of points) {
    const distance = slope === Infinity
      ? Math.abs(point.x - intercept)
      : Math.abs(slope * point.x - point.y + intercept) / Math.sqrt(slope * slope + 1)
    if (distance > maxDev) maxDev = distance
  }
  return { maxDev }
}

/**
 * Ramer-Douglas-Peucker simplification. The recursion is kept on an explicit stack so a 30k-point
 * stroke cannot exhaust the call stack.
 */
export function rdp(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length
  if (n <= 2) return points.map((point) => ({ x: point.x, y: point.y }))
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    const a = points[first]!
    const b = points[last]!
    let maxDistance = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const point = points[i]!
      const distance = segmentDistance(point.x, point.y, a.x, a.y, b.x, b.y)
      if (distance > maxDistance) {
        maxDistance = distance
        index = i
      }
    }
    if (maxDistance > epsilon && index > first) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push({ x: points[i]!.x, y: points[i]!.y })
  }
  return out
}

/** Whether every sample hugs the bounding box edge and all four corners are represented. */
export function rectFitOk(
  points: readonly Point[],
  minX: number,
  minY: number,
  width: number,
  height: number,
  diagonal: number,
): boolean {
  const maxX = minX + width
  const maxY = minY + height
  let maxDistance = 0
  for (const point of points) {
    const distance = Math.min(
      Math.abs(point.y - minY),
      Math.abs(point.y - maxY),
      Math.abs(point.x - minX),
      Math.abs(point.x - maxX),
    )
    if (distance > maxDistance) maxDistance = distance
  }
  if (maxDistance >= diagonal * RECT_DEV_RATIO) return false
  const tolerance = diagonal * RECT_CORNER_RATIO
  const corners: ReadonlyArray<readonly [number, number]> = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ]
  for (const [cornerX, cornerY] of corners) {
    let found = false
    for (const point of points) {
      if (Math.hypot(point.x - cornerX, point.y - cornerY) < tolerance) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/** Whether every sample lies close enough to the simplified polygon's edges. */
export function polyFitOk(points: readonly Point[], polygon: readonly Point[], diagonal: number): boolean {
  if (polygon.length === 0) return false
  let maxDistance = 0
  for (const point of points) {
    let best = Infinity
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!
      const b = polygon[(i + 1) % polygon.length]!
      best = Math.min(best, segmentDistance(point.x, point.y, a.x, a.y, b.x, b.y))
    }
    if (best > maxDistance) maxDistance = best
  }
  return maxDistance < diagonal * POLYGON_FIT_RATIO
}

/** Round points onto the recognition grid used for rectangles, squares, ellipses and circles. */
export function snapToGrid(points: readonly Point[], grid: number = SHAPE_SNAP_SIZE): Point[] {
  if (!(grid > 0)) return points.map((point) => ({ x: point.x, y: point.y }))
  return points.map((point) => ({
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid,
  }))
}
