import { useEffect, useState } from 'react'
import { heartbeatProjectBoardPresence } from './api'
import { PROJECT_REALTIME_EVENT, type ProjectRealtimeDetail } from './realtime-events'

const PRESENCE_INTERVAL_MS = 20_000

export function useBoardPresence(boardId: string, enabled: boolean): string[] {
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([])

  useEffect(() => {
    if (!enabled) {
      setOnlineUserIds([])
      return
    }
    let alive = true
    let inFlight = false
    const send = (): void => {
      if (!alive || inFlight || document.hidden) return
      inFlight = true
      void heartbeatProjectBoardPresence(boardId)
        .then((users) => { if (alive) setOnlineUserIds(users) })
        .catch((cause: unknown) => { console.warn('[inkstone] project presence heartbeat failed:', cause) })
        .finally(() => { inFlight = false })
    }
    const onRealtime = (event: Event): void => {
      const detail = (event as CustomEvent<ProjectRealtimeDetail>).detail
      if (detail?.boardId === boardId) send()
    }
    const onOffline = (): void => { if (alive) setOnlineUserIds([]) }
    send()
    const timer = window.setInterval(send, PRESENCE_INTERVAL_MS)
    document.addEventListener('visibilitychange', send)
    window.addEventListener('focus', send)
    window.addEventListener('offline', onOffline)
    window.addEventListener(PROJECT_REALTIME_EVENT, onRealtime)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', send)
      window.removeEventListener('focus', send)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener(PROJECT_REALTIME_EVENT, onRealtime)
    }
  }, [boardId, enabled])

  return enabled ? onlineUserIds : []
}
