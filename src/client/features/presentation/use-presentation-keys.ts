import { useCallback, useEffect, useRef, useState } from 'react'
import { presentationCommand, type PresentationCommand } from './presentation-keys'

export type ScreenCoverType = 'black' | 'white' | null

export interface PresentationKeysOptions {
  open: boolean
  slideCount: number
  goNext: () => void
  goPrev: () => void
  jumpTo: (index: number) => void
  toggleFullscreen: () => void
  toggleRail: () => void
  toggleFollowing: () => void
  openPresenter?: () => void
  isMenuOpen?: boolean
}

function useScreenCover(open: boolean) {
  const [screenCover, setScreenCover] = useState<ScreenCoverType>(null)
  const clearCover = useCallback(() => setScreenCover(null), [])
  const toggleBlackout = useCallback(() => setScreenCover((c) => (c === 'black' ? null : 'black')), [])
  const toggleWhiteout = useCallback(() => setScreenCover((c) => (c === 'white' ? null : 'white')), [])
  useEffect(() => {
    if (!open) setScreenCover(null)
  }, [open])
  return { screenCover, clearCover, toggleBlackout, toggleWhiteout }
}

// The pointer is a mode of the show rather than of the note, so it goes out with the show:
// a talk that ends must not leave a red dot following whoever moves the mouse next.
function usePointerTools(open: boolean) {
  const [tool, setTool] = useState<'laser' | 'spotlight' | null>(null)
  const clearLaser = useCallback(() => setTool((t) => (t === 'laser' ? null : t)), [])
  const clearSpotlight = useCallback(() => setTool((t) => (t === 'spotlight' ? null : t)), [])
  const toggleLaser = useCallback(() => setTool((t) => (t === 'laser' ? null : 'laser')), [])
  const toggleSpotlight = useCallback(() => setTool((t) => (t === 'spotlight' ? null : 'spotlight')), [])
  useEffect(() => {
    if (!open) setTool(null)
  }, [open])
  return { laser: tool === 'laser', spotlight: tool === 'spotlight', clearLaser, clearSpotlight, toggleLaser, toggleSpotlight }
}

// A mode of the screen rather than of the note: the overview grid and the key card both go out with
// the show, so a talk that ends cannot leave either of them lying on the page for the next one.
function useShowMode(open: boolean) {
  const [active, setActive] = useState(false)
  const clear = useCallback(() => setActive(false), [])
  const toggle = useCallback(() => setActive((on) => !on), [])
  useEffect(() => {
    if (!open) setActive(false)
  }, [open])
  return { active, clear, toggle }
}

// One runner per command keeps the listener itself short, and a command that is not
// claimed leaves the event alone instead of swallowing it for the rest of the page.
// The actions are held in a ref rather than in the callback's dependencies: the caller passes a
// fresh object on every render of the show, and a keystroke has to reach the action that render
// ended up with — while the listener on `window` stays where it was hung.
function usePresentationRunner(actions: {
  goNext: () => void
  goPrev: () => void
  jumpTo: (index: number) => void
  slideCount: number
  toggleFullscreen: () => void
  toggleRail: () => void
  toggleFollowing: () => void
  toggleBlackout: () => void
  toggleWhiteout: () => void
  toggleLaser: () => void
  toggleSpotlight: () => void
  toggleOverview: () => void
  toggleKeyGuide: () => void
  openPresenter?: () => void
}) {
  const latest = useRef(actions)
  latest.current = actions
  return useCallback((command: PresentationCommand) => {
    const current = latest.current
    switch (command) {
      case 'next':
        return current.goNext()
      case 'prev':
        return current.goPrev()
      case 'first':
        return current.jumpTo(0)
      case 'last':
        return current.jumpTo(current.slideCount - 1)
      case 'fullscreen':
        return current.toggleFullscreen()
      case 'slideList':
        return current.toggleRail()
      case 'follow':
        return current.toggleFollowing()
      case 'blackout':
        return current.toggleBlackout()
      case 'whiteout':
        return current.toggleWhiteout()
      case 'laser':
        return current.toggleLaser()
      case 'spotlight':
        return current.toggleSpotlight()
      case 'overview':
        return current.toggleOverview()
      case 'keyGuide':
        return current.toggleKeyGuide()
      case 'presenter':
        return current.openPresenter?.()
    }
  }, [])
}

export interface PresentationKeysResult {
  screenCover: ScreenCoverType
  clearCover: () => void
  toggleBlackout: () => void
  toggleWhiteout: () => void
  laser: boolean
  clearLaser: () => void
  toggleLaser: () => void
  spotlight: boolean
  clearSpotlight: () => void
  toggleSpotlight: () => void
  /** Whether the whole deck is laid out on top of the slide surface. */
  overview: boolean
  clearOverview: () => void
  toggleOverview: () => void
  /** Whether the show's own key card is lying over the projector. */
  keyGuide: boolean
  clearKeyGuide: () => void
  toggleKeyGuide: () => void
}

export function usePresentationKeys(options: PresentationKeysOptions): PresentationKeysResult {
  const { open, slideCount, goNext, goPrev, jumpTo, toggleFullscreen, toggleRail, toggleFollowing, openPresenter, isMenuOpen } = options
  const { screenCover, clearCover, toggleBlackout, toggleWhiteout } = useScreenCover(open)
  const { laser, clearLaser, toggleLaser, spotlight, clearSpotlight, toggleSpotlight } = usePointerTools(open)
  const grid = useShowMode(open)
  const card = useShowMode(open)
  const run = usePresentationRunner({ goNext, goPrev, jumpTo, slideCount, toggleFullscreen, toggleRail, toggleFollowing, toggleBlackout, toggleWhiteout, toggleLaser, toggleSpotlight, toggleOverview: grid.toggle, toggleKeyGuide: card.toggle, openPresenter })

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (screenCover) {
      event.preventDefault()
      clearCover()
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const command = presentationCommand(event.key, {
      onControl: Boolean(target?.closest('button, a, input, select, textarea, [contenteditable="true"]')),
      // The two slide lists walk differently: the rail its column, the overview grid its rows — so
      // the sideways turn goes back to the show whenever the rail holds the focus.
      onSlideList: Boolean(target?.closest('[data-presentation-rail]')),
      onOverviewGrid: Boolean(target?.closest('[data-presentation-overview]')),
      onNotesPane: Boolean(target?.closest('[data-speaker-notes]')),
      onMenu: Boolean(isMenuOpen || target?.closest('[role="menu"], [data-presentation-menu]')),
    })
    if (!command) return
    event.preventDefault()
    run(command)
  }, [clearCover, isMenuOpen, run, screenCover])

  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onKeyDown])

  return { screenCover, clearCover, toggleBlackout, toggleWhiteout, laser, clearLaser, toggleLaser, spotlight, clearSpotlight, toggleSpotlight, overview: grid.active, clearOverview: grid.clear, toggleOverview: grid.toggle, keyGuide: card.active, clearKeyGuide: card.clear, toggleKeyGuide: card.toggle }
}
