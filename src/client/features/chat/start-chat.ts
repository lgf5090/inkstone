/**
 * Starting a conversation that is about one note, or one folder.
 *
 * The composer can be pointed at a note by hand, but "what did I decide about this?" is asked from the
 * thing itself — the row in the list, the folder in the tree — and a reader who has to open the assistant,
 * start a thread and then find the note has already lost the thought. So the command starts the thread and
 * pins the scope before the reader types: a new conversation, one chip, the composer waiting.
 *
 * A new conversation rather than the open one: the pin would otherwise follow them into a thread about
 * something else, and the chips of a thread are the record of what it was asked about. What is *not* done
 * here is sending anything — the question is the reader's, and a menu entry that asked it for them would be
 * guessing at it.
 */
import { tabIdForPath } from '../shell/app-tabs'
import { currentPathname, navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'

/** Put the assistant in front of the reader: the notebook's dock where it exists, the chat tab otherwise. */
function surfaceAssistant(): void {
  if (tabIdForPath(currentPathname()) === 'notes') {
    useUi.getState().setAssistantDock(true)
    return
  }
  navigateToPath('/chat')
}

function beginWithScope(scope: { kind: 'note' | 'folder', id: string, name: string }): void {
  const assistant = useAssistant.getState()
  assistant.setView('chat')
  assistant.newConversation()
  assistant.addTurnScope(scope)
  surfaceAssistant()
}

export function startChatAboutNote(noteId: string): void {
  const note = useNotes.getState().notes[noteId]
  if (!note || note.deletedAt) return
  beginWithScope({ kind: 'note', id: noteId, name: note.title })
}

export function startChatAboutFolder(folderId: string): void {
  const folder = useNotes.getState().folders.find((entry) => entry.id === folderId)
  if (!folder) return
  beginWithScope({ kind: 'folder', id: folderId, name: folder.name })
}

/**
 * Open a stored conversation from wherever the reader is.
 *
 * A note can point at a thread (`![[chat:…]]`), and following that pointer is not a scope change — it
 * is "show me what we said". So the thread is opened as it is, and the tab switch is the same one every
 * other entry point uses. A turn named here is the one the reader was looking at when they left the note,
 * so the thread opens around it instead of at its newest page.
 */
export function openConversationInChat(conversationId: string, messageId?: string): void {
  navigateToPath('/chat')
  const assistant = useAssistant.getState()
  assistant.setView('chat')
  void assistant.openConversation(conversationId, messageId ? { focusMessageId: messageId } : undefined)
}
