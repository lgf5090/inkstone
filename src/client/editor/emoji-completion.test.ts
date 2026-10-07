import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/constants'
import { useSession } from '../store/session'
import { emojiUnicodeEntries, loadEmojiUnicode } from '../lib/emoji-unicode'
import { loadEmojiPrefs, saveEmojiPrefs } from '../lib/emoji-prefs'
import { emojiSource } from './completion'

const ROCKET = String.fromCodePoint(0x1f680)

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
    if (!proto.getClientRects)
        proto.getClientRects = () => [] as unknown as DOMRectList
}

async function completeAt(doc: string, caret = doc.length) {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
    const result = await emojiSource(new CompletionContext(state, caret, true))
    return { result, state }
}

async function accept(doc: string, code: string): Promise<string> {
    const { result, state } = await completeAt(doc)
    expect(result, doc).not.toBeNull()
    const option = result!.options.find((entry) => entry.detail === `:${code}:`)!
    const host = document.createElement('div')
    document.body.append(host)
    const view: EditorView = new EditorView({ state, parent: host })
    ;(option.apply as (target: EditorView) => void)(view)
    const text = view.state.doc.toString()
    const caret = view.state.selection.main.head
    view.destroy()
    host.remove()
    return `${text}|${caret}`
}

function setEditor(patch: Record<string, unknown>): void {
    useSession.setState({ settings: mergeSettings({ editor: patch }) })
}

beforeAll(async () => {
    await loadEmojiUnicode()
})

beforeEach(() => {
    localStorage.clear()
    saveEmojiPrefs({ recentEmojis: [] })
    setEditor({})
})

describe('emoji completion', () => {
    it('offers the emoji a half-typed code names', async () => {
        const { result } = await completeAt('ship it :roc')
        expect(result).not.toBeNull()
        expect(result!.options.map((option) => option.detail)).toContain(':rocket:')
    })

    it('starts the replacement at the colon, so accepting removes it', async () => {
        const { result } = await completeAt('ship it :roc')
        expect(result!.from).toBe('ship it '.length)
        expect(await accept('ship it :roc', 'rocket')).toBe(`ship it ${ROCKET}|${'ship it '.length + ROCKET.length}`)
    })

    it('waits for the set when this keystroke is the first to want it', async () => {
        const state = EditorState.create({ doc: ':roc', selection: EditorSelection.cursor(4) })
        const result = emojiSource(new CompletionContext(state, 4, true))
        expect(await result).not.toBeNull()
    })

    it('needs two letters before it interrupts typing', async () => {
        expect((await completeAt(':r')).result).toBeNull()
        expect((await completeAt('a:ro')).result).toBeNull()
    })

    it('stays out of the way of a URL, a time, and the container colons', async () => {
        for (const doc of ['https://ex', 'data:text', '12:30', 'score 5:3', ':::tab', 'key: value'])
            expect((await completeAt(doc)).result, doc).toBeNull()
    })

    it('gives up when nothing matches', async () => {
        expect((await completeAt(':qqqqzzzzx')).result).toBeNull()
    })

    it('writes a :code: instead when that is the reader’s format', async () => {
        setEditor({ emojiInsertFormat: 'shortcode' })
        expect(await accept('ship it :roc', 'rocket')).toBe(`ship it :rocket:|${'ship it :rocket:'.length}`)
    })

    it('applies the stored skin tone to the hand it completes', async () => {
        const thumb = emojiUnicodeEntries().find((entry) => entry.code === '+1')!
        expect(thumb.tones?.length).toBeGreaterThan(0)
        setEditor({ emojiSkinTone: 3 })
        const { result } = await completeAt('nice :+1')
        const option = result!.options.find((entry) => entry.detail === ':+1:')!
        expect(option.label).toBe(thumb.tones![2])
    })

    it('records what was accepted, so the picker can offer it again', async () => {
        await accept('ship it :roc', 'rocket')
        expect(loadEmojiPrefs().recentEmojis).toEqual([ROCKET])
    })
})
