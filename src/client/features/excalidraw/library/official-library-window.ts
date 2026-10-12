import { useEffect, useState } from 'react'

/**
 * The official catalog holds 232 libraries. Mounting all of them at once was measured in Chromium as a
 * single 355-383 ms long task that also holds up the modal's own shell, and it asked for a preview image
 * per card (748 kB before the first scroll). So the grid renders a window and hands out the rest as the
 * reader approaches its end — the same shape the kanban board uses, with a real button for the tail so a
 * browser without an observer, or a keyboard that never scrolls, still reaches every card.
 */
export const OFFICIAL_WINDOW = 24
const OFFICIAL_WINDOW_STEP = 24
const OFFICIAL_WINDOW_PRELOAD_PX = 600

export interface RenderWindow<T> {
  visible: T[]
  hiddenCount: number
  setTailElement: (el: HTMLButtonElement | null) => void
  revealMore: () => void
}

export function sliceWindow<T>(items: readonly T[], limit: number): T[] {
  return limit >= items.length ? items as T[] : items.slice(0, limit)
}

export function hiddenCount(items: readonly unknown[], limit: number): number {
  return Math.max(0, items.length - limit)
}

export function useRenderWindow<T>(items: readonly T[], resetKey: string): RenderWindow<T> {
  const [limit, setLimit] = useState(OFFICIAL_WINDOW)
  const [tailElement, setTailElement] = useState<HTMLButtonElement | null>(null)
  const hidden = hiddenCount(items, limit)

  useEffect(() => {
    setLimit(OFFICIAL_WINDOW)
  }, [resetKey])

  const revealMore = () => {
    setLimit((current) => current + OFFICIAL_WINDOW_STEP)
  }

  useEffect(() => {
    if (!tailElement || hidden === 0 || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        revealMore()
      }
    }, { rootMargin: `${OFFICIAL_WINDOW_PRELOAD_PX}px 0px` })
    observer.observe(tailElement)
    return () => {
      observer.disconnect()
    }
  }, [hidden, tailElement])

  return {
    visible: sliceWindow(items, limit),
    hiddenCount: hidden,
    setTailElement,
    revealMore,
  }
}
