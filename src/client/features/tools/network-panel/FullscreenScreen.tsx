/**
 * The full-screen clock the reference panel called Screensaver.
 *
 * It is a real fullscreen request on this element, so the browser's own escape works, plus a screen
 * wake lock while it is up. Neither is guaranteed — a phone may refuse the lock and a browser may
 * refuse fullscreen — and both failures leave the same usable overlay rather than an error.
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { Tooltip, useDialogFocus, useEscape } from '../../../components/overlay'
import { formatBandwidth, formatBytes, formatSpeed } from '@shared/tools/network-panel/engine'
import { getLocale, t } from '../../../lib/i18n'
import { useNetworkPanelStore } from './store'

type WakeLockSentinel = { release: () => Promise<void> }
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
}

export function FullscreenScreen({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runtime = useNetworkPanelStore((s) => s.runtime)
  const [now, setNow] = useState(() => new Date())
  const panelRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  useEscape(open, onClose)
  useDialogFocus(open, panelRef)

  useEffect(() => {
    if (!open) return
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const wakeLock = (navigator as WakeLockNavigator).wakeLock
    wakeLock?.request('screen')
      .then((lock) => {
        if (cancelled) void lock.release().catch(() => {})
        else sentinel = lock
      })
      .catch(() => {
        // A refused wake lock only means the screen may sleep; the overlay still works.
      })
    return () => {
      cancelled = true
      void sentinel?.release().catch(() => {})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const element = overlayRef.current
    if (!element) return
    let entered = false
    const request = element.requestFullscreen?.()
    request
      ?.then(() => {
        entered = true
      })
      .catch(() => {
        // The overlay fills the viewport even without the browser's fullscreen mode.
      })
    const onFullscreenChange = () => {
      if (entered && !document.fullscreenElement) onClose()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
    }
  }, [open, onClose])

  if (!open) return null

  const time = now.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString(getLocale(), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

  const rows = [
    { label: t('tools.network_panel.metric.total'), value: formatBytes(runtime.bytesUsed) },
    {
      label: runtime.running
        ? t('tools.network_panel.metric.speed_live')
        : t('tools.network_panel.metric.speed_average'),
      value: runtime.speedBps > 0 ? formatSpeed(runtime.speedBps) : '—',
    },
    {
      label: runtime.running
        ? t('tools.network_panel.metric.bandwidth_live')
        : t('tools.network_panel.metric.bandwidth_average'),
      value: runtime.speedBps > 0 ? formatBandwidth(runtime.speedBps) : '—',
    },
  ]

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[var(--z-top)] flex bg-black text-white"
      onClick={onClose}
    >
      <div className="absolute right-3 top-3 z-10">
        <Tooltip label={t('tools.network_panel.fullscreen.close')} side="left">
          <IconButton
            label={t('tools.network_panel.fullscreen.close')}
            size="lg"
            className="text-white/70 hover:bg-white/10 hover:text-white"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            <X size={18} />
          </IconButton>
        </Tooltip>
      </div>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('tools.network_panel.fullscreen.label')}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="m-auto grid w-full max-w-[720px] gap-6 px-6 text-center sm:grid-cols-2 sm:text-left"
      >
        <div className="space-y-1">
          <p className="text-[length:var(--text-13)] font-medium uppercase tracking-[0.28em] text-white/55">
            {t('tools.network_panel.fullscreen.title')}
          </p>
          <p className="text-[length:var(--text-30)] font-bold leading-none tabular-nums tracking-[-0.03em]">
            {time}
          </p>
          <p className="text-[length:var(--text-13)] text-white/70">{date}</p>
        </div>
        <dl className="space-y-3 sm:self-center">
          {rows.map((row) => (
            <div key={row.label} className="min-w-0">
              <dt className="text-[length:var(--text-11-5)] font-medium uppercase tracking-[0.12em] text-white/55">
                {row.label}
              </dt>
              <dd className="truncate text-[length:var(--text-20)] font-semibold tabular-nums">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="absolute inset-x-0 bottom-4 text-center text-[length:var(--text-11)] text-white/45">
        {t('tools.network_panel.fullscreen.hint')}
      </p>
    </div>
  )
}
