import { describe, expect, it } from 'vitest';
import { EN_US_MESSAGES } from './locales/en-US';
import { ZH_CN_MESSAGES } from './locales/zh-CN';
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants';

/**
 * Each renderer switch is reached by its own accessible label, and a switch is found by name by a screen
 * reader and by a browser driver alike. `settings.diagram` already carried the same two-character word
 * for "chart" in Chinese that a naive `settings.chart` would, which gave two adjacent switches one name:
 * the panel then toggled the wrong one while looking correct. That is how this came to be checked at all.
 */
describe('the preview renderer switches are tellable apart', () => {
    const RENDERER_KEYS = ['settings.math', 'settings.diagram', 'settings.chart'] as const;

    for (const [name, catalog] of [['en-US', EN_US_MESSAGES], ['zh-CN', ZH_CN_MESSAGES]] as const) {
        it(`gives each switch a distinct label in ${name}`, () => {
            const labels = RENDERER_KEYS.map((key) => String(catalog[key]));
            expect(labels.every(Boolean)).toBe(true);
            expect(new Set(labels).size).toBe(RENDERER_KEYS.length);
            console.log(`${name}: ${RENDERER_KEYS.map((k, i) => `${k}=${labels[i]}`).join('  ')}`);
        });
    }
});

/**
 * A stored settings object is older than any given key, so every renderer switch has to arrive through
 * `mergeSettings` rather than be read off the JSON: a stored `preview` that predates `chart` must come
 * back as the default, not as `undefined` coerced to "off" — that would silently stop drawing charts for
 * every account that existed before the switch shipped, with nothing wrong in the note.
 */
describe('the chart renderer switch survives an older stored settings object', () => {
    it('defaults to on for a stored preview that predates the key', () => {
        expect(DEFAULT_SETTINGS.preview.chart).toBe(true);
        expect(mergeSettings({}).preview.chart).toBe(true);
        expect(mergeSettings({ preview: { math: true, mermaid: true } }).preview.chart).toBe(true);
        expect(mergeSettings({ preview: { layout: 'split', codeBlockCollapseLines: 40 } }).preview.chart).toBe(true);
    });

    it('keeps an explicit choice either way, and refuses a non-boolean', () => {
        expect(mergeSettings({ preview: { chart: false } }).preview.chart).toBe(false);
        expect(mergeSettings({ preview: { chart: true } }).preview.chart).toBe(true);
        expect(mergeSettings({ preview: { chart: 'no' } }).preview.chart).toBe(true);
        expect(mergeSettings({ preview: { chart: null } }).preview.chart).toBe(true);
    });

    it('is not disturbed by a patch that touches another section', () => {
        const stored = mergeSettings({ preview: { chart: false } });
        expect(mergeSettingsPatch(stored, { editor: { fontSize: 17 } }).preview.chart).toBe(false);
        expect(mergeSettingsPatch(stored, { appearance: { accent: 'indigo' } }).preview.chart).toBe(false);
        expect(mergeSettingsPatch(stored, { preview: { chart: true } }).preview.chart).toBe(true);
    });

    it('leaves the neighbouring renderer switches alone', () => {
        const merged = mergeSettings({ preview: { chart: false } });
        expect(merged.preview).toMatchObject({ math: true, mermaid: true, chart: false });
    });
});
