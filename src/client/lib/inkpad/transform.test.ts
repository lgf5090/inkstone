import { describe, expect, it } from 'vitest'
import { clampZoom, frameTransform, pinchTransform, resetZoomTransform, toWorldPoint, zoomAt } from './transform'

const rect = { left: 10, top: 20, width: 800, height: 600 }

describe('world coordinates', () => {
    it('undoes translation and zoom with the canvas offset', () => {
        expect(toWorldPoint(110, 220, rect, { x: 10, y: 20, zoom: 2 })).toEqual({ x: 45, y: 90 })
    })

    it('keeps the world point under the pointer while zooming', () => {
        const transform = { x: 30, y: 40, zoom: 1.25 }
        const before = toWorldPoint(400, 300, rect, transform)
        const next = zoomAt(transform, { x: 400, y: 300 }, 1.8, rect)
        const after = toWorldPoint(400, 300, rect, next)
        expect(after.x).toBeCloseTo(before.x)
        expect(after.y).toBeCloseTo(before.y)
        expect(next.zoom).toBeCloseTo(2.25)
    })

    it('clamps both zoom paths', () => {
        expect(clampZoom(0.01)).toBe(0.15)
        expect(clampZoom(99)).toBe(6)
        expect(zoomAt({ x: 0, y: 0, zoom: 5 }, { x: 0, y: 0 }, 99, rect).zoom).toBe(6)
    })
})

describe('pinch', () => {
    it('keeps the pinch centre anchored', () => {
        const start = { distance: 100, centerX: 410, centerY: 320, transform: { x: 0, y: 0, zoom: 1 } }
        const next = pinchTransform(start, { x: 310, y: 320 }, { x: 510, y: 320 }, rect)
        expect(next.zoom).toBeCloseTo(2)
        const before = toWorldPoint(410, 320, rect, start.transform)
        const after = toWorldPoint(410, 320, rect, next)
        expect(after.x).toBeCloseTo(before.x)
        expect(after.y).toBeCloseTo(before.y)
    })

    it('leaves the transform alone for a zero distance', () => {
        const start = { distance: 0, centerX: 1, centerY: 1, transform: { x: 5, y: 6, zoom: 1 } }
        expect(pinchTransform(start, { x: 0, y: 0 }, { x: 0, y: 0 }, rect)).toEqual(start.transform)
    })
})

describe('framing', () => {
    it('centres content with the requested padding', () => {
        const next = frameTransform({ left: 100, top: 200, width: 100, height: 100 }, rect, 56)
        expect(next.zoom).toBe(3)
        expect(next.x).toBeCloseTo((800 - 300) / 2 - 100 * 3)
        expect(next.y).toBeCloseTo((600 - 300) / 2 - 200 * 3)
    })

    it('resets to 100% around the viewport centre', () => {
        const next = resetZoomTransform({ x: 0, y: 0, zoom: 2 }, rect)
        expect(next.zoom).toBe(1)
        const centre = toWorldPoint(410, 320, rect, { x: 0, y: 0, zoom: 2 })
        expect(toWorldPoint(410, 320, rect, next)).toEqual(centre)
    })
})
