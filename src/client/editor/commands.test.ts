import type { EditorView } from '@codemirror/view'
import { EditorSelection, EditorState } from '@codemirror/state'
import { beforeAll } from 'vitest'
import { describe, expect, it } from 'vitest'
import { completeCodeFenceOnEnter, completeColonFenceOnEnter, insertMathBlock, setHeading, toggleComment } from './commands'
import { renderMarkdown } from '../lib/markdown/renderer'

function runFenceCompletion(doc: string, cursor = doc.length) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  let next = state
  const handled = completeCodeFenceOnEnter({ state, dispatch: (transaction) => { next = transaction.state } })
  return { handled, state: next }
}

describe('completeCodeFenceOnEnter', () => {
  it('adds a closing fence and places the cursor inside a new code block', () => {
    const result = runFenceCompletion('```ts')

    expect(result.handled).toBe(true)
    expect(result.state.doc.toString()).toBe('```ts\n\n```')
    expect(result.state.selection.main.head).toBe(6)
  })

  it('does not add another fence when Enter is pressed on a closing fence', () => {
    const result = runFenceCompletion('```\nconsole.log(1)\n```')

    expect(result.handled).toBe(false)
    expect(result.state.doc.toString()).toBe('```\nconsole.log(1)\n```')
  })

  it('ignores a plain text line even while an earlier fence is still open', () => {
    const result = runFenceCompletion('```ts\nstill inside the fence')

    expect(result.handled).toBe(false)
    expect(result.state.doc.toString()).toBe('```ts\nstill inside the fence')
  })

  it('ignores a fence line when the caret is not at its end', () => {
    const result = runFenceCompletion('```ts', 3)

    expect(result.handled).toBe(false)
  })
})

