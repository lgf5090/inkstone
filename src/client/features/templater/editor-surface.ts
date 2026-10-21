/**
 * The note editor a Templater run may write through, or nothing.
 *
 * Two of this feature's surfaces — a run that splices text into the open note, and the cursor jump that
 * deletes markers from it — need the same answer, and a run that got it wrong would put a caret in the
 * wrong pane or replace text the reader cannot undo. The rule is the one the template host already holds
 * for `tp.file.append_at_cursor` (`lib/templater/host/store-port.ts`): a view that is on screen, not inert,
 * and not read-only. This adds the one check that module cannot make, because it never sees a note id: the
 * view has to be the editor *of the note the run is about*.
 *
 * That last check is not decoration. `getActiveEditorView()` names the editor that mounted last, so with
 * the workspace split it is whichever pane was opened last rather than the one under the reader's keys —
 * and a template whose selection came from the other pane would write into this note at those offsets.
 * `noteIdForView` is what the link editor keeps for the same reason, and the palette asks it the same way.
 */
import type { EditorView } from '@codemirror/view'
import { t } from '../../lib/i18n'
import { getActiveEditorView } from '../../editor/commands'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { noteIdForView } from '../links/store'

/** What the first selection of an editor holds, in the shape a run wants it. */
export interface EditorSelectionSnapshot {
  from: number
  to: number
  text: string
}

/**
 * The note a run that writes into the open note may be started against, saying why when it cannot.
 *
 * Both doors need this answer — the command before it opens a chooser the reader would have to fill in for
 * nothing, and the run itself before it reads a document — so the rule and its sentence live here once.
 */
export function requireOpenNote(): string | null {
  const ui = useUi.getState()
  const id = ui.activeNoteId
  const summary = id ? useNotes.getState().notes[id] : null
  if (!id || !summary || summary.deletedAt !== null) {
    ui.toast({ title: t('templates.no_note_to_insert_into'), tone: 'warning' })
    return null
  }
  return id
}

export function writableNoteEditor(noteId: string): EditorView | null {
  const view = getActiveEditorView()
  if (!view) return null
  if (!view.dom.isConnected || view.dom.closest('[inert]') !== null) return null
  if (view.state.readOnly) return null
  return noteIdForView(view) === noteId ? view : null
}

export function selectionOf(view: EditorView): EditorSelectionSnapshot {
  const { from, to } = view.state.selection.main
  return { from, to, text: view.state.sliceDoc(from, to) }
}
