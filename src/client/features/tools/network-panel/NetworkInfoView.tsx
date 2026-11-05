/**
 * What this deployment can say about the reader's connection.
 *
 * The address, country and network come from Cloudflare's own reading of the request, so nothing is
 * fetched from a third party and no arbitrary URL is involved. The latency is a round trip to this
 * deployment — the same origin the speed test measures — rather than to a foreign check endpoint the
 * page's security policy would refuse.
 */
import { useCallback, useEffect, useState } from 'react'
import { Copy, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import type { NetworkPanelInfo } from '@shared/tools/network-panel/types'
import { Button, IconButton } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { Tooltip } from '../../../components/overlay'
import { getLocale, t } from '../../../lib/i18n'
import { useOnlineStatus } from '../../../lib/hooks'
import { useUi } from '../../../store/ui'
import { networkPanelApi } from './api'
import { useNetworkPanelStore } from './store'

const INFO_INTERVAL_MS = 30_000
const LATENCY_INTERVAL_MS = 5_000

function regionName(code: string | null): string {
  if (!code) return '—'
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

export function NetworkInfoView() {
  const autoRefresh = useNetworkPanelStore((s) => s.settings.autoRefreshInfo)
  const [info, setInfo] = useState<NetworkPanelInfo | null>(null)
  const [infoError, setInfoError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [latency, setLatency] = useState<number | null>(null)
  const [latencyError, setLatencyError] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [reloadKey, setReloadKey] = useState(0)

  useOnlineStatus(setOnline)

  useEffect(() => {
    let cancelled = false
    const run = async (first: boolean) => {
      if (first) setLoading(true)
      try {
        const next = await networkPanelApi.getInfo()
        if (!cancelled) {
          setInfo(next)
          setInfoError(false)
        }
      } catch {
        if (!cancelled) setInfoError(true)
      } finally {
        if (!cancelled && first) setLoading(false)
      }
    }
    void run(true)
    if (!autoRefresh) {
      return () => {
        cancelled = true
      }
    }
    const timer = window.setInterval(() => { void run(false) }, INFO_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [autoRefresh, reloadKey])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const value = await networkPanelApi.ping()
        if (!cancelled) {
          setLatency(value)
          setLatencyError(false)
        }
      } catch {
        if (!cancelled) setLatencyError(true)
      }
    }
    void run()
    if (!autoRefresh) {
      return () => {
        cancelled = true
      }
    }
    const timer = window.setInterval(() => { void run() }, LATENCY_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [autoRefresh, reloadKey])

  const copyIp = useCallback(async () => {
    if (!info?.ip) return
    try {
      await navigator.clipboard.writeText(info.ip)
      useUi.getState().toast({ title: t('tools.network_panel.info.copied'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.info.copy_failed'), tone: 'danger' })
    }
  }, [info?.ip])

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.network_panel.info.title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.network_panel.info.desc')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[length:var(--text-11)] ${
              online
                ? 'border-[var(--success)]/35 bg-[var(--success)]/10 text-[var(--success)]'
                : 'border-[var(--danger)]/35 bg-[var(--danger)]/10 text-[var(--danger)]'
            }`}
          >
            {online ? <Wifi size={11} aria-hidden="true" /> : <WifiOff size={11} aria-hidden="true" />}
            {online ? t('tools.network_panel.info.online') : t('tools.network_panel.info.offline')}
          </span>
          <Tooltip label={t('common.refresh')}>
            <IconButton
              label={t('common.refresh')}
              size="sm"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      {loading ? (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <LoadingBlock label={t('tools.network_panel.info.loading')} />
        </div>
      ) : infoError || !info ? (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-[length:var(--text-12)] text-[var(--danger)]">
          <p>{t('tools.network_panel.info.load_failed')}</p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <section className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                  {t('tools.network_panel.info.ip')}
                </span>
                {info.ip && (
                  <Tooltip label={t('tools.network_panel.info.copy')} side="left">
                    <IconButton
                      label={t('tools.network_panel.info.copy')}
                      size="xs"
                      onClick={() => { void copyIp() }}
                    >
                      <Copy size={12} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
              <p className="mt-1 truncate font-mono text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]" title={info.ip ?? undefined}>
                {info.ip ?? '—'}
              </p>
              <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('tools.network_panel.info.source')}
              </p>
            </div>

            <div className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
              <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('tools.network_panel.info.latency')}
              </span>
              <p className="mt-1 text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">
                {latencyError ? '—' : latency === null ? t('tools.network_panel.info.measuring') : `${latency} ms`}
              </p>
              <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('tools.network_panel.info.latency_hint')}
              </p>
            </div>
          </section>

          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {t('tools.network_panel.info.location')}
            </h3>
            <dl className="grid gap-x-4 gap-y-2 text-[length:var(--text-12)] sm:grid-cols-2">
              <InfoRow label={t('tools.network_panel.info.country')} value={regionName(info.country)} />
              <InfoRow label={t('tools.network_panel.info.region')} value={info.region ?? '—'} />
              <InfoRow label={t('tools.network_panel.info.city')} value={info.city ?? '—'} />
              <InfoRow label={t('tools.network_panel.info.isp')} value={info.isp ?? '—'} />
              <InfoRow label={t('tools.network_panel.info.asn')} value={info.asn ? `AS${info.asn}` : '—'} />
              <InfoRow label={t('tools.network_panel.info.colo')} value={info.colo ?? '—'} />
            </dl>
            {!info.edge_geo && (
              <p className="mt-3 rounded-[var(--r-sm)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 p-2 text-[length:var(--text-11-5)] text-[var(--warning)]">
                {t('tools.network_panel.info.geo_unavailable')}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border-subtle)] pb-1.5 last:border-b-0 sm:border-b-0 sm:pb-0">
      <dt className="shrink-0 text-[var(--text-tertiary)]">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-[var(--text-primary)]" title={value}>{value}</dd>
    </div>
  )
}
