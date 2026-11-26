/**
 * Pointer drag for the board and the list.
 *
 * HTML5 drag-and-drop never fires from a touch, so a board built on `draggable` is a desktop-only
 * board. This walks the same path for mouse, pen and finger: press, cross a small threshold (or hold
 * on touch), then a fixed clone follows the pointer while the real card stays behind as a slot.
 *
 * The drop index is counted in midlines and means "insert here after the dragged card is removed",
 * so the caller can splice without a ±1 correction. Geometry is stored in document coordinates, so a
 * scroll changes only the pointer's coordinate and never the cards'; the target column is re-measured
 * at a low rate while auto-scrolling, which keeps a card whose height is still an intrinsic estimate
 * from leaving a stale drop line behind.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

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

export interface DragGeometry {
  zones: readonly { key: string, left: number, right: number, top: number, bottom: number }[]
  items: ReadonlyMap<string, readonly { id: string, top: number, height: number }[]>
}

export interface DragOverStore {
  isActive: (zone: string, index: number) => boolean
  subscribe: (listener: () => void) => () => void
}

export function useDragOverSlot(store: DragOverStore, zone: string, index: number): boolean {
  const getSnapshot = useCallback(() => store.isActive(zone, index), [store, zone, index])
  return useSyncExternalStore(store.subscribe, getSnapshot, () => false)
}

/**
 * The pure half of hit testing: geometry is in document coordinates, so the pointer is the only thing
 * that has to be shifted by the scroll offsets. An empty column wins by band, and the last target is
 * kept when the pointer leaves every band, so a drag that strays outside the board does not drop.
 */
