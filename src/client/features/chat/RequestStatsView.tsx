import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Coins, Download, Gauge, Hash, Layers, RefreshCw,
  Sparkles, XCircle,
} from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import type { AssistantStatsDimension, AssistantStatsReport } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Select } from '../../components/form'
import { ChartCanvas, withAlpha, type ChartColors } from '../../components/chart-canvas'
import { cn } from '../../lib/cn'
import {
  REFRESH_INTERVALS, LogFilterBar, Stat, bucketLabel, count, dayLabel, ms, themeColor, tokens,
  useAutoRefresh, useLogFacets, useLogFilters, when,
} from './request-log-shared'

const DIMENSIONS = [
  { id: 'provider', key: 'assistant.stats.dim_provider' },
  { id: 'key', key: 'assistant.stats.dim_key' },
  { id: 'model', key: 'assistant.stats.dim_model' },
  { id: 'operation', key: 'assistant.stats.dim_operation' },
  { id: 'status', key: 'assistant.stats.dim_status' },
  { id: 'day', key: 'assistant.stats.dim_day' },
] as const satisfies ReadonlyArray<{ id: AssistantStatsDimension, key: string }>

const METRICS = [
  { id: 'requests', key: 'assistant.stats.metric_requests' },
  { id: 'tokens', key: 'assistant.stats.metric_tokens' },
  { id: 'latency', key: 'assistant.stats.metric_latency' },
  { id: 'failure', key: 'assistant.stats.metric_failure' },
] as const

type Metric = (typeof METRICS)[number]['id']
type ChartKind = 'line' | 'bar'

