import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { preloadPinyin } from '../../lib/pinyin'
import { initI18n } from '../../lib/i18n'
import { markdownDecorations } from '../../editor/decorations'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { registerLinkEditorNote, useLinkEditor, writeLinkSpan } from './store'
import {
  edgeProtected,
  editLinkFromMenu,
  insideFencedCode,
  linkFromPoint,
  linkFromRendered,
  linkGestureFor,
  openLinkAtCursor,
  runSourceLinkGesture,
} from './use-link-editor'
import type { LinkMatch } from './link-syntax'

const CHAR_W = 4
const LINE_H = 16

let mounted: Array<{ view: EditorView, container: HTMLElement }> = []

function contentRoot(): HTMLElement | null {
  const last = mounted.at(-1)
  return last ? last.view.contentDOM : document.querySelector('.cm-content')
}

function globalCharOffset(node: Node, offset: number): number {
  const root = contentRoot()
  if (!root || !root.contains(node)) return Math.max(0, offset)
  let before = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    if (current === node) break
    before += current.data.length
  }
  return before + Math.min(Math.max(0, offset), (node.textContent ?? '').length)
}

function elementStartOffset(element: Element): number {
  const root = contentRoot()
  if (!root || !root.contains(element)) return 0
  let before = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const current = walker.currentNode as Text
    if (element.contains(current)) break
    before += current.data.length
  }
  return before
}

beforeAll(async () => {
  await initI18n()
  await preloadPinyin()
  Range.prototype.getClientRects = function () {
    const left = 4 + globalCharOffset(this.startContainer, this.startOffset) * CHAR_W
    return [{ left, top: 4, right: left + 2, bottom: 4 + LINE_H, width: 2, height: LINE_H }] as unknown as DOMRectList
  }
  Element.prototype.getBoundingClientRect = function () {
    const left = 4 + elementStartOffset(this) * CHAR_W
    const width = Math.max(2, (this.textContent ?? '').length * CHAR_W)
    return { left, top: 4, right: left + width, bottom: 4 + LINE_H, width, height: LINE_H, x: left, y: 4, toJSON: () => ({}) } as DOMRect
  }
})

afterEach(() => {
  useLinkEditor.getState().close()
  for (const entry of mounted) {
    entry.view.destroy()
    entry.container.remove()
  }
  mounted = []
})

function mountEditor(doc: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, addKeymap: false }), markdownDecorations] }),
    parent: container,
  })
  mounted.push({ view, container })
  return view
}

function match(over: Partial<LinkMatch>): LinkMatch {
  return { kind: 'wiki', embed: false, image: false, raw: '', start: 0, end: 0, text: '', target: '', hasText: false, ...over }
}

function click(x: number, y: number, over: Partial<MouseEvent> = {}): MouseEvent {
  return new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, button: 0, ...over })
}

/**
 * jsdom has no layout, so the pointer-to-character mapping CodeMirror does for us cannot be driven
 * with real pixels. The coordinate plumbing is covered by the `linkFromPoint` cases; these stand on
 * the decision the function makes once it knows which character was clicked.
 */
function pointAt(view: EditorView, pos: number): { x: number, y: number } {
  view.posAtCoords = () => pos
  const coords = view.coordsAtPos(pos)!
  return { x: coords.left + 8, y: coords.top + 2 }
}

const settings = DEFAULT_SETTINGS.editor

