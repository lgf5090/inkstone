import type { InkDocument, InkPoint } from './types'

export interface InkBounds {
    left: number
    top: number
    right: number
    bottom: number
}

export interface InkBox {
    left: number
    top: number
    width: number
    height: number
}

export interface InkSelection {
    strokeIds: Set<string>
    shapeIds: Set<string>
}

type PointLike = Pick<InkPoint, 'x' | 'y'>

export function boundsOf(points: Iterable<PointLike>): InkBounds | null {
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const point of points) {
        if (point.x < left) left = point.x
        if (point.x > right) right = point.x
        if (point.y < top) top = point.y
        if (point.y > bottom) bottom = point.y
    }
    return left === Infinity ? null : { left, top, right, bottom }
}

export function mergeBounds(base: InkBounds | null, next: InkBounds | null): InkBounds | null {
    if (!base) return next
    if (!next) return base
    return {
        left: Math.min(base.left, next.left),
        top: Math.min(base.top, next.top),
        right: Math.max(base.right, next.right),
        bottom: Math.max(base.bottom, next.bottom),
    }
}

export function contentBounds(document: InkDocument, includeElements = true): InkBox | null {
    let bounds: InkBounds | null = null
    for (const stroke of document.strokes) bounds = mergeBounds(bounds, boundsOf(stroke.points))
    for (const shape of document.shapes) bounds = mergeBounds(bounds, boundsOf([shape.start, shape.end]))
    if (includeElements) {
        for (const element of document.elements) {
            bounds = mergeBounds(bounds, boundsOf([
                { x: element.x, y: element.y },
                { x: element.x + element.width, y: element.y + element.height },
            ]))
        }
    }
    if (!bounds) return null
    return {
        left: bounds.left,
        top: bounds.top,
        width: Math.max(1, bounds.right - bounds.left),
        height: Math.max(1, bounds.bottom - bounds.top),
    }
}

/** The ink-only box, padded for export. A blank drawing still names a valid 1×1 viewBox. */
export function inkBounds(document: InkDocument, padding = 24): InkBox {
    let bounds: InkBounds | null = null
    for (const stroke of document.strokes) bounds = mergeBounds(bounds, boundsOf(stroke.points))
    for (const shape of document.shapes) bounds = mergeBounds(bounds, boundsOf([shape.start, shape.end]))
    if (!bounds) return { left: 0, top: 0, width: 1, height: 1 }
    const left = bounds.left - padding
    const top = bounds.top - padding
    return {
        left,
        top,
        width: Math.max(1, bounds.right - left + padding),
        height: Math.max(1, bounds.bottom - top + padding),
    }
}

export function pointInPolygon(point: PointLike, polygon: readonly PointLike[]): boolean {
    let inside = false
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[index]!
        const b = polygon[previous]!
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside
        }
    }
    return inside
}

function strideFor(length: number, ceiling: number): number {
    return Math.max(1, Math.ceil(length / ceiling))
}

export function selectionBounds(
    document: InkDocument,
    strokeIds: ReadonlySet<string>,
    shapeIds: ReadonlySet<string>,
): InkBounds | null {
    let bounds: InkBounds | null = null
    for (const stroke of document.strokes) {
        if (strokeIds.has(stroke.id)) bounds = mergeBounds(bounds, boundsOf(stroke.points))
    }
    for (const shape of document.shapes) {
        if (shapeIds.has(shape.id)) bounds = mergeBounds(bounds, boundsOf([shape.start, shape.end]))
    }
    return bounds
}

/**
 * A lasso selection is decided by sampled points, never by replaying every sample of a lecture:
 * the polygon is decimated to at most 180 points and each stroke to at most 600 probes.
 */
export function selectLasso(document: InkDocument, lassoPoints: readonly InkPoint[]): InkSelection {
    const strokeIds = new Set<string>()
    const shapeIds = new Set<string>()
    if (lassoPoints.length < 3) return { strokeIds, shapeIds }
    const stride = strideFor(lassoPoints.length, 180)
    const polygon = lassoPoints.filter((_, index) => index % stride === 0 || index === lassoPoints.length - 1)
    const lassoBounds = boundsOf(polygon)
    if (!lassoBounds) return { strokeIds, shapeIds }
    const intersects = (point: PointLike): boolean => point.x >= lassoBounds.left
        && point.x <= lassoBounds.right
        && point.y >= lassoBounds.top
        && point.y <= lassoBounds.bottom
        && pointInPolygon(point, polygon)
    for (const stroke of document.strokes) {
        const bounds = boundsOf(stroke.points)
        if (!bounds
            || bounds.right < lassoBounds.left
            || bounds.left > lassoBounds.right
            || bounds.bottom < lassoBounds.top
            || bounds.top > lassoBounds.bottom) {
            continue
        }
        const pointStride = Math.max(1, Math.floor(stroke.points.length / 600))
        let hit = false
        for (let index = 0; index < stroke.points.length; index += pointStride) {
            if (intersects(stroke.points[index]!)) {
                hit = true
                break
            }
        }
        const last = stroke.points[stroke.points.length - 1]
        if (!hit && last && intersects(last)) hit = true
        if (hit) strokeIds.add(stroke.id)
    }
    for (const shape of document.shapes) {
        if (intersects(shape.start)
            || intersects(shape.end)
            || intersects({ x: (shape.start.x + shape.end.x) / 2, y: (shape.start.y + shape.end.y) / 2 })) {
            shapeIds.add(shape.id)
        }
    }
    return { strokeIds, shapeIds }
}
