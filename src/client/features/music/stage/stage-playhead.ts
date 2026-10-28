// The stage's clock.
//
// One animation frame drives the whole pane: the active line changes at most once per line, and the
// per-word fill is painted through CSS variables from that same frame. Pausing, reducing motion or
// hiding the page stops the loop instead of leaving a frame scheduled every sixteen milliseconds.
import { useEffect, useRef, useState } from 'react'
import { findActiveLineIndex, type LyricLine } from '@shared/music/lyrics'
import { musicAudioEngine } from '../player/engine'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The engine's position when it has a source; the store's position otherwise (tests, restored queues). */
export function readStageTime(fallbackMs: number): number {
  const engineMs = musicAudioEngine.currentTimeMs()
  if (musicAudioEngine.hasSource() && Number.isFinite(engineMs)) return engineMs
  return fallbackMs
}

/** The line that owns a position; -1 before the first timed line. */
export function activeStageLine(lines: readonly LyricLine[], timeMs: number): number {
  return findActiveLineIndex(lines, timeMs)
}

/** Whether the reader asked the system to reduce motion, kept current if the setting changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches
  ))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  return reduced
}

export interface StagePlayheadOptions {
  lines: readonly LyricLine[]
  /** The store's position, used while the engine has no source or is paused without one. */
  fallbackTimeMs: number
  /** A per-track lyric offset, already the sign the lyric surface shows. */
  offsetMs: number
  playing: boolean
  reducedMotion: boolean
  /**
   * Called on every frame with the position that includes the offset and the line it lands in.
   * The pane paints CSS variables here; it must not call `setState`.
   */
  onFrame?: (timeMs: number, activeIndex: number) => void
}

/**
 * Follow the audio while the stage is on screen.
 *
 * The returned index is the only React state: a normal line lasts seconds, so this re-renders at
 * line boundaries rather than at frame rate. In reduced motion, and while paused, the store's
 * four-hertz position is enough and no frame is scheduled at all.
 */
export function useStagePlayhead({
  lines,
  fallbackTimeMs,
  offsetMs,
  playing,
  reducedMotion,
  onFrame,
}: StagePlayheadOptions): number {
  const fallbackRef = useRef(fallbackTimeMs)
  fallbackRef.current = fallbackTimeMs
  const frameRef = useRef(onFrame)
  frameRef.current = onFrame
  const [activeIndex, setActiveIndex] = useState(() => (
    activeStageLine(lines, readStageTime(fallbackTimeMs) + offsetMs)
  ))
  const activeRef = useRef(activeIndex)

  const emit = (timeMs: number): void => {
    const next = activeStageLine(lines, timeMs)
    frameRef.current?.(timeMs, next)
    if (next !== activeRef.current) {
      activeRef.current = next
      setActiveIndex(next)
    }
  }
  const emitRef = useRef(emit)
  emitRef.current = emit

  // Paused and reduced-motion readers follow the store's position, which is already sampled four
  // times a second. This is also the one read that freezes the pane on a pause, between two
  // `timeupdate` events.
  useEffect(() => {
    if (playing && !reducedMotion) return
    emitRef.current(readStageTime(fallbackRef.current) + offsetMs)
  }, [fallbackTimeMs, lines, offsetMs, playing, reducedMotion])

  useEffect(() => {
    if (!playing || reducedMotion || typeof requestAnimationFrame !== 'function') return
    let frame = 0
    let stopped = false
    const tick = (): void => {
      frame = 0
      if (stopped || document.visibilityState === 'hidden') return
      emitRef.current(readStageTime(fallbackRef.current) + offsetMs)
      schedule()
    }
    const schedule = (): void => {
      if (stopped || frame) return
      frame = requestAnimationFrame(tick)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        return
      }
      schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
    return () => {
      stopped = true
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [lines, offsetMs, playing, reducedMotion])

  return activeIndex
}