describe('linkGestureFor', () => {
  it('opens the editor on a plain click and the target on a modified one', () => {
    expect(linkGestureFor(click(0, 0, { detail: 1 }), settings, 'click')).toBe('edit')
    expect(linkGestureFor(click(0, 0, { detail: 1, ctrlKey: true }), settings, 'click')).toBe('open')
    expect(linkGestureFor(click(0, 0, { detail: 1, metaKey: true }), settings, 'click')).toBe('open')
  })

  it('ignores the second click of a double click so one gesture cannot fire twice', () => {
    expect(linkGestureFor(click(0, 0, { detail: 2 }), settings, 'click')).toBeNull()
  })

  it('waits for a double click when that is the configured trigger', () => {
    const double = { ...settings, linkEditorTrigger: 'double-click' as const }
    expect(linkGestureFor(click(0, 0, { detail: 1 }), double, 'click')).toBeNull()
    expect(linkGestureFor(click(0, 0, { detail: 2 }), double, 'dblclick')).toBe('edit')
  })

  it('requires the configured modifier to be held', () => {
    for (const modifier of ['ctrl', 'alt', 'shift'] as const) {
      const withModifier = { ...settings, linkEditorModifier: modifier }
      expect(linkGestureFor(click(0, 0, { detail: 1 }), withModifier, 'click')).toBeNull()
      const held = click(0, 0, { detail: 1, ctrlKey: modifier === 'ctrl', altKey: modifier === 'alt', shiftKey: modifier === 'shift' })
      expect(linkGestureFor(held, withModifier, 'click')).toBe('edit')
    }
  })

  it('stands aside for a right click and for the other modifiers', () => {
    expect(linkGestureFor(click(0, 0, { button: 2, detail: 1 }), settings, 'click')).toBeNull()
    expect(linkGestureFor(click(0, 0, { detail: 1, shiftKey: true }), settings, 'click')).toBeNull()
  })

  it('does nothing at all once the feature is switched off', () => {
    expect(linkGestureFor(click(0, 0, { detail: 1 }), { ...settings, linkEditor: false }, 'click')).toBeNull()
  })
})

describe('linkFromPoint', () => {
  it('returns the span the link really occupies in the document', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    const start = 5
    const located = linkFromPoint(view, start + 3)
    expect(located?.match.target).toBe('Deep Notes')
    expect(view.state.doc.sliceString(located!.from, located!.to)).toBe('[[Deep Notes]]')
  })

  it('finds a bare address', () => {
    const view = mountEditor('see https://example.com/a.')
    const located = linkFromPoint(view, 8)
    expect(located?.match.kind).toBe('url')
    expect(view.state.doc.sliceString(located!.from, located!.to)).toBe('https://example.com/a')
  })

  it('reports nothing outside a link', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    expect(linkFromPoint(view, 0)).toBeNull()
  })
})

describe('edgeProtected', () => {
  it('rejects a click on the first or last pixel of the span', () => {
    const view = mountEditor('[[Note]]')
    const located = linkFromPoint(view, 2)!
    expect(edgeProtected(located, click(located.anchor.left, 6))).toBe(true)
    expect(edgeProtected(located, click(located.anchor.right, 6))).toBe(true)
    expect(edgeProtected(located, click(located.anchor.left + 8, 6))).toBe(false)
  })
})

describe('insideFencedCode', () => {
  it('says no to markup written inside a sample', () => {
    const view = mountEditor('prose\n```js\nconst a = "[[Note]]"\n```\nmore')
    expect(insideFencedCode(view, view.state.doc.line(3).from + 12)).toBe(true)
    expect(insideFencedCode(view, view.state.doc.line(1).from)).toBe(false)
    expect(insideFencedCode(view, view.state.doc.line(5).from)).toBe(false)
  })
})

describe('runSourceLinkGesture', () => {
  it('opens the editor over the link under the pointer', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    registerLinkEditorNote(view, 'note-1')
    const point = pointAt(view, 8)
    expect(runSourceLinkGesture(click(point.x, point.y), view, 'click', settings, 'note-1')).toBe(true)
    const request = useLinkEditor.getState().request
    expect(request?.noteId).toBe('note-1')
    expect(request?.match.target).toBe('Deep Notes')
    expect(request?.view).toBe(view)
  })

  it('leaves a click on the edge of a link to the editor', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    view.posAtCoords = () => 8
    const located = linkFromPoint(view, 8)!
    expect(runSourceLinkGesture(click(located.anchor.left, located.anchor.top + 2), view, 'click', settings, 'note-1')).toBe(false)
    expect(useLinkEditor.getState().request).toBeNull()
  })

  it('does not open over markup inside a code sample', () => {
    const view = mountEditor('prose\n```js\nconst a = "[[Note]]"\n```')
    const point = pointAt(view, view.state.doc.line(3).from + 14)
    expect(runSourceLinkGesture(click(point.x, point.y), view, 'click', settings, 'note-1')).toBe(false)
  })

  it('stands aside while the reader has text selected', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    view.dispatch({ selection: { anchor: 5, head: 17 } })
    const point = pointAt(view, 8)
    expect(runSourceLinkGesture(click(point.x, point.y), view, 'click', settings, 'note-1')).toBe(false)
  })

  it('opens the link instead of the editor when the gesture carries a modifier', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    const openNote = vi.fn()
    const createNote = vi.fn()
    const previous = useNotes.getState()
    useNotes.setState({ notes: { 'n1': { id: 'n1', title: 'Deep Notes', deletedAt: null } as never }, openNote, createNote })
    const point = pointAt(view, 8)
    expect(runSourceLinkGesture(click(point.x, point.y, { ctrlKey: true }), view, 'click', settings, 'note-1')).toBe(true)
    expect(openNote).toHaveBeenCalledWith('n1')
    expect(useLinkEditor.getState().request).toBeNull()
    useNotes.setState(previous)
  })
})

