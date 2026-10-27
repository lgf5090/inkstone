/**
 * The lyric list's scroll model: where the line being sung should sit, and when to return to the top.
 *
 * Scrolling by `scrollTop` rather than `scrollIntoView` keeps the page behind the player still; the
 * ratio is the reference's third-of-the-pane placement, expressed here as the 40% the reader sees
 * under the line.
 */
import { useEffect, useRef, type RefObject } from 'react'

export const LYRIC_ACTIVE_LINE_RATIO = 0.4

/** The scroll offset that puts `lineTop` at `ratio` of a viewport, never above the list's start. */
export function lyricScrollTop(lineTop: number, viewportHeight: number, ratio = LYRIC_ACTIVE_LINE_RATIO): number {
  if (!Number.isFinite(lineTop) || !Number.isFinite(viewportHeight)) return 0
  return Math.max(0, Math.round(lineTop - viewportHeight * ratio))
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Follow the active line with a smooth scroll, and reset to the top for a new track.
 *
 * `trackKey` is optional because a plain list (a test harness, a static preview) has no track; when
 * it is present, a change resets the scroll even if the active index is unchanged, which happens
 * whenever both tracks start on line zero.
 */
export function useActiveLineScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  activeIndex: number,
  trackKey?: string,
): void {
  const previousTrack = useRef<string | undefined>(trackKey)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (trackKey !== undefined && previousTrack.current !== trackKey) {
      previousTrack.current = trackKey
      container.scrollTop = 0
      return
    }
    if (activeIndex < 0) return
    const active = container.querySelector<HTMLElement>('[data-lyric-active="true"]')
    if (!active) return
    const top = lyricScrollTop(active.offsetTop, container.clientHeight)
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    } else {
      container.scrollTop = top
    }
  }, [activeIndex, containerRef, trackKey])
}