describe('toolbar formatting commands', () => {
  it('restores selected headings to body text without changing ordinary lines', () => {
    const doc = '# Title\nBody\n### Section'
    let state = EditorState.create({ doc, selection: EditorSelection.range(0, doc.length) })
    setHeading(0)({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('Title\nBody\nSection')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('Title\nBody\nSection')
    expect(setHeading(0)({ state, dispatch: () => {} })).toBe(false)
  })

  it('preserves selected math inside a renderable block in the middle of a paragraph', () => {
    let state = EditorState.create({ doc: 'Before a^2 After', selection: EditorSelection.range(7, 10) })
    insertMathBlock({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('Before \n\n$$\na^2\n$$\n\n After')
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('a^2')
    const rendered = renderMarkdown(state.doc.toString())
    expect(rendered.hasMath).toBe(true)
    expect(rendered.html).toContain('class="math-block"')
    expect(rendered.html).toContain('Before')
    expect(rendered.html).toContain('After')
  })

  it('places the cursor inside an empty block formula', () => {
    let state = EditorState.create()
    insertMathBlock({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe('$$\n\n$$\n')
    expect(state.selection.main.head).toBe(3)
  })

  it('hides multiline comments in preview and restores the selected text when toggled again', () => {
    const doc = 'Public\n\nPrivate first\nPrivate second'
    let state = EditorState.create({ doc, selection: EditorSelection.range(8, doc.length) })
    toggleComment({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(renderMarkdown(state.doc.toString()).html).not.toContain('Private')
    expect(renderMarkdown(state.doc.toString()).html).toContain('Public')
    toggleComment({ state, dispatch: (transaction) => { state = transaction.state } })
    expect(state.doc.toString()).toBe(doc)
  })
})

function runColonCompletion(doc: string, cursor = doc.length) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  let next = state
  const handled = completeColonFenceOnEnter({ state, dispatch: (transaction) => { next = transaction.state } })
  return { handled, doc: next.doc.toString(), head: next.selection.main.head }
}

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is
// attached and focused; the shim keeps the completion path exercisable instead of untestable.
beforeAll(() => {
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (!proto.getClientRects)
    proto.getClientRects = () => [] as unknown as DOMRectList
})

async function runCommand(command: StateCommandLike, doc: string, caret: number, anchorTo?: number, withCompletions = false, source: 'wiki' | 'tag' = 'wiki') {
  const { EditorView } = await import('@codemirror/view')
  const { autocompletion, completionStatus } = await import('@codemirror/autocomplete')
  const { tagSource, wikiLinkSource } = await import('./completion')
  const selection = anchorTo === undefined ? EditorSelection.cursor(caret) : EditorSelection.range(caret, anchorTo)
  const sources = () => ({
    notes: () => [{ id: '1', title: 'Welcome to Inkstone', excerpt: '' }],
    tags: () => [{ name: 'work/meeting', count: 3 }, { name: 'job', count: 1 }],
  })
  const extensions = withCompletions ? [autocompletion({
    override: [(source === 'tag' ? tagSource : wikiLinkSource)(sources)],
  })] : []
  const state = EditorState.create({ doc, selection, extensions })
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({ state, parent })
  await command({ state: view.state, dispatch: (value: Parameters<EditorView['dispatch']>[0]) => view.dispatch(value), view })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const result = {
    text: view.state.doc.toString(),
    head: view.state.selection.main.head,
    status: completionStatus(view.state),
    focused: view.hasFocus,
  }
  view.destroy()
  parent.remove()
  return result
}

type StateCommandLike = (ctx: { state: EditorState; dispatch: (value: Parameters<EditorView['dispatch']>[0]) => void; view?: EditorView }) => boolean

describe('toolbar wiki link insertion', () => {
  it('inserts an empty pair with the caret inside, ready for the note list', async () => {
    const { toggleWikiLink } = await import('./commands')
    const result = await runCommand(toggleWikiLink as StateCommandLike, '', 0, undefined, true)
    expect(result.text).toBe('[[]]')
    expect(result.head).toBe(2)
    expect(['active', 'pending'], result.text).toContain(result.status)
  })

  it('does the same for a note embed', async () => {
    const { toggleNoteEmbed } = await import('./commands')
    const result = await runCommand(toggleNoteEmbed as StateCommandLike, '', 0, undefined, true)
    expect(result.text).toBe('![[]]')
    expect(['active', 'pending'], result.text).toContain(result.status)
  })

  it('opens the tag list when the toolbar inserts a hashtag', async () => {
    const { insertTag } = await import('./commands')
    const result = await runCommand(insertTag as StateCommandLike, 'Status: ', 8, undefined, true, 'tag')
    expect(result.text).toBe('Status: #')
    expect(result.head).toBe(9)
    expect(['active', 'pending'], result.text).toContain(result.status)
    expect(result.focused, 'the toolbar button took focus, so the command has to give it back').toBe(true)
  })

  it('keeps the hashtag inert when it lands inside a word', async () => {
    const { insertTag } = await import('./commands')
    const result = await runCommand(insertTag as StateCommandLike, 'abc', 3, undefined, true, 'tag')
    expect(result.text).toBe('abc#')
    expect(result.status).toBeNull()
  })

  it('wraps a selection without touching the markers', async () => {
    const { toggleWikiLink } = await import('./commands')
    const result = await runCommand(toggleWikiLink as StateCommandLike, 'Welcome to Inkstone', 0, 19)
    expect(result.text).toBe('[[Welcome to Inkstone]]')
    expect(result.head).toBe(21)
  })

  it('unwraps an already linked selection', async () => {
    const { toggleWikiLink } = await import('./commands')
    const result = await runCommand(toggleWikiLink as StateCommandLike, '[[Welcome]]', 2, 9)
    expect(result.text).toBe('Welcome')
  })

  it('leaves ordinary emphasis toggles alone', async () => {
    const { toggleBold } = await import('./commands')
    expect((await runCommand(toggleBold as StateCommandLike, '', 0)).text).toBe('****')
  })
})

describe('completeColonFenceOnEnter', () => {
  it('closes a details block and leaves the caret on the empty body line', () => {
    const result = runColonCompletion('::: details Notes')
    expect(result.handled).toBe(true)
    expect(result.doc).toBe('::: details Notes\n\n:::')
    expect(result.head).toBe(18)
  })

  it('repeats the marker the author typed', () => {
    const result = runColonCompletion(':::: tabs')
    expect(result.doc).toBe(':::: tabs\n\n::::')
    expect(result.head).toBe(10)
  })

  it('closes a tab item that already sits inside an open set', () => {
    const result = runColonCompletion(':::: tabs\n::: tab-item A')
    expect(result.handled).toBe(true)
    expect(result.doc).toBe(':::: tabs\n::: tab-item A\n\n:::')
  })

  it('leaves a closer line alone', () => {
    const result = runColonCompletion(':::: tabs\n::: tab-item A\n\n:::')
    expect(result.handled).toBe(false)
    expect(result.doc).toBe(':::: tabs\n::: tab-item A\n\n:::')
  })

  it('does not fire inside a code fence', () => {
    const result = runColonCompletion('```md\n::: tabs')
    expect(result.handled).toBe(false)
  })

  it('does not fire on an unknown directive or on a brace-only line', () => {
    expect(runColonCompletion('::: note X').handled).toBe(false)
    expect(runColonCompletion(':::::').handled).toBe(false)
  })

  it('round-trips through the renderer after completion', () => {
    const { doc } = runColonCompletion(':::details Notes')
    expect(doc).toBe(':::details Notes\n\n:::')
    expect(renderMarkdown(doc).html).toContain('<summary>Notes</summary>')
  })
})
