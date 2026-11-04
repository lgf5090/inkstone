/**
 * The comparison ledger, as numbers.
 *
 * Every figure comes from `tools_compare_runs`, counted server-side for the signed-in reader. The
 * trend fills the days with no comparison with a real zero, so a quiet week reads as quiet rather
 * than as a straight line between two points.
 */
import { useEffect, useState } from 'react'
import type { CompareKind, CompareStats, StatsRange } from '@shared/tools/compare/types'
import { COMPARE_KINDS } from '@shared/tools/compare/types'
import { Button } from '../../../../components/primitives'
import { Tabs } from '../../../../components/tabs'
import { LoadingBlock } from '../../../../components/feedback'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { compareApi } from '../api'

const KIND_LABEL: Record<CompareKind, string> = {
  text: 'tools.compare.projects.kind.text',
  file: 'tools.compare.projects.kind.file',
  dir: 'tools.compare.projects.kind.dir',
  image: 'tools.compare.projects.kind.image',
  binary: 'tools.compare.projects.kind.binary',
}

export function StatsView() {
  const [range, setRange] = useState<StatsRange>('7d')
  const [stats, setStats] = useState<CompareStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    compareApi.getStats(range)
      .then((value) => { if (!cancelled) setStats(value) })
      .catch(() => { if (!cancelled) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, reload])

  const maxTrend = stats ? Math.max(1, ...stats.trend.map((bucket) => bucket.count)) : 1
  const maxKind = stats ? Math.max(1, ...COMPARE_KINDS.map((kind) => stats.byKind[kind] ?? 0)) : 1

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.stats.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.stats.desc')}</p>
        </div>
        <Tabs
          label={t('tools.compare.stats.range_label')}
          value={range}
          onChange={setRange}
          items={[
            { id: '7d' as StatsRange, label: t('tools.compare.stats.range.7d') },
            { id: '30d' as StatsRange, label: t('tools.compare.stats.range.30d') },
          ]}
        />
      </header>

      {loading ? (
        <div className="flex-1 rounded-[var(--r-md)] border border-[var(--border-subtle)]"><LoadingBlock label={t('tools.compare.stats.loading')} /></div>
      ) : error || !stats ? (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-[length:var(--text-12)] text-[var(--danger)]">
          <p>{t('tools.compare.stats.load_failed')}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setReload((value) => value + 1)}>{t('tools.compare.stats.retry')}</Button>
        </div>
      ) : stats.total === 0 ? (
        <p className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.compare.stats.empty')}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric label={t('tools.compare.stats.total')} value={String(stats.total)} />
            <Metric label={t('tools.compare.stats.identical')} value={String(stats.identical)} />
            <Metric label={t('tools.compare.stats.average')} value={String(stats.averageChangedLines)} />
            <Metric label={t('tools.compare.stats.top_extension')} value={stats.topExtensions[0]?.ext ?? '—'} />
          </div>

          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('tools.compare.stats.by_kind')}</h3>
            <div className="flex flex-col gap-1.5">
              {COMPARE_KINDS.map((kind) => {
                const value = stats.byKind[kind] ?? 0
                return (
                  <div key={kind} className="grid grid-cols-[80px_1fr_44px] items-center gap-2 text-[length:var(--text-11)]">
                    <span className="truncate text-[var(--text-secondary)]">{t(KIND_LABEL[kind] as never)}</span>
                    <span className="h-2 rounded-full bg-[var(--bg-base)]">
                      <span className="block h-2 rounded-full bg-[var(--accent)]" style={{ width: `${(value / maxKind) * 100}%` }} />
                    </span>
                    <span className="text-right font-mono tabular-nums text-[var(--text-tertiary)]">{value}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
            <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('tools.compare.stats.trend')}</h3>
            <div className="flex h-[140px] items-end gap-1" role="img" aria-label={t('tools.compare.stats.trend')}>
              {stats.trend.map((bucket) => (
                <div key={bucket.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span className="text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]">{bucket.count || ''}</span>
                  <span
                    className={cn('w-full rounded-t-[var(--r-xs)] bg-[var(--accent)]/70', bucket.count === 0 && 'bg-[var(--border-subtle)]')}
                    style={{ height: `${Math.max(2, (bucket.count / maxTrend) * 110)}px` }}
                    title={`${bucket.day}: ${bucket.count}`}
                  />
                  {range === '7d' && <span className="truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">{bucket.day.slice(5)}</span>}
                </div>
              ))}
            </div>
          </section>

          {stats.topExtensions.length > 0 && (
            <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
              <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('tools.compare.stats.extensions')}</h3>
              <div className="flex flex-wrap gap-1.5">
                {stats.topExtensions.map((entry) => (
                  <span key={entry.ext} className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    .{entry.ext} <span className="text-[var(--text-quaternary)]">{entry.count}</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
      <span className="truncate text-[length:var(--text-18)] font-semibold tabular-nums text-[var(--text-primary)]">{value}</span>
    </div>
  )
}
