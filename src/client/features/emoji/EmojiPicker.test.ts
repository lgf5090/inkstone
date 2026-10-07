import { act, createElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { emojiUnicodeGroups, emojiWithTone, loadEmojiUnicode, searchEmojiUnicode } from '../../lib/emoji-unicode'
import { saveEmojiPrefs, useEmojiPreferences } from '../../lib/emoji-prefs'
import type { SkinTone } from '@shared/types'
import { renderElement } from '../../lib/test-render'
import { EmojiPicker } from './EmojiPicker'

const ROCKET = String.fromCodePoint(0x1f680)
const GRINNING = String.fromCodePoint(0x1f600)
const THUMB = String.fromCodePoint(0x1f44d)
const THUMB_MEDIUM = String.fromCodePoint(0x1f44d, 0x1f3fd)
/** huō-jiàn, rocket: the Han word the set carries for it. */
const HUO_JIAN = String.fromCodePoint(0x706b, 0x7bad)

interface Pick {
    glyph: string
    code: string | null
}

let picks: Pick[] = []
let tones: number[] = []

function mount(tone: SkinTone = 0) {
    const rendered = renderElement(createElement(EmojiPicker, {
        tone,
        onTone: (next: SkinTone) => {
            tones.push(next)
        },
        onInsert: (glyph: string, code: string | null) => {
            picks.push({ glyph, code })
        },
    }))
    return {
        container: rendered.container,
        unmount: rendered.unmount,
        input: () => rendered.container.querySelector('input[type=text]') as HTMLInputElement,
        tiles: () => [...rendered.container.querySelectorAll('[role=option]')] as HTMLButtonElement[],
        groups: () => [...rendered.container.querySelectorAll('[role=group] button')] as HTMLButtonElement[],
    }
}

function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

function keyDown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
}

function click(element: HTMLElement): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        element.click()
    })
}

beforeAll(async () => {
    await initI18n()
    await loadEmojiUnicode()
})

beforeEach(() => {
    picks = []
    tones = []
    localStorage.clear()
    saveEmojiPrefs({ recentEmojis: [] })
})