describe('linkFromRendered', () => {
  function rendered(doc: string, html: string) {
    const view = mountEditor(doc)
    const host = document.createElement('div')
    host.dataset.line = '0'
    host.innerHTML = html
    document.body.appendChild(host)
    return { view, host, element: host.firstElementChild! }
  }

  it('matches a rendered wiki link back onto its source span', () => {
    const { view, element } = rendered('Read [[Deep Notes]] now', '<a data-wikilink="Deep Notes">the note</a>')
    const located = linkFromRendered(view, element)!
    expect(view.state.doc.sliceString(located.from, located.to)).toBe('[[Deep Notes]]')
  })

  it('prefers the link whose own text matches the element', () => {
    const { view, element } = rendered('[[A]] [[B|the note]]', '<a data-wikilink="B">the note</a>')
    const located = linkFromRendered(view, element)!
    expect(located.match.target).toBe('B')
  })

  it('reports nothing for an element that matches no link on its line', () => {
    const { view, element } = rendered('plain text', '<a href="https://x.dev">elsewhere</a>')
    expect(linkFromRendered(view, element)).toBeNull()
  })

  it('ignores a hashtag, which has a menu of its own', () => {
    const { view, element } = rendered('#tag here', '<span data-tag="tag">#tag</span>')
    expect(linkFromRendered(view, element)).toBeNull()
  })
})

describe('writeLinkSpan', () => {
  it('writes through the editor it was opened from', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    const located = linkFromPoint(view, 8)!
    const request = { anchor: located.anchor, noteId: 'n', match: located.match, from: located.from, to: located.to, view }
    expect(writeLinkSpan(request, '[[Other]]')).toBe('written')
    expect(view.state.doc.toString()).toBe('Read [[Other]] now')
  })

  it('refuses once the span no longer holds the link it was opened on', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    const located = linkFromPoint(view, 8)!
    const request = { anchor: located.anchor, noteId: 'n', match: located.match, from: located.from, to: located.to, view }
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x ' } })
    expect(writeLinkSpan(request, '[[Other]]')).toBe('moved')
    expect(view.state.doc.toString()).toBe('x Read [[Deep Notes]] now')
  })

  it('writes into the note when there is no editor open', () => {
    const previous = useNotes.getState()
    useNotes.setState({ contents: { n: 'Read [[Deep Notes]] now' }, editContent: vi.fn() })
    const content = 'Read [[Deep Notes]] now'
    const from = content.indexOf('[[')
    const to = from + '[[Deep Notes]]'.length
    const request = {
      anchor: new DOMRect(),
      noteId: 'n',
      match: match({ raw: '[[Deep Notes]]', target: 'Deep Notes' }),
      from,
      to,
      view: null,
    }
    expect(writeLinkSpan(request, '[[Other]]')).toBe('written')
    expect(useNotes.getState().editContent).toHaveBeenCalledWith('n', 'Read [[Other]] now')
    useNotes.setState(previous)
  })

  it('accepts an insertion at a collapsed cursor', () => {
    const view = mountEditor('Read  now')
    const request = {
      anchor: new DOMRect(),
      noteId: 'n',
      match: match({ raw: '', target: '' }),
      from: 5,
      to: 5,
      view,
      creating: true,
    }
    expect(writeLinkSpan(request, '[[Other]]')).toBe('written')
    expect(view.state.doc.toString()).toBe('Read [[Other]] now')
  })
})

