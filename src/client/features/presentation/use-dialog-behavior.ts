import { useCallback, type RefObject } from 'react'
import { useDialogFocus, useEscape, useLockScroll } from '../../components/overlay'
import { escapeAction } from './presentation-state'

// The dialog's own browser contracts: Escape closes, the page behind stops scrolling,
// and focus stays inside the dialog until it goes back to whatever opened it.
// Called after the keyboard hook, because Escape reads the modes that hook owns: the first rung of
// the ladder is whatever layer the presenter is looking at, so neither the key card, the overview grid
// nor the laser ever costs a talk its show.
export function useDialogBehavior({ open, panelRef, isFullscreen, toggleFullscreen, onClose, laserOn, clearLaser, overviewOn, clearOverview, spotlightOn, clearSpotlight, keyGuideOn, clearKeyGuide }: {
  open: boolean
  panelRef: RefObject<HTMLDivElement | null>
  isFullscreen: boolean
  toggleFullscreen: () => void
  onClose: () => void
  laserOn: boolean
  clearLaser: () => void
  overviewOn: boolean
  clearOverview: () => void
  spotlightOn?: boolean
  clearSpotlight?: () => void
  keyGuideOn: boolean
  clearKeyGuide: () => void
}): void {
  const handleEscape = useCallback(() => {
    const action = escapeAction({ fullscreen: isFullscreen, laser: laserOn, overview: overviewOn, spotlight: Boolean(spotlightOn), keyGuide: keyGuideOn })
    switch (action) {
      case 'closeKeyGuide':
        return clearKeyGuide()
      case 'closeOverview':
        return clearOverview()
      case 'clearSpotlight':
        return clearSpotlight?.()
      case 'clearLaser':
        return clearLaser()
      case 'exitFullscreen':
        return toggleFullscreen()
      case 'close':
        return onClose()
    }
  }, [isFullscreen, laserOn, overviewOn, spotlightOn, keyGuideOn, toggleFullscreen, clearLaser, clearOverview, clearSpotlight, clearKeyGuide, onClose])
  useEscape(open, handleEscape)
  useLockScroll(open)
  useDialogFocus(open, panelRef, panelRef)
}
