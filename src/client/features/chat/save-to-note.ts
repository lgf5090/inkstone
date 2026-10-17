/**
 * Keeping a reply, or a whole conversation.
 *
 * An answer worth having is often the start of a note — a procedure, a summary, a plan — and the
 * alternative is selecting text in a chat bubble and retyping the title in the notebook. The note is
 * created through the notes store rather than the raw API so it lands the way a note made anywhere else
 * does: in the list, queued for sync, openable from the toast that announces it.
 *
 * A saved note names the thread it came from, because the note is a copy and the thread is the record:
 * `![[chat:<id>]]` is the embed the notebook already renders, so the way back is the same door the
 * conversation menu draws by hand. The whole conversation can be kept the same way, and a reply can be
 * inserted into the note the reader has open instead of becoming a second note.
 */

import { titleFromMessage, type AssistantMessage } from '@shared/assistant'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { isChatEmbedId } from '../../lib/markdown/chat-embed'
import { getActiveEditorView } from '../../editor/commands'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { openNote } from './note-links'
import { insertBlockAt } from './editor-ai'
import { useAssistant } from './assistant-store'
import { transcriptMarkdown } from './transcript'

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
 * The block that points a saved note back at its conversation.
 *
 * Empty for a missing or malformed id: a note is not the place to discover that a caller passed an
 * id-shaped mistake, and the embed renderer would draw that as a broken box.
 */
export function conversationSourceBlock(conversationId: string | null | undefined): string {
  if (!conversationId || !isChatEmbedId(conversationId)) return ''
  return `---\n\n![[chat:${conversationId}]]`
}

/**
 * The note body with the source block appended once.
 *
 * A body that already names the thread is left alone: the side panel saves a note from the draft it is
 * showing, and a draft may already carry the embed a menu row put there.
 */
export function withConversationSource(body: string, conversationId: string | null | undefined): string {
  const trimmed = body.trimEnd()
  const block = conversationSourceBlock(conversationId)
  if (!block || trimmed.includes(`![[chat:${conversationId}]]`)) return body
  return `${trimmed}\n\n${block}`
}

/**
 * Tell the worker which thread a saved note came from.
 *
 * The note is written by the browser, so the worker never sees the save; this report is what puts the
 * note in the thread's backlinks, and it is best-effort by design: the note exists either way, and a
 * missing backlink must not turn a successful save into an error. The failure is logged rather than
 * shown because the reader's outcome did not change.
 */
export async function rememberNoteOrigin(noteId: string, conversationId: string | null | undefined): Promise<void> {
  if (!conversationId) return
  try {
    await api.assistant.recordNoteWrite(noteId, conversationId)
  } catch (error) {
    console.warn('[inkstone] could not record the note origin', error)
  }
}

/**
 * A conversation's title for the note it becomes: its own name, else the opening question.
 *
 * A thread started from a prompt often has no title until the server names it after the first answer, so
 * the question is the next-best name — and it is the same first line the reply titles are read from.
 */
export function conversationNoteTitle(title: string, messages: readonly AssistantMessage[]): string {
  const named = title.trim()
  if (named) return named
  const question = messages.find((message) => message.role === 'user' && message.content.trim())
  return titleFromMessage(leadingProse(question?.content ?? '')) || t('assistant.note.conversation_untitled')
}

/**
 * A transcript without the title heading the downloaded file opens with.
 *
 * The note already carries that title, so printing it again is one heading too many in the body.
 */
export function noteBodyFromTranscript(transcript: string): string {
  const body = transcript.trimEnd()
  if (!body.startsWith('# ')) return body
  const end = body.indexOf('\n\n')
  return end < 0 ? '' : body.slice(end + 2)
}

/**
 * Writes a reply into a new note, with a pointer back to the conversation it came from, and offers the
 * reader the way in.
 *
 * The id comes back because a caller may have more to do with the note than announce it: the side panel
 * links the draft it was working on to the note it just made, so the two are one document from then on.
 */
export async function saveReplyAsNote(body: string): Promise<string | null> {
  const title = titleFromMessage(leadingProse(body)) || t('assistant.chat.saved_note_untitled')
  const conversationId = useAssistant.getState().activeId
  const content = withConversationSource(body, conversationId)
  const id = await useNotes.getState().createNote({ title, content, open: false })
  if (!id) {
    useUi.getState().toast({ title: t('assistant.toast.failed'), tone: 'danger' })
    return null
  }
  void rememberNoteOrigin(id, conversationId)
  useUi.getState().toast({
    title: t('assistant.chat.saved_to_note', { title }),
    tone: 'success',
    action: { label: t('assistant.chat.saved_note_open'), run: () => openNote(id) },
  })
  return id
}

