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
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { sendForAnswer } from './editor-ai'
import { openNote } from './note-links'
import { rememberNoteOrigin, withConversationSource } from './save-to-note'
import { startChatAboutFolder } from './start-chat'

/**
 * Read the folder, write the summary, file it.
 *
 * The turn is awaited rather than watched: the reader pressed a menu entry, so the one thing this owes them
 * is a note at the end of it — or a reason why there is none. A thread with nothing in it, an answer that
 * failed, a turn the reader stopped and a run that could not start because another answer is still on its
 * way all leave the vault untouched and say so.
 *
 * The answer is read from the turn this call sent, never from the newest row on the screen: the text is
 * filed under the folder's own name, so anything else in the notebook would become a lie in a note.
 */
export async function summarizeFolder(folderId: string): Promise<string | null> {
  const folder = useNotes.getState().folders.find((entry) => entry.id === folderId)
  if (!folder) return null
  const toast = useUi.getState().toast
  const running = useAssistant.getState().turn
  if (running && !running.done) {
    // Starting here would not start: the store refuses a second turn, and the reader would watch the
    // menu do nothing at all.
    toast({ title: t('assistant.edit.busy'), tone: 'warning' })
    return null
  }
  startChatAboutFolder(folderId)
  const answer = await sendForAnswer(t('assistant.folder_summary.prompt', { name: folder.name }))
  if (!answer) {
    toast({ title: t('assistant.folder_summary.empty', { name: folder.name }), tone: 'warning' })
    return null
  }
  // Read after the turn, not before it: the thread is made by its first turn.
  const conversationId = useAssistant.getState().activeId
  const title = t('assistant.folder_summary.title', { name: folder.name })
  try {
    // Through the notes store rather than the HTTP call: a note the store does not carry cannot be
    // opened, because the notebook's own open refuses a row it has never seen.
    const id = await useNotes.getState().createNote({
      title,
      // The summary is a copy of the thread's answer, so it names the thread it came from the same way
      // a saved reply does: the note can be read later without the conversation, but not against it.
      content: withConversationSource(answer, conversationId),
      folderId,
      // The reveal below is what puts it on the page; the store's own version would only set the
      // pointer, and the summary is about to be opened as a note, not as an id.
      open: false,
    })
    if (!id) {
      toast({ title: t('assistant.folder_summary.failed'), tone: 'danger' })
      return null
    }
    // The summary is written here rather than by the model's own note tool, so its backlink has to be
    // reported the same way a saved reply's is: the note and its thread are one subject.
    const recorded = await rememberNoteOrigin(id, conversationId)
    toast({
      title: t('assistant.folder_summary.done', { title }),
      tone: 'success',
      action: { label: t('assistant.chat.saved_note_open'), run: () => openNote(id) },
    })
    if (!recorded) {
      // The note exists and its thread exists; only the link between them is missing, which is worth
      // saying and not worth failing the whole command for.
      toast({ title: t('assistant.folder_summary.backlink_failed'), tone: 'warning' })
    }
    // The reader is about to want to read it, and it is in the folder they were looking at.
    openNote(id)
    return id
  } catch (error) {
    toast({
      title: t('assistant.folder_summary.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return null
  }
}
