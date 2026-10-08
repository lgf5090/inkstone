/**
 * Moving the reader to a match. The index holds offsets into the note body, and the editor is the only
 * surface that can show one — so a result either lands the caret in the source or says nothing at all.
 */
import { EditorView } from '@codemirror/view'
import { getActiveEditorView } from '../../editor/commands'
import { noteIdForView } from '../links/store'

const REVEAL_WAIT_MS = 1800
const REVEAL_POLL_MS = 60

function viewForNote(noteId: string): EditorView | null {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'))) {
    const view = EditorView.findFromDOM(element)
    if (view && noteIdForView(view) === noteId) return view
  }
  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/**
 * Select and centre `from..to` in the note's editor. The pane may still be loading the body, so this
 * waits briefly for the view to appear; a note open in reading mode has no editor to land in, and the
 * caller is told so rather than silently scrolling elsewhere.
 */
export async function revealInNote(noteId: string, from: number, to: number, focus: boolean): Promise<boolean> {
  const deadline = Date.now() + REVEAL_WAIT_MS
  for (;;) {
    const view = viewForNote(noteId)
    if (view) {
      const length = view.state.doc.length
      if (length === 0) return true
      const start = Math.max(0, Math.min(from, length))
      const end = Math.max(start, Math.min(to, length))
      view.dispatch({
        selection: { anchor: start, head: end },
        effects: EditorView.scrollIntoView(start, { y: 'center' }),
        userEvent: 'select.search',
      })
      if (focus) view.focus()
      return true
    }
    if (Date.now() >= deadline) return false
    await wait(REVEAL_POLL_MS)
  }
}

/** Insert at the caret of the editor the reader is actually in. */
export function insertAtActiveCursor(text: string): boolean {
  const view = getActiveEditorView()
  if (!view) return false
  view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true })
  view.focus()
  return true
}
