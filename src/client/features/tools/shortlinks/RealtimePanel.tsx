/**
 * Polling feed of the newest clicks. A hidden tab stops asking, a failed round backs off, and the
 * visible tabs each read one page per tick so several open dashboards do not multiply the load.
 */

import { useEffect, useRef, useState } from 'react'
import { Activity, Pause, Play } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import type { RealtimeClick } from '@shared/tools/shortlinks/types'
import { shortlinksApi } from './api'

const POLL_INTERVAL_MS = 10_000
const MAX_BACKOFF_MS = 60_000
const MAX_ITEMS = 40

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString()
}

export function RealtimePanel() {
  const [items, setItems] = useState<RealtimeClick[]>([])
  const [paused, setPaused] = useState(false)
  const [connected, setConnected] = useState(true)
  const cursorRef = useRef(0)

  useEffect(() => {
    if (paused) return
    let timer: number | undefined
    let disposed = false
    let busy = false
    let backoff = POLL_INTERVAL_MS

    const schedule = (delay: number) => {
      if (disposed) return
      timer = window.setTimeout(() => void tick(), delay)
    }

    const tick = async () => {
      if (disposed) return
      if (document.visibilityState === 'hidden') {
        timer = undefined
        return
      }
      if (busy) return
      busy = true
      try {
        const feed = await shortlinksApi.getRealtime(cursorRef.current || undefined)
        if (feed.items.length > 0) {
          setItems((previous) => {
            const seen = new Set(previous.map((item) => item.id))
            const merged = [...previous, ...feed.items.filter((item) => !seen.has(item.id))]
            return merged.slice(-MAX_ITEMS)
          })
        }
        if (feed.latest_id > cursorRef.current) cursorRef.current = feed.latest_id
        setConnected(true)
        backoff = POLL_INTERVAL_MS
      } catch {
        setConnected(false)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      } finally {
        busy = false
        schedule(backoff)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return
      }
      void tick()
    }

    if (document.visibilityState !== 'hidden') void tick()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onVisibility)

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onVisibility)
    }
  }, [paused])

  const newestFirst = [...items].reverse()

  return (
    <section
      aria-labelledby="shortlinks-realtime-title"
      className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-[var(--accent)]" aria-hidden="true" />
          <h2 id="shortlinks-realtime-title" className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.shortlinks.realtime.title')}
          </h2>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-11)] ${
              paused
                ? 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]'
                : connected
                  ? 'bg-[var(--success-soft)] text-[var(--success)]'
                  : 'bg-[var(--warning-soft)] text-[var(--warning)]'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {paused
              ? t('tools.shortlinks.realtime.paused')
              : connected
                ? t('tools.shortlinks.realtime.live')
                : t('tools.shortlinks.realtime.reconnecting')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.realtime.hint')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPaused((value) => !value)}
            aria-label={paused ? t('tools.shortlinks.realtime.resume') : t('tools.shortlinks.realtime.pause')}
          >
            {paused ? <Play size={13} className="mr-1" aria-hidden="true" /> : <Pause size={13} className="mr-1" aria-hidden="true" />}
            {paused ? t('tools.shortlinks.realtime.resume') : t('tools.shortlinks.realtime.pause')}
          </Button>
        </div>
      </div>

      {newestFirst.length === 0 ? (
        <div className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.shortlinks.realtime.empty')}
        </div>
      ) : (
        <ul aria-live="polite" className="mt-3 max-h-56 divide-y divide-[var(--border-subtle)] overflow-y-auto">
          {newestFirst.slice(0, 10).map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 py-2 text-[length:var(--text-12)]">
              <time className="font-mono text-[var(--text-tertiary)]" dateTime={new Date(item.clicked_at * 1000).toISOString()}>
                {formatTime(item.clicked_at)}
              </time>
              <span className="font-mono font-semibold text-[var(--accent)]">/{item.slug}</span>
              {item.label ? <span className="truncate text-[var(--text-secondary)]">{item.label}</span> : null}
              {item.country ? <span className="text-[var(--text-tertiary)]">{item.country}</span> : null}
              {item.device_type ? <span className="text-[var(--text-tertiary)]">{item.device_type}</span> : null}
              {item.is_bot ? (
                <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.2 text-[length:var(--text-10)] text-[var(--warning)]">
                  {t('tools.shortlinks.realtime.bot')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
