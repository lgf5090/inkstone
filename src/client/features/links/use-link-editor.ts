import type { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { EditorSettings } from '@shared/types'
import { decodeDataValue } from '../../lib/markdown/data-attr'
import { splitLines } from '../../lib/markdown/fence-edit'
import { isSafeExternalUrl } from '../workspace/context-menu/line-edits'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import {
  ALL_LINK_KINDS,
  collectLinks,
  displayTextOf,
  findLinkAt,
  isExternalTarget,
  splitTarget,
  type LinkMatch,
} from './link-syntax'
import { findNoteIdByTitle, noteIdForView, openLinkEditor, useLinkEditor } from './store'

const EDGE_BUFFER = 4

export interface LocatedLink {
  match: LinkMatch
  from: number
  to: number
  anchor: DOMRect
}

/** Which gesture the reader made: open the editor over the link, open what the link points at, or neither. */
export function linkGestureFor(event: MouseEvent, settings: EditorSettings, kind: 'click' | 'dblclick'): 'edit' | 'open' | null {
  if (!settings.linkEditor || event.button !== 0) return null
  if (settings.linkEditorModifier !== 'none') {
    if (kind !== settings.linkEditorTrigger) return null
    const held = settings.linkEditorModifier === 'ctrl'
      ? event.ctrlKey || event.metaKey
      : settings.linkEditorModifier === 'alt'
        ? event.altKey
        : event.shiftKey
    return held ? 'edit' : null
  }
  if (settings.linkEditorTrigger === 'double-click') return kind === 'dblclick' ? 'edit' : null
  if (kind !== 'click' || event.detail > 1) return null
  if (event.ctrlKey || event.metaKey) return 'open'
  return event.altKey || event.shiftKey ? null : 'edit'
}

function sourceLineOf(element: Element): number | null {
  const stamped = element.closest<HTMLElement>('[data-line]')
  const raw = stamped?.dataset.line
  if (raw === undefined || raw === '') return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function renderedIdentity(element: Element): { target: string, text: string } {
  const text = (element.textContent ?? '').trim()
  if (element instanceof HTMLImageElement) return { target: element.getAttribute('src') ?? '', text: element.alt }
  if (element instanceof HTMLAnchorElement) {
    const wiki = element.dataset.wikilink === undefined ? null : decodeDataValue(element.dataset.wikilink)
    if (wiki !== null) {
      const pipe = wiki.indexOf('|')
      return { target: (pipe >= 0 ? wiki.slice(0, pipe) : wiki).trim(), text }
    }
    return { target: element.getAttribute('href') ?? '', text }
  }
  return { target: '', text }
}

function sameTarget(a: string, b: string): boolean {
  if (!a || !b) return false
  const left = a.replace(/^\.?\//, '').replace(/^file:\/\//i, '')
  const right = b.replace(/^\.?\//, '').replace(/^file:\/\//i, '')
  if (left === right) return true
  const base = (value: string): string => (value.split(/[?#]/, 1)[0] ?? value).split('/').pop() ?? value
  return base(left) === base(right)
}

function scoreCandidate(match: LinkMatch, wanted: { target: string, text: string }): number {
  const textMatches = wanted.text !== '' && displayTextOf(match) === wanted.text
  if (wanted.target && sameTarget(match.target, wanted.target)) return textMatches ? 3 : 2
  return textMatches ? 1 : 0
}

/** The link a rendered element came from, found by matching the element back onto its source line. */
export function linkFromRendered(view: EditorView, element: Element): LocatedLink | null {
  const anchor = element.closest<HTMLElement>('a, img')
  if (!anchor) return null
  if (anchor.hasAttribute('data-tag') || anchor.hasAttribute('data-block-ref')) return null
  const line = sourceLineOf(anchor)
  if (line === null || line + 1 > view.state.doc.lines) return null
  const doc = view.state.doc.line(line + 1)
  const wanted = renderedIdentity(anchor)
  let best: { match: LinkMatch, score: number } | null = null
  for (const match of collectLinks(doc.text, ALL_LINK_KINDS)) {
    const score = scoreCandidate(match, wanted)
    if (score > 0 && (!best || score > best.score)) best = { match, score }
  }
  if (!best) return null
  const rect = anchor.getBoundingClientRect()
  return {
    match: best.match,
    from: doc.from + best.match.start,
    to: doc.from + best.match.end,
    anchor: rect.width || rect.height ? rect : new DOMRect(rect.left, rect.top, 1, 1),
  }
}

/** The link under a position in the note's own text, with its painted rectangle for the panel to hang from. */
export function linkFromPoint(view: EditorView, pos: number): LocatedLink | null {
  const line = view.state.doc.lineAt(pos)
  const match = findLinkAt(line.text, pos - line.from, ALL_LINK_KINDS)
  if (!match) return null
  const from = line.from + match.start
  const to = line.from + match.end
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to)
  if (!start) return { match, from, to, anchor: new DOMRect(0, 0, 1, 1) }
  const left = end ? Math.min(start.left, end.left) : start.left
  const right = end ? Math.max(start.right, end.right) : start.right
  return { match, from, to, anchor: new DOMRect(left, start.top, Math.max(1, right - left), Math.max(1, start.bottom - start.top)) }
}

const FENCE_NODES = new Set(['FencedCode', 'CodeBlock'])

/** Whether a position belongs to a fenced block, whose `#` and `[x](y)` are sample text, not markup. */
export function insideFencedCode(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos)
  let found = false
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (FENCE_NODES.has(node.name) && node.from <= pos && node.to >= pos) {
        found = true
        return false
      }
      return undefined
    },
  })
  return found
}

/** The character offset a 0-based line starts at, keeping the note's own end-of-line style. */
export function lineStartOffset(content: string, line: number): number {
  const { lines, eol } = splitLines(content)
  let offset = 0
  for (let index = 0; index < line && index < lines.length; index++) offset += lines[index]!.length + eol.length
  return offset
}

/**
 * The link a rendered element came from, when the note's text is all there is — reading mode has no
 * editor open underneath the preview, so the span has to be found by arithmetic instead of by `posAtDOM`.
 */
export function linkFromContentLine(content: string, line: number, element: Element | null, ch?: number): LocatedLink | null {
  const { lines } = splitLines(content)
  const text = lines[line]
  if (text === undefined) return null
  const base = lineStartOffset(content, line)
  if (ch !== undefined) {
    const match = findLinkAt(text, ch, ALL_LINK_KINDS)
    if (!match) return null
    return { match, from: base + match.start, to: base + match.end, anchor: element?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1) }
  }
  if (!element) return null
  const wanted = renderedIdentity(element)
  let best: { match: LinkMatch, score: number } | null = null
  for (const match of collectLinks(text, ALL_LINK_KINDS)) {
    const score = scoreCandidate(match, wanted)
    if (score > 0 && (!best || score > best.score)) best = { match, score }
  }
  if (!best) return null
  const rect = element.getBoundingClientRect()
  return {
    match: best.match,
    from: base + best.match.start,
    to: base + best.match.end,
    anchor: rect.width || rect.height ? rect : new DOMRect(rect.left, rect.top, 1, 1),
  }
}

/** The reference's edge guard: a click on the first or last pixel of a link places the cursor instead. */
export function edgeProtected(located: LocatedLink, event: MouseEvent): boolean {
  return event.clientX <= located.anchor.left + EDGE_BUFFER || event.clientX >= located.anchor.right - EDGE_BUFFER
}

export function requestLinkEditor(located: LocatedLink, noteId: string, view: EditorView | null, focusTarget?: 'text' | 'target'): void {
  openLinkEditor({
    anchor: located.anchor,
    noteId,
    match: located.match,
    from: located.from,
    to: located.to,
    view,
    focusTarget,
  })
}

const EMPTY_LINK: LinkMatch = {
  kind: 'url',
  embed: false,
  image: false,
  raw: '',
  start: 0,
  end: 0,
  text: '',
  target: '',
  hasText: false,
}

/**
 * The command's entry point: edit the link the cursor is on, or write one where it stands.
 *
 * A cursor sitting at either end of a link counts as being on it, because that is where a reader who
 * means "link this word" usually is; the selection is then taken as the link's own text.
 */
export function openLinkAtCursor(view: EditorView): boolean {
  const noteId = noteIdForView(view)
  if (!noteId) return false
  const range = view.state.selection.main
  if (range.empty) {
    const located = linkFromPoint(view, range.head) ?? linkFromPoint(view, range.head - 1)
    if (located) {
      requestLinkEditor(located, noteId, view)
      return true
    }
  }
  const head = range.empty ? range.head : range.from
  const line = view.state.doc.lineAt(head)
  const selected = view.state.sliceDoc(range.from, range.to)
  const rect = view.coordsAtPos(head)
  openLinkEditor({
    anchor: rect ? new DOMRect(rect.left, rect.top, 1, Math.max(1, rect.bottom - rect.top)) : new DOMRect(0, 0, 1, 1),
    noteId,
    match: {
      ...EMPTY_LINK,
      kind: selected ? 'markdown' : 'url',
      raw: selected,
      start: head - line.from,
      end: range.to - line.from,
      text: selected,
      hasText: true,
    },
    from: range.from,
    to: range.to,
    view,
    focusTarget: 'target',
    creating: true,
    replaces: selected,
  })
  return true
}

export function openLinkTarget(target: string, currentNoteId: string): void {
  const value = target.trim()
  if (!value) return
  if (isExternalTarget(value)) {
    if (!isSafeExternalUrl(value)) {
      useUi.getState().toast({ title: t('links.unsafe_target'), tone: 'danger' })
      return
    }
    window.open(value, '_blank', 'noopener,noreferrer')
    return
  }
  const { note } = splitTarget(value)
  const id = note ? findNoteIdByTitle(note) : currentNoteId
  if (id && useNotes.getState().notes[id]) {
    void useNotes.getState().openNote(id)
    return
  }
  if (!note) {
    useUi.getState().toast({ title: t('links.need_note_name'), tone: 'warning' })
    return
  }
  void useNotes.getState().createNote({ title: note, open: true })
}

function takeGesture(located: LocatedLink, gesture: 'edit' | 'open', event: MouseEvent, noteId: string, view: EditorView | null): boolean {
  if (gesture === 'open') {
    openLinkTarget(located.match.target, noteId)
    return true
  }
  if (edgeProtected(located, event)) return false
  // A rendered block and the editor's own DOM can both answer for one click; reopening the same span
  // would remount the panel and throw the reader's caret away.
  const open = useLinkEditor.getState().request
  if (open && open.noteId === noteId && open.from === located.from && open.to === located.to) return true
  requestLinkEditor(located, noteId, view)
  return true
}

/** The gesture on the note's own text, where a link is characters rather than an element. */
export function runSourceLinkGesture(event: MouseEvent, view: EditorView, kind: 'click' | 'dblclick', settings: EditorSettings, noteId: string): boolean {
  const gesture = linkGestureFor(event, settings, kind)
  if (!gesture) return false
  if (!view.state.selection.main.empty) return false
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (pos === null || insideFencedCode(view, pos)) return false
  const located = linkFromPoint(view, pos)
  return located ? takeGesture(located, gesture, event, noteId, view) : false
}

/** The gesture on a rendered block, where the element under the pointer has to be matched back to its source. */
export function runRenderedLinkGesture(event: MouseEvent, view: EditorView, element: HTMLElement, kind: 'click' | 'dblclick', settings: EditorSettings, noteId: string): boolean {
  const gesture = linkGestureFor(event, settings, kind)
  if (!gesture) return false
  const located = linkFromRendered(view, element)
  return located ? takeGesture(located, gesture, event, noteId, view) : false
}

/**
 * Open the editor over the link a context menu was raised on.
 *
 * The menu already knows which link it means, but it knows that differently on each side: a character
 * position in the note's text on one, an element plus the source line it was rendered from on the
 * other. Both are turned back into a span here so the menu rows stay one line of code each.
 */
export function editLinkFromMenu(input: {
  noteId: string | null
  content: string
  editorPos: number | null
  previewLine: number | null
  previewElement: Element | null
  view: EditorView | null
}): boolean {
  if (!input.noteId) return false
  if (input.view !== null && input.editorPos !== null) {
    const located = linkFromPoint(input.view, input.editorPos)
    if (located) {
      requestLinkEditor(located, input.noteId, input.view)
      return true
    }
  }
  if (input.previewLine !== null && input.previewElement !== null) {
    const located = linkFromContentLine(input.content, input.previewLine, input.previewElement)
    if (located) {
      requestLinkEditor(located, input.noteId, input.view)
      return true
    }
  }
  return false
}
