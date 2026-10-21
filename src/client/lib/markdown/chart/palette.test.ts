import { describe, expect, it } from 'vitest';
import { PALETTE_SIZE, accentPalette, identityPalette, parseOklch, toRgb } from './palette';

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

describe('the identity ramp a label is tinted with', () => {
    /** Any two of these can end up as neighbouring slices, so no pairing may read as one colour. */
    const ACCENTS = [
        { l: 0.54, c: 0.15, h: 30 },
        { l: 0.52, c: 0.14, h: 252 },
        { l: 0.49, c: 0.13, h: 150 },
        { l: 0.56, c: 0.105, h: 95 },
        { l: 0.52, c: 0.16, h: 300 },
        { l: 0.38, c: 0.03, h: 250 },
    ];

    function oklab(hex: string): number[] {
        const n = Number.parseInt(hex.slice(1), 16);
        const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        const [r, g, b] = [channel(((n >> 16) & 255) / 255), channel(((n >> 8) & 255) / 255), channel((n & 255) / 255)];
        const [l, m, s] = [
            0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!,
            0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!,
            0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!,
        ].map((axis) => (axis > 0 ? Math.cbrt(axis) : 0));
        return [
            0.2104542553 * l! + 0.793617785 * m! - 0.0040720468 * s!,
            1.9779984951 * l! - 2.428592205 * m! + 0.4505937099 * s!,
            0.0259040371 * l! + 0.7827717662 * m! - 0.808675766 * s!,
        ];
    }

    it('keeps every pairing tellable apart, for every accent and in either theme', () => {
        for (const accent of ACCENTS) {
            for (const dark of [false, true]) {
                const ramp = identityPalette(accent, PALETTE_SIZE, dark);
                // Narrowing the group is allowed; collapsing it is not. A grey accent keeps the fewest —
                // four greys and one gold is what a near-colourless theme can separate — and that is the
                // honest price of choosing it, not a bug to hide by inventing chroma.
                expect(ramp.length, `too few colours for ${accent.h}`).toBeGreaterThanOrEqual(4);
                for (let i = 0; i < ramp.length; i += 1) {
                    expect(ramp[i]).toMatch(/^#[0-9a-f]{6}$/);
                    for (let j = i + 1; j < ramp.length; j += 1) {
                        const a = oklab(ramp[i]!);
                        const b = oklab(ramp[j]!);
                        const apart = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
                        expect(apart, `${ramp[i]} and ${ramp[j]} are one colour to the eye`).toBeGreaterThanOrEqual(0.12);
                    }
                }
            }
        }
    });

    it('starts on the accent, so the page and its biggest label agree', () => {
        expect(identityPalette(CINNABAR, PALETTE_SIZE, false)[0]).toBe(toRgb(CINNABAR));
    });

    it('moves with the accent rather than repeating it', () => {
        const warm = identityPalette(CINNABAR, PALETTE_SIZE, false);
        const cool = identityPalette({ l: 0.52, c: 0.14, h: 252 }, PALETTE_SIZE, false);
        expect(cool).not.toEqual(warm);
    });
});
