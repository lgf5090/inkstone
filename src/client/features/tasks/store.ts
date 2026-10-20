import { create } from 'zustand'

/**
 * The task the edit form was asked to open.
 *
 * `line` and `text` are the same two anchors a tick uses: the line says where to write and the words
 * say which line the reader was looking at, so a note that changed between opening the form and
 * saving it is refused rather than overwritten. Everything else — the current text, the parsed
 * fields — is read when the form opens, because a row can point into a note that is closed.
 */
export interface TaskEditRequest {
  noteId: string
  /** Zero-based line the task sits on. */
  line: number
  /**
   * The words the reader saw on that line, or null when the caller already holds the note's text —
   * the editor, the reading preview and the context menu all do. The words are what refuses a note
   * that moved since the row was drawn; where there is no row, only the live text, the question is
   * already answered.
   */
  text: string | null
}

interface TaskEditorState {
  request: TaskEditRequest | null
  open: (request: TaskEditRequest) => void
  close: () => void
}

export const useTaskEditor = create<TaskEditorState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))

export function openTaskEditor(request: TaskEditRequest): void {
  useTaskEditor.getState().open(request)
}
