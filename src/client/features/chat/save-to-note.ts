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
import { insertBlockAt } from './editor-ai'
import { useAssistant } from './assistant-store'

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

/**
 * Writes a reply into a new note, and offers the reader the way in.
 *
 * The id comes back because a caller may have more to do with the note than announce it: the side panel
 * links the draft it was working on to the note it just made, so the two are one document from then on.
 */
export async function saveReplyAsNote(body: string): Promise<string | null> {
  const title = titleFromMessage(leadingProse(body)) || t('assistant.chat.saved_note_untitled')
  const id = await useNotes.getState().createNote({ title, content: body, open: false })
  if (!id) {
    useUi.getState().toast({ title: t('assistant.toast.failed'), tone: 'danger' })
    return null
  }
  useUi.getState().toast({
    title: t('assistant.chat.saved_to_note', { title }),
    tone: 'success',
    action: { label: t('assistant.chat.saved_note_open'), run: () => openNote(id) },
  })
  return id
}

/**
 * Put a pointer to the conversation into the note that is open.
 *
 * The note gets `![[chat:<id>]]` and nothing else: the thread is not copied, so it stays one thread.
 * Appending rather than inserting at the caret, because this row is reached from the chat surface —
 * the reader is not looking at the note, and a write in the middle of a paragraph they cannot see
 * would be a change they did not watch happen.
 */
export function embedConversationInNote(): void {
  const conversationId = useAssistant.getState().activeId
  const noteId = useUi.getState().activeNoteId
  const toast = useUi.getState().toast
  if (!conversationId) {
    toast({ title: t('assistant.embed.no_conversation'), tone: 'warning' })
    return
  }
  if (!noteId) {
    toast({ title: t('assistant.embed.no_note'), tone: 'warning' })
    return
  }
  const notes = useNotes.getState()
  const content = notes.contents[noteId]
  if (content === undefined) {
    toast({ title: t('assistant.edit.note_gone'), tone: 'danger' })
    return
  }
  notes.editContent(noteId, insertBlockAt(content, content.length, `![[chat:${conversationId}]]`))
  toast({ title: t('assistant.embed.added'), tone: 'success' })
}
