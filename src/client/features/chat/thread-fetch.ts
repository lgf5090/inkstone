/**
 * A whole thread, not just the page the thread view opens with.
 *
 * The transcript is paged: opening a conversation reads its newest page, and the turns above arrive as
 * the reader scrolls. Everything that treats the thread as a document — saving it as a note, exporting
 * it, drawing an embed — needs all of it, so it walks the pages here rather than repeating the loop.
 */

import type { AssistantConversation, AssistantMessage, ChatAttachment } from '@shared/assistant'
import { api } from '../../lib/api'

/** How many turns a page asks for: the same page the thread view uses, so the walks stay few. */
const PAGE = '200'

export interface WholeConversation {
  conversation: AssistantConversation
  messages: AssistantMessage[]
  attachments: ChatAttachment[]
}

export async function fetchWholeConversation(id: string): Promise<WholeConversation> {
  const first = await api.assistant.conversation(id, { limit: PAGE })
  const messages = [...first.messages]
  const attachments = new Map((first.attachments ?? []).map((entry) => [entry.id, entry]))
  let before = first.nextBefore
  let hasMore = first.hasMore === true
  // A bound as well as the cursor: a thread being written into while it is read would otherwise be
  // walked forever, and a file that missed the newest turn is better than a tab that never finishes.
  for (let pages = 0; hasMore && before && pages < 50; pages++) {
    const page = await api.assistant.conversation(id, { limit: PAGE, before })
    messages.unshift(...page.messages)
    for (const entry of page.attachments ?? []) attachments.set(entry.id, entry)
    before = page.nextBefore
    hasMore = page.hasMore === true
  }
  return { conversation: first.conversation, messages, attachments: [...attachments.values()] }
}
