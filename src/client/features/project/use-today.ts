import { useEffect, useRef, useState } from 'react'

function localMidnight(): number {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export function useToday(): number {
  const [today, setToday] = useState(localMidnight)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const update = (): void => {
      if (!alive) return
      setToday(localMidnight())
      const next = new Date()
      next.setHours(24, 0, 0, 10)
      timer.current = window.setTimeout(update, Math.max(1000, next.getTime() - Date.now()))
    }
    const visible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      update()
    }
    update()
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])

  return today
}