export function RequestStatsView() {
  const controls = useLogFilters()
  const { facets, refresh: refreshFacets } = useLogFacets()
  const [dimension, setDimension] = useState<AssistantStatsDimension>('provider')
  const [metric, setMetric] = useState<Metric>('requests')
  const [kind, setKind] = useState<ChartKind>('bar')
  const [report, setReport] = useState<AssistantStatsReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  /** A dimension switch and an auto refresh can overlap; the older answer must not win. */
  const loadId = useRef(0)

  const load = useCallback(async () => {
    const id = ++loadId.current
    setBusy(true)
    setFailure(null)
    try {
      const answer = await api.assistant.requestStats(controls.query, dimension)
      if (id !== loadId.current) return
      setReport(answer)
    } catch (error) {
      if (id !== loadId.current) return
      // A failed auto refresh keeps the last good report on screen rather than blanking the panel.
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (id === loadId.current) setBusy(false)
    }
  }, [controls.query, dimension])

  useEffect(() => { void load() }, [load])
  useAutoRefresh(refreshSeconds, () => void load())

  const hourly = controls.filters.sinceMs > 0 && controls.filters.sinceMs <= 2 * 86_400_000
  const summary = report?.summary

  // Two providers may carry the same label — a rename or a second account — so a shared name keeps the
  // last four characters of the id, which is what tells the rows apart without widening the column.
  const groupName = useCallback((id: string): string => {
    if (dimension === 'provider') {
      const found = facets.providers.find((row) => row.id === id)
      if (!found) return id || t('assistant.logs.none')
      const label = found.label || id
      const shared = facets.providers.filter((row) => row.label === found.label).length > 1
      return shared ? `${label} ····${found.id.slice(-4)}` : label
    }
    if (dimension === 'key') {
      const found = facets.keys.find((row) => row.id === id)
      if (!found) return id || t('assistant.logs.none')
      const label = found.label || t('assistant.keys.unnamed')
      const shared = facets.keys.filter((row) => row.label === found.label).length > 1
      return shared || !found.label ? `${label} ····${found.keyHint}` : label
    }
    if (dimension === 'status') return id === '1' ? t('assistant.logs.status_ok') : t('assistant.logs.status_failed')
    if (dimension === 'day') return dayLabel(Number(id))
    return id || t('assistant.logs.none')
  }, [dimension, facets])

  // Each row used to call groupName two or three times (label, title, chart, export). One Map holds the
  // answer per id so a refresh recomputes it once instead of on every cell that names the group.
  const groupNames = useMemo(
    () => new Map((report?.breakdown ?? []).map((row) => [row.id, groupName(row.id)])),
    [report, groupName],
  )
  const nameOf = useCallback(
    (id: string): string => groupNames.get(id) ?? groupName(id),
    [groupNames, groupName],
  )
  const topBreakdown = useMemo(() => (report?.breakdown ?? []).slice(0, 8), [report])

  const exportBreakdown = () => {
    if (!report) return
    const header = 'group,requests,succeeded,failed,input_tokens,output_tokens,avg_latency_ms'
    const lines = report.breakdown.map((row) => [
      nameOf(row.id), row.requests, row.succeeded, row.failed, row.inputTokens, row.outputTokens,
      row.avgLatencyMs === null ? '' : Math.round(row.avgLatencyMs),
    ].map((cell) => {
      const text = String(cell)
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    }).join(','))
    const blob = new Blob(['\uFEFF' + [header, ...lines].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `request-stats-${dimension}.csv`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 px-4 py-4 md:px-6">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('assistant.stats.request_title')}</h2>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.stats.hint')}</p>
        </div>

        <LogFilterBar controls={controls} facets={facets} showStarred={false} onRefreshFacets={refreshFacets}>
          <Select
            aria-label={t('assistant.logs.auto_refresh')}
            className="w-[120px] shrink-0 text-[length:var(--text-11)]"
            value={String(refreshSeconds)}
            onChange={(event) => setRefreshSeconds(Number(event.target.value))}
          >
            {REFRESH_INTERVALS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === 0 ? t('assistant.logs.auto_refresh_off') : t('assistant.logs.auto_refresh_every', { seconds })}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" icon={<RefreshCw size={12} />} disabled={busy} onClick={() => void load()}>
            {t('assistant.logs.refresh')}
          </Button>
        </LogFilterBar>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.stats.dimension')}</span>
          <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={t('assistant.stats.dimension')}>
            {DIMENSIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={dimension === entry.id}
                onClick={() => setDimension(entry.id)}
                className={cn(
                  'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-10-5)] transition-colors duration-[var(--dur-fast)]',
                  dimension === entry.id
                    ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                    : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {t(entry.key)}
              </button>
            ))}
          </div>
        </div>

        {failure && (
          <p role="alert" className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertTriangle size={13} /> {t('assistant.stats.load_failed')} · {failure}
          </p>
        )}
        {report === null && busy && <div className="flex justify-center py-8"><Spinner /></div>}
        {summary && report && (
          <>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              <Stat icon={<Activity size={13} />} label={t('assistant.insights.requests')} value={count(summary.requests)} />
              <Stat icon={<CheckCircle2 size={13} />} label={t('assistant.stats.success_rate')} value={`${Math.round(summary.successRate * 100)}%`} tone="ok" />
              <Stat icon={<XCircle size={13} />} label={t('assistant.insights.failed')} value={count(summary.failed)} tone={summary.failed > 0 ? 'bad' : 'plain'} />
              <Stat icon={<Hash size={13} />} label={t('assistant.insights.input')} value={tokens(summary.inputTokens)} />
              <Stat icon={<Hash size={13} />} label={t('assistant.insights.output')} value={tokens(summary.outputTokens)} />
              <Stat icon={<Sparkles size={13} />} label={t('assistant.insights.cached')} value={tokens(summary.cachedInputTokens)} />
              <Stat icon={<Clock size={13} />} label={t('assistant.stats.avg_latency')} value={ms(summary.avgLatencyMs)} />
              <Stat
                icon={<Gauge size={13} />}
                label={t('assistant.stats.p95_latency')}
                value={ms(summary.p95LatencyMs)}
                tone={summary.p95LatencyMs !== null && summary.p95LatencyMs > 3000 ? 'warn' : 'plain'}
              />
              <Stat
                icon={<Coins size={13} />}
                label={t('assistant.stats.last_at')}
                value={summary.lastAt === null ? '—' : when(summary.lastAt)}
              />
            </div>

            {summary.requests === 0 ? (
              <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.stats.request_empty')}</p>
            ) : (
              <>
                <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('assistant.stats.trend')}</h3>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <div className="flex items-center gap-0.5" role="group" aria-label={t('assistant.stats.metric')}>
                        {METRICS.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            aria-pressed={metric === entry.id}
                            onClick={() => setMetric(entry.id)}
                            className={cn(
                              'rounded-[var(--r-md)] px-1.5 py-0.5 text-[length:var(--text-10-5)]',
                              metric === entry.id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                            )}
                          >
                            {t(entry.key)}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-0.5" role="group" aria-label={t('assistant.stats.chart_type')}>
                        {(['bar', 'line'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={kind === value}
                            onClick={() => setKind(value)}
                            className={cn(
                              'rounded-[var(--r-md)] px-1.5 py-0.5 text-[length:var(--text-10-5)]',
                              kind === value ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                            )}
                          >
                            {value === 'bar' ? t('assistant.stats.chart_bar') : t('assistant.stats.chart_line')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {report.series.length > 0
                    ? <TrendChart series={report.series} hourly={hourly} metric={metric} kind={kind} />
                    : <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.stats.request_empty')}</p>}
                </section>

                <div className="grid gap-1.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                    <h3 className="mb-1 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('assistant.stats.composition')}</h3>
                    <TokenDonut summary={summary} />
                  </section>
                  <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
                    <div className="mb-1 flex items-center gap-2">
                      <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('assistant.stats.compare')}</h3>
                      <span className="ml-auto text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.stats.top_n', { count: 8 })}</span>
                    </div>
                    <GroupBars breakdown={topBreakdown} nameOf={nameOf} />
                  </section>
                </div>

                <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                  <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
                    <Layers size={13} className="text-[var(--text-quaternary)]" aria-hidden />
                    <h3 className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('assistant.stats.breakdown')}</h3>
                    <Button size="sm" variant="ghost" icon={<Download size={12} />} className="ml-auto" onClick={exportBreakdown}>
                      {t('assistant.insights.export_csv')}
                    </Button>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_72px_64px_88px_76px_72px] gap-2 px-2.5 py-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    <span>{t('assistant.stats.column_group')}</span>
                    <span>{t('assistant.stats.column_requests')}</span>
                    <span>{t('assistant.stats.column_failed')}</span>
                    <span>{t('assistant.stats.column_tokens')}</span>
                    <span>{t('assistant.stats.column_latency')}</span>
                    <span>{t('assistant.stats.column_share')}</span>
                  </div>
                  <ul>
                    {report.breakdown.map((row) => {
                      const share = summary.requests ? row.requests / summary.requests : 0
                      const name = nameOf(row.id)
                      return (
                        <li key={row.id} className="border-t border-[var(--border-subtle)] px-2.5 py-1.5">
                          <div className="grid grid-cols-[minmax(0,1fr)_72px_64px_88px_76px_72px] items-center gap-2 text-[length:var(--text-11)]">
                            <span className="min-w-0 truncate text-[var(--text-secondary)]" title={name}>{name}</span>
                            <span className="tabular text-[var(--text-secondary)]">{count(row.requests)}</span>
                            <span className={cn('tabular', row.failed > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>{count(row.failed)}</span>
                            <span className="tabular text-[var(--text-quaternary)]">{tokens(row.inputTokens + row.outputTokens)}</span>
                            <span className="tabular text-[var(--text-quaternary)]">{ms(row.avgLatencyMs)}</span>
                            <span className="flex items-center gap-1">
                              <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                                <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} />
                              </span>
                              <span className="w-8 shrink-0 text-right tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                                {Math.round(share * 100)}%
                              </span>
                            </span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TrendChart({ series, hourly, metric, kind }: {
  series: AssistantStatsReport['series']
  hourly: boolean
  metric: Metric
  kind: ChartKind
}) {
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration => {
    const success = themeColor('--success', colors.palette[0] ?? '#2f9e6f')
    const danger = themeColor('--danger', colors.palette[3] ?? '#d05252')
    const labels = series.map((point) => bucketLabel(point.at, hourly))
    const stacked = metric === 'requests'
    const datasets = metric === 'requests'
      ? [
        { label: t('assistant.logs.status_ok'), data: series.map((p) => Math.max(0, p.requests - p.failed)), backgroundColor: success, borderRadius: 2, stack: 's' },
        { label: t('assistant.logs.status_failed'), data: series.map((p) => p.failed), backgroundColor: danger, borderRadius: 2, stack: 's' },
      ]
      : metric === 'tokens'
        ? [
          { label: t('assistant.insights.input'), data: series.map((p) => p.inputTokens), backgroundColor: withAlpha(colors.palette[0] ?? '#888888', 0.25), borderColor: colors.palette[0], fill: true, tension: 0.25, pointRadius: 2, borderWidth: 1.5 },
          { label: t('assistant.insights.output'), data: series.map((p) => p.outputTokens), backgroundColor: withAlpha(colors.palette[1] ?? '#888888', 0.2), borderColor: colors.palette[1], fill: true, tension: 0.25, pointRadius: 2, borderWidth: 1.5 },
        ]
        : metric === 'latency'
          ? [{ label: t('assistant.stats.avg_latency'), data: series.map((p) => p.avgLatencyMs ?? 0), borderColor: colors.palette[0], backgroundColor: withAlpha(colors.palette[0] ?? '#888888', 0.15), fill: true, tension: 0.25, pointRadius: 2, borderWidth: 1.5 }]
          : [{
            label: t('assistant.stats.metric_failure'),
            data: series.map((p) => (p.requests ? Math.round((p.failed / p.requests) * 100) : 0)),
            borderColor: danger,
            backgroundColor: withAlpha(danger, 0.15),
            fill: true,
            tension: 0.25,
            pointRadius: 2,
            borderWidth: 1.5,
          }]
    return {
      type: stacked && kind === 'bar' ? 'bar' : 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { stacked, ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: {
            stacked,
            beginAtZero: true,
            ticks: { color: colors.text, font: { size: 10 }, precision: 0 },
            grid: { color: colors.grid },
          },
        },
      },
    }
  }, [series, hourly, metric, kind])
  return <ChartCanvas height="h-52" label={t('assistant.stats.chart_label')} build={build} structureKey={`${metric}:${kind}`} />
}

function TokenDonut({ summary }: { summary: AssistantStatsReport['summary'] }) {
  const total = summary.inputTokens + summary.outputTokens + summary.cachedInputTokens
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration<'doughnut'> => ({
    type: 'doughnut',
    data: {
      labels: [t('assistant.stats.composition_input'), t('assistant.stats.composition_output'), t('assistant.stats.composition_cached')],
      datasets: [{
        data: [summary.inputTokens, summary.outputTokens, summary.cachedInputTokens],
        backgroundColor: [
          colors.palette[0] ?? '#888888', colors.palette[2] ?? '#888888', colors.palette[4] ?? '#888888',
        ],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
    },
  }), [summary])
  if (!total) return <p className="py-6 text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.stats.request_empty')}</p>
  return (
    <div className="relative">
      <ChartCanvas height="h-40" label={t('assistant.stats.composition_label')} build={build} structureKey="doughnut" />
      <span className="pointer-events-none absolute inset-x-0 top-[26%] text-center tabular text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
        {tokens(total)}
      </span>
    </div>
  )
}

function GroupBars({ breakdown, nameOf }: {
  breakdown: AssistantStatsReport['breakdown']
  nameOf: (id: string) => string
}) {
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration => {
    const success = themeColor('--success', colors.palette[0] ?? '#2f9e6f')
    const danger = themeColor('--danger', colors.palette[3] ?? '#d05252')
    return {
      type: 'bar',
      data: {
        labels: breakdown.map((row) => nameOf(row.id)),
        datasets: [
          { label: t('assistant.logs.status_ok'), data: breakdown.map((row) => row.succeeded), backgroundColor: success, borderRadius: 2, stack: 'g' },
          { label: t('assistant.logs.status_failed'), data: breakdown.map((row) => row.failed), backgroundColor: danger, borderRadius: 2, stack: 'g' },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, precision: 0 }, grid: { color: colors.grid } },
          y: { stacked: true, ticks: { color: colors.text, font: { size: 10 } }, grid: { display: false } },
        },
      },
    }
  }, [breakdown, nameOf])
  if (!breakdown.length) return <p className="py-6 text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.stats.request_empty')}</p>
  return <ChartCanvas height="h-52" label={t('assistant.stats.compare_label')} build={build} structureKey="bars" />
}
