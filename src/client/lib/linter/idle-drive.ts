/**
 * The linter's automatic runs.
 *
 * `Lint on save` means "when this app would write the note", which here is the reader's own auto-save
 * delay; `lint while idle` is a delay of its own, and whichever of the two comes first wins. Both wait
 * for the typing to stop, because a rule that counts blank lines cannot judge a document that is still
 * arriving under the caret. Both also step around an input method that is mid-word: replacing the
 * document while a composition is open would throw away what the reader had typed.
 *
 * The drive is armed by the editor's own change callback rather than by the note's text, so opening a
 * note — which fills its content in a beat after the title — is never mistaken for an edit. This lives
 * apart from `drive.ts` so the editor host does not pull the diff library and the reporting into the
 * first paint for a reader who never switches the linter on.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'
import { useSession } from '../../store/session'

export function useLinterDrives(noteId: string | null, view: EditorView | null): () => void {
  const enabled = useSession((state) => state.settings.linter.enabled)
  const lintOnSave = useSession((state) => state.settings.linter.lintOnSave)
  const lintOnIdle = useSession((state) => state.settings.linter.lintOnIdle)
  const autoSaveDelay = useSession((state) => state.settings.editor.autoSaveDelay)
  const timer = useRef<number | undefined>(undefined)
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => () => {
    window.clearTimeout(timer.current)
  }, [noteId])

  return useCallback(() => {
    if (!noteId || !enabled) {
      return
    }
    const delay = Math.min(
      lintOnSave ? Math.max(100, autoSaveDelay) : Number.POSITIVE_INFINITY,
      lintOnIdle > 0 ? lintOnIdle : Number.POSITIVE_INFINITY,
    )
    if (!Number.isFinite(delay)) {
      return
    }
    const target = noteId
    const run = (attempts: number) => {
      if (viewRef.current?.composing) {
        if (attempts > 0) {
          timer.current = window.setTimeout(() => run(attempts - 1), 400)
        }
        return
      }
      // A drive that found nothing to say stays silent: only a real edit or a real error is news.
      void import('./drive').then((drive) => drive.lintAndReport(target, true, viewRef.current))
    }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => run(8), delay)
  }, [noteId, enabled, lintOnSave, lintOnIdle, autoSaveDelay])
}
