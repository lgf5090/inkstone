import { useCallback, useEffect, useState, type UIEvent } from 'react'

const DEFAULT_INITIAL = 60
const DEFAULT_STEP = 60
const SCROLL_THRESHOLD = 400

export interface WindowedRows<T> {
  visibleItems: readonly T[]
  remaining: number
  onScroll: (event: UIEvent<HTMLElement>) => void
  showMore: () => void
}

export function useWindowedRows<T>(
  items: readonly T[],
  initial = DEFAULT_INITIAL,
  step = DEFAULT_STEP,
): WindowedRows<T> {
  const [visibleCount, setVisibleCount] = useState(initial)
  useEffect(() => {
    setVisibleCount(initial)
  }, [items, initial])
  const grow = useCallback(() => {
    setVisibleCount((current) => Math.min(items.length, current + step))
  }, [items.length, step])
  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const node = event.currentTarget
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - SCROLL_THRESHOLD) grow()
  }, [grow])
  return {
    visibleItems: items.slice(0, visibleCount),
    remaining: Math.max(0, items.length - visibleCount),
    onScroll,
    showMore: grow,
  }
}