describe('the emoji picker', () => {
    it('opens on the first category with a search box that owns the keyboard', () => {
        const picker = mount()
        expect(picker.input()).not.toBeNull()
        expect(document.activeElement).toBe(picker.input())
        expect(picker.groups().length).toBe(8)
        const people = emojiUnicodeGroups().find((group) => group.id === 'people')!
        expect(picker.tiles().length).toBe(people.entries.length)
        expect(picker.tiles()[0]!.textContent).toBe(GRINNING)
        picker.unmount()
    })

    it('offers the glyph and its code when a tile is clicked', () => {
        const picker = mount()
        type(picker.input(), 'rocket')
        const tile = picker.tiles()[0]!
        expect(tile.textContent).toBe(ROCKET)
        click(tile)
        expect(picks).toEqual([{ glyph: ROCKET, code: 'rocket' }])
        picker.unmount()
    })

    it('narrows to what the query matches, in the language that was typed', () => {
        const picker = mount()
        expect(picker.tiles().length).toBeGreaterThan(100)
        type(picker.input(), 'rocket')
        expect(picker.tiles().map((tile) => tile.textContent)).toContain(ROCKET)
        expect(picker.tiles().length).toBeLessThan(20)
        type(picker.input(), HUO_JIAN)
        expect(picker.tiles().length).toBeGreaterThan(0)
        type(picker.input(), 'qqqqzzzz')
        expect(picker.tiles()).toHaveLength(0)
        expect(picker.container.textContent).toContain(t('emoji.no_match'))
        picker.unmount()
    })

    it('walks the grid with the arrows and inserts what the cursor reached', () => {
        const picker = mount()
        type(picker.input(), 'smile')
        const ranked = searchEmojiUnicode('smile')
        const first = picker.tiles()[0]!
        expect(first.textContent).toBe(emojiWithTone(ranked[0]!.entry, 0))
        expect(picker.input().getAttribute('aria-activedescendant')).toBe(first.id)
        keyDown('ArrowRight')
        expect(picker.input().getAttribute('aria-activedescendant')).toBe(picker.tiles()[1]!.id)
        keyDown('Enter')
        expect(picks).toEqual([{ glyph: picker.tiles()[1]!.textContent, code: ranked[1]!.entry.code }])
        keyDown('ArrowLeft')
        expect(picker.input().getAttribute('aria-activedescendant')).toBe(first.id)
        keyDown('Enter')
        expect(picks.length).toBe(2)
        picker.unmount()
    })

    it('does not walk past either end of the list', () => {
        const picker = mount()
        type(picker.input(), 'rocket')
        keyDown('ArrowUp')
        keyDown('ArrowLeft')
        expect(picker.input().getAttribute('aria-activedescendant')).toBe(picker.tiles()[0]!.id)
        for (let index = 0; index < 30; index++)
            keyDown('ArrowDown')
        const last = picker.tiles().length - 1
        expect(Number(picker.input().getAttribute('aria-activedescendant')!.split('-').at(-1))).toBeLessThanOrEqual(last)
        picker.unmount()
    })

    it('moves between categories with the rail and with PageUp and PageDown', () => {
        const picker = mount()
        const flags = picker.groups()[7]!
        expect(flags.getAttribute('aria-pressed')).toBe('false')
        click(flags)
        expect(flags.getAttribute('aria-pressed')).toBe('true')
        expect(picker.tiles().length).toBe(269)
        keyDown('PageUp')
        expect(picker.groups()[6]!.getAttribute('aria-pressed')).toBe('true')
        picker.unmount()
    })

    it('applies the skin tone to the tiles it draws and to what it hands back', () => {
        const picker = mount(3)
        type(picker.input(), '+1')
        const tile = picker.tiles().find((entry) => entry.textContent === THUMB || entry.textContent === THUMB_MEDIUM)!
        expect(tile.textContent).toBe(THUMB_MEDIUM)
        click(tile)
        expect(picks).toEqual([{ glyph: THUMB_MEDIUM, code: '+1' }])
        picker.unmount()
    })

    it('lets the reader change the tone from inside the picker', () => {
        const picker = mount()
        const toneButton = picker.container.querySelector('button[aria-haspopup=true]') as HTMLButtonElement
        click(toneButton)
        const strip = picker.container.querySelector(`[role=group][aria-label="${t('emoji.skin_tone')}"]`)
        expect(strip, 'the tone strip opens inside the panel, not in a portal it would click out of').not.toBeNull()
        const rows = [...strip!.querySelectorAll('button')]
        expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
            t('emoji.tone.default'), t('emoji.tone.light'), t('emoji.tone.medium_light'),
            t('emoji.tone.medium'), t('emoji.tone.medium_dark'), t('emoji.tone.dark'),
        ])
        expect(rows[0]!.getAttribute('aria-pressed')).toBe('true')
        click(rows[3]!)
        expect(tones).toEqual([3])
        expect(picker.container.querySelector(`[role=group][aria-label="${t('emoji.skin_tone')}"]`)).toBeNull()
        picker.unmount()
    })

    it('shows the row of recent picks once something has been picked', () => {
        saveEmojiPrefs({ recentEmojis: [ROCKET] })
        const picker = mount()
        const rail = picker.groups()
        expect(rail.length).toBe(9)
        expect(rail[0]!.getAttribute('aria-pressed')).toBe('true')
        expect(picker.tiles().map((tile) => tile.textContent)).toEqual([ROCKET])
        keyDown('Enter')
        expect(picks).toEqual([{ glyph: ROCKET, code: 'rocket' }])
        picker.unmount()
    })

    it('names a recent row from the set even when it was stored with a tone', () => {
        saveEmojiPrefs({ recentEmojis: [THUMB_MEDIUM] })
        const picker = mount()
        const tile = picker.tiles()[0]!
        expect(tile.getAttribute('aria-label')).toBeTruthy()
        expect(tile.textContent).toBe(THUMB_MEDIUM)
        picker.unmount()
    })

    it('keeps its own store of recents in step while it is open', () => {
        const seen: number[] = []
        const Watcher = () => {
            const { recentEmojis } = useEmojiPreferences()
            seen.push(recentEmojis.length)
            return null
        }
        const rendered = renderElement(createElement(Watcher))
        act(() => {
            saveEmojiPrefs({ recentEmojis: [ROCKET] })
        })
        expect(seen.at(-1)).toBe(1)
        rendered.unmount()
    })
})
