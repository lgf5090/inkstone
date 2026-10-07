import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import { normalizeLinkKey } from '@shared/markdown-utils'
import type { LinkMatch } from './link-syntax'
import { useNotes } from '../../store/notes'

export interface LinkEditorRequest {
  /** The box the panel hangs from: the link's own pixels, or the caret when one is being written. */
  anchor: DOMRect
  noteId: string
  match: LinkMatch
  /** Character span `match.raw` occupies in the note's markdown. */
  from: number
  to: number
  /** Present when the link was read out of a live editor, which is where the write goes back. */
  view: EditorView | null
  focusTarget?: 'text' | 'target'
  /** True when the panel is writing a link that is not in the note yet. */
  creating?: boolean
  /** What the first write is allowed to overwrite; defaults to the link's own text. */
  replaces?: string
}

interface LinkEditorState {
  request: LinkEditorRequest | null
  open: (request: LinkEditorRequest) => void
  close: () => void
}

export const useLinkEditor = create<LinkEditorState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))

export function openLinkEditor(request: LinkEditorRequest): void {
  useLinkEditor.getState().open(request)
}

export function closeLinkEditor(): void {
  useLinkEditor.getState().close()
}

export type LinkWriteResult = 'written' | 'moved' | 'unloaded'

/** The text the panel's next write is allowed to replace. */
export function spanPayload(request: LinkEditorRequest): string {
  return request.replaces ?? (request.creating ? '' : request.match.raw)
}

/**
 * Replace the span the panel was opened on, refusing when the note moved underneath it.
 *
 * The check is the point: a link's span is a character range, and between opening the panel and
 * pressing Enter a sync patch, a second pane, or an outline drag can all shift it. Writing to a
 * range that no longer holds the link would rewrite unrelated text, so the edit is dropped and the
 * caller tells the reader instead of guessing.
 */
export function writeLinkSpan(request: LinkEditorRequest, next: string): LinkWriteResult {
  const expected = spanPayload(request)
  if (request.view) {
    const doc = request.view.state.doc
    if (doc.sliceString(request.from, request.to) !== expected) return 'moved'
    request.view.dispatch({
      changes: { from: request.from, to: request.to, insert: next },
      selection: { anchor: request.from + next.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    })
    request.view.focus()
    return 'written'
  }
  const content = useNotes.getState().contents[request.noteId]
  if (content === undefined) return 'unloaded'
  if (content.slice(request.from, request.to) !== expected) return 'moved'
  useNotes.getState().editContent(request.noteId, `${content.slice(0, request.from)}${next}${content.slice(request.to)}`)
  return 'written'
}

export function findNoteIdByTitle(title: string): string | null {
  const key = normalizeLinkKey(title.replace(/\.md$/i, ''))
  if (!key) return null
  const notes = useNotes.getState().notes
  for (const summary of Object.values(notes)) {
    if (summary.deletedAt) continue
    if (normalizeLinkKey(summary.title) === key) return summary.id
  }
  return null
}

/**
 * Which note an editor is showing.
 *
 * A command is handed the `EditorView` and nothing else, so the surfaces that run one — the toolbar,
 * the palette, the keymap — need this to know which note a link belongs to. The editor registers
 * itself for as long as it is mounted.
 */
const noteByView = new WeakMap<EditorView, string>()

export function registerLinkEditorNote(view: EditorView, noteId: string): void {
  noteByView.set(view, noteId)
}

export function noteIdForView(view: EditorView): string | null {
  return noteByView.get(view) ?? null
}
