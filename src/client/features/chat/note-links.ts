/**
 * The notebook, reached from the assistant's container.
 *
 * A `[[note]]` in a reply is a door the reader can walk through, and the notebook is a different
 * container: following one is an address change plus the store's own open — the same pair the reading
 * app's saved-note links use, which is what keeps the note's pane, revision and scroll handled in one
 * place. A title the vault does not have yet is offered as a new note rather than a dead word, which is
 * what the preview pane does when the reader clicks one there.
 */
import { appTab } from '../shell/app-tabs'
import { navigateToPath } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { useUi, type WorkspacePane } from '../../store/ui'
import type { MarkdownLinks } from '../preview/MarkdownBody'

/**
 * Whether the note is still there to be read.
 *
 * The id can outlive the page: a thread names a note the reader has since deleted, and a press that did
 * nothing would look like a broken control rather than a missing document.
 */
function noteIsReadable(noteId: string): boolean {
  const summary = useNotes.getState().notes[noteId]
  if (summary && !summary.deletedAt) return true
  useUi.getState().toast({ title: t('assistant.chat.note_gone'), tone: 'warning' })
  return false
}

/**
 * The pane a citation lands in: the one behind what the reader is already reading.
 *
 * A citation is asked for the page a claim came from, and the page the reader has open is the one they will
 * want back — so a two-pane workspace reveals it in the column that is not focused and leaves the reader
 * where they were. A single-pane workspace has no column behind: the note takes the only pane it can have.
 */
function paneBehindReader(): { pane: WorkspacePane, activate: boolean } {
  const ui = useUi.getState()
  if (!ui.workspaceSecondaryNoteId) return { pane: 'primary', activate: true }
  return { pane: ui.activeWorkspacePane === 'secondary' ? 'primary' : 'secondary', activate: false }
}

/** Follows a note into the notebook. Exported for the surfaces that have an id and no link, like a saved reply. */
export function openNote(noteId: string): void {
  if (!noteIsReadable(noteId)) return
  navigateToPath(appTab('notes').path)
  void useNotes.getState().openNote(noteId)
}

/**
 * Follows a citation into the notebook without moving the reader's own page.
 *
 * The same door as {@link openNote} — address change plus the store's open, so the pane, revision and
 * scroll stay handled in one place — with one difference: it names the pane the answer is read beside.
 */
export function openCitedNote(noteId: string): void {
  if (!noteIsReadable(noteId)) return
  navigateToPath(appTab('notes').path)
  void useNotes.getState().openNote(noteId, paneBehindReader())
}

function createMissingNote(title: string): void {
  const existing = findNoteByTitle(title)
  if (existing) {
    openNote(existing.id)
    return
  }
  navigateToPath(appTab('notes').path)
  void useNotes.getState().createNote({ title, open: true }).then((id) => {
    if (id) useUi.getState().toast({ title: t('assistant.chat.note_created', { title }), tone: 'success' })
  })
}

/** One object for every reply on screen: a fresh literal per message would be a new identity per render. */
export const CHAT_NOTE_LINKS: MarkdownLinks = { openNote, createNote: createMissingNote }
