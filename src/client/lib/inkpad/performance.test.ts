import { describe, expect, it } from 'vitest'
import { parseInkDocument, serializeInkDocument } from './format'
import type { InkDocument } from './types'

describe('lecture-sized documents', () => {
    it('serializes and parses 30k points inside the budget', () => {
        const points = Array.from({ length: 30_000 }, (_, index) => ({
            x: index % 900,
            y: Math.floor(index / 900),
            p: 0.5,
            t: index,
        }))
        const document: InkDocument = {
            format: 'inkpad',
            version: 1,
            strokes: [{ id: 'benchmark', tool: 'pen', color: '#ffffff', width: 3, points }],
            shapes: [],
            elements: [],
            viewport: { x: 0, y: 0, zoom: 1 },
        }
        const start = performance.now()
        const encoded = serializeInkDocument(document)
        const decoded = parseInkDocument(encoded)
        const elapsed = performance.now() - start
        expect(decoded.strokes[0]?.points).toHaveLength(points.length)
        expect(elapsed).toBeLessThan(1_500)
    })
})
