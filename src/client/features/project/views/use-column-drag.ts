/**
 * Reordering columns by pointer, so a finger works the same as a mouse.
 *
 * HTML5 drag-and-drop never fires from a touch, which left the board's and the table's column order
 * desktop-only. This reads the header rectangles once at press, follows the pointer, and reports the
 * column it is over; the caller decides what a drop means.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const THRESHOLD = 4
const HOLD_MS = 220
const SLOP = 8

export interface ColumnDragState {
  draggingId: string | null
  overId: string | null
  start: (event: ReactPointerEvent, id: string) => void
}

export function useColumnDrag(options: {
  enabled: boolean
  /** Header elements in their drawn order, read at press so scrolling mid-drag stays honest. */
  measure: () => { id: string, left: number, right: number }[]
  onDrop: (sourceId: string, targetId: string) => void
}): ColumnDragState {
  const { enabled, measure, onDrop } = options
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
    let bands: { id: string, left: number, right: number }[] = []
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
    const over = (x: number): string | null => bands.find((band) => x >= band.left && x <= band.right)?.id ?? null

    const move = (moveEvent: PointerEvent): void => {
      if (!begun) {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        if (touch) { if (dx > SLOP || dy > SLOP) cleanup(); return }
        if (dx < THRESHOLD && dy < THRESHOLD) return
        begin()
      }
      moveEvent.preventDefault()
      const next = over(moveEvent.clientX)
      if (next !== latest) { latest = next; setOverId(next) }
    }
    const up = (): void => {
      const target = begun ? latest : null
      cleanup()
      if (target && target !== id) dropRef.current(id, target)
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
  }, [enabled])

  return { draggingId, overId, start }
}