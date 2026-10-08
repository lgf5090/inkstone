import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { EditorSettings } from '@shared/types'
import { draggerExtensions, type DraggerHost } from './extension'
import { draggerMoveCommand } from './extension'

let view: EditorView | null = null

const host = (patch: Partial<EditorSettings> = {}, state: { touch?: boolean; dragMode?: boolean } = {}): DraggerHost => ({
  settings: () => ({ ...DEFAULT_SETTINGS.editor, ...patch }),
  isTouch: () => state.touch ?? false,
  dragMode: () => state.dragMode ?? false,
  openBlockMenu: vi.fn(),
  notifyDrop: vi.fn(),
})

function mount(document: string, draggerHost: DraggerHost) {
  const parent = document0()
  view = new EditorView({
    state: EditorState.create({ doc: document, extensions: draggerExtensions(draggerHost) }),
    parent,
  })
  return view
}

function document0() {
  const parent = document.createElement('div')
  document.body.append(parent)
  return parent
}

const gripLines = () => [...document.querySelectorAll('.md-dragger-handle[data-block-start]')]
  .map((grip) => Number(grip.getAttribute('data-block-start')))
  .sort((a, b) => a - b)

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('the dragger layer', () => {
  it('puts one grip beside the first line of every block in view', () => {
    mount('# Title\n\nA paragraph.\n\n- one\n- two\n', host())
    // Each list item is a block of its own: the parent's grip carries its children, a sibling's does not.
    expect(gripLines()).toEqual([1, 3, 5, 6])
  })

  it('names the block a grip belongs to, which is how a press becomes a move', () => {
    const target = mount('# Title\n\nA paragraph.\n', host())
    const grip = target.dom.querySelector<HTMLElement>('.md-dragger-handle[data-block-start="3"]')
    expect(grip?.textContent).toBe('')
    expect(grip?.firstElementChild?.className).toBe('ink-dragger-handle-core')
  })

  it('draws no grips while the feature is off, and none while they are hidden', () => {
    mount('# Title\n\nA paragraph.\n', host({ dragger: false }))
    expect(gripLines()).toEqual([])
    mount('# Title\n\nA paragraph.\n', host({ draggerHandles: 'hidden' }))
    expect(gripLines()).toEqual([])
  })

  it('keeps its layer out of the editor’s own content', () => {
    const target = mount('# Title\n', host())
    expect(target.contentDOM.querySelector('.ink-dragger-layer')).toBeNull()
    expect(target.dom.querySelector(':scope > .ink-dragger-layer')).not.toBeNull()
  })

  it('hands a keyboard carry to the move only while the setting allows it', () => {
    const target = mount('# Title\n\nBody.\n', host())
    target.dispatch({ selection: { anchor: target.state.doc.line(3).from } })
    expect(draggerMoveCommand(1, () => false)(target)).toBe(false)
    expect(draggerMoveCommand(-1, () => true)(target)).toBe(true)
    expect(target.state.doc.line(1).text).toBe('Body.')
  })
})
