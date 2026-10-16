/**
 * Keeping a reply.
 *
 * An answer worth having is often the start of a note — a procedure, a summary, a plan — and the
 * alternative is selecting text in a chat bubble and retyping the title in the notebook. The note is
 * created through the notes store rather than the raw API so it lands the way a note made anywhere else
 * does: in the list, queued for sync, openable from the toast that announces it.
 */

import { titleFromMessage } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { openNote } from './note-links'

/**
 * The first line of prose in a reply, without the marks that made it a heading or a list item.
 *
 * A reply usually opens with a heading, so the title is the heading's own words rather than a run of
 * `#` in front of them — the marks are structure for the body and noise in a name.
 */
export function leadingProse(source: string): string {
  const line = source.split(/\r?\n/).map((row) => row.trim()).find(Boolean) ?? ''
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`~]/g, '')
    .trim()
}

/** Writes a reply into a new note, and offers the reader the way in. */
export function saveReplyAsNote(body: string): void {
  const title = titleFromMessage(leadingProse(body)) || t('assistant.chat.saved_note_untitled')
  void useNotes.getState().createNote({ title, content: body, open: false }).then((id) => {
    if (!id) {
      useUi.getState().toast({ title: t('assistant.toast.failed'), tone: 'danger' })
      return
    }
    useUi.getState().toast({
      title: t('assistant.chat.saved_to_note', { title }),
      tone: 'success',
      action: { label: t('assistant.chat.saved_note_open'), run: () => openNote(id) },
    })
  })
}