describe('openLinkAtCursor', () => {
  it('edits the link the cursor is inside', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    registerLinkEditorNote(view, 'note-1')
    view.dispatch({ selection: { anchor: 8 } })
    expect(openLinkAtCursor(view)).toBe(true)
    expect(useLinkEditor.getState().request?.match.target).toBe('Deep Notes')
  })

  it('counts a cursor parked at either end of a link as being on it', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    registerLinkEditorNote(view, 'note-1')
    view.dispatch({ selection: { anchor: 17 } })
    openLinkAtCursor(view)
    expect(useLinkEditor.getState().request?.match.target).toBe('Deep Notes')
  })

  it('falls back to writing a new link, focused on the target field', () => {
    const view = mountEditor('plain text')
    registerLinkEditorNote(view, 'note-1')
    view.dispatch({ selection: { anchor: 5 } })
    expect(openLinkAtCursor(view)).toBe(true)
    const request = useLinkEditor.getState().request
    expect(request?.creating).toBe(true)
    expect(request?.focusTarget).toBe('target')
  })

  it('takes a selection as the link text to wrap', () => {
    const view = mountEditor('plain text')
    registerLinkEditorNote(view, 'note-1')
    view.dispatch({ selection: { anchor: 0, head: 5 } })
    openLinkAtCursor(view)
    const request = useLinkEditor.getState().request!
    expect(request.from).toBe(0)
    expect(request.to).toBe(5)
    expect(request.replaces).toBe('plain')
    expect(request.match.text).toBe('plain')
  })

  it('does nothing for a view that belongs to no note', () => {
    const view = mountEditor('plain text')
    expect(openLinkAtCursor(view)).toBe(false)
  })
})

describe('the panel request survives a toast-free close', () => {
  it('leaves no request behind', () => {
    const view = mountEditor('[[Note]]')
    registerLinkEditorNote(view, 'n')
    openLinkAtCursor(view)
    expect(useLinkEditor.getState().request).not.toBeNull()
    useLinkEditor.getState().close()
    expect(useLinkEditor.getState().request).toBeNull()
  })
})

describe('editLinkFromMenu', () => {
  it('opens the panel from the source side, on the span the menu was raised at', () => {
    const view = mountEditor('Read [[Deep Notes]] now')
    expect(editLinkFromMenu({
      noteId: 'note-1',
      content: 'Read [[Deep Notes]] now',
      editorPos: 8,
      previewLine: null,
      previewElement: null,
      view,
    })).toBe(true)
    const request = useLinkEditor.getState().request!
    expect(request.match.target).toBe('Deep Notes')
    expect(request.view).toBe(view)
    expect(view.state.doc.sliceString(request.from, request.to)).toBe('[[Deep Notes]]')
  })

  it('opens the panel from the reading side, where no editor is mounted', () => {
    const content = 'Read [[Deep Notes]] now'
    const element = document.createElement('a')
    element.setAttribute('data-wikilink', 'Deep Notes')
    element.textContent = 'Deep Notes'
    expect(editLinkFromMenu({
      noteId: 'note-1',
      content,
      editorPos: null,
      previewLine: 0,
      previewElement: element,
      view: null,
    })).toBe(true)
    const request = useLinkEditor.getState().request!
    expect(request.view).toBeNull()
    expect(content.slice(request.from, request.to)).toBe('[[Deep Notes]]')
  })

  it('says no rather than opening a panel that would edit the wrong span', () => {
    const element = document.createElement('a')
    element.setAttribute('href', 'https://elsewhere.dev')
    element.textContent = 'elsewhere'
    expect(editLinkFromMenu({
      noteId: 'note-1',
      content: 'nothing linked here',
      editorPos: null,
      previewLine: 0,
      previewElement: element,
      view: null,
    })).toBe(false)
    expect(editLinkFromMenu({
      noteId: null,
      content: 'Read [[Deep Notes]] now',
      editorPos: 8,
      previewLine: null,
      previewElement: null,
      view: null,
    })).toBe(false)
    expect(useLinkEditor.getState().request).toBeNull()
  })
})

describe('openLinkTarget safety', () => {
  it('refuses to hand the browser a script url', async () => {
    const { openLinkTarget } = await import('./use-link-editor')
    const toast = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => 'id')
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    openLinkTarget('javascript:alert(1)', 'n')
    expect(opened).not.toHaveBeenCalled()
    toast.mockRestore()
    opened.mockRestore()
  })
})
