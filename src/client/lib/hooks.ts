import { useCallback, useEffect, useRef, useState } from 'react'
import { relativeTime } from './time'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

export function useBreakpoint(): Breakpoint {
  const wide = useMediaQuery('(min-width: 1180px)')
  const medium = useMediaQuery('(min-width: 768px)')
  const touchLandscape = useMediaQuery('(pointer: coarse) and (max-height: 600px) and (max-width: 1179px)')
  return touchLandscape ? 'mobile' : wide ? 'desktop' : medium ? 'tablet' : 'mobile'
}


export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}


export function useRelativeTime(timestamp: number, enabled = true): string {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled || !Number.isFinite(timestamp) || !timestamp) return
    const elapsed = Math.abs(Date.now() - timestamp)
    const delay = Math.max(1_000, 60_000 - (elapsed % 60_000))
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay)
    return () => window.clearTimeout(timer)
  }, [enabled, tick, timestamp])
  return relativeTime(timestamp)
}

/**
 * A clock safe to keep in a dependency list: it only changes on a tick boundary,
 * so a caller that re-renders on pointer movement does not re-derive its inputs.
 */
export function useNow(intervalMs = 60_000, enabled = true): number {
  const interval = Number.isFinite(intervalMs) ? Math.max(1_000, Math.floor(intervalMs)) : 60_000
  const [slot, setSlot] = useState(() => Math.floor(Date.now() / interval))
  useEffect(() => {
    if (!enabled) return
    const current = Math.floor(Date.now() / interval)
    if (current !== slot) {
      setSlot(current)
      return
    }
    const timer = window.setTimeout(() => setSlot(slot + 1), Math.max(1, (slot + 1) * interval - Date.now()))
    return () => window.clearTimeout(timer)
  }, [enabled, interval, slot])
  return slot * interval
}


export function useEvent<T extends (...args: never[]) => unknown>(handler: T): T {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  return useCallback(((...args: never[]) => ref.current(...args)) as T, [])
}

export function useOnlineStatus(onChange: (online: boolean) => void): void {
  const handler = useEvent(onChange)
  useEffect(() => {
    const online = () => handler(true)
    const offline = () => handler(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [handler])
}


export function useResizeObserver<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onResize: (rect: DOMRectReadOnly) => void,
): void {
  const handler = useEvent(onResize)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) handler(entry.contentRect)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, handler])
}


export function useThemeDark(): boolean {
  const [isDark, setIsDark] = useState(() => (document.documentElement.dataset.theme ?? 'dark') === 'dark')
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark((document.documentElement.dataset.theme ?? 'dark') === 'dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return isDark
}
