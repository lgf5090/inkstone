import { act, createElement } from 'react'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/constants'
import { initI18n, t } from '../../lib/i18n'
import { loadEmojiUnicode } from '../../lib/emoji-unicode'
import { saveEmojiPrefs } from '../../lib/emoji-prefs'
import { setActiveEditorView } from '../../editor/commands'
import { useSession } from '../../store/session'
import { closeEmojiPicker, openEmojiPicker, useEmojiPicker } from '../../store/emoji-picker'
import { renderElement } from '../../lib/test-render'
import { EmojiPickerHost } from './EmojiPickerHost'

const ROCKET = String.fromCodePoint(0x1f680)

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
    if (!proto.getClientRects)
        proto.getClientRects = () => [] as unknown as DOMRectList
}

let rendered: ReturnType<typeof renderElement>
let editorHost: HTMLElement
let view: EditorView

function setEditor(patch: Record<string, unknown>): void {
    useSession.setState({ settings: mergeSettings({ editor: patch }) })
}

function mountEditor(doc: string): void {
    editorHost = document.createElement('div')
    document.body.append(editorHost)
    view = new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) }), parent: editorHost })
    setActiveEditorView(view)
}

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve())
        })
        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0)
        })
    })
}

function tiles(): HTMLButtonElement[] {
    return [...document.querySelectorAll('[role=option]')] as HTMLButtonElement[]
}

async function pick(code: string): Promise<void> {
    const input = document.querySelector('input[type=text]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
        setter.call(input, code)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const tile = tiles().find((entry) => entry.getAttribute('aria-label') && entry.textContent === ROCKET)!
    await act(async () => {
        tile.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        tile.click()
    })
    await settle()
}

beforeAll(async () => {
    await initI18n()
    await loadEmojiUnicode()
})

beforeEach(() => {
    localStorage.clear()
    saveEmojiPrefs({ recentEmojis: [] })
    setEditor({})
    closeEmojiPicker()
    rendered = renderElement(createElement(EmojiPickerHost))
    mountEditor('ship it ')
})

afterEach(() => {
    rendered.unmount()
    view.destroy()
    editorHost.remove()
    setActiveEditorView(null)
    closeEmojiPicker()
    document.body.replaceChildren()
})

describe('the emoji picker host', () => {
    it('draws nothing until something asks for it', () => {
        expect(document.querySelector('[role=dialog]')).toBeNull()
    })

    it('centres a dialog when opened from a key or the palette', async () => {
        act(() => {
            openEmojiPicker()
        })
        const dialog = document.querySelector('[role=dialog]')
        expect(dialog).not.toBeNull()
        expect(dialog!.getAttribute('aria-labelledby') ? dialog!.querySelector('h2')?.textContent : dialog!.getAttribute('aria-label')).toBe(t('emoji.picker'))
        expect(document.querySelector('input[type=text]')).not.toBeNull()
    })

    it('hangs the panel under the control that opened it', () => {
        const button = document.createElement('button')
        document.body.append(button)
        button.getBoundingClientRect = () => ({ top: 120, bottom: 140, left: 40, right: 90, width: 50, height: 20, x: 40, y: 120, toJSON: () => ({}) }) as DOMRect
        act(() => {
            openEmojiPicker(button)
        })
        const dialog = document.querySelector('[role=dialog]') as HTMLElement
        expect(dialog).not.toBeNull()
        expect(dialog.style.top).toBeTruthy()
        expect(Number.parseInt(dialog.style.left, 10)).toBeGreaterThanOrEqual(0)
    })

    it('writes the glyph into the editor and closes itself', async () => {
        act(() => {
            openEmojiPicker()
        })
        await pick('rocket')
        expect(view.state.doc.toString()).toBe(`ship it ${ROCKET}`)
        expect(useEmojiPicker.getState().open).toBe(false)
    })

    it('writes the :code: instead when that is the format', async () => {
        setEditor({ emojiInsertFormat: 'shortcode' })
        act(() => {
            openEmojiPicker()
        })
        await pick('rocket')
        expect(view.state.doc.toString()).toBe('ship it :rocket:')
    })

    it('closes on Escape without writing anything', () => {
        act(() => {
            openEmojiPicker()
        })
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        expect(useEmojiPicker.getState().open).toBe(false)
        expect(view.state.doc.toString()).toBe('ship it ')
    })

    it('forgets an anchor that left the document instead of drawing a panel at zero', async () => {
        const button = document.createElement('button')
        document.body.append(button)
        act(() => {
            openEmojiPicker(button)
        })
        button.remove()
        act(() => {
            useEmojiPicker.setState({ open: true, anchor: button })
        })
        await settle()
        expect(document.querySelector('[role=dialog] .anim-pop')).toBeNull()
        expect(document.querySelector('input[type=text]')).not.toBeNull()
    })
})
