import { getActiveEditorView } from '../../editor/commands'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { usePresentation } from '../../store/presentation'
import { useUi } from '../../store/ui'
import { findSlideIndexByOffset } from './slides'

/**
 * Puts the named note on the projector: the workspace button, the command palette and the
 * global shortcut all open the same show, so the slide the deck starts on is computed here
 * and nowhere else. The cursor decides it — a talk resumed from the middle of a long note
 * should not begin at its title slide.
 *
 * A note that is gone by the time the command runs opens nothing, and says so here rather than
 * in the three callers: an empty return value they all threw away was indistinguishable from a
 * control that does nothing.
 */
export function startPresentationFromNote(noteId: string): boolean {
  const state = useNotes.getState()
  const note = state.notes[noteId]
  if (!note) {
    useUi.getState().toast({ title: t('workspace.presentation_start_no_note'), tone: 'warning' })
    return false
  }
  const content = state.contents[noteId] ?? ''
  const offset = getActiveEditorView()?.state.selection.main.head ?? 0
  usePresentation.getState().start({ noteId, content, title: note.title, initialSlideIndex: findSlideIndexByOffset(content, offset) })
  return true
}
