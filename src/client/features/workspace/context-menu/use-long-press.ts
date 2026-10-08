import { useCallback, useEffect, useRef } from 'react'

/** How long a finger has to stay down before the note treats it as "open the menu". */
const LONG_PRESS_MS = 500

/** How far it may wander in that time before the gesture was clearly a scroll, not a press. */
const LONG_PRESS_SLOP = 12

/**
 * A touch stand-in for the right button.
 *
 * A phone has no right-click, and the note's menu is where every per-block action lives, so a held
 * press opens it at the finger. A desktop browser answers a long press with its own `contextmenu`
 * event too; `lastLongPressRef` is how the caller tells the two apart and does not open the menu a
 * second time for the same gesture.
 */
export function useLongPress(onLongPress: (point: { x: number; y: number }, target: HTMLElement) => void, options?: {
  /** False when another gesture owns the press — a finger that is carrying a block is not also asking for a menu. */
  enabled?: () => boolean
}) {
  const enabled = options?.enabled
  const timer = useRef<number | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const firedAt = useRef(0)

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    origin.current = null
  }, [])

  useEffect(() => cancel, [cancel])

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    if (enabled && !enabled()) return
    if (event.touches.length !== 1) {
      cancel()
      return
    }
    const touch = event.touches[0]!
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target) return
    origin.current = { x: touch.clientX, y: touch.clientY }
    window.clearTimeout(timer.current)
    const held = target
    timer.current = window.setTimeout(() => {
      const from = origin.current
      if (!from) return
      firedAt.current = Date.now()
      origin.current = null
      onLongPress(from, held)
    }, LONG_PRESS_MS)
  }, [cancel, onLongPress, enabled])

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    const from = origin.current
    if (!from) return
    const touch = event.touches[0]
    if (!touch || Math.abs(touch.clientX - from.x) > LONG_PRESS_SLOP || Math.abs(touch.clientY - from.y) > LONG_PRESS_SLOP) cancel()
  }, [cancel])

  /**
   * A lift before the timer fires was a tap, and the tap has to do what it already does. A lift after
   * the menu opened is the same gesture ending, so the click the browser would synthesise from it is
   * swallowed — otherwise the press that opened the menu would also follow the link under the finger.
   */
  const onTouchEnd = useCallback((event: React.TouchEvent) => {
    const wasTap = origin.current !== null
    cancel()
    if (!wasTap && Date.now() - firedAt.current < 800 && event.cancelable) event.preventDefault()
  }, [cancel])

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: cancel },
    /** True for the `contextmenu` event that belongs to a long press the handler already served. */
    justLongPressed: () => Date.now() - firedAt.current < 800,
  }
}
