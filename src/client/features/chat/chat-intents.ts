/**
 * A chat action a command asked for before the view was standing.
 *
 * The palette, a hotkey and a note's menu can all say "find in this thread" while the reader is looking
 * at the library, and the three things they want to move are the chat view's own state: the find panel,
 * the conversation list's search box and the composer's model picker. None of them belongs in the
 * assistant's store — that holds what the server knows — and none of them can be reached from outside a
 * mounted component. So the ask is left here, and the view takes it the moment it is up.
 *
 * A handover rather than an event bus: one pending intention, spent on arrival, because two queued asks
 * would have to decide which one the reader meant.
 */
import { create } from 'zustand'

export type ChatIntent = 'find' | 'conversation-search' | 'model'

interface ChatIntentState {
  /** The ask the view has not taken yet; null once it has been spent or nothing was asked. */
  intent: ChatIntent | null
  request: (intent: ChatIntent) => void
  clear: () => void
}

export const useChatIntent = create<ChatIntentState>((set) => ({
  intent: null,
  request: (intent) => set({ intent }),
  clear: () => set({ intent: null }),
}))

/** Leave the ask for the chat view, wherever the reader is standing when it is made. */
export function requestChatIntent(intent: ChatIntent): void {
  useChatIntent.getState().request(intent)
}
