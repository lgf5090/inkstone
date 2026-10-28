/** What the assistant may know about the hand-written note on screen. */
export const INKNOTE_ASSISTANT_PAGE_TEXT_MAX = 6_000
export const INKNOTE_ASSISTANT_NOTE_TEXT_MAX = 12_000
export const INKNOTE_ASSISTANT_TITLE_MAX = 512
export const INKNOTE_ASSISTANT_ROLE_MAX = 2_000

export interface InknoteAssistantContext {
  noteId: string
  noteTitle: string
  notebookName: string
  pageIndex: number
  pageCount: number
  pageText: string
  noteText?: string
  rolePrompt?: string
}
