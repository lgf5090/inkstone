import type { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { containerDirectiveSource, slashCommandSource } from './completion'

function complete(doc: string) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) })
  return containerDirectiveSource(new CompletionContext(state, doc.length, true))
}

describe('wikiLinkSource closing brackets', () => {
  async function applyAt(doc: string, caret: number, to: number | undefined = caret) {
    const { EditorState } = await import('@codemirror/state')
    const { EditorView } = await import('@codemirror/view')
    const { CompletionContext } = await import('@codemirror/autocomplete')
    const { wikiLinkSource } = await import('./completion')
    const source = wikiLinkSource(() => ({
      notes: () => [{ id: '1', title: 'Welcome to Inkstone', excerpt: '' }],
      tags: () => [],
    }))
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) })
    const view = new EditorView({ state, parent: document.createElement('div') })
    const result = source(new CompletionContext(state, caret, true))
    expect(result, doc).not.toBeNull()
    const option = result!.options.find((entry) => entry.label === 'Welcome to Inkstone')!
    void to
    ;(option.apply as (v: EditorView, c: unknown, f: number, t?: number) => void)(view, option, result!.from, to)
    const text = view.state.doc.toString()
    view.destroy()
    return text
  }

  it('does not stack a second closing pair onto the one closeBrackets inserted', async () => {
    expect(await applyAt('[[]]', 2)).toBe('[[Welcome to Inkstone]]')
  })

  it('holds the same result when the caller passes no replacement end', async () => {
    expect(await applyAt('[[]]', 2, undefined)).toBe('[[Welcome to Inkstone]]')
  })

  it('still closes a bare opening pair typed without auto-closing', async () => {
    expect(await applyAt('[[', 2)).toBe('[[Welcome to Inkstone]]')
  })

  it('replaces what the caret already sits in, keeping the rest of the line', async () => {
    expect(await applyAt('prefix [[]] suffix', 9)).toBe('prefix [[Welcome to Inkstone]] suffix')
  })
})

describe('slashCommandSource', () => {
  function complete(doc: string) {
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) })
    return slashCommandSource(new CompletionContext(state, doc.length, true))
  }

  it('offers block and inline commands only at the start of a line', () => {
    expect(complete('/')!.options.map((option) => option.label)).toEqual(expect.arrayContaining(['/heading1', '/task', '/table', '/bold']))
    expect(complete('/head')!.options.map((option) => option.label)).toEqual([
      '/heading1', '/heading2', '/heading3', '/heading4', '/heading5', '/heading6',
    ])
    expect(complete('text /head')).toBeNull()
    expect(complete('https://example.com')).toBeNull()
  })

  it('inserts the selected Markdown and places the cursor in its editable slot', async () => {
    const { EditorView } = await import('@codemirror/view')
    const state = EditorState.create({ doc: '/task', selection: EditorSelection.cursor(5) })
    const view = new EditorView({ state, parent: document.createElement('div') })
    const result = slashCommandSource(new CompletionContext(state, 5, true))!
    const option = result.options.find((entry) => entry.label === '/task')!
    ;(option.apply as (v: EditorView, c: unknown, f: number, t: number) => void)(view, option, result.from, 5)
    expect(view.state.doc.toString()).toBe('- [ ] ')
    expect(view.state.selection.main.head).toBe(6)
    view.destroy()
  })
})

describe('containerDirectiveSource', () => {
  it('offers the container directives right after the colon marker', () => {
    const result = complete(':::')
    expect(result).not.toBeNull()
    expect(result!.from).toBe(3)
    expect(result!.options.map((option) => option.label)).toEqual(['details', 'tabs', 'tab-item', 'timeline', '{tab-set}', '{tab-item}', 'cols', 'media', 'left', 'center', 'right', 'justify'])
  })

  it('keeps the marker length out of the replacement range', () => {
    expect(complete(':::::')!.from).toBe(5)
    expect(complete(':::: tab')!.from).toBe(4)
  })

  it('accepts the space-free spelling', () => {
    expect(complete(':::details')!.from).toBe(3)
  })

  it('stays quiet away from the start of a line', () => {
    expect(complete('see :::')).toBeNull()
    expect(complete('### :::')).toBeNull()
    expect(complete('```')).toBeNull()
    expect(complete('- :::')).toBeNull()
  })
})
