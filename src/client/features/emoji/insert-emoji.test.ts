import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveEditorView } from '../../editor/commands'
import { useUi } from '../../store/ui'
import { insertEmojiText } from './insert-emoji'

const ROCKET = String.fromCodePoint(0x1f680)

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
    if (!proto.getClientRects)
        proto.getClientRects = () => [] as unknown as DOMRectList
}

let writeText: ReturnType<typeof vi.fn>

function mountEditor(doc: string, cursor: number, inert = false): { view: EditorView; text: () => string } {
    const host = document.createElement('div')
    if (inert)
        host.setAttribute('inert', '')
    const parent = document.createElement('div')
    parent.append(host)
    document.body.append(parent)
    const view = new EditorView({
        state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor) }),
        parent: host,
    })
    setActiveEditorView(view)
    return { view, text: () => view.state.doc.toString() }
}

function toasts(): string[] {
    return useUi.getState().toasts.map((toast) => toast.title)
}

beforeEach(() => {
    localStorage.clear()
    useUi.setState({ toasts: [] })
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
    setActiveEditorView(null)
    document.body.replaceChildren()
})

describe('insertEmojiText', () => {
    it('writes at the caret of the editor on screen and leaves it after the glyph', async () => {
        const editor = mountEditor('ship it ', 8)
        expect(await insertEmojiText(ROCKET)).toBe(true)
        expect(editor.text()).toBe(`ship it ${ROCKET}`)
        expect(editor.view.state.selection.main.head).toBe(8 + ROCKET.length)
        expect(writeText).not.toHaveBeenCalled()
    })

    it('replaces what was selected, like every other insert', async () => {
        const state = EditorState.create({ doc: 'a bb c', selection: EditorSelection.range(2, 4) })
        const host = document.createElement('div')
        document.body.append(host)
        const view = new EditorView({ state, parent: host })
        setActiveEditorView(view)
        await insertEmojiText(ROCKET)
        expect(view.state.doc.toString()).toBe(`a ${ROCKET} c`)
    })

    it('copies instead when there is no editor to write into', async () => {
        setActiveEditorView(null)
        expect(await insertEmojiText(ROCKET)).toBe(true)
        expect(writeText).toHaveBeenCalledWith(ROCKET)
        expect(toasts().length).toBe(1)
    })

    it('copies instead when the editor belongs to a note that is no longer on screen', async () => {
        const editor = mountEditor('gone', 4)
        editor.view.destroy()
        await insertEmojiText(ROCKET)
        expect(writeText).toHaveBeenCalledWith(ROCKET)
    })

    it('copies instead when the pane is inert, because the reader could not see the change', async () => {
        const editor = mountEditor('hidden', 6, true)
        await insertEmojiText(ROCKET)
        expect(editor.text()).toBe('hidden')
        expect(writeText).toHaveBeenCalledWith(ROCKET)
    })

    it('says so when the clipboard refuses', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn(async () => { throw new Error('denied') }) },
            configurable: true,
        })
        setActiveEditorView(null)
        expect(await insertEmojiText(ROCKET)).toBe(false)
        const toast = useUi.getState().toasts.at(-1)
        expect(toast?.tone).toBe('danger')
    })
})
