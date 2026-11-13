/**
 * Pointer drag for the board and the list.
 *
 * HTML5 drag-and-drop never fires from a touch, so a board built on `draggable` is a desktop-only
 * board. This walks the same path for mouse, pen and finger: press, cross a small threshold (or hold
 * on touch), then a fixed clone follows the pointer while the real card stays behind as a slot.
 *
 * The drop index is counted in midlines and means "insert here after the dragged card is removed",
 * so the caller can splice without a ±1 correction. Geometry is read once at drag start and corrected
 * by scroll deltas, because reading every card's rect on every pointermove forces a layout per frame.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export interface DragDropTarget {
  zone: string
  index: number
}

interface ItemRect {
  id: string
  zone: string
  top: number
  height: number
  index: number
}

interface ZoneRect {
  key: string
  el: HTMLElement
  left: number
  right: number
  top: number
  bottom: number
}

const MOUSE_THRESHOLD = 4
const TOUCH_HOLD_MS = 220
const TOUCH_SLOP = 8
const EDGE = 48
const EDGE_SPEED = 14

export function useDragSort(options: {
  enabled: boolean
  /** The full set travelling together when the pressed card is part of a multi-selection. */
  groupOf?: (id: string) => readonly string[]
  onDrop: (id: string, target: DragDropTarget) => void
}): {
  draggingId: string | null
  over: DragDropTarget | null
  start: (event: ReactPointerEvent, id: string) => void
} {
  const { enabled, groupOf, onDrop } = options
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [over, setOver] = useState<DragDropTarget | null>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  const groupRef = useRef(groupOf)
  groupRef.current = groupOf
  const session = useRef<{ cleanup: () => void } | null>(null)

  useEffect(() => () => { session.current?.cleanup() }, [])

  const start = useCallback((event: ReactPointerEvent, id: string) => {
    if (!enabled || event.button !== 0 || session.current) return
    const source = (event.currentTarget as HTMLElement).closest('[data-drag-item]') as HTMLElement | null
    const root = (event.currentTarget as HTMLElement).closest('[data-drag-root]') as HTMLElement | null
    if (!source || !root) return
    const group = new Set(groupRef.current?.(id) ?? [id])
    const touch = event.pointerType === 'touch'
    const startX = event.clientX
    const startY = event.clientY
    let begun = false
    let ghost: HTMLElement | null = null
    let itemsByZone = new Map<string, ItemRect[]>()
    let zones: ZoneRect[] = []
    let scrollers: HTMLElement[] = []
    let scrollBase: { top: number, left: number }[] = []
    let offsetX = 0
    let offsetY = 0
    let width = 0
    let latest: DragDropTarget | null = null
    let frame = 0
    let lastX = startX
    let lastY = startY
    let hold: number | null = null

    const measure = (): void => {
      const zoneEls = [...root.querySelectorAll<HTMLElement>('[data-drag-zone]')]
      zones = zoneEls.map((el) => {
        const rect = el.getBoundingClientRect()
        return { key: el.dataset.dragZone ?? '', el, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
      itemsByZone = new Map()
      for (const zone of zones) {
        const cards = [...zone.el.querySelectorAll<HTMLElement>('[data-drag-item]')]
        itemsByZone.set(zone.key, cards.map((el, index) => {
          const rect = el.getBoundingClientRect()
          return { id: el.dataset.dragId ?? '', zone: zone.key, top: rect.top, height: rect.height, index }
        }))
      }
      scrollers = []
      let node: HTMLElement | null = root
      while (node) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(`${style.overflowY}${style.overflowX}`)) scrollers.push(node)
        node = node.parentElement
      }
      scrollBase = scrollers.map((el) => ({ top: el.scrollTop, left: el.scrollLeft }))
    }

    const begin = (): void => {
      if (begun) return
      begun = true
      const rect = source.getBoundingClientRect()
      offsetX = startX - rect.left
      offsetY = startY - rect.top
      width = rect.width
      measure()
      ghost = source.cloneNode(true) as HTMLElement
      ghost.classList.add('pv-ghost')
      ghost.style.width = `${width}px`
      ghost.style.left = '0'
      ghost.style.top = '0'
      ghost.setAttribute('aria-hidden', 'true')
      if (group.size > 1) {
        const badge = document.createElement('span')
        badge.className = 'pv-ghost-count'
        badge.textContent = String(group.size)
        ghost.appendChild(badge)
      }
      document.body.appendChild(ghost)
      document.body.classList.add('pv-dragging')
      setDraggingId(id)
    }

    /** Scroll deltas since `measure`, so a cached rect stays honest while the column scrolls. */
    const scrollDelta = (): { dx: number, dy: number } => {
      let dx = 0
      let dy = 0
      scrollers.forEach((el, index) => {
        const base = scrollBase[index] ?? { top: 0, left: 0 }
        dx += el.scrollLeft - base.left
        dy += el.scrollTop - base.top
      })
      return { dx, dy }
    }

    const resolve = (x: number, y: number): DragDropTarget | null => {
      const { dx, dy } = scrollDelta()
      const inBand = zones.filter((entry) => x >= entry.left - dx && x <= entry.right - dx)
      const zone = inBand.find((entry) => y >= entry.top - dy && y <= entry.bottom - dy) ?? inBand[0]
      if (!zone) return latest
      const siblings = (itemsByZone.get(zone.key) ?? []).filter((entry) => !group.has(entry.id))
      let index = 0
      for (const entry of siblings) {
        if (y > entry.top - dy + entry.height / 2) index += 1
      }
      return { zone: zone.key, index }
    }

    const paint = (): void => {
      frame = 0
      if (ghost) ghost.style.transform = `translate3d(${lastX - offsetX}px, ${lastY - offsetY}px, 0)`
      const next = resolve(lastX, lastY)
      if (next && (next.zone !== latest?.zone || next.index !== latest?.index)) {
        latest = next
        setOver(next)
      }
      for (const el of scrollers) {
        const rect = el.getBoundingClientRect()
        if (lastY < rect.top + EDGE) el.scrollTop -= EDGE_SPEED
        else if (lastY > rect.bottom - EDGE) el.scrollTop += EDGE_SPEED
        if (lastX < rect.left + EDGE) el.scrollLeft -= EDGE_SPEED
        else if (lastX > rect.right - EDGE) el.scrollLeft += EDGE_SPEED
      }
      if (begun) frame = requestAnimationFrame(paint)
    }

    const move = (moveEvent: PointerEvent): void => {
      lastX = moveEvent.clientX
      lastY = moveEvent.clientY
      if (!begun) {
        const dx = Math.abs(lastX - startX)
        const dy = Math.abs(lastY - startY)
        if (touch) {
          // A finger that travels before the hold expires meant to scroll the column, not drag.
          if (dx > TOUCH_SLOP || dy > TOUCH_SLOP) cleanup()
          return
        }
        if (dx < MOUSE_THRESHOLD && dy < MOUSE_THRESHOLD) return
        begin()
      }
      moveEvent.preventDefault()
      if (!frame) frame = requestAnimationFrame(paint)
    }

    const up = (): void => {
      const target = begun ? (latest ?? resolve(lastX, lastY)) : null
      cleanup()
      if (target) dropRef.current(id, target)
    }

    const key = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') cleanup()
    }

    function cleanup(): void {
      if (hold !== null) { window.clearTimeout(hold); hold = null }
      if (frame) { cancelAnimationFrame(frame); frame = 0 }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('keydown', key)
      ghost?.remove()
      ghost = null
      document.body.classList.remove('pv-dragging')
      begun = false
      latest = null
      session.current = null
      setDraggingId(null)
      setOver(null)
    }

    session.current = { cleanup }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('keydown', key)
    if (touch) hold = window.setTimeout(() => { hold = null; begin(); if (!frame) frame = requestAnimationFrame(paint) }, TOUCH_HOLD_MS)
  }, [enabled])

  return { draggingId, over, start }
}