/**
 * Writes one whole conversation into a note, and offers the reader the way in.
 *
 * The turns are fetched rather than read from the store: a conversation can be saved from its own row
 * while another thread is open, and the stored rows are what a reader means by "the conversation".
 * The note lands in the conversation's own folder when there is one — a thread filed under Work is about
 * Work, and its note should not fall wherever the list happened to be scoped.
 */
export async function saveConversationAsNote(conversationId?: string | null): Promise<string | null> {
  const toast = useUi.getState().toast
  const id = conversationId ?? useAssistant.getState().activeId
  if (!id) {
    toast({ title: t('assistant.embed.no_conversation'), tone: 'warning' })
    return null
  }
  let detail: Awaited<ReturnType<typeof api.assistant.conversation>>
  try {
    detail = await api.assistant.conversation(id)
  } catch (error) {
    toast({
      title: t('assistant.note.conversation_failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
    return null
  }
  const messages = detail.messages
  // A turn can carry an attachment and no words; the transcript keeps it, and only a thread with
  // nothing at all in it is refused.
  if (!messages.some((message) => message.content.trim() !== '' || (message.attachments?.length ?? 0) > 0)) {
    toast({ title: t('assistant.note.conversation_empty'), tone: 'warning' })
    return null
  }
  const title = conversationNoteTitle(detail.conversation.title, messages)
  const content = withConversationSource(noteBodyFromTranscript(transcriptMarkdown(messages, title)), id)
  const state = useNotes.getState()
  const folderId = detail.conversation.folderId
  const noteId = await state.createNote({
    title,
    content,
    open: false,
    ...(folderId && state.folders.some((folder) => folder.id === folderId) ? { folderId } : {}),
  })
  if (!noteId) {
    toast({ title: t('assistant.toast.failed'), tone: 'danger' })
    return null
  }
  void rememberNoteOrigin(noteId, id)
  toast({
    title: t('assistant.note.conversation_saved', { title }),
    tone: 'success',
    action: { label: t('assistant.chat.saved_note_open'), run: () => openNote(noteId) },
  })
  return noteId
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

/**
 * Put a reply into the note the reader has open, at the caret when the editor is showing it.
 *
 * The caret lives in the editor and the store holds no offset, so an open editor whose document is this
 * note takes the write as one editor transaction — the change appears under the reader's cursor, and one
 * press of undo takes it back. Anywhere else (the chat tab is its own container, so the notebook is not
 * mounted) the paragraph goes to the end of the note through the store: the note the reader last had open
 * is the only fact available, and losing the answer because the notebook is not on screen would be worse.
 *
 * No source block here: a paragraph written into the middle of a document is part of that document, and
 * the conversation embed belongs to a note made from a reply, not to the prose it was pasted into.
 */
export function insertReplyIntoNote(body: string): boolean {
  const text = body.trim()
  if (!text) return false
  const toast = useUi.getState().toast
  const noteId = useUi.getState().activeNoteId
  if (!noteId) {
    toast({ title: t('assistant.note.insert_no_note'), tone: 'warning' })
    return false
  }
  const state = useNotes.getState()
  const content = state.contents[noteId]
  if (content === undefined) {
    toast({ title: t('assistant.edit.note_gone'), tone: 'danger' })
    return false
  }
  const view = getActiveEditorView()
  // The document is compared rather than the note id: a second pane or a pinned window may hold another
  // note, and an offset taken from the wrong document writes the paragraph over an unrelated line. A
  // detached view is the editor that was closed while its last state still names the note: it is not on
  // screen, so it is not where the reader's caret is.
  if (view && view.dom.isConnected && view.state.doc.toString() === content) {
    const at = view.state.selection.main.head
    const next = insertBlockAt(content, at, text)
    const inserted = next.slice(at, next.length - (content.length - at))
    view.dispatch({ changes: { from: at, insert: inserted }, selection: { anchor: at + inserted.length } })
    view.focus()
  } else {
    state.editContent(noteId, insertBlockAt(content, content.length, text))
  }
  toast({
    title: t('assistant.note.inserted', { title: state.notes[noteId]?.title || t('common.untitled_note') }),
    tone: 'success',
  })
  return true
}
