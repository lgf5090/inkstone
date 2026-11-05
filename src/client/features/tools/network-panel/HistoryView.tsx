/**
 * The ledger of measurements.
 *
 * Rows are what the server kept, not what this tab remembers: a run survives a reload, a browser and
 * a device. The summary above the list is counted server-side over the whole ledger rather than the
 * page on screen, so "average" means every run, not the last thirty.
 */
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type {
  NetworkPanelHistory,
  NetworkPanelRun,
  NetworkPanelRunSummary,
} from '@shared/tools/network-panel/types'
import type { MessageKey } from '@shared/locales/en-US'
import { NETWORK_PANEL_LIMITS, type StopReason } from '@shared/tools/network-panel/types'
import { formatBytes, formatDuration, formatSpeed } from '@shared/tools/network-panel/engine'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { Tooltip, confirm } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { getLocale, t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { networkPanelApi } from './api'

const PAGE_SIZE = NETWORK_PANEL_LIMITS.runPageDefault

const REASON_KEY: Record<StopReason, MessageKey> = {
  manual: 'tools.network_panel.reason.manual',
  data_cap: 'tools.network_panel.reason.data_cap',
  hidden: 'tools.network_panel.reason.hidden',
  failed: 'tools.network_panel.reason.failed',
}

export function HistoryView() {
  const [history, setHistory] = useState<NetworkPanelHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    networkPanelApi.listRuns(PAGE_SIZE, 0)
      .then((value) => { if (!cancelled) setHistory(value) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  const loadMore = async () => {
    if (!history || busy) return
    setBusy(true)
    try {
      const next = await networkPanelApi.listRuns(PAGE_SIZE, history.items.length)
      setHistory({ ...next, items: [...history.items, ...next.items] })
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.history.load_failed'), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const removeRun = async (run: NetworkPanelRun) => {
    const answer = await confirm({
      title: t('tools.network_panel.history.delete_confirm'),
      description: `${new Date(run.created_at * 1000).toLocaleString(getLocale())} · ${run.node_label}`,
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!answer) return
    try {
      await networkPanelApi.deleteRun(run.id)
      useUi.getState().toast({ title: t('tools.network_panel.history.deleted'), tone: 'success' })
      setReload((value) => value + 1)
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.history.delete_failed'), tone: 'danger' })
    }
  }

  const clearAll = async () => {
    const answer = await confirm({
      title: t('tools.network_panel.history.clear_confirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (!answer) return
    try {
      const result = await networkPanelApi.clearRuns()
      setHistory((current) => current
        ? { items: [], total: 0, summary: emptySummary() }
        : current)
      useUi.getState().toast({
        title: t('tools.network_panel.history.cleared', { count: result.removed }),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({ title: t('tools.network_panel.history.clear_failed'), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.network_panel.history.title')}
          </h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.network_panel.history.desc')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
          >
            {t('common.refresh')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={13} />}
            disabled={!history || history.total === 0}
            onClick={() => { void clearAll() }}
          >
            {t('tools.network_panel.history.clear')}
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <LoadingBlock label={t('tools.network_panel.history.loading')} />
        </div>
      ) : error || !history ? (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-[length:var(--text-12)] text-[var(--danger)]">
          <p>{t('tools.network_panel.history.load_failed')}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setReload((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        </div>
      ) : history.total === 0 ? (
        <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-sunken)] p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.network_panel.history.empty')}
        </p>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <SummaryCell label={t('tools.network_panel.history.summary_count')} value={String(history.summary.count)} />
            <SummaryCell label={t('tools.network_panel.history.summary_bytes')} value={formatBytes(history.summary.bytes)} />
            <SummaryCell label={t('tools.network_panel.history.summary_best')} value={formatSpeed(history.summary.best_speed_bps)} />
            <SummaryCell label={t('tools.network_panel.history.summary_average')} value={formatSpeed(history.summary.avg_speed_bps)} />
          </section>

          <ul className="space-y-1.5">
            {history.items.map((run) => {
              /**
               * Rows written before the thread count was clamped can carry `threads = 0`, which is also
               * the signature of the old global failure streak ending a run that was still moving bytes.
               * Their stored reason stays untouched, but the badge says the run was interrupted rather
               * than claiming a failure the current engine no longer produces.
               */
              const legacyFailure = run.stop_reason === 'failed' && run.threads < 1
              return (
              <li
                key={run.id}
                className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1" title={run.node_url}>
                    <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                      {run.node_label}
                    </span>
                    <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      {run.node_url}
                    </span>
                  </div>
                  <Tooltip label={t('tools.network_panel.history.delete')} side="left">
                    <IconButton
                      label={t('tools.network_panel.history.delete')}
                      size="sm"
                      onClick={() => { void removeRun(run) }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </Tooltip>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <span className="tabular-nums">{new Date(run.created_at * 1000).toLocaleString(getLocale())}</span>
                  <span>{formatBytes(run.bytes_used)}</span>
                  <span>{formatSpeed(run.avg_speed_bps)}</span>
                  <span>{formatDuration(run.duration_ms)}</span>
                  <span>{run.threads > 0
                    ? t('tools.network_panel.history.threads_value', { count: run.threads })
                    : t('tools.network_panel.history.threads_unknown')}</span>
                  <span
                    className={cn(
                      'rounded-full border px-1.5 py-0.5',
                      legacyFailure
                        ? 'border-[var(--warning)]/35 text-[var(--warning)]'
                        : run.stop_reason === 'failed'
                          ? 'border-[var(--danger)]/35 text-[var(--danger)]'
                          : run.stop_reason === 'data_cap'
                            ? 'border-[var(--warning)]/35 text-[var(--warning)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-quaternary)]',
                    )}
                  >
                    {legacyFailure
                      ? t('tools.network_panel.history.legacy_failed')
                      : t(REASON_KEY[run.stop_reason])}
                  </span>
                </div>
              </li>
              )
            })}
          </ul>

          {history.items.length < history.total && (
            <Button
              variant="secondary"
              size="sm"
              block
              loading={busy}
              onClick={() => { void loadMore() }}
            >
              {t('tools.network_panel.history.load_more')}
            </Button>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5">
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-0.5 truncate text-[length:var(--text-16)] font-semibold tabular-nums text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  )
}

function emptySummary(): NetworkPanelRunSummary {
  return { count: 0, bytes: 0, best_speed_bps: 0, avg_speed_bps: 0 }
}
