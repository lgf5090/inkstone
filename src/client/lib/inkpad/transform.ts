import type { InkViewport } from './types'

export type InkTransform = InkViewport

export interface InkRect {
    left: number
    top: number
    width: number
    height: number
}

export interface InkPointLike {
    x: number
    y: number
}

export const MIN_ZOOM = 0.15
export const MAX_ZOOM = 6

export function clampZoom(zoom: number): number {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function toWorldPoint(clientX: number, clientY: number, rect: Pick<InkRect, 'left' | 'top'>, transform: InkTransform): InkPointLike {
    return {
        x: (clientX - rect.left - transform.x) / transform.zoom,
        y: (clientY - rect.top - transform.y) / transform.zoom,
    }
}

export function zoomAt(transform: InkTransform, pointer: InkPointLike, factor: number, rect: Pick<InkRect, 'left' | 'top'>): InkTransform {
    const zoom = clampZoom(transform.zoom * factor)
    const x = pointer.x - rect.left
    const y = pointer.y - rect.top
    return {
        x: x - (x - transform.x) * (zoom / transform.zoom),
        y: y - (y - transform.y) * (zoom / transform.zoom),
        zoom,
    }
}

export interface InkPinchStart {
    distance: number
    centerX: number
    centerY: number
    transform: InkTransform
}

export function pinchTransform(
    start: InkPinchStart,
    first: InkPointLike,
    second: InkPointLike,
    rect: Pick<InkRect, 'left' | 'top'>,
): InkTransform {
    const distance = Math.hypot(second.x - first.x, second.y - first.y)
    if (!distance || !start.distance) return start.transform
    const zoom = clampZoom(start.transform.zoom * (distance / start.distance))
    const centerX = (first.x + second.x) / 2 - rect.left
    const centerY = (first.y + second.y) / 2 - rect.top
    const initialX = start.centerX - rect.left
    const initialY = start.centerY - rect.top
    const worldX = (initialX - start.transform.x) / start.transform.zoom
    const worldY = (initialY - start.transform.y) / start.transform.zoom
    return { x: centerX - worldX * zoom, y: centerY - worldY * zoom, zoom }
}

export function frameTransform(
    bounds: { left: number; top: number; width: number; height: number },
    rect: InkRect,
    padding = 56,
): InkTransform {
    const availableWidth = Math.max(1, rect.width - padding * 2)
    const availableHeight = Math.max(1, rect.height - padding * 2)
    const zoom = Math.min(3, Math.max(MIN_ZOOM, Math.min(availableWidth / bounds.width, availableHeight / bounds.height)))
    return {
        x: (rect.width - bounds.width * zoom) / 2 - bounds.left * zoom,
        y: (rect.height - bounds.height * zoom) / 2 - bounds.top * zoom,
        zoom,
    }
}

/** 100% around the current viewport centre, without moving the document location. */
export function resetZoomTransform(transform: InkTransform, rect: InkRect): InkTransform {
    const worldX = (rect.width / 2 - transform.x) / transform.zoom
    const worldY = (rect.height / 2 - transform.y) / transform.zoom
    return { x: rect.width / 2 - worldX, y: rect.height / 2 - worldY, zoom: 1 }
}
