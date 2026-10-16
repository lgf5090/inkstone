/**
 * Dragging a conversation onto a folder.
 *
 * A conversation is moved by the same gesture a note is, and by a payload of its own: a note drag carries
 * a note id, and a drop target that read one as the other would file the wrong row — or file a
 * conversation because some note id happened to name it. So the type is distinct, and only the folder
 * row that knows about conversations accepts it.
 */

import type { DragEvent } from 'react'

const CONVERSATION_DRAG_TYPE = 'application/x-inkstone-conversation'

export function writeConversationDrag(event: DragEvent, conversationId: string): void {
  event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, conversationId)
  event.dataTransfer.effectAllowed = 'move'
}

/** The conversation being dragged, or null for a drag that is not a conversation's. */
export function readConversationDrag(event: DragEvent): string | null {
  if (!event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)) return null
  return event.dataTransfer.getData(CONVERSATION_DRAG_TYPE) || null
}

/** True while a conversation is over the target, which is what says the drop is accepted. */
export function isConversationDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)
}
