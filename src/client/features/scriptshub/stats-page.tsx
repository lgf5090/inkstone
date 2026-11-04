/**
 * The statistics screen: real aggregates from the event and snippet tables.
 *
 * Every number here is a server-side count over a bounded window; the charts are the shared
 * `ChartCanvas`, which defers chart.js until a chart is actually drawn. The daily line is filled
 * across the whole window so a quiet Tuesday is visible as a zero rather than as a missing point, and
 * the tables beside it carry the same numbers in text for a reader who cannot see the canvas.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import type { ScriptStatsRange, ScriptStatsResponse } from '@shared/scriptshub/types'
import { SCRIPT_STATS_DAYS } from '@shared/scriptshub/stats'
import { languageFor } from '@shared/scriptshub/languages'
import { t } from '../../lib/i18n'
import { formatNumber } from '../../lib/time'
import { cn } from '../../lib/cn'
import { Badge, Button, Spinner } from '../../components/primitives'
import { SelectMenu } from '../../components/select-menu'
import { ChartCanvas } from '../../components/chart-canvas'
import { scriptshubApi } from './api'

function dayKeys(range: ScriptStatsRange, now: number): string[] {
  const days = SCRIPT_STATS_DAYS[range]
  const out: string[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    out.push(new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  }
  return out
}

function Card({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3">
      <p className="text-[length:var(--text-10-5)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{label}</p>
      <p className="mt-1 text-[length:var(--text-20)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
      {hint && <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{hint}</p>}
    </div>
  )
}

function RankList({ title, rows, unit }: {
  title: string
  rows: Array<{ label: string; value: number }>
  unit: string
}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
      <h3 className="text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.no_data')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((row) => (
            <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
              <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">{row.label}</span>
              <span className="tabular text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatNumber(row.value)} {unit}</span>
              <span aria-hidden="true" className="col-span-2 h-1 rounded-full bg-[var(--bg-inset)]">
                <span className="block h-full rounded-full bg-[var(--accent)]/60" style={{ width: `${Math.max(2, Math.round((row.value / max) * 100))}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function StatsPage({ onBack }: { onBack: () => void }) {
  const [range, setRange] = useState<ScriptStatsRange>('30d')
  const [data, setData] = useState<ScriptStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    void scriptshubApi.stats(range).then((response) => {
      if (alive) setData(response)
    }).catch((loadError: unknown) => {
      if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [range])

  const daily = data?.distribution.daily ?? []
  const keys = useMemo(() => dayKeys(range, data?.generatedAt ?? Date.now()), [range, data?.generatedAt])
  const trend = useMemo(() => {
    const byDay = new Map(daily.map((point) => [point.day, point]))
    return keys.map((day) => ({
      day,
      downloads: byDay.get(day)?.downloads ?? 0,
      visitors: byDay.get(day)?.visitors ?? 0,
      failures: byDay.get(day)?.failures ?? 0,
    }))
  }, [daily, keys])

  const lineConfig = useMemo(() => ((colors) => ({
    type: 'line' as const,
    data: {
      labels: trend.map((point) => point.day.slice(5)),
      datasets: [
        {
          label: t('scriptshub.stats.downloads'),
          data: trend.map((point) => point.downloads),
          borderColor: colors.palette[0],
          backgroundColor: `${colors.palette[0]}33`,
          fill: true,
          tension: 0.28,
          pointRadius: 0,
          borderWidth: 1.6,
        },
        {
          label: t('scriptshub.stats.visitors'),
          data: trend.map((point) => point.visitors),
          borderColor: colors.palette[1] ?? colors.palette[0],
          fill: false,
          tension: 0.28,
          pointRadius: 0,
          borderWidth: 1.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: colors.grid }, ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 9 } } },
        y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text, precision: 0, font: { size: 9 } } },
      },
    },
  })) satisfies (colors: { palette: string[]; grid: string; text: string }) => ChartConfiguration<'line'>, [trend])

  const languageConfig = useMemo(() => ((colors) => ({
    type: 'doughnut' as const,
    data: {
      labels: (data?.overview.languages ?? []).map((row) => t(languageFor(row.label).labelKey)),
      datasets: [{
        data: (data?.overview.languages ?? []).map((row) => row.value),
        backgroundColor: colors.palette,
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: { legend: { display: true, position: 'bottom' as const, labels: { color: colors.text, boxWidth: 8, font: { size: 9 } } } },
    },
  })) satisfies (colors: { palette: string[]; text: string }) => ChartConfiguration<'doughnut'>, [data?.overview.languages])

  if (loading && !data) {
    return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
        <Button size="sm" variant="secondary" onClick={onBack}>{t('scriptshub.common.back')}</Button>
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} aria-hidden="true" />} onClick={onBack}>
          {t('scriptshub.common.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('scriptshub.stats.title')}</h1>
          <p className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.subtitle')}</p>
        </div>
        <SelectMenu
          size="sm"
          width={150}
          label={t('scriptshub.stats.range')}
          value={range}
          onChange={setRange}
          options={[
            { value: '7d', label: t('scriptshub.stats.range_7d') },
            { value: '30d', label: t('scriptshub.stats.range_30d') },
            { value: '365d', label: t('scriptshub.stats.range_365d') },
          ]}
          className="w-[130px]"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card label={t('scriptshub.stats.snippets')} value={formatNumber(data.overview.snippets)} hint={t('scriptshub.stats.files', { count: data.overview.files })} />
          <Card label={t('scriptshub.stats.published')} value={formatNumber(data.overview.published)} hint={t('scriptshub.stats.published_share', { percent: data.overview.publishedShare })} />
          <Card label={t('scriptshub.stats.downloads')} value={formatNumber(data.distribution.downloads)} hint={t('scriptshub.stats.range_note')} />
          <Card label={t('scriptshub.stats.unique_visitors')} value={formatNumber(data.distribution.uniqueVisitors)} hint={t('scriptshub.stats.revisions', { count: data.snippets.revisions })} />
        </div>

        <section className="mt-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.trend')}</h2>
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.utc_days')}</span>
          </div>
          <ChartCanvas
            height="h-[220px] mt-2"
            label={t('scriptshub.stats.trend_label', {
              downloads: data.distribution.downloads,
              visitors: data.distribution.uniqueVisitors,
            })}
            build={lineConfig}
          />
        </section>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.languages')}</h2>
            {data.overview.languages.length ? (
              <ChartCanvas height="h-[220px] mt-2" label={t('scriptshub.stats.languages')} build={languageConfig} />
            ) : (
              <p className="mt-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.no_data')}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.overview.languages.slice(0, 8).map((row) => (
                <Badge key={row.label} tone="neutral">{t(languageFor(row.label).labelKey)} · {row.value}</Badge>
              ))}
            </div>
          </section>

          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.top_scripts')}</h2>
            {data.distribution.topScripts.length === 0 ? (
              <p className="mt-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.no_data')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--border-subtle)]">
                {data.distribution.topScripts.map((row) => (
                  <li key={`${row.id}-${row.path ?? ''}`} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{row.title}</span>
                      <span className="block truncate font-mono text-[length:var(--text-10)] text-[var(--text-quaternary)]">{row.path ? `/${row.path}` : '—'}</span>
                    </span>
                    <span className="tabular shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {formatNumber(row.downloads)} · {formatNumber(row.uniqueVisitors)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <RankList title={t('scriptshub.stats.referrers')} rows={data.distribution.referrers} unit={t('scriptshub.stats.visits_unit')} />
          <RankList title={t('scriptshub.stats.browsers')} rows={data.distribution.browsers} unit={t('scriptshub.stats.visits_unit')} />
          <RankList title={t('scriptshub.stats.devices')} rows={data.distribution.devices} unit={t('scriptshub.stats.visits_unit')} />
          <RankList title={t('scriptshub.stats.failures')} rows={data.distribution.failures} unit={t('scriptshub.stats.requests_unit')} />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <h2 className="text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.hot_copies')}</h2>
            {data.snippets.hotCopies.length === 0 ? (
              <p className="mt-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.stats.no_data')}</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.snippets.hotCopies.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 text-[length:var(--text-10-5)]">
                    <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{row.title}</span>
                    <span className="tabular text-[var(--text-quaternary)]">{row.copies}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <h2 className="text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.recent_edits')}</h2>
            <ul className="mt-2 space-y-1">
              {data.snippets.recentEdits.map((row) => (
                <li key={row.id} className="flex items-center gap-2 text-[length:var(--text-10-5)]">
                  <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{row.title}</span>
                  <span className="tabular text-[var(--text-quaternary)]">{row.revisionCount}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
            <h2 className="text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.added')}</h2>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              {(['7d', '30d', '365d'] as const).map((window) => (
                <div key={window} className={cn('rounded-[var(--r-sm)] bg-[var(--bg-inset)] p-2')}>
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t(`scriptshub.stats.window_${window}` as Parameters<typeof t>[0])}</p>
                  <p className="tabular text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{data.overview.added[window]}</p>
                </div>
              ))}
            </div>
            <h2 className="mt-3 text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">{t('scriptshub.stats.folders')}</h2>
            <ul className="mt-1.5 space-y-1">
              {data.overview.folders.slice(0, 6).map((row) => (
                <li key={row.label} className="flex items-center gap-2 text-[length:var(--text-10-5)]">
                  <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{row.label || t('scriptshub.sidebar.unfiled')}</span>
                  <span className="tabular text-[var(--text-quaternary)]">{row.value}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
