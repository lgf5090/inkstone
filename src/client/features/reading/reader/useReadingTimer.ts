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
import { ReadingClock } from '../reading-clock'

const TICK_MS = 15_000

export interface ReadingTimer {
  sessionSeconds: number
  todaySeconds: number
  goalMinutes: number
}

export function useReadingTimer(bookId: string, enabled: boolean, goalMinutes: number): ReadingTimer {
  const [sessionSeconds, setSessionSeconds] = useState(0)
  const clock = useRef(new ReadingClock())

  useEffect(() => {
    if (!enabled) return
    const wake = () => clock.current.wake()
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
    clock.current = new ReadingClock()
    const flush = (seconds: number): void => {
      if (seconds <= 0) return
      setSessionSeconds((current) => current + seconds)
      useLibrary.getState().recordSeconds(bookId, seconds)
    }
    const tick = () => flush(clock.current.tick(Date.now(), document.visibilityState === 'visible'))
    const timer = window.setInterval(tick, TICK_MS)
    const onLeave = () => flush(clock.current.tick(Date.now(), document.visibilityState === 'visible'))
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
