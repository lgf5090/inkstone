/**
 * Long-press drag for touch and pen, which HTML5 drag-and-drop never delivers.
 *
 * The desktop gesture in `FilesPage` stays the authority on what a drop means: this hook only turns
 * a pointer into the same payload and the same target, so both routes end in one `actions.move`.
 * A press becomes a drag only after it is held still, because a finger that moves first is scrolling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'

export interface TouchDragPayload {
  ids: string[]
  paths: string[]
}

const LONG_PRESS_MS = 380
const MOVE_SLOP_PX = 10
const HIGHLIGHT = 'cd-drop-target'

function clearHighlight(element: HTMLElement | null) {
  element?.classList.remove(HIGHLIGHT)
}

export function useTouchDrag(input: {
  /** Resolve the id a hit element carries back to the row it belongs to. */
  entryOf: (id: string) => CloudDriveEntry | undefined
  /** What would move if this row were picked up, or null when the row cannot be dragged. */
  payloadFor: (entry: CloudDriveEntry) => TouchDragPayload | null
  accepts: (payload: TouchDragPayload | null, targetPath: string) => boolean
  onDrop: (payload: TouchDragPayload, targetPath: string) => void
  /** The text the floating chip shows while the rows are in the air. */
  labelFor: (entry: CloudDriveEntry, count: number) => string
}) {
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const latest = useRef(input)
  const active = useRef(false)
  const stopGesture = useRef<(() => void) | null>(null)

  // The gesture lives longer than the render that started it, so it reads the caller through a ref
  // that tracks the callbacks it actually uses.
  useEffect(() => {
    latest.current = input
  }, [input.entryOf, input.payloadFor, input.accepts, input.onDrop, input.labelFor])

  const onPointerDownEntry = useCallback((entry: CloudDriveEntry, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0 || active.current) return
    const payload = latest.current.payloadFor(entry)
    if (!payload) return
    // A hoisted handler cannot rely on a narrowing made outside it, so the payload is named once here.
    const drag: TouchDragPayload = payload

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const label = latest.current.labelFor(entry, payload.ids.length)
    let held = false
    let timer = 0
    let target: HTMLElement | null = null
    let targetPath: string | null = null

    const stop = () => {
      active.current = false
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      document.removeEventListener('touchmove', blockScroll)
      clearHighlight(target)
      target = null
      setGhost(null)
    }

    /** A finger that keeps moving is scrolling; the page must not jump while the rows are held. */
    function blockScroll(moveEvent: TouchEvent) {
      if (held) moveEvent.preventDefault()
    }

    function hit(x: number, y: number): { element: HTMLElement | null; path: string | null } {
      const found = document.elementFromPoint(x, y)
      const row = found?.closest<HTMLElement>('[data-cd-entry]')
      if (row) {
        const one = latest.current.entryOf(row.dataset.cdEntry ?? '')
        return { element: one?.kind === 'folder' ? row : null, path: one?.path ?? null }
      }
      const crumb = found?.closest<HTMLElement>('[data-cd-crumb]')
      return { element: crumb ?? null, path: crumb?.dataset.cdCrumb ?? null }
    }

    function onMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return
      if (!held) {
        if (Math.abs(moveEvent.clientX - startX) > MOVE_SLOP_PX
          || Math.abs(moveEvent.clientY - startY) > MOVE_SLOP_PX) stop()
        return
      }
      moveEvent.preventDefault()
      setGhost({ x: moveEvent.clientX, y: moveEvent.clientY, label })
      const { element, path } = hit(moveEvent.clientX, moveEvent.clientY)
      if (!element || path === null || !latest.current.accepts(drag, path)) {
        clearHighlight(target)
        target = null
        targetPath = null
        return
      }
      if (element === target) return
      clearHighlight(target)
      element.classList.add(HIGHLIGHT)
      target = element
      targetPath = path
    }

    function onUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return
      const dropped = held ? targetPath : null
      stop()
      if (dropped) latest.current.onDrop(drag, dropped)
    }

    active.current = true
    stopGesture.current = stop
    timer = window.setTimeout(() => {
      held = true
      setGhost({ x: startX, y: startY, label })
    }, LONG_PRESS_MS)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    document.addEventListener('touchmove', blockScroll, { passive: false })
  }, [])

  useEffect(() => () => {
    stopGesture.current?.()
    stopGesture.current = null
  }, [])

  return { ghost, onPointerDownEntry }
}
