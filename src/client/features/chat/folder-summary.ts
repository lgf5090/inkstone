/**
 * One folder, summarised into a note.
 *
 * A vault grows into folders that nobody can hold in their head any more: what is in "Work" by now, which
 * threads run through it, what is still open. That is a question about the shape of a set of notes, so it
 * is asked as a conversation — the assistant reads with its own note tools, under the folder's own scope —
 * and the answer is filed back into the folder it describes.
 *
 * The note is made here rather than by the model. `create_note` has no folder argument, so a model-written
 * summary would land unfiled, away from the notes it is about; and the reader asked for a summary of *this*
 * folder, which means the note belongs in it. The prompt therefore asks for prose only, and the write is
 * ours.
 */
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { lastAnswerText } from './editor-ai'
import { rememberNoteOrigin, withConversationSource } from './save-to-note'
import { startChatAboutFolder } from './start-chat'

/**
 * Read the folder, write the summary, file it.
 *
 * The turn is awaited rather than watched: the reader pressed a menu entry, so the one thing this owes them
 * is a note at the end of it — or a reason why there is none. A thread with nothing in it, or an answer that
 * failed, leaves the vault untouched and says so.
 */
export async function summarizeFolder(folderId: string): Promise<string | null> {
  const folder = useNotes.getState().folders.find((entry) => entry.id === folderId)
  if (!folder) return null
  const toast = useUi.getState().toast
  startChatAboutFolder(folderId)
  await useAssistant.getState().send(t('assistant.folder_summary.prompt', { name: folder.name }))
  const answer = lastAnswerText().trim()
  if (!answer) {
    toast({ title: t('assistant.folder_summary.empty', { name: folder.name }), tone: 'warning' })
    return null
  }
  try {
    const note = await api.notes.create({
      title: t('assistant.folder_summary.title', { name: folder.name }),
      // The summary is a copy of the thread's answer, so it names the thread it came from the same way
      // a saved reply does: the note can be read later without the conversation, but not against it.
      content: withConversationSource(answer, useAssistant.getState().activeId),
      folderId,
    })
    // The summary is written here rather than by the model's own note tool, so its backlink has to be
    // reported the same way a saved reply's is: the note and its thread are one subject.
    void rememberNoteOrigin(note.id, useAssistant.getState().activeId)
    toast({ title: t('assistant.folder_summary.done', { title: note.title }), tone: 'success' })
    // The reader is about to want to read it, and it is in the folder they were looking at.
    void useNotes.getState().openNote(note.id)
    return note.id
  } catch (error) {
    toast({
      title: t('assistant.folder_summary.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return null
  }
}
