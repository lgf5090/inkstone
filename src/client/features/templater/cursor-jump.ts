/**
 * The C4 chord: step the editor to the next `tp.file.cursor(n)` group in the note.
 *
 * A rendered template leaves its markers in the text on purpose (`engine/cursor-markers.ts` explains why),
 * and the write pipeline takes only the *first* group when it inserts. Everything after it stays in the
 * note as visible `<% tp.file.cursor(2) %>` text until somebody deletes it and moves the carets — which is
 * what this does, in one CodeMirror transaction, so one press of Ctrl+Z puts the markers back. That is the
 * whole reason this is a transaction and not a store write: the reader is editing this note, and a change
 * that skips the editor's history is a change they cannot take back.
 *
 * The rules of which group is next, and which markers belong to it, are the engine's. Nothing is
 * re-derived here.
 */
import { EditorSelection, Text } from '@codemirror/state'
import { jumpToNextCursor } from '../../lib/templater/engine/cursor-markers'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { writableNoteEditor } from './editor-surface'

/**
 * Consume one marker group and place the carets it leaves.
 *
 * Returns whether the editor moved. Every way it can refuse is said out loud, because a key that does
 * nothing and explains nothing is how a reader ends up pressing it four times.
 */
export function jumpToNextTemplaterCursor(): boolean {
  const noteId = useUi.getState().activeNoteId
  const view = noteId ? writableNoteEditor(noteId) : null
  if (view === null) {
    // No editor of the open note to work on: a preview-only layout, another pane's view, a split whose
    // editor has not mounted, or nothing open at all. One answer covers all four, and the note is untouched.
    useUi.getState().toast({ title: t('command.no_editor_to_edit'), tone: 'warning' })
    return false
  }
  const jump = jumpToNextCursor(view.state.doc.toString())
  if (jump === null) {
    // The normal state of a note with no template in it, so it is a notice and not an error.
    useUi.getState().toast({ title: t('templater.jump.none') })
    return false
  }
  const state = view.state
  // The carets are measured in the document the deletions produce, and a transaction's `selection` is read
  // in exactly those coordinates — hence the line/column half of `CursorJump` against a `Text` of the new
  // body rather than against the one on screen.
  const next = Text.of(jump.text.split('\n'))
  const points = [...new Set(jump.positions
    .map((position) => Math.min(next.line(position.line + 1).from + position.ch, next.length)))]
    .sort((left, right) => left - right)
  view.dispatch(state.update({
    changes: jump.markers.map((marker) => ({ from: marker.start, to: marker.end })),
    selection: EditorSelection.create(points.map((position) => EditorSelection.cursor(position)), 0),
    scrollIntoView: true,
    userEvent: 'delete.template-cursor',
  }))
  view.focus()
  return true
}
