import { describe, expect, it } from 'vitest';
import { ICON_MAX_CODE_UNITS, isUsableIconGlyph, searchEmojiIn } from './emoji-catalog-core';
import { pinyinKeysOf, preloadPinyin } from './pinyin';
import { loadEmojiCatalog } from './emoji-catalog';
import { EMOJI_ICON_CATEGORIES, EMOJI_ICON_ENTRIES } from './emoji-catalog-data';

const searchEmoji = (query: string, limit?: number) => searchEmojiIn(EMOJI_ICON_ENTRIES, query, limit);

const ALL = EMOJI_ICON_CATEGORIES.flatMap((category) => category.entries.map((entry) => ({ ...entry, category: category.id })));

describe('emoji icon catalog', () => {
    it('covers the categories a library organiser looks for', () => {
        expect(EMOJI_ICON_CATEGORIES.map((category) => category.id)).toEqual([
            'documents',
            'development',
            'languages',
            'work',
            'travel',
            'shopping',
            'people',
            'learning',
            'nature',
            'food',
            'status',
            'symbols',
        ]);
        for (const category of EMOJI_ICON_CATEGORIES)
            expect(category.entries.length, category.id).toBeGreaterThanOrEqual(20);
    });

    it('stores every glyph inside the icon budget the backend truncates to', () => {
        for (const entry of ALL) {
            expect(entry.char.length, entry.char).toBeLessThanOrEqual(ICON_MAX_CODE_UNITS);
            expect(entry.char.length, entry.char).toBeGreaterThan(0);
            expect(entry.char.includes('\u200d'), entry.char).toBe(false);
            expect(isUsableIconGlyph(entry.char), entry.char).toBe(true);
        }
        expect(ICON_MAX_CODE_UNITS).toBe(8);
    });

    it('keeps one home per glyph so the grid never repeats a tile', () => {
        const seen = new Map<string, string>();
        for (const entry of ALL) {
            expect(seen.has(entry.char), `${entry.char} also in ${seen.get(entry.char)}`).toBe(false);
            seen.set(entry.char, entry.category);
        }
        expect(seen.size).toBe(ALL.length);
    });

    it('gives every glyph latin and chinese search terms', () => {
        for (const entry of ALL) {
            const words = entry.keys.split(' ');
            expect(words.some((word) => /^[a-z0-9]+$/.test(word)), entry.char).toBe(true);
            expect(words.some((word) => /[\u4e00-\u9fff]/.test(word)), entry.char).toBe(true);
            expect(entry.keys, entry.char).toBe(entry.keys.trim());
            expect(entry.keys.includes('  '), entry.char).toBe(false);
        }
    });

    it('finds a language by its community animal', () => {
        expect(searchEmoji('python')[0]?.char).toBe('🐍');
        expect(searchEmoji('rust')[0]?.char).toBe('🦀');
        expect(searchEmoji('docker')[0]?.char).toBe('🐳');
    });

    it('matches chinese keywords and multi-word queries', () => {
        expect(searchEmoji('文件夹').some((entry) => entry.char === '📁')).toBe(true);
        expect(searchEmoji('红 点').some((entry) => entry.char === '🔴')).toBe(true);
        expect(searchEmoji('plane 飞机').some((entry) => entry.char === '✈️')).toBe(true);
    });

    it('tolerates a misspelled keyword through a subsequence match', () => {
        expect(searchEmoji('fldr').some((entry) => entry.char === '📁')).toBe(true);
    });

    it('ranks an exact glyph ahead of keyword hits', () => {
        expect(searchEmoji('📁')[0]?.char).toBe('📁');
    });

    it('returns nothing for a blank or impossible query and never more than the cap', () => {
        expect(searchEmoji('   ')).toEqual([]);
        expect(searchEmoji('zzzqqqxxx')).toEqual([]);
        expect(searchEmoji('a').length).toBeLessThanOrEqual(60);
    });

    it('loads the whole library on demand and hands back the same module', async () => {
        const first = await loadEmojiCatalog();
        const second = await loadEmojiCatalog();
        expect(second).toBe(first);
        expect(first.EMOJI_ICON_CATEGORIES).toBe(EMOJI_ICON_CATEGORIES);
        expect(first.EMOJI_ICON_ENTRIES).toHaveLength(515);
    });
    it('answers a pinyin query once the dictionary has landed', async () => {
        await preloadPinyin();
        const reading = pinyinKeysOf('文件夹');
        expect(reading, 'the dictionary should read a two-character label').not.toBeNull();
        expect(searchEmoji(reading!.initials).some((entry) => entry.char === '📁')).toBe(true);
        expect(searchEmoji(reading!.full).some((entry) => entry.char === '📁')).toBe(true);
    });
    it('rejects glyphs the store would truncate', () => {
        expect(isUsableIconGlyph(String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467))).toBe(false);
        expect(isUsableIconGlyph('👨‍👩‍👧')).toBe(false);
        expect(isUsableIconGlyph('123456789')).toBe(false);
        expect(isUsableIconGlyph('🛠️')).toBe(true);
    });
});
