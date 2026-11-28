import { useEffect, useState } from 'react'

const HUD_IDLE_MS = 3200

export function useHudAutoHide(enabled: boolean, busy: boolean, pinned: boolean): boolean {
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    if (!enabled || busy) {
      setHidden(false)
      return
    }
    let timer = 0
    const wake = () => {
      if (pinned) return
      setHidden(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setHidden(true), HUD_IDLE_MS)
    }
    wake()
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    for (const event of events) window.addEventListener(event, wake, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, wake)
    }
  }, [busy, enabled, pinned])
  return hidden
}
