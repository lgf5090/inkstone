import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface VirtualRange {
  start: number
  end: number
  offset: number
  bottom: number
  total: number
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

function indexAtOffset(values: readonly number[], target: number, count: number): number {
  const found = lowerBound(values, target)
  const index = found > 0 && values[found] !== target ? found - 1 : found
  return Math.max(0, Math.min(count - 1, index))
}

export function virtualRange(
  offsets: readonly number[],
  scrollTop: number,
  height: number,
  overscan: number,
): VirtualRange {
  const count = offsets.length - 1
  const total = offsets[offsets.length - 1] ?? 0
  const top = Math.max(0, scrollTop)
  const first = indexAtOffset(offsets, top, count)
  const last = indexAtOffset(offsets, Math.max(top, top + height - 1), count)
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, last + overscan + 1)
  return { start, end, offset: offsets[start] ?? 0, bottom: Math.max(0, total - (offsets[end] ?? total)), total }
}

export function useVirtualList(
  count: number,
  estimateSize: number | ((index: number) => number),
  resetKey: string,
  overscan = 6,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [measurements, setMeasurements] = useState(() => new Map<number, number>())
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  const offsets = useMemo(() => {
    const values = new Array<number>(count + 1)
    values[0] = 0
    for (let index = 0; index < count; index += 1) {
      values[index + 1] = values[index]! + (measurements.get(index) ?? (typeof estimateSize === 'function' ? estimateSize(index) : estimateSize))
    }
    return values
  }, [count, estimateSize, measurements])
  const range = useMemo(() => virtualRange(offsets, viewport.scrollTop, viewport.height, overscan), [offsets, overscan, viewport])

  useLayoutEffect(() => {
    setMeasurements(new Map())
    const node = containerRef.current
    setViewport({ scrollTop: 0, height: node?.clientHeight ?? 0 })
    if (node) node.scrollTop = 0
  }, [resetKey])

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node) return
    const update = () => setViewport({ scrollTop: node.scrollTop, height: node.clientHeight })
    update()
    node.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    window.addEventListener('resize', update)
    return () => {
      node.removeEventListener('scroll', update)
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [resetKey])

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const changes = new Map<number, number>()
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        const index = Number(element.dataset.virtualIndex)
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height)
        if (Number.isInteger(index) && height > 0 && measurements.get(index) !== height) changes.set(index, height)
      }
      if (changes.size) setMeasurements((current) => {
        const next = new Map(current)
        for (const [index, height] of changes) next.set(index, height)
        return next
      })
    })
    for (const element of node.querySelectorAll<HTMLElement>('[data-virtual-index]')) observer.observe(element)
    return () => observer.disconnect()
  }, [measurements, range.end, range.start, resetKey])

  const onScroll = useCallback(() => {
    const node = containerRef.current
    if (node) setViewport({ scrollTop: node.scrollTop, height: node.clientHeight })
  }, [])

  const scrollToIndex = useCallback((index: number) => {
    const node = containerRef.current
    if (!node || index < 0 || index >= count) return
    const top = offsets[index] ?? 0
    const bottom = offsets[index + 1] ?? top
    const visibleTop = node.scrollTop
    const visibleBottom = visibleTop + node.clientHeight
    if (top < visibleTop) node.scrollTop = top
    else if (bottom > visibleBottom) node.scrollTop = Math.max(0, bottom - node.clientHeight)
  }, [count, offsets])

  return { containerRef, ...range, offsets, scrollToIndex, onScroll }
}
