import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

// The show is the one surface in this app allowed to take the browser's own full screen —
// `tests/fullscreen-policy.test.ts` lists this file as its only owner — because the element it asks
// for is the dialog's panel, which lives unchanged for the whole session. A widget whose element is
// re-rendered out of the document loses the full screen mid-talk, which is why every other "full
// screen" in the app routes to an in-app overlay instead.
//
// A refusal used to vanish: `console.debug` sits below this app's warn/error logging floor, and on
// the keyboard path the presenter pressed a key and watched nothing happen. The show is perfectly
// usable without the full screen, so what is owed here is a sentence about what the browser said,
// not an error state.
export function useFullscreenToggle(open: boolean, panelRef: RefObject<HTMLDivElement | null>): {
  isFullscreen: boolean
  toggleFullscreen: () => void
} {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const refuse = useCallback((scope: string, error: unknown, asked: boolean) => {
    console.warn(`[inkstone] ${scope}`, error)
    // Only a request somebody pressed for gets told out loud. The show reaching for the full screen
    // on its own at the start of a talk is not something the presenter did, and a talk should not
    // open with an apology — the log carries that one, and the button keeps telling the truth.
    if (asked) useUi.getState().toast({ title: t('workspace.presentation_fullscreen_denied'), tone: 'warning' })
  }, [])
  const enter = useCallback((asked: boolean) => {
    const panel = panelRef.current
    if (!panel || document.fullscreenElement) return
    if (typeof panel.requestFullscreen !== 'function') {
      refuse('fullscreen request unsupported by this browser', undefined, asked)
      return
    }
    const pending = panel.requestFullscreen()
    pending?.catch?.((error: unknown) => refuse('fullscreen request rejected', error, asked))
  }, [panelRef, refuse])
  const exit = useCallback((asked: boolean) => {
    if (!panelRef.current || document.fullscreenElement !== panelRef.current || typeof document.exitFullscreen !== 'function') return
    document.exitFullscreen().catch((error: unknown) => refuse('exit fullscreen rejected', error, asked))
  }, [panelRef, refuse])
  // Starting the show enters fullscreen, and the request has to happen while the
  // click that opened the overlay is still a user gesture: a layout effect runs inside that same
  // task, a plain effect after it does not.
  useLayoutEffect(() => {
    if (open) enter(false)
  }, [open, enter])
  useEffect(() => {
    if (!open) return
    const owned = () => document.fullscreenElement === panelRef.current
    const sync = () => setIsFullscreen(owned())
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      // Leaving the show must not leave the browser holding the app fullscreen.
      if (owned()) exit(false)
    }
  }, [open, panelRef, exit])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === panelRef.current) exit(true)
    else enter(true)
  }, [enter, exit, panelRef])
  return { isFullscreen, toggleFullscreen }
}
