import { describe, expect, it } from 'vitest';
import { PALETTE_SIZE, accentPalette, parseOklch, toRgb } from './palette';

const CINNABAR = { l: 0.54, c: 0.15, h: 30 };

describe('the accent palette a chart draws with', () => {
    it('parses both spellings the token layer uses', () => {
        expect(parseOklch('oklch(54% 0.15 30)')).toEqual({ l: 0.54, c: 0.15, h: 30 });
        expect(parseOklch('oklch(0.54 0.15 30 / 0.6)')).toEqual({ l: 0.54, c: 0.15, h: 30 });
        expect(parseOklch('#ff0000')).toBeNull();
        expect(parseOklch('  oklch(66.5% 0.15 32)  ')).toEqual({ l: 0.665, c: 0.15, h: 32 });
    });

    it('answers sRGB hex, which is what the engine can parse', () => {
        for (const color of accentPalette(CINNABAR, PALETTE_SIZE, false))
            expect(color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('keeps every stop inside the channel edges whatever hue it is asked for', () => {
        for (const h of [0, 45, 90, 135, 180, 225, 270, 315]) {
            const hex = toRgb({ l: 0.7, c: 0.3, h });
            expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('anchors the group on the accent itself', () => {
        const [first] = accentPalette(CINNABAR, PALETTE_SIZE, false);
        expect(first).toBe(toRgb({ l: 0.54, c: 0.15, h: 30 }));
    });

    it('keeps ten series tellable apart in either theme', () => {
        for (const dark of [false, true]) {
            const palette = accentPalette(CINNABAR, PALETTE_SIZE, dark);
            expect(new Set(palette).size).toBe(PALETTE_SIZE);
        }
    });

    it('moves the whole group with the accent rather than colliding with it', () => {
        for (const accent of [{ l: 0.3, c: 0.02, h: 200 }, { l: 0.8, c: 0.16, h: 100 }]) {
            const palette = accentPalette(accent, PALETTE_SIZE, false);
            expect(new Set(palette).size).toBe(PALETTE_SIZE);
            for (const color of palette)
                expect(color).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('gives a grey accent a colour rather than a second grey', () => {
        const palette = accentPalette({ l: 0.5, c: 0, h: 0 }, PALETTE_SIZE, false);
        const chroma = palette.map((hex) => Number.parseInt(hex.slice(1, 3), 16) - Number.parseInt(hex.slice(3, 5), 16));
        expect(chroma.some((gap) => Math.abs(gap) > 8)).toBe(true);
    });
});
