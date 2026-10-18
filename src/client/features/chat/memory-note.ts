/**
 * The note a memory names, read from the memory's own side.
 *
 * `chat_memories.note_id` says which page a fact was written out as, and the memory row has carried a button
 * promising to open it for as long as the column has existed. The promise outlives the page: purging a note
 * from the trash clears the pointer, but a note that is only *in* the trash, a restore that brought the facts
 * without the pages, and a device that has not yet heard about a deletion all leave a row pointing at
 * something that cannot be opened — where the press did nothing at all rather than saying why.
 *
 * So the state is read rather than assumed, and it is read from the notebook's own list, because `hydrated`
 * is what says that list is the whole one. Before the list has been read the page cannot be called gone:
 * nothing has established that it is missing, and a row that announced a deletion the browser had not looked
 * up would be a worse answer than the plain entry.
 */
import type { AssistantMemory } from '@shared/assistant'
import type { NoteSummary } from '@shared/types'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'

/** What the row is allowed to say about the note its memory names. */
export type NotePointer =
  | { state: 'none' }
  /** Pressable. `title` is the notebook's name for the page, or null while the list has not been read. */
  | { state: 'open'; title: string | null }
  /** The page is not there: said out loud, with taking the pointer off offered as the reader's own fix. */
  | { state: 'gone' }

/**
 * Which of those states this row is in.
 *
 * A note the list carries with `deletedAt` set is in the trash — still a row in the database, still not a
 * page the reader can be sent to — so it is called gone rather than left as a link that goes nowhere.
 */
export function notePointer(
  memory: Pick<AssistantMemory, 'noteId'>,
  notes: Record<string, NoteSummary>,
  hydrated: boolean,
): NotePointer {
  if (!memory.noteId) return { state: 'none' }
  const note = notes[memory.noteId]
  if (note && !note.deletedAt) return { state: 'open', title: note.title || null }
  if (!note && !hydrated) return { state: 'open', title: null }
  return { state: 'gone' }
}

/** Go to the page a fact was written out as, the way every other note entry in the app does it. */
export function openMemoryNote(noteId: string): void {
  navigateToPath('/notes')
  void useNotes.getState().openNote(noteId)
}

/**
 * Take a dead pointer off a fact.
 *
 * Nothing else fixes the row: the note is not coming back because the reader pressed a button, and the
 * pointer with nothing behind it is what made the entry a dead link. Clearing it is the reader's own
 * `POST /memories/:id/note` with `null`, which the route already treats as a value rather than as a missing
 * field — and a refusal is named, not swallowed, because a row that merely looked unchanged reads as a
 * control that does nothing.
 */
export async function unlinkMemoryNote(memoryId: string): Promise<boolean> {
  try {
    await api.assistant.memoryNote(memoryId, null)
  } catch (error) {
    useUi.getState().toast({
      title: t('assistant.memory.note_link_kept'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return false
  }
  // The page re-reads itself rather than patching one row: the answer the server gave is the version the
  // rest of the list is drawn from too, and the row's own state comes from the notebook's note list.
  await useAssistant.getState().loadMemories()
  return true
}
