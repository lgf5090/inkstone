import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'

function useTimerInterval(isPaused: boolean, setNow: Dispatch<SetStateAction<number>>) {
  useEffect(() => {
    if (isPaused) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [isPaused, setNow])
}

/**
 * The show's own clock.
 *
 * `frozen` is the show having ended while this window is still open: the reading stops where the room
 * stopped rather than counting the silence after it. It is deliberately not the pause button — a paused
 * clock is a presenter's decision that resumes on the next press, a frozen one is a record.
 */
export function usePresenterTimer(startedAt: number, frozen = false) {
  const [isPaused, setIsPaused] = useState(false)
  const [accumulatedMs, setAccumulatedMs] = useState(0)
  const [lastResumeAt, setLastResumeAt] = useState(() => startedAt)
  const [now, setNow] = useState(() => Date.now())

  const prevStartedAtRef = useRef(startedAt)
  useEffect(() => {
    if (prevStartedAtRef.current !== startedAt) {
      prevStartedAtRef.current = startedAt
      setAccumulatedMs(0)
      setLastResumeAt(startedAt)
      setIsPaused(false)
      setNow(Date.now())
    }
  }, [startedAt])

  // Stopping the tick is the whole of freezing: `elapsedSeconds` reads `now`, and `now` only moves on
  // a tick, so the display holds at whatever the clock last said.
  useTimerInterval(isPaused || frozen, setNow)

  const togglePause = useCallback(() => {
    setIsPaused((currentlyPaused) => {
      const currentTime = Date.now()
      if (currentlyPaused) {
        setLastResumeAt(currentTime)
        setNow(currentTime)
        return false
      }
      if (lastResumeAt !== null) {
        setAccumulatedMs((prev) => prev + Math.max(0, currentTime - lastResumeAt))
      }
      return true
    })
  }, [lastResumeAt])

  const resetTimer = useCallback(() => {
    const currentTime = Date.now()
    setIsPaused(false)
    setAccumulatedMs(0)
    setLastResumeAt(currentTime)
    setNow(currentTime)
  }, [])

  const runningElapsedMs = !isPaused && lastResumeAt !== null ? Math.max(0, now - lastResumeAt) : 0
  const elapsedSeconds = Math.max(0, Math.floor((accumulatedMs + runningElapsedMs) / 1000))

  return { elapsedSeconds, isPaused, togglePause, resetTimer }
}

/** Where the show has been and how long each page held it, in seconds. */
export interface SlideTimings {
  /** How long the page on screen has been on screen. */
  currentSeconds: number
  /** Seconds spent on each slide, summed over every visit. */
  bySlide: Record<number, number>
  /** How many distinct slides the run went across. */
  visited: number
}

/**
 * Per-slide time, derived from the show's own clock rather than from a second one (PR-M9).
 *
 * `elapsedSeconds` already stops when the presenter pauses and holds when the show ends, so reading
 * page time off it means a paused room is not charged to the page that was up, and a talk that was
 * stopped on stage is a record rather than a running count. A page visited twice is charged twice —
 * going back to the numbers is part of the talk, and a rehearsal that forgot it would report a run
 * that never happened.
 */
export function useSlideTimings(slideIndex: number, elapsedSeconds: number): SlideTimings {
  const [trail, setTrail] = useState<Array<{ slide: number; at: number }>>(() => [{ slide: slideIndex, at: 0 }])

  useEffect(() => {
    setTrail((current) => {
      const last = current[current.length - 1]
      if (!last || last.slide === slideIndex) return current
      return [...current, { slide: slideIndex, at: elapsedSeconds }]
    })
  }, [slideIndex, elapsedSeconds])

  return useMemo(() => {
    const bySlide: Record<number, number> = {}
    for (let index = 0; index < trail.length - 1; index++) {
      const from = trail[index]!
      const seconds = Math.max(0, (trail[index + 1]!.at - from.at))
      bySlide[from.slide] = (bySlide[from.slide] ?? 0) + seconds
    }
    const tail = trail[trail.length - 1] ?? { slide: slideIndex, at: 0 }
    bySlide[tail.slide] = (bySlide[tail.slide] ?? 0) + Math.max(0, elapsedSeconds - tail.at)
    return {
      currentSeconds: Math.max(0, elapsedSeconds - tail.at),
      bySlide,
      visited: Object.keys(bySlide).length,
    }
  }, [trail, elapsedSeconds, slideIndex])
}
