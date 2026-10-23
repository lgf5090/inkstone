import { useEffect, useRef } from "react"
import { AUTO_REFRESH_MS } from "./constants"

/**
 * One cadence for the whole dashboard.
 *
 * The reference implementation started a timer per mount, so two open panels asked twice as often and
 * each ask could land on top of the one before it. This holds exactly one interval, tears it down on
 * unmount, and stops while the tab is in the background — a hidden tab polling is pure cost, and coming
 * back to the front is precisely when the figures on screen are most stale, so returning triggers one
 * read rather than waiting out another interval.
 */
export function useAutoRefresh(params: {
  enabled: boolean
  refresh: () => void
  /** Whether a request is already on the wire; a tick that stacks on one is the bug this prevents. */
  isBusy: () => boolean
}): void {
  const { enabled, refresh, isBusy } = params
  // The caller's closure is rebuilt every render, and an effect keyed on it would tear the timer down
  // and rebuild it on each render — which means it would never fire. A ref keeps the latest one readable
  // at the moment the timer fires.
  const refreshRef = useRef(refresh)
  const busyRef = useRef(isBusy)
  useEffect(() => {
    refreshRef.current = refresh
    busyRef.current = isBusy
  })

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      if (busyRef.current()) return
      refreshRef.current()
    }
    const start = () => {
      timer ??= setInterval(tick, AUTO_REFRESH_MS)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
        return
      }
      tick()
      start()
    }
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [enabled])
}
