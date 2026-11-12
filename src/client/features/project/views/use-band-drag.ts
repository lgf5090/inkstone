/**
 * Reordering a row of bands by pointer, so a finger works the same as a mouse.
 *
 * HTML5 drag-and-drop never fires from a touch, which left column and content-block order
 * desktop-only. This reads the band rectangles once at press, follows the pointer along one axis,
 * and reports the band it is over; the caller decides what a drop means.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const THRESHOLD = 4
const HOLD_MS = 220
const SLOP = 8

export interface BandDragState {
  draggingId: string | null
  overId: string | null
  start: (event: ReactPointerEvent, id: string) => void
}

export function useBandDrag(options: {
  enabled: boolean
  /** Which way the bands run: columns across, content blocks down. */
  axis: 'x' | 'y'
  /** Band elements in their drawn order, read at press so scrolling mid-drag stays honest. */
  measure: () => { id: string, from: number, to: number }[]
  /** The release point, for callers whose drop means more than "over this band" (nest vs beside). */
  onDrop: (sourceId: string, targetId: string, point: { x: number, y: number }) => void
}): BandDragState {
  const { enabled, axis, measure, onDrop } = options
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  const measureRef = useRef(measure)
  measureRef.current = measure
  const session = useRef<{ cleanup: () => void } | null>(null)

  useEffect(() => () => { session.current?.cleanup() }, [])

  const start = useCallback((event: ReactPointerEvent, id: string) => {
    if (!enabled || event.button !== 0 || session.current) return
    const touch = event.pointerType === 'touch'
    const startX = event.clientX
    const startY = event.clientY
    let bands: { id: string, from: number, to: number }[] = []
    let begun = false
    let latest: string | null = null
    let hold: number | null = null

    const begin = (): void => {
      if (begun) return
      begun = true
      bands = measureRef.current()
      setDraggingId(id)
      document.body.classList.add('pv-dragging')
    }
    const over = (at: number): string | null => bands.find((band) => at >= band.from && at <= band.to)?.id ?? null

    const move = (moveEvent: PointerEvent): void => {
      if (!begun) {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        if (touch) { if (dx > SLOP || dy > SLOP) cleanup(); return }
        if (dx < THRESHOLD && dy < THRESHOLD) return
        begin()
      }
      moveEvent.preventDefault()
      const next = over(axis === 'x' ? moveEvent.clientX : moveEvent.clientY)
      if (next !== latest) { latest = next; setOverId(next) }
    }
    const up = (upEvent: PointerEvent): void => {
      const target = begun ? latest : null
      cleanup()
      if (target && target !== id) dropRef.current(id, target, { x: upEvent.clientX, y: upEvent.clientY })
    }
    const key = (keyEvent: KeyboardEvent): void => { if (keyEvent.key === 'Escape') cleanup() }

    function cleanup(): void {
      if (hold !== null) { window.clearTimeout(hold); hold = null }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('keydown', key)
      document.body.classList.remove('pv-dragging')
      begun = false
      latest = null
      session.current = null
      setDraggingId(null)
      setOverId(null)
    }

    session.current = { cleanup }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('keydown', key)
    if (touch) hold = window.setTimeout(() => { hold = null; begin() }, HOLD_MS)
  }, [enabled, axis])

  return { draggingId, overId, start }
}