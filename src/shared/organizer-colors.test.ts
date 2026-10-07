import { describe, expect, it } from 'vitest';
import { ORGANIZER_COLORS, isCustomOrganizerColor, isOrganizerColorVisible, organizerColorContrast, organizerColorLabel, organizerColorOrNull } from './organizer-colors';

describe('organizer colours', () => {
    it('keeps every preset named in both languages', () => {
        for (const value of ORGANIZER_COLORS) {
            const label = organizerColorLabel(value, (key) => key);
            expect(label, value).toMatch(/^color\./);
        }
    });

    it('accepts a six-digit hex as a custom colour and normalises it', () => {
        expect(organizerColorOrNull('#1A2B3C')).toBe('#1a2b3c');
        expect(isCustomOrganizerColor('#1a2b3c')).toBe(true);
        expect(isCustomOrganizerColor('#dc2626')).toBe(false);
        expect(organizerColorLabel('#1a2B3C', (key) => key)).toBe('color.custom #1a2b3c');
    });

    it('refuses anything that is not a plain colour', () => {
        for (const hostile of ['red; color:blue', 'url(https://evil)', '#12', '#1234567890', 'background:var(--x)', '', null, 7])
            expect(organizerColorOrNull(hostile as string | null | number), String(hostile)).toBeNull();
    });

    it('measures contrast against the answers WCAG publishes', () => {
        expect(organizerColorContrast('#000000', '#ffffff')?.toFixed(2)).toBe('21.00');
        expect(organizerColorContrast('#ffffff', '#ffffff')?.toFixed(2)).toBe('1.00');
        expect(organizerColorContrast('#7f7f7f', '#ffffff')?.toFixed(1)).toBe('4.0');
        expect(organizerColorContrast('#767676', '#ffffff')?.toFixed(2)).toBe('4.54');
    });

    it('reads the surfaces the theme actually paints with', () => {
        expect(organizerColorContrast('#000000', 'oklch(1 0 0)')?.toFixed(2)).toBe('21.00');
        expect(organizerColorContrast('#000000', 'oklch(100% 0 0)')?.toFixed(2)).toBe('21.00');
        expect(organizerColorContrast('#000000', 'rgb(255, 255, 255)')?.toFixed(2)).toBe('21.00');
        expect(organizerColorContrast('#059669', 'transparent')).toBeNull();
        expect(organizerColorContrast('#059669', 'rgba(0, 0, 0, 0)')).toBeNull();
    });

    it('blocks a colour that would vanish into its surface and allows an unknown one', () => {
        expect(isOrganizerColorVisible('#f4f4f5', '#ffffff')).toBe(false);
        expect(isOrganizerColorVisible('#059669', '#ffffff')).toBe(true);
        expect(isOrganizerColorVisible('#059669', 'var(--bg-overlay)')).toBe(true);
    });
});
