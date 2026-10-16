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
import { useUi } from '../../store/ui'
import type { MarkdownLinks } from '../preview/MarkdownBody'

function openNote(noteId: string): void {
  const summary = useNotes.getState().notes[noteId]
  if (!summary || summary.deletedAt) {
    useUi.getState().toast({ title: t('assistant.chat.note_gone'), tone: 'warning' })
    return
  }
  navigateToPath(appTab('notes').path)
  void useNotes.getState().openNote(noteId)
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
