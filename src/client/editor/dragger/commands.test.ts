import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import { BlockType } from 'md-dragger/domain'
import { convertBlock, copyBlock, cutBlock, deleteBlock, duplicateBlock, moveBlockOver, outsideTable } from './commands'

let view: EditorView | null = null

function editor(doc: string) {
  view?.destroy()
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [indentUnit.of('  ')] }),
    parent,
  })
  return view
}

const text = () => view?.state.doc.toString() ?? ''
const lines = () => text().split('\n')

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('block commands', () => {
  it('rewrites a paragraph as a heading and back', () => {
    const target = editor('Title body\n')
    expect(convertBlock(target, 1, { type: BlockType.Heading, level: 2 })).toBe(true)
    expect(lines()[0]).toBe('## Title body')
    expect(convertBlock(target, 1, { type: BlockType.Paragraph })).toBe(true)
    expect(lines()[0]).toBe('Title body')
  })

  it('turns a bullet into a task without losing its text', () => {
    editor('- one item\n')
    expect(convertBlock(view!, 1, { type: BlockType.ListItem, markerType: 'task' })).toBe(true)
    expect(lines()[0]).toBe('- [ ] one item')
  })

  it('refuses a conversion the block cannot take', () => {
    editor('\n')
    expect(convertBlock(view!, 1, { type: BlockType.Paragraph })).toBe(false)
  })

  it('deletes a block and the blank line that would have doubled up', () => {
    editor('# T\n\ngone\n\nkept\n')
    expect(deleteBlock(view!, 3)).toBe(true)
    expect(text()).toBe('# T\n\nkept\n')
  })

  it('duplicates a paragraph below itself with one blank between', () => {
    editor('copy me\n\nnext\n')
    expect(duplicateBlock(view!, 1)).toBe(true)
    expect(lines().slice(0, 4)).toEqual(['copy me', '', 'copy me', 'next'])
  })

  it('keeps a duplicated list item inside its run', () => {
    editor('- a\n- b\n')
    expect(duplicateBlock(view!, 1)).toBe(true)
    expect(lines().slice(0, 3)).toEqual(['- a', '- a', '- b'])
  })

  it('carries a list item with its children over its neighbour', () => {
    editor('- parent\n  - child\n- other\n')
    expect(moveBlockOver(view!, 1, 1)).toBe(true)
    expect(lines().slice(0, 3)).toEqual(['- other', '- parent', '  - child'])
  })

  it('carries a block up as well as down', () => {
    editor('first\n\nsecond\n')
    expect(moveBlockOver(view!, 3, -1)).toBe(true)
    expect(lines().slice(0, 3)).toEqual(['second', '', 'first'])
  })

  it('refuses to carry the only block past the ends of the note', () => {
    editor('only\n')
    expect(moveBlockOver(view!, 1, 1)).toBe(false)
    expect(moveBlockOver(view!, 1, -1)).toBe(false)
  })

  it('copies and cuts a block through the clipboard', async () => {
    const write = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    const target = editor('keep\n\nclip me\n\nrest\n')
    expect(await copyBlock(target, 3)).toBe(true)
    expect(write).toHaveBeenCalledWith('clip me')
    expect(text()).toContain('clip me')
    const second = editor('keep\n\nclip me\n\nrest\n')
    expect(await cutBlock(second, 3)).toBe(true)
    expect(text()).toBe('keep\n\nrest\n')
  })
})

describe('the table seam guard', () => {
  const doc = () => EditorState.create({ doc: '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nTail.\n' }).doc

  it('lifts a seam from between a table’s rows to the edge it was nearer', () => {
    const source = doc()
    const inside = outsideTable(source, { doc: source, line: 2, parent: null }, 2)
    expect(inside.line).toBe(1)
    const lower = outsideTable(source, { doc: source, line: 3, parent: null }, 2)
    expect(lower.line).toBe(4)
  })

  it('leaves a seam that was never inside a table alone', () => {
    const source = doc()
    const before = { doc: source, line: 1, parent: null }
    expect(outsideTable(source, before, 2)).toBe(before)
    const after = { doc: source, line: 4, parent: null }
    expect(outsideTable(source, after, 2)).toBe(after)
  })
})
