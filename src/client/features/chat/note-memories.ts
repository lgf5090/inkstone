/**
 * What the assistant remembers about one page, asked from the page.
 *
 * The note's backlink panel answers three questions and this is the third: which threads wrote the page,
 * which were started from it, and what the assistant kept from it. The answer has been stored the whole time
 * — `chat_memories.note_id` names the page a fact was written out as — and only the memory page has ever
 * read that column, so a reader standing on the note could not see the facts it had produced.
 *
 * The read is narrowed by the server, not trimmed in the browser: the route answers a `noteId` with the rows
 * whose own column says that page and nothing else, on an index that starts with the account.
 */
import type { AssistantMemory } from '@shared/assistant'
import { api } from '../../lib/api'
import { navigateToPath } from '../../lib/app-history'
import { useAssistant } from './assistant-store'

/**
 * The published memory read names the memory page's own three filters.
 *
 * The note filter is a fourth, answered by the same route, and `lib/api.ts` belongs to another change this
 * round — so the key is carried on a query type widened here rather than on a request of this module's own.
 * Widening that signature is the edit that retires these two lines.
 */
type PublishedMemoryQuery = NonNullable<Parameters<typeof api.assistant.memories>[0]>
type NoteMemoryQuery = PublishedMemoryQuery & { noteId?: string }

/**
 * The facts written out of this page, current ones only.
 *
 * `current` rather than `all`: the panel is a pointer list beside the editor, and a retired fact about a page
 * the reader is reading now is not something they can act on. The memory page still shows them, with the row
 * that superseded each one.
 */
export async function noteMemories(noteId: string): Promise<AssistantMemory[]> {
  const query: NoteMemoryQuery = { status: 'current', noteId }
  const answer = await api.assistant.memories(query)
  return answer.memories
}

/**
 * Hand the reader from a note to the assistant's own memory page.
 *
 * The facts listed beside a page belong to the assistant: correcting one, retiring it or forgetting it is
 * done on its own page, where the history and the conflict review already are. Repeating that surface inside
 * the notebook would give the reader two places to edit one fact and two answers to disagree.
 */
export function openAssistantMemories(): void {
  navigateToPath('/chat')
  useAssistant.getState().setView('memory')
}
