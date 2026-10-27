import { describe, expect, it } from 'vitest'
import type { InkDocument, InkPoint } from './types'
import {
    boundsOf,
    contentBounds,
    inkBounds,
    mergeBounds,
    pointInPolygon,
    selectLasso,
    selectionBounds,
} from './geometry'

function point(x: number, y: number): InkPoint {
    return { x, y, p: 0.5, t: 0 }
}

function document(overrides: Partial<InkDocument> = {}): InkDocument {
    return { format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [], ...overrides }
}

const square = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)]

describe('bounds', () => {
    it('returns null for nothing and the box for points', () => {
        expect(boundsOf([])).toBeNull()
        expect(boundsOf([point(2, 3), point(-1, 8)])).toEqual({ left: -1, top: 3, right: 2, bottom: 8 })
    })

    it('merges two boxes', () => {
        expect(mergeBounds({ left: 0, top: 0, right: 1, bottom: 1 }, { left: -2, top: 3, right: 0, bottom: 4 }))
            .toEqual({ left: -2, top: 0, right: 1, bottom: 4 })
        expect(mergeBounds(null, null)).toBeNull()
    })

    it('sizes content that contains a card', () => {
        const doc = document({
            strokes: [{ id: 's', tool: 'pen', color: '#000', width: 1, points: [point(0, 0), point(20, 10)] }],
            elements: [{ id: 'e', kind: 'text', path: '', text: 'x', x: 30, y: 40, width: 100, height: 50 }],
        })
        expect(contentBounds(doc)).toEqual({ left: 0, top: 0, width: 130, height: 90 })
        expect(contentBounds(doc, false)).toEqual({ left: 0, top: 0, width: 20, height: 10 })
    })

    it('pads the ink-only box and keeps an empty drawing valid', () => {
        const doc = document({ shapes: [{ id: 'r', type: 'rectangle', color: '#000', width: 1, start: { x: 10, y: 20 }, end: { x: 30, y: 40 } }] })
        expect(inkBounds(doc, 5)).toEqual({ left: 5, top: 15, width: 30, height: 30 })
        expect(inkBounds(document(), 5)).toEqual({ left: 0, top: 0, width: 1, height: 1 })
    })
})

describe('lasso selection', () => {
    it('recognises a point inside and outside a polygon', () => {
        expect(pointInPolygon(point(5, 5), square)).toBe(true)
        expect(pointInPolygon(point(15, 5), square)).toBe(false)
    })

    it('selects strokes and shapes whose samples fall inside', () => {
        const inside = { id: 'in', tool: 'pen' as const, color: '#000', width: 1, points: [point(1, 1), point(2, 2)] }
        const outside = { id: 'out', tool: 'pen' as const, color: '#000', width: 1, points: [point(30, 30), point(31, 31)] }
        const shape = { id: 'r', type: 'rectangle' as const, color: '#000', width: 1, start: { x: 1, y: 1 }, end: { x: 9, y: 9 } }
        const result = selectLasso(document({ strokes: [inside, outside], shapes: [shape] }), [...square, point(0, 0)])
        expect([...result.strokeIds]).toEqual(['in'])
        expect([...result.shapeIds]).toEqual(['r'])
    })

    it('returns nothing for a degenerate lasso', () => {
        expect(selectLasso(document({ strokes: [{ id: 's', tool: 'pen', color: '#000', width: 1, points: [point(1, 1)] }] }), [point(0, 0)]))
            .toEqual({ strokeIds: new Set(), shapeIds: new Set() })
    })

    it('bounds a selection from both collections', () => {
        const doc = document({
            strokes: [{ id: 's', tool: 'pen', color: '#000', width: 1, points: [point(0, 0), point(2, 2)] }],
            shapes: [{ id: 'r', type: 'rectangle', color: '#000', width: 1, start: { x: 5, y: 5 }, end: { x: 9, y: 9 } }],
        })
        expect(selectionBounds(doc, new Set(['s']), new Set(['r']))).toEqual({ left: 0, top: 0, right: 9, bottom: 9 })
        expect(selectionBounds(doc, new Set(), new Set())).toBeNull()
    })
})
