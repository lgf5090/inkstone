/**
 * Turning a page with a thumb.
 *
 * A reader on a phone expects to tap the right edge to go forward and to swipe, because that is what
 * every book app they have used does; the arrows in the bar are the fallback, not the gesture. So this
 * hook owns the two and stays out of everything else: a drag that was really a selection, a tap that
 * landed on a link or a mark, and a second finger coming down mid-gesture all end with the reader's
 * intent intact and no page turned.
 *
 * Mouse pointers are deliberately ignored. A click on a page with a mouse usually means "put my caret
 * here" or "clear this selection", and turning the page under it reads as the app misbehaving.
 */
import { useEffect, useRef, type RefObject } from 'react'

const TAP_MS = 400
const TAP_SLOP = 12
const SWIPE_PX = 48

export interface PointerPagingOptions {
  /** `thirds` gives the middle of the screen to the chrome, `edges` keeps the text clickable. */
  zones: 'thirds' | 'edges' | 'off'
  swipe: boolean
  onNext: () => void
  onPrev: () => void
  onCenterTap: () => void
}

export function usePointerPaging(host: RefObject<HTMLElement | null>, options: PointerPagingOptions): void {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  useEffect(() => {
    const element = host.current
    if (!element) return
    let startX = 0
    let startY = 0
    let startAt = 0
    let pointerId = -1
    let moved = false

    const interactive = (target: EventTarget | null): boolean => {
      const node = target as Element | null
      if (!node || typeof node.closest !== 'function') return false
      return Boolean(node.closest('a, button, textarea, input, select, .reader-mark, .reader-hud, .reader-selection-bar, [data-reader-panel], [role="dialog"]'))
    }

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') {
        pointerId = -1
        return
      }
      if (pointerId !== -1) return
      if (interactive(event.target)) {
        pointerId = -1
        return
      }
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      startAt = event.timeStamp
      moved = false
    }

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (Math.abs(event.clientX - startX) > TAP_SLOP || Math.abs(event.clientY - startY) > TAP_SLOP) moved = true
    }

    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== pointerId) return
      pointerId = -1
      if (cancelled) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      const elapsed = event.timeStamp - startAt
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return
      // A swipe is a move by definition, so it is judged before the "did the finger wander" guard that
      // rules out a tap.
      if (latest.current.swipe && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0) latest.current.onNext()
        else latest.current.onPrev()
        return
      }
      if (moved || elapsed > TAP_MS || Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) return
      const width = element.clientWidth
      const ratio = (event.clientX - element.getBoundingClientRect().left) / Math.max(1, width)
      if (latest.current.zones === 'off') {
        latest.current.onCenterTap()
        return
      }
      if (latest.current.zones === 'edges') {
        if (ratio > 0.78) latest.current.onNext()
        else if (ratio < 0.22) latest.current.onPrev()
        else latest.current.onCenterTap()
        return
      }
      if (ratio > 0.66) latest.current.onNext()
      else if (ratio < 0.34) latest.current.onPrev()
      else latest.current.onCenterTap()
    }

    const onUp = (event: PointerEvent) => finish(event, false)
    const onCancel = (event: PointerEvent) => finish(event, true)

    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onCancel)
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onCancel)
    }
  }, [host])
}
