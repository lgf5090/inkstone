import { useEffect, useState } from 'react'

export const CHROME_IDLE_MS = 2600

// Presenting is a full-screen activity: the controls and the slide list fade out
// while nothing happens and come back on the next pointer move or key press, so
// the slide itself owns the whole screen.
export function useChromeAutoHide(active: boolean): boolean {
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    if (!active) {
      setHidden(false)
      return
    }
    let timer = 0
    let frame = 0
    const arm = () => {
      // The wake has to move the deadline even when the chrome is already up, and saying so with the
      // value it already has is what lets React skip the render: a pointer crossing the slide is not
      // a change to the slide.
      window.clearTimeout(timer)
      setHidden(false)
      timer = window.setTimeout(() => setHidden(true), CHROME_IDLE_MS)
    }
    // One wake per frame, because that is the rate the screen can change at. The idle window is
    // postponed by the frame it waited for, which against a two-and-a-half second fade is nothing.
    const wake = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        arm()
      })
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake, true)
    return () => {
      window.clearTimeout(timer)
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', wake, true)
    }
  }, [active])
  return hidden
}
