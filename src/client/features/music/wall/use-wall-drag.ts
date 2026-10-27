/**
 * Pointer panning for the wall plane.
 *
 * The wall is one oversized plane: dragging never scrolls anything, it only moves the plane with a
 * single `transform`. A press that travels less than {@link WALL_DRAG_THRESHOLD} stays a click on the
 * cover under the pointer; a longer one becomes a drag and the click it would have produced is
 * swallowed. Releasing with speed hands the remaining motion to a short animation-frame decay, which
 * is skipped when the reader asked for reduced motion.
 *
 * The hook is deliberately unaware of React state. Moving a 200-tile plane through a state update on
 * every pointer event would re-render the whole wall sixty times a second, so the offset lives in a
 * ref and is written straight to the plane's inline transform.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { centre, clamp, type WallLayout, type WallPoint } from './wall-layout'

/** Movement below this many CSS pixels is still a press, not a drag. */
export const WALL_DRAG_THRESHOLD = 5

/** The recent motion used to estimate release velocity. */
const VELOCITY_WINDOW_MS = 100
/** Fraction of the velocity kept by each animation frame. */
const INERTIA_FRICTION = 0.92
/** Below this speed (px/ms) the decay has stopped being visible. */
const INERTIA_MIN_SPEED = 0.02
/** The frame length the velocity is converted with; close enough at any refresh rate. */
const FRAME_MS = 1000 / 60

interface DragSample {
  x: number
  y: number
  at: number
}

export interface WallDragOptions {
  /** The clipped box the wall is seen through. */
  viewportRef: RefObject<HTMLDivElement | null>
  /** The plane that carries the single translate. */
  planeRef: RefObject<HTMLElement | null>
  layout: WallLayout
  width: number
  height: number
  /** Heading height above the covers; the centre is measured below it. */
  top: number
  /** Height kept clear at the bottom, such as the shell's transport. */
  foot: number
  /** Queue-local index of the playing cover. Changing it centres that cover again. */
  centreIndex: number
  /** From {@link usePrefersReducedMotion}; suppresses release inertia only. */
  reducedMotion: boolean
}

interface DragConfig {
  layout: WallLayout
  width: number
  height: number
  top: number
  foot: number
  reducedMotion: boolean
}

function applyOffset(plane: HTMLElement, point: WallPoint): void {
  plane.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
}

/** The release velocity in px/ms, measured across the samples still in the window. */
function velocityOf(samples: readonly DragSample[]): WallPoint {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || first === last) return { x: 0, y: 0 }
  const span = last.at - first.at
  // A synthetic or coalesced pointer stream can carry one timestamp for every move. Treat the
  // gesture as one frame long in that case rather than dividing by zero.
  const scale = span > 0 ? 1 / span : 1 / FRAME_MS
  return { x: (last.x - first.x) * scale, y: (last.y - first.y) * scale }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(query.matches)
    update()
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update)
      return () => query.removeEventListener('change', update)
    }
    query.addListener(update)
    return () => query.removeListener(update)
  }, [])

  return reduced
}

