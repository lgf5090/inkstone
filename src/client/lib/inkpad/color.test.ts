import { describe, expect, it } from 'vitest'
import { inkColorForSvg, isSafeInkColor, normalizeInkColor } from './color'
import { isHexInkColor } from './hex-color'

describe('ink colour validation', () => {
    it('accepts hex, rgb, hsl and named colours', () => {
        for (const value of ['#fff', '#ffffff', '#ffffffcc', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(10, 20%, 30%)', 'red']) {
            expect(isSafeInkColor(value), value).toBe(true)
        }
    })

    it('rejects markup, unknown keywords and overlong values', () => {
        for (const value of ['"><script>', 'javascript:', '#fff;background:url(x)', 'x'.repeat(65), '', null, 12]) {
            expect(isSafeInkColor(value), String(value)).toBe(false)
        }
    })

    it('accepts only hex for settings', () => {
        expect(isHexInkColor('#abc')).toBe(true)
        expect(isHexInkColor('#AABBCCDD')).toBe(true)
        expect(isHexInkColor('red')).toBe(false)
        expect(isHexInkColor('rgb(1,2,3)')).toBe(false)
    })

    it('normalizes to an rgb string and gives the exporter a safe fallback', () => {
        expect(normalizeInkColor('#ffffff')).toBe('rgb(255, 255, 255)')
        expect(normalizeInkColor('not a colour')).toBeNull()
        expect(inkColorForSvg('not a colour')).toBe('#000000')
    })
})
