/**
 * Reordering a row of bands by pointer, so a finger works the same as a mouse.
 *
 * HTML5 drag-and-drop never fires from a touch, which left column and content-block order
 * desktop-only. This reads the band rectangles once at press, follows the pointer along one axis,
 * and reports the band it is over; the caller decides what a drop means.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

const THRESHOLD = 4
const HOLD_MS = 220
const SLOP = 8

export interface BandDragState {
  draggingId: string | null
  keyboardDragId: string | null
  overId: string | null
  start: (event: ReactPointerEvent, id: string) => void
  onKeyDown: (event: ReactKeyboardEvent, id: string) => void
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
  const [keyboardDragId, setKeyboardDragId] = useState<string | null>(null)
  const keyboardAnchor = useRef<HTMLElement | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  const measureRef = useRef(measure)
  measureRef.current = measure
  const clearKeyboard = useCallback(() => { keyboardAnchor.current = null; setKeyboardDragId(null); setOverId(null) }, [])
  const session = useRef<{ cleanup: () => void } | null>(null)

  useEffect(() => () => { session.current?.cleanup() }, [])

  useEffect(() => {
    if (!keyboardDragId) return
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') clearKeyboard() }
    const focus = (event: FocusEvent): void => { if (event.target !== keyboardAnchor.current) clearKeyboard() }
    window.addEventListener('keydown', key)
    document.addEventListener('focusin', focus)
    return () => {
      window.removeEventListener('keydown', key)
      document.removeEventListener('focusin', focus)
    }
  }, [keyboardDragId, clearKeyboard])

  const start = useCallback((event: ReactPointerEvent, id: string) => {
    if (!enabled || event.button !== 0 || session.current) return
    clearKeyboard()
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

    function cleanup(silent: boolean | PointerEvent = false): void {
      if (hold !== null) { window.clearTimeout(hold); hold = null }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('keydown', key)
      document.body.classList.remove('pv-dragging')
      begun = false
      latest = null
      session.current = null
      if (silent !== true) {
        setDraggingId(null)
        setOverId(null)
      }
    }

    const dispose = (): void => cleanup(true)
    session.current = { cleanup: dispose }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('keydown', key)
    if (touch) hold = window.setTimeout(() => { hold = null; begin() }, HOLD_MS)
  }, [enabled, axis, clearKeyboard])

  const onKeyDown = useCallback((event: ReactKeyboardEvent, id: string) => {
    if (!enabled) return
    if (event.key === 'Escape') { event.preventDefault(); clearKeyboard(); return }
    const bands = measureRef.current()
    const index = bands.findIndex((band) => band.id === id)
    if (index < 0) return
    if (event.key === 'Enter' || event.key === ' ') {
      if (keyboardDragId && keyboardDragId !== id) return
      event.preventDefault()
      if (keyboardDragId === id) {
        const target = bands.find((band) => band.id === overId)
        const targetIndex = bands.findIndex((band) => band.id === overId)
        const forwards = targetIndex > index
        clearKeyboard()
        if (target && target.id !== id) {
          dropRef.current(id, target.id, axis === 'x'
            ? { x: forwards ? target.to - 1 : target.from + 1, y: 0 }
            : { x: 0, y: forwards ? target.to - 1 : target.from + 1 })
        }
      } else if (!keyboardDragId) {
        keyboardAnchor.current = event.currentTarget as HTMLElement
        setKeyboardDragId(id)
        setOverId(id)
      }
      return
    }
    if (!keyboardDragId || keyboardDragId !== id || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const currentIndex = bands.findIndex((band) => band.id === overId)
    const next = bands[Math.max(0, Math.min(bands.length - 1, (currentIndex >= 0 ? currentIndex : index) + delta))]
    if (next) setOverId(next.id)
  }, [enabled, axis, keyboardDragId, overId, clearKeyboard])

  return { draggingId, keyboardDragId, overId, start, onKeyDown }
}