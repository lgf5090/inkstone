import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebsshMonitorProcess, WebsshMonitorSnapshot } from '@shared/webssh/types'
import { websshApi } from './api'
import { ApiError } from '../../lib/api'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

export interface MonitorHistoryEntry {
  at: number
  rx: number
  tx: number
  cpu: number | null
}

export const MONITOR_POLL_INTERVAL_MS = 5_000
export const MONITOR_HISTORY_LIMIT = 120

export interface MonitorData {
  snapshot: WebsshMonitorSnapshot | null
  history: MonitorHistoryEntry[]
  loading: boolean
  error: string | null
  refresh: () => void
}

/** One throttled monitor poll; history keeps the last ten minutes of transfer rates. */
export function useMonitorSnapshot(sessionId: string | null, enabled = true): MonitorData {
  const [snapshot, setSnapshot] = useState<WebsshMonitorSnapshot | null>(null)
  const [history, setHistory] = useState<MonitorHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    if (!sessionId || !enabled) {
      setSnapshot(null)
      setHistory([])
      setError(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    setSnapshot(null)
    setHistory([])
    setError(null)
    const poll = () => {
      setLoading(true)
      websshApi.monitor(sessionId)
        .then((next) => {
          if (cancelled || sessionRef.current !== sessionId) return
          setSnapshot(next)
          setError(null)
          setHistory((current) => [
            ...current,
            { at: next.sampledAt, rx: next.network.total.rx ?? 0, tx: next.network.total.tx ?? 0, cpu: next.resources.cpuPercent },
          ].slice(-MONITOR_HISTORY_LIMIT))
        })
        .catch((caught: unknown) => {
          if (cancelled || sessionRef.current !== sessionId) return
          if (caught instanceof ApiError && caught.status === 409) {
            setSnapshot(null)
            setHistory([])
          }
          setError(caught instanceof ApiError ? caught.message : 'monitor unavailable')
        })
        .finally(() => {
          if (cancelled || sessionRef.current !== sessionId) return
          setLoading(false)
          timer = setTimeout(poll, MONITOR_POLL_INTERVAL_MS)
        })
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, enabled, tick])

  return { snapshot, history, loading, error, refresh }
}

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit++
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`
}

export function formatRate(value: number | null): string {
  return value === null ? '—' : `${formatBytes(value)}/s`
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** SIGTERM is the only signal the monitor sends, and only after the owner confirms the row. */
export function useProcessKill(sessionId: string | null, onDone: () => void) {
  return useCallback(async (process: WebsshMonitorProcess) => {
    if (!sessionId) return
    const approved = await confirm({
      title: t('webssh.monitor.kill_title'),
      description: t('webssh.monitor.kill_description', {
        pid: process.pid,
        command: process.command.length > 80 ? `${process.command.slice(0, 77)}...` : process.command,
      }),
      tone: 'danger',
      confirmLabel: t('webssh.monitor.kill_confirm'),
    })
    if (!approved) return
    try {
      const result = await websshApi.killProcess(sessionId, process.pid)
      const failed = result.exitCode !== null && result.exitCode !== 0
      useUi.getState().toast({
        title: failed ? t('webssh.monitor.kill_failed') : t('webssh.monitor.kill_sent', { pid: process.pid }),
        description: result.stderr || undefined,
        tone: failed ? 'danger' : 'success',
      })
      onDone()
    } catch (caught) {
      useUi.getState().toast({
        title: caught instanceof ApiError ? caught.message : t('webssh.error.generic'),
        tone: 'danger',
      })
    }
  }, [sessionId, onDone])
}