export function resolveDragTarget(
  geometry: DragGeometry,
  pointer: { x: number, y: number, scrollX: number, scrollY: number },
  excluded: ReadonlySet<string>,
  fallback: DragDropTarget | null,
): DragDropTarget | null {
  const x = pointer.x + pointer.scrollX
  const y = pointer.y + pointer.scrollY
  const inBand = geometry.zones.filter((entry) => x >= entry.left && x <= entry.right)
  const zone = inBand.find((entry) => y >= entry.top && y <= entry.bottom) ?? inBand[0]
  if (!zone) return fallback
  const siblings = (geometry.items.get(zone.key) ?? []).filter((entry) => !excluded.has(entry.id))
  let index = 0
  for (const entry of siblings) {
    if (y > entry.top + entry.height / 2) index += 1
  }
  return { zone: zone.key, index }
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
  keyboardDragId: string | null
  overStore: DragOverStore
  start: (event: ReactPointerEvent, id: string) => void
  onKeyDown: (event: ReactKeyboardEvent, id: string) => void
} {
  const { enabled, groupOf, onDrop } = options
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [keyboardDragId, setKeyboardDragId] = useState<string | null>(null)
  const keyboardAnchor = useRef<HTMLElement | null>(null)
  const overRef = useRef<DragDropTarget | null>(null)
  const listeners = useRef(new Set<() => void>())
  const notify = useCallback(() => { for (const listener of listeners.current) listener() }, [])
  const overStore = useMemo<DragOverStore>(() => ({
    isActive: (zone, index) => {
      const current = overRef.current
      return current !== null && current.zone === zone && current.index === index
    },
    subscribe: (listener) => {
      listeners.current.add(listener)
      return () => { listeners.current.delete(listener) }
    },
  }), [])
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  const groupRef = useRef(groupOf)
  groupRef.current = groupOf
  const clearKeyboard = useCallback(() => {
    keyboardAnchor.current = null
    setKeyboardDragId(null)
    overRef.current = null
    notify()
  }, [notify])
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
    let zoneEls: HTMLElement[] = []
    let scrollers: HTMLElement[] = []
    let scrollX = 0
    let scrollY = 0
    let lastRemeasure = 0
    let offsetX = 0
    let offsetY = 0
    let width = 0
    let latest: DragDropTarget | null = null
    let frame = 0
    let lastX = startX
    let lastY = startY
    let hold: number | null = null

    /** Every card's rect, expressed in the content coordinates that scrolling does not move. */
    const readScroll = (): void => {
      scrollX = 0
      scrollY = 0
      for (const el of scrollers) {
        scrollX += el.scrollLeft
        scrollY += el.scrollTop
      }
    }

    const measureZones = (): void => {
      readScroll()
      zones = zoneEls.map((el) => {
        const rect = el.getBoundingClientRect()
        return { key: el.dataset.dragZone ?? '', el, left: rect.left + scrollX, right: rect.right + scrollX, top: rect.top + scrollY, bottom: rect.bottom + scrollY }
      })
    }

    const measureZone = (key: string): void => {
      const zone = zones.find((entry) => entry.key === key)
      if (!zone) return
      readScroll()
      const cards = [...zone.el.querySelectorAll<HTMLElement>('[data-drag-item]:not([data-child="true"])')]
      itemsByZone.set(key, cards.map((el, index) => {
        const rect = el.getBoundingClientRect()
        return { id: el.dataset.dragId ?? '', zone: key, top: rect.top + scrollY, height: rect.height, index }
      }))
    }

    const measure = (): void => {
      zoneEls = [...root.querySelectorAll<HTMLElement>('[data-drag-zone]')]
      scrollers = []
      let node: HTMLElement | null = root
      while (node) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(`${style.overflowY}${style.overflowX}`)) scrollers.push(node)
        node = node.parentElement
      }
      measureZones()
      itemsByZone = new Map()
      for (const zone of zones) measureZone(zone.key)
      lastRemeasure = performance.now()
    }

    /** A virtualised card can enter the viewport with a different height than its estimate held. */
    const remeasureTarget = (): void => {
      const now = performance.now()
      if (now - lastRemeasure < 120) return
      lastRemeasure = now
      measureZones()
      if (latest) measureZone(latest.zone)
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

    const resolve = (x: number, y: number): DragDropTarget | null => {
      readScroll()
      return resolveDragTarget({ zones, items: itemsByZone }, { x, y, scrollX, scrollY }, group, latest)
    }

    const autoScroll = (): boolean => {
      let moved = false
      for (const el of scrollers) {
        const rect = el.getBoundingClientRect()
        if (lastY < rect.top + EDGE) { el.scrollTop -= EDGE_SPEED; moved = true }
        else if (lastY > rect.bottom - EDGE) { el.scrollTop += EDGE_SPEED; moved = true }
        if (lastX < rect.left + EDGE) { el.scrollLeft -= EDGE_SPEED; moved = true }
        else if (lastX > rect.right - EDGE) { el.scrollLeft += EDGE_SPEED; moved = true }
      }
      return moved
    }

    const paint = (): void => {
      frame = 0
      if (ghost) ghost.style.transform = `translate3d(${lastX - offsetX}px, ${lastY - offsetY}px, 0)`
      const next = resolve(lastX, lastY)
      if (next && (next.zone !== latest?.zone || next.index !== latest?.index)) {
        latest = next
        overRef.current = next
        notify()
      }
      if (autoScroll()) remeasureTarget()
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

    function cleanup(silent: boolean | PointerEvent = false): void {
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
      if (silent !== true) {
        setDraggingId(null)
        overRef.current = null
        notify()
      }
    }

    const dispose = (): void => cleanup(true)
    session.current = { cleanup: dispose }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('keydown', key)
    if (touch) hold = window.setTimeout(() => { hold = null; begin(); if (!frame) frame = requestAnimationFrame(paint) }, TOUCH_HOLD_MS)
  }, [enabled, clearKeyboard])

  const onKeyDown = useCallback((event: ReactKeyboardEvent, id: string) => {
    if (!enabled) return
    if (event.key === 'Escape') { event.preventDefault(); clearKeyboard(); return }
    const root = (event.currentTarget as HTMLElement).closest('[data-drag-root]') as HTMLElement | null
    if (!root) return
    const group = new Set(groupRef.current?.(id) ?? [id])
    const zones = [...root.querySelectorAll<HTMLElement>('[data-drag-zone]')].map((zone) => ({
      key: zone.dataset.dragZone ?? '',
      ids: [...zone.querySelectorAll<HTMLElement>('[data-drag-item]:not([data-child="true"])')]
        .map((item) => item.dataset.dragId ?? '')
        .filter((itemId) => Boolean(itemId)),
    }))
    const locate = (): DragDropTarget | null => {
      const zoneIndex = zones.findIndex((zone) => zone.ids.includes(id))
      if (zoneIndex < 0) return null
      const ids = zones[zoneIndex]!.ids
      return { zone: zones[zoneIndex]!.key, index: ids.slice(0, ids.indexOf(id)).filter((itemId) => !group.has(itemId)).length }
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (keyboardDragId && keyboardDragId !== id) return
      event.preventDefault()
      if (keyboardDragId === id) {
        const target = overRef.current
        clearKeyboard()
        if (target) dropRef.current(id, target)
      } else if (!keyboardDragId) {
        const target = locate()
        if (target) {
          keyboardAnchor.current = event.currentTarget as HTMLElement
          setKeyboardDragId(id)
          overRef.current = target
          notify()
        }
      }
      return
    }
    if (!keyboardDragId || keyboardDragId !== id || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const current = overRef.current ?? locate()
    if (!current) return
    let zoneIndex = zones.findIndex((zone) => zone.key === current.zone)
    let index = current.index
    if (event.key === 'ArrowLeft') zoneIndex = Math.max(0, zoneIndex - 1)
    else if (event.key === 'ArrowRight') zoneIndex = Math.min(zones.length - 1, zoneIndex + 1)
    else if (event.key === 'ArrowUp') index = Math.max(0, index - 1)
    else index = Math.min(zones[zoneIndex]?.ids.length ?? 0, index + 1)
    const zone = zones[zoneIndex]
    if (!zone) return
    const target = { zone: zone.key, index: Math.min(index, zone.ids.filter((itemId) => !group.has(itemId)).length) }
    overRef.current = target
    notify()
  }, [enabled, keyboardDragId, clearKeyboard, notify])

  return useMemo(() => ({ draggingId, keyboardDragId, overStore, start, onKeyDown }), [draggingId, keyboardDragId, overStore, start, onKeyDown])
}