/**
 * How long the reader has been reading.
 *
 * Time is counted only while the tab is visible and the reader is actually doing something: a page left
 * open in a background tab is not a reading session, and counting it would make the daily goal a
 * measure of tab hygiene rather than of reading.
 */
import { useEffect, useRef, useState } from 'react'
import { useLibrary } from '../store/library'
import { dayKey } from '../format-time'

const TICK_MS = 15_000
const IDLE_MS = 90_000

export interface ReadingTimer {
  sessionSeconds: number
  todaySeconds: number
  goalMinutes: number
}

export function useReadingTimer(bookId: string, enabled: boolean, goalMinutes: number): ReadingTimer {
  const [sessionSeconds, setSessionSeconds] = useState(0)
  const lastActivity = useRef(Date.now())
  const recorded = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const wake = () => {
      lastActivity.current = Date.now()
    }
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(event, wake, { passive: true })
    }
    return () => {
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
        window.removeEventListener(event, wake)
      }
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const flush = (seconds: number): void => {
      if (seconds <= 0) return
      recorded.current += seconds
      setSessionSeconds((current) => current + seconds)
      useLibrary.getState().recordSeconds(bookId, seconds)
    }
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastActivity.current > IDLE_MS) return
      flush(TICK_MS / 1000)
    }
    const timer = window.setInterval(tick, TICK_MS)
    // Capped, because a tab left open overnight would otherwise book the whole idle stretch as reading.
    const onLeave = () => {
      const since = Math.floor((Date.now() - lastActivity.current) / 1000)
      flush(Math.min(since, IDLE_MS / 1000))
    }
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', onLeave)
      onLeave()
    }
  }, [bookId, enabled])

  const todaySeconds = useLibrary((state) => state.stats[bookId]?.days[dayKey()] ?? 0)
  return { sessionSeconds, todaySeconds, goalMinutes }
}
