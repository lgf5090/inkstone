import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { installTestGlobals } from '../lib/test-render';
import { liveBlockContextMenu, livePreview } from './live-preview';

const PARAGRAPH = '\u666e\u901a\u7684\u4e00\u884c\u6b63\u6587\u3002' // one ordinary paragraph
const TABLE_HEADER = '\u540d\u79f0' // the first column of the table below

const doc = [
    '# \u6570\u636e\u6765\u6e90',
    '',
    PARAGRAPH,
    '',
    '| \u540d\u79f0 | \u6570\u91cf |',
    '| --- | ---: |',
    '| \u82f9\u679c | 10 |',
    '| \u9999\u8549 | 3 |',
].join('\n')

let view: EditorView | null = null

function mount(extensions: Extension[]): EditorView {
    installTestGlobals()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    view = new EditorView({ state: EditorState.create({ doc, extensions }), parent })
    return view
}

function blockHolding(editor: EditorView, text: string): HTMLElement | undefined {
    return [...editor.dom.querySelectorAll<HTMLElement>('.cm-live-block')].find((block) => (block.textContent ?? '').includes(text))
}

function rightClick(target: HTMLElement): MouseEvent {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    target.dispatchEvent(event)
    return event
}

afterEach(() => {
    view?.destroy()
    view = null
    document.body.innerHTML = ''
})

describe('a right-click inside a rendered block', () => {
    it('asks the host for the note menu, naming the source line each block was rendered from', () => {
        const asked: Array<{ line: number; text: string }> = []
        const editor = mount([
            livePreview(() => undefined),
            liveBlockContextMenu.of((event, target, lineStart) => {
                event.preventDefault()
                const at = target.state.doc.lineAt(lineStart)
                asked.push({ line: at.number, text: at.text })
            }),
        ])
        const paragraph = blockHolding(editor, PARAGRAPH)
        const table = blockHolding(editor, TABLE_HEADER)
        expect(paragraph, 'the paragraph is a rendered block').toBeTruthy()
        expect(table, 'the table is a rendered block').toBeTruthy()

        const first = rightClick(paragraph!)
        expect(asked).toEqual([{ line: 3, text: PARAGRAPH }])
        expect(first.defaultPrevented).toBe(true)

        rightClick(table!)
        expect(asked).toHaveLength(2)
        expect(asked[1]!.line).toBe(5)
        expect(asked[1]!.text).toContain(TABLE_HEADER)
    })

    it('maps a click inside a table row to that row, not to the block that opens it', () => {
        const asked: number[] = []
        const editor = mount([
            livePreview(() => undefined),
            liveBlockContextMenu.of((_event, target, lineStart) => {
                asked.push(target.state.doc.lineAt(lineStart).number)
            }),
        ])
        const rows = [...editor.dom.querySelectorAll<HTMLElement>('.cm-live-block tbody tr')]
        const secondRow = rows.find((row) => (row.textContent ?? '').includes('\u9999\u8549'))
        expect(secondRow, 'the rendered table has body rows to point at').toBeTruthy()
        rightClick(secondRow!.querySelector('td')!)
        expect(asked).toEqual([8])
    })

    it('does nothing when the host offers no menu, so a plain editor keeps its browser menu', () => {
        const editor = mount([livePreview(() => undefined)])
        const block = editor.dom.querySelector<HTMLElement>('.cm-live-block')
        expect(block).toBeTruthy()
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
        expect(block!.dispatchEvent(event)).toBe(true)
        expect(event.defaultPrevented).toBe(false)
    })

    it('leaves the clicks the widget already handles alone', () => {
        const asked: string[] = []
        const editor = mount([livePreview(() => undefined), liveBlockContextMenu.of((event) => { asked.push(event.type) })])
        const block = editor.dom.querySelector<HTMLElement>('.cm-live-block')
        expect(block).toBeTruthy()
        // The block owns its clicks: one of them moves the caret to the source line it was rendered
        // from, and it prevents the default for that. Only `contextmenu` is the menu's business.
        expect(block!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
        expect(asked).toEqual([])
    })
})