export function useWallDrag({
  viewportRef,
  planeRef,
  layout,
  width,
  height,
  top,
  foot,
  centreIndex,
  reducedMotion,
}: WallDragOptions): void {
  const offsetRef = useRef<WallPoint>({ x: 0, y: 0 })
  const frameRef = useRef(0)
  const configRef = useRef<DragConfig>({ layout, width, height, top, foot, reducedMotion })
  configRef.current = { layout, width, height, top, foot, reducedMotion }

  // Centre the playing cover on first paint, on resize, and whenever playback moves to another
  // track. The layout is memoized by the pane, so a drag or a position tick is not in these
  // dependencies and never snaps the plane back under the reader's hand.
  useLayoutEffect(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
    const plane = planeRef.current
    if (!plane) return
    const next = centre(layout, centreIndex, width, height, top, foot)
    offsetRef.current = next
    applyOffset(plane, next)
  }, [centreIndex, foot, height, layout, planeRef, top, width])

  useEffect(() => {
    const viewport = viewportRef.current
    const plane = planeRef.current
    if (!viewport || !plane) return

    let pressed = false
    let dragging = false
    let pointerId: number | undefined
    let origin: WallPoint = { x: 0, y: 0 }
    let startX = 0
    let startY = 0
    let samples: DragSample[] = []
    // The sample list the release velocity is measured from; `finish` clears the live list.
    let samplesAtRelease: DragSample[] = []
    let suppressClick = false
    let suppressTimer = 0

    const stopInertia = (): void => {
      if (!frameRef.current) return
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }

    const setDraggingState = (active: boolean): void => {
      if (active) viewport.dataset.dragging = 'true'
      else viewport.removeAttribute('data-dragging')
    }

    const startInertia = (velocity: WallPoint): void => {
      stopInertia()
      let speedX = velocity.x
      let speedY = velocity.y
      const step = (): void => {
        speedX *= INERTIA_FRICTION
        speedY *= INERTIA_FRICTION
        if (Math.abs(speedX) < INERTIA_MIN_SPEED && Math.abs(speedY) < INERTIA_MIN_SPEED) {
          frameRef.current = 0
          setDraggingState(false)
          return
        }
        const { layout: currentLayout } = configRef.current
        const next = clamp(currentLayout, {
          x: offsetRef.current.x + speedX * FRAME_MS,
          y: offsetRef.current.y + speedY * FRAME_MS,
        })
        offsetRef.current = next
        applyOffset(plane, next)
        frameRef.current = requestAnimationFrame(step)
      }
      frameRef.current = requestAnimationFrame(step)
    }

    const releaseCapture = (): void => {
      if (pointerId === undefined || typeof viewport.releasePointerCapture !== 'function') return
      try {
        viewport.releasePointerCapture(pointerId)
      } catch {
        // The pointer may already be gone; the window listeners still finish the gesture.
      }
    }

    const finish = (allowInertia: boolean): void => {
      const wasDragging = dragging
      pressed = false
      dragging = false
      samples = []
      releaseCapture()
      if (!wasDragging) {
        setDraggingState(false)
        return
      }
      const velocity = velocityOf(samplesAtRelease)
      if (allowInertia && !configRef.current.reducedMotion) {
        const speed = Math.hypot(velocity.x, velocity.y)
        if (speed >= INERTIA_MIN_SPEED) startInertia(velocity)
        else setDraggingState(false)
      } else {
        setDraggingState(false)
      }
      // The click a browser synthesises after a drag arrives before this timer; a gesture that
      // produced no click must not swallow the next real press.
      window.clearTimeout(suppressTimer)
      suppressTimer = window.setTimeout(() => {
        suppressClick = false
      }, 0)
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.isPrimary === false) return
      stopInertia()
      suppressClick = false
      window.clearTimeout(suppressTimer)
      pressed = true
      dragging = false
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      origin = offsetRef.current
      samples = [{ x: event.clientX, y: event.clientY, at: event.timeStamp }]
      setDraggingState(false)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!pressed) return
      if (pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== pointerId) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      samples.push({ x: event.clientX, y: event.clientY, at: event.timeStamp })
      while (samples.length > 2 && event.timeStamp - samples[0]!.at > VELOCITY_WINDOW_MS) samples.shift()
      if (!dragging) {
        if (dx * dx + dy * dy < WALL_DRAG_THRESHOLD * WALL_DRAG_THRESHOLD) return
        dragging = true
        suppressClick = true
        setDraggingState(true)
        if (pointerId !== undefined && typeof viewport.setPointerCapture === 'function') {
          try {
            viewport.setPointerCapture(pointerId)
          } catch {
            // An already-released pointer cannot be captured; the window listeners still track it.
          }
        }
      }
      event.preventDefault()
      const next = clamp(configRef.current.layout, { x: origin.x + dx, y: origin.y + dy })
      offsetRef.current = next
      applyOffset(plane, next)
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (!pressed) return
      if (pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== pointerId) return
      samplesAtRelease = samples
      finish(true)
    }

    const onPointerCancel = (event: PointerEvent): void => {
      if (!pressed) return
      if (pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== pointerId) return
      samplesAtRelease = []
      suppressClick = false
      finish(false)
    }

    const onClickCapture = (event: MouseEvent): void => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    viewport.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    viewport.addEventListener('click', onClickCapture, true)

    return () => {
      stopInertia()
      window.clearTimeout(suppressTimer)
      setDraggingState(false)
      viewport.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      viewport.removeEventListener('click', onClickCapture, true)
    }
  }, [planeRef, viewportRef])
}
