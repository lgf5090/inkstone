import { describe, expect, it } from 'vitest'
import { buildInkSvg } from './svg-export'
import type { InkDocument } from './types'

function document(overrides: Partial<InkDocument> = {}): InkDocument {
    return { format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [], ...overrides }
}

function parse(svg: string): Document {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    return doc
}

describe('buildInkSvg', () => {
    it('pads the viewBox and exports a stroke with tool opacity', () => {
        const svg = buildInkSvg(document({
            strokes: [
                { id: 'p', tool: 'pencil', color: '#ffffff', width: 3, points: [{ x: 0, y: 0, p: 0.5, t: 0 }, { x: 10, y: 10, p: 0.5, t: 1 }] },
                { id: 'h', tool: 'highlighter', color: '#ff0', width: 3, points: [{ x: 0, y: 0, p: 0.5, t: 0 }, { x: 10, y: 0, p: 0.5, t: 1 }] },
            ],
        }))
        const doc = parse(svg)
        expect(doc.documentElement.getAttribute('viewBox')).toBe('-24 -24 58 58')
        const paths = doc.querySelectorAll('path')
        expect(paths).toHaveLength(2)
        expect(paths[0]!.getAttribute('opacity')).toBe('0.78')
        expect(paths[1]!.getAttribute('opacity')).toBe('0.32')
        expect(paths[0]!.getAttribute('stroke')).toBe('rgb(255, 255, 255)')
    })

    it('exports rectangles, ellipses, lines and arrow heads', () => {
        const svg = buildInkSvg(document({
            shapes: [
                { id: 'r', type: 'rectangle', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 20 } },
                { id: 'e', type: 'ellipse', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 20 } },
                { id: 'l', type: 'line', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
                { id: 'a', type: 'arrow', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
            ],
        }))
        const doc = parse(svg)
        expect(doc.querySelectorAll('rect')).toHaveLength(1)
        expect(doc.querySelectorAll('ellipse')).toHaveLength(1)
        expect(doc.querySelectorAll('line')).toHaveLength(4)
    })

    it('normalizes an unsafe colour instead of copying it into an attribute', () => {
        const svg = buildInkSvg(document({
            strokes: [{ id: 's', tool: 'pen', color: '"><script>alert(1)</script>', width: 1, points: [{ x: 0, y: 0, p: 0.5, t: 0 }] }],
        }))
        expect(svg).not.toContain('<script')
        expect(svg).toContain('stroke="#000000"')
    })

    it('always returns a parsable document, even when empty', () => {
        const doc = parse(buildInkSvg(document()))
        expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 1 1')
        expect(doc.querySelectorAll('path, rect, ellipse, line')).toHaveLength(0)
    })
})
