/**
 * A Worker's logs: the existing tail sessions, plus a live tail opened through the Worker bridge.
 *
 * The live connection is a real WebSocket to `/workers/:account/workers/:name/tail`; the Worker
 * creates Cloudflare's tail session, opens the upstream socket, and forwards each frame. There is no
 * polling here: the status line says whether the socket is connecting, connected, closed or failed.
 */
import { useEffect, useRef, useState } from 'react'
import { Drawer } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { cfErrorText } from '../../api/client'
import { tailSocketUrl, workersApi } from '../../api/workers'
import { useCfT } from '../../i18n'
import { stringifyOrPretty } from '../../lib/format'

type LiveStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'failed'

const MAX_LIVE_CHARS = 80_000

function frames(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const events = Array.isArray(parsed) ? parsed : [parsed]
    return events.map((event) => {
      const row = event as Record<string, unknown>
      const logs = Array.isArray(row.logs) ? row.logs : []
      const messages = logs.map((item) => {
        const log = item as Record<string, unknown>
        return `[${String(log.level ?? 'log')}] ${String(log.message ?? '')}`
      })
      const exceptions = Array.isArray(row.exceptions) ? row.exceptions : []
      const exceptionText = exceptions.map((item) => {
        const failure = item as Record<string, unknown>
        return `! ${String(failure.name ?? 'exception')}: ${String(failure.message ?? '')}`
      })
      return [
        String(row.eventTimestamp ?? row.timestamp ?? ''),
        String(row.outcome ?? row.event ?? ''),
        ...messages,
        ...exceptionText,
      ].filter(Boolean).join(' ')
    }).join('\n')
  } catch {
    return text
  }
}

export function LogsDrawer({
  open,
  onClose,
  accountId,
  name,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  name: string
}) {
  const t = useCfT()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [live, setLive] = useState(false)
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle')
  const [liveText, setLiveText] = useState('')
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setContent('')
    setFailed(false)
    setLoading(true)
    void workersApi.getLogs(accountId, name)
      .then((data) => {
        if (!cancelled) setContent(stringifyOrPretty(data))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailed(true)
        setContent(t('cloudflare.workers.get_log_failed', { error: cfErrorText(error) }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, name, t])

  useEffect(() => {
    if (!open) {
      socketRef.current?.close(1000, 'drawer closed')
      socketRef.current = null
      setLive(false)
      setLiveStatus('idle')
      setLiveText('')
    }
    return () => {
      socketRef.current?.close(1000, 'drawer closed')
      socketRef.current = null
    }
  }, [open])

  function stopLive(): void {
    socketRef.current?.close(1000, 'reader stopped')
    socketRef.current = null
    setLive(false)
    setLiveStatus('closed')
  }

  function startLive(): void {
    if (!accountId || !name || socketRef.current) return
    setLive(true)
    setLiveText('')
    setLiveStatus('connecting')
    const socket = new WebSocket(tailSocketUrl(accountId, name))
    socketRef.current = socket
    socket.addEventListener('open', () => setLiveStatus('connected'))
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const line = frames(event.data)
      setLiveText((current) => {
        const next = current ? `${current}\n${line}` : line
        return next.length > MAX_LIVE_CHARS ? next.slice(next.length - MAX_LIVE_CHARS) : next
      })
    })
    socket.addEventListener('error', () => setLiveStatus('failed'))
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) socketRef.current = null
      setLive(false)
      setLiveStatus((current) => current === 'failed' ? 'failed' : 'closed')
    })
  }

  const statusLabel = {
    idle: '',
    connecting: t('cloudflare.workers.live_tail_connecting'),
    connected: t('cloudflare.workers.live_tail_connected'),
    closed: t('cloudflare.workers.live_tail_closed'),
    failed: t('cloudflare.workers.live_tail_failed'),
  }[liveStatus]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={680}
      title={t('cloudflare.workers.log_drawer_title', { name })}
    >
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.workers.live_tail_hint')}
          </p>
          <div className="flex items-center gap-2">
            {statusLabel ? <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{statusLabel}</span> : null}
            <Button
              size="sm"
              variant={live ? 'danger' : 'primary'}
              onClick={live ? stopLive : startLive}
            >
              {live ? t('cloudflare.workers.live_tail_stop') : t('cloudflare.workers.live_tail_start')}
            </Button>
          </div>
        </div>

        {liveText ? (
          <pre
            role="log"
            aria-live="polite"
            className="max-h-[52vh] overflow-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]"
          >
            {liveText}
          </pre>
        ) : null}

        {content && !liveText ? (
          <pre className="max-h-[40vh] overflow-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
            {content}
          </pre>
        ) : null}
        {!content && !liveText && !loading && !failed && (
          <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('cloudflare.workers.no_logs')}
          </p>
        )}
        {loading && (
          <p className="py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('common.loading')}
          </p>
        )}
      </div>
    </Drawer>
  )
}
