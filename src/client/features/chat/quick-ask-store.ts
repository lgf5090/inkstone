/**
 * The little Ask panel that floats beside the note.
 *
 * It is deliberately not the main conversation: opening Quick Ask must not change which thread the
 * chat tab is showing. The turn is sent as an ephemeral conversation, so its words are kept for the
 * retention window but never appear in the history list the reader browses.
 */
import { create } from 'zustand'

export interface QuickAskContext {
  noteId: string | null
  noteTitle: string
  selection: string
  whole: string
  from: number
  to: number
}

export interface QuickAskState {
  open: boolean
  context: QuickAskContext
  anchor: { top: number, left: number } | null
  openPanel: (context: QuickAskContext, anchor?: { top: number, left: number } | null) => void
  close: () => void
}

export const useQuickAsk = create<QuickAskState>((set) => ({
  open: false,
  context: { noteId: null, noteTitle: '', selection: '', whole: '', from: 0, to: 0 },
  anchor: null,
  openPanel: (context, anchor = null) => set({ open: true, context, anchor }),
  close: () => set({ open: false }),
}))
