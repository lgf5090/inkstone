import type { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatCodeBlock } from './commands'
import { useSession } from '../store/session'
import { useUi } from '../store/ui'

const MESSY = 'intro\n\n```ts\nfunction f(){\nconst a=1\nreturn a\n}\n```\n\nafter\n'
const FORMATTED = 'intro\n\n```ts\nfunction f() {\n  const a = 1\n  return a\n}\n```\n\nafter\n'

function press(doc: string, cursor: number): { handled: boolean, doc: string, transactions: number } {
  const state = EditorState.create({ doc, selection: { anchor: cursor } })
  let next = state
  let transactions = 0
  const view = {
    state,
    dispatch: (update: Parameters<typeof state.update>[0]) => {
      transactions += 1
      next = next.update(update).state
    },
  } as unknown as EditorView
  const handled = formatCodeBlock(view)
  return { handled, doc: next.doc.toString(), transactions }
}

function cursorOn(doc: string, needle: string, occurrence = 0): number {
  let at = -1
  for (let i = 0; i <= occurrence; i++) at = doc.indexOf(needle, at + 1)
  return at + Math.floor(needle.length / 2)
}

function lastToast(): { title: string, tone?: string } | undefined {
  return useUi.getState().toasts.at(-1)
}

beforeEach(() => {
  useUi.setState({ toasts: [] })
  useSession.setState((state) => ({
    settings: {
      ...state.settings,
      editor: { ...state.settings.editor, tabSize: 2, codeFormatKeywordCase: 'upper' },
    },
  }))
})

describe('formatCodeBlock', () => {
  it('rewrites the body of the block the cursor is inside and nothing else', () => {
    const result = press(MESSY, cursorOn(MESSY, 'const a=1'))
    expect(result.handled).toBe(true)
    expect(result.doc).toBe(FORMATTED)
    expect(result.transactions).toBe(1)
  })

  it('treats a cursor parked on either fence line as being on that block', () => {
    expect(press(MESSY, cursorOn(MESSY, '```ts')).doc).toBe(FORMATTED)
    expect(press(MESSY, cursorOn(MESSY, '```', 1)).doc).toBe(FORMATTED)
  })

  it('says so when the cursor is in prose, and leaves the note alone', () => {
    const result = press(MESSY, 2)
    expect(result.handled).toBe(false)
    expect(result.doc).toBe(MESSY)
    expect(lastToast()?.title).toBe('command.format_code_block_outside')
  })

  it('keeps a block inside a list item inside it', () => {
    const doc = '- item\n  ```ts\n  const a=1\n  ```\n'
    const result = press(doc, cursorOn(doc, 'const a=1'))
    expect(result.doc).toBe('- item\n  ```ts\n  const a = 1\n  ```\n')
  })

  it('follows the indent width the account chose', () => {
    useSession.setState((state) => ({ settings: { ...state.settings, editor: { ...state.settings.editor, tabSize: 4 } } }))
    const result = press(MESSY, cursorOn(MESSY, 'const a=1'))
    expect(result.doc).toBe('intro\n\n```ts\nfunction f() {\n    const a = 1\n    return a\n}\n```\n\nafter\n')
  })

  it('reports a block that was already formatted instead of writing it back', () => {
    const result = press(FORMATTED, cursorOn(FORMATTED, 'const a = 1'))
    expect(result.handled).toBe(true)
    expect(result.transactions).toBe(0)
    expect(lastToast()?.title).toBe('preview.code_format_unchanged')
  })

  it('keeps the fence info string a block was written with', () => {
    const doc = '```ts title="utils.ts" line-numbers\nconst a=1\n```\n'
    const result = press(doc, cursorOn(doc, 'const a=1'))
    expect(result.doc).toBe('```ts title="utils.ts" line-numbers\nconst a = 1\n```\n')
  })

  it('does not invent a trailing newline for a block the note left open', () => {
    const doc = '```ts\nconst a=1'
    const result = press(doc, cursorOn(doc, 'const a=1'))
    expect(result.doc).toBe('```ts\nconst a = 1')
  })

  it('leaves a block with nothing in it alone', () => {
    const doc = '```ts\n```\n'
    const result = press(doc, cursorOn(doc, '```ts'))
    expect(result.transactions).toBe(0)
    expect(result.doc).toBe(doc)
  })
})
