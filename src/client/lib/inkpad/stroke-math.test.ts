import { describe, expect, it } from 'vitest'
import type { InkPoint } from './types'
import {
    canAcceptPoint,
    filterPressure,
    strokeAlpha,
    strokeBaseWidth,
    strokeSvgPath,
    strokeWidthAt,
    traceSmoothPath,
} from './stroke-math'

function point(x: number, y: number): InkPoint {
    return { x, y, p: 0.5, t: 0 }
}

describe('stroke widths', () => {
    it('applies the reference multipliers', () => {
        expect(strokeBaseWidth('pen', 3)).toBe(3)
        expect(strokeBaseWidth('pencil', 3)).toBeCloseTo(2.46)
        expect(strokeBaseWidth('marker', 3)).toBeCloseTo(5.1)
        expect(strokeBaseWidth('highlighter', 3)).toBe(12)
    })

    it('follows the three pressure responses', () => {
        expect(strokeWidthAt('pen', 10, 0.2, 'fixed')).toBe(10)
        expect(strokeWidthAt('pen', 10, 0.2, 'subtle')).toBeCloseTo(8.88)
        expect(strokeWidthAt('pen', 10, 0.9, 'subtle')).toBeCloseTo(9.86)
        expect(strokeWidthAt('pen', 10, 0.2, 'natural')).toBeCloseTo(6.96)
        expect(strokeWidthAt('pencil', 10, 0.9, 'natural')).toBeCloseTo(7.831)
    })

    it('maps tool alpha', () => {
        expect(strokeAlpha('highlighter')).toBe(0.32)
        expect(strokeAlpha('pencil')).toBe(0.78)
        expect(strokeAlpha('pen')).toBe(1)
    })
})

describe('pressure and sampling', () => {
    it('low-passes pressure around the previous sample', () => {
        expect(filterPressure(undefined, 0.8)).toBe(0.8)
        expect(filterPressure(0.5, 0.9)).toBeCloseTo(0.572)
        expect(filterPressure(0.5, 0.01)).toBeCloseTo(0.446)
    })

    it('keeps only points that moved enough for the zoom', () => {
        expect(canAcceptPoint(undefined, point(0, 0), 1)).toBe(true)
        expect(canAcceptPoint(point(0, 0), point(0.1, 0), 1)).toBe(false)
        expect(canAcceptPoint(point(0, 0), point(0.1, 0), 2)).toBe(true)
    })
})

describe('path building', () => {
    it('traces one midpoint quadratic per inner point', () => {
        const calls: string[] = []
        traceSmoothPath({
            moveTo: (x, y) => calls.push(`M ${x} ${y}`),
            lineTo: (x, y) => calls.push(`L ${x} ${y}`),
            quadraticCurveTo: (cx, cy, x, y) => calls.push(`Q ${cx} ${cy} ${x} ${y}`),
        }, [point(0, 0), point(1, 1), point(2, 2), point(3, 3)])
        expect(calls).toEqual(['M 0 0', 'Q 1 1 1.5 1.5', 'Q 2 2 2.5 2.5', 'L 3 3'])
    })

    it('writes the same midpoint geometry as an SVG path', () => {
        expect(strokeSvgPath([point(0, 0), point(1, 1), point(2, 2)])).toBe('M 0 0 Q 1 1 1.5 1.5 L 2 2')
        expect(strokeSvgPath([point(0, 0)])).toBe('M 0 0')
        expect(strokeSvgPath([])).toBe('')
    })
})
