import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EMOJI_PREFS_STORAGE_KEY,
    RECENT_EMOJI_LIMIT,
    clearRecentEmojis,
    loadEmojiPrefs,
    pushRecentEmoji,
    saveEmojiPrefs,
} from './emoji-prefs'

const A = String.fromCodePoint(0x1f600)
const B = String.fromCodePoint(0x1f680)
const C = String.fromCodePoint(0x2764, 0xfe0f)
const TONED = String.fromCodePoint(0x1f44d, 0x1f3fd)

function stored(value: unknown): void {
    localStorage.setItem(EMOJI_PREFS_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value))
}

function read(): string[] {
    return loadEmojiPrefs().recentEmojis
}

beforeEach(() => {
    localStorage.clear()
    saveEmojiPrefs({ recentEmojis: [] })
})

describe('recent emoji preferences', () => {
    it('starts empty when nothing is stored', () => {
        expect(loadEmojiPrefs(null)).toEqual({ recentEmojis: [] })
        expect(read()).toEqual([])
    })

    it('survives a storage value that is not the shape it wrote', () => {
        for (const junk of ['', 'not json', '[]', 'null', '42', '{"recentEmojis":"nope"}', '{"recentEmojis":[1,2,null]}']) {
            stored(junk)
            expect(read(), junk).toEqual([])
        }
    })

    it('keeps only plausible glyphs, in order and without repeats', () => {
        stored({ recentEmojis: [A, A, B, '', 'x'.repeat(40), String.fromCodePoint(0x01), C] })
        expect(read()).toEqual([A, B, C])
    })

    it('caps what a hand-edited storage key can put in the row', () => {
        stored({ recentEmojis: Array.from({ length: 400 }, (_, index) => String.fromCodePoint(0x1f600 + (index % 40))) })
        expect(read().length).toBe(RECENT_EMOJI_LIMIT)
    })
})

describe('pushing a pick', () => {
    it('puts the newest first and never grows past the cap', () => {
        for (const glyph of [A, B, C])
            pushRecentEmoji(glyph)
        expect(read()).toEqual([C, B, A])
        for (let index = 0; index < RECENT_EMOJI_LIMIT + 5; index++)
            pushRecentEmoji(String.fromCodePoint(0x1f680 + index))
        expect(read().length).toBe(RECENT_EMOJI_LIMIT)
    })

    it('moves a repeat to the front instead of listing it twice', () => {
        pushRecentEmoji(A)
        pushRecentEmoji(B)
        pushRecentEmoji(A)
        expect(read()).toEqual([A, B])
    })

    it('refuses a glyph it would not have drawn', () => {
        pushRecentEmoji('')
        pushRecentEmoji('plain text')
        expect(read()).toEqual([])
    })

    it('keeps the keycaps and flags, which are spelled with digits and symbols', () => {
        pushRecentEmoji(String.fromCodePoint(0x31, 0xfe0f, 0x20e3))
        pushRecentEmoji(String.fromCodePoint(0x1f1e6, 0x1f1fa))
        expect(read()).toEqual(['🇦🇺', '1️⃣'])
    })

    it('writes nothing when the front of the row already is that pick', () => {
        pushRecentEmoji(A)
        const setItem = vi.spyOn(Storage.prototype, 'setItem')
        pushRecentEmoji(A)
        expect(setItem).not.toHaveBeenCalled()
        pushRecentEmoji(B)
        expect(setItem).toHaveBeenCalledTimes(1)
        setItem.mockRestore()
    })

    it('clears the row, and a clear of an empty row is not a write', () => {
        pushRecentEmoji(A)
        clearRecentEmojis()
        expect(read()).toEqual([])
        const setItem = vi.spyOn(Storage.prototype, 'setItem')
        clearRecentEmojis()
        expect(setItem).not.toHaveBeenCalled()
        setItem.mockRestore()
    })

    it('keeps a toned pick as its own entry', () => {
        pushRecentEmoji(TONED)
        pushRecentEmoji(String.fromCodePoint(0x1f44d))
        expect(read()).toEqual(['👍', TONED])
    })
})
