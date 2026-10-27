import { describe, expect, it } from 'vitest'
import { pdfPagePixelRatio } from './ink-pdf'

describe('pdfPagePixelRatio', () => {
    it('uses a readable 1.5× cap for a single preview page', () => {
        expect(pdfPagePixelRatio(600, 800, 1, false, 10, 2)).toBe(1.5)
    })

    it('shrinks a multi-page preview to its total pixel budget', () => {
        expect(pdfPagePixelRatio(600, 800, 1, true, 10, 2)).toBeCloseTo(0.8)
        expect(pdfPagePixelRatio(2000, 3000, 1, true, 30, 2)).toBeLessThan(0.8)
    })

    it('never returns zero or a negative ratio', () => {
        expect(pdfPagePixelRatio(0, 0, 0, true, 100, 0)).toBeGreaterThan(0)
    })
})
