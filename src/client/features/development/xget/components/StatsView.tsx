import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, BarChart3, CalendarDays, Gauge, Layers, PieChart, TrendingUp } from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import type { MessageKey } from '@shared/locales/en-US'
import { XGET_PLATFORM_BY_KEY } from '@shared/development/xget/catalog'
import { XGET_CATEGORIES, type XgetStatsRange, type XgetStatsSummary } from '@shared/development/xget/types'
import { t, getLocale } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { useThemeDark } from '../../../../lib/hooks'
import { chartIdentityPalette } from '../../../../lib/markdown/chart/accent'
import { Badge, Button } from '../../../../components/primitives'
import { Segmented } from '../../../../components/form'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { ChartCanvas, type ChartColors } from '../../../../components/chart-canvas'
import { xgetApi, describeXgetError } from '../api'
import { CATEGORY_LABEL_KEYS, CATEGORY_ORDER } from '../lib/category'
import { PlatformIcon } from './PlatformIcon'

type RangeKey = '7' | '30' | 'all'

const RANGE_OPTIONS: { value: RangeKey; label: MessageKey }[] = [
  { value: '7', label: 'development.xget.stats.range7' },
  { value: '30', label: 'development.xget.stats.range30' },
  { value: 'all', label: 'development.xget.stats.range_all' },
]

function formatNumber(value: number): string {
  return value.toLocaleString(getLocale())
}

export function StatsView() {
  const dark = useThemeDark()
  const locale = getLocale()
  const identities = useMemo(() => chartIdentityPalette(dark), [dark])
  const [range, setRange] = useState<XgetStatsRange>(7)
  const [summary, setSummary] = useState<XgetStatsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  async function fetchStats(next: XgetStatsRange): Promise<void> {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const stats = await xgetApi.getStats(next)
      if (id === requestId.current) setSummary(stats)
    } catch (cause) {
      if (id === requestId.current) setError(describeXgetError(cause))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    void fetchStats(7)
  }, [])

  function switchRange(next: XgetStatsRange): void {
    setRange(next)
    void fetchStats(next)
  }

  const kpis = [
    { label: t('development.xget.stats.total'), value: formatNumber(summary?.total ?? 0), icon: Activity },
    { label: t('development.xget.stats.today'), value: formatNumber(summary?.today ?? 0), icon: CalendarDays },
    { label: t('development.xget.stats.ok_rate'), value: `${summary?.okRate ?? 0}%`, icon: Gauge },
    { label: t('development.xget.stats.platforms'), value: formatNumber(summary?.platformCount ?? 0), icon: Layers },
  ]

  const topPlatforms = (summary?.platforms ?? []).slice(0, 10)
  const maxCount = Math.max(1, ...topPlatforms.map((platform) => platform.count))
  const trend = summary?.trend ?? []
  const categoryTrend = summary?.trendByCategory ?? []

  const trendBuild = useMemo(
    () => (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line',
      data: {
        labels: trend.map((point) => point.day.slice(5)),
        datasets: [
          {
            label: t('development.xget.stats.total'),
            data: trend.map((point) => point.count),
            borderColor: colors.identities[0] ?? colors.palette[0],
            backgroundColor: colors.identities[0] ?? colors.palette[0],
            pointRadius: trend.length <= 2 ? 3 : 0,
            pointHoverRadius: 3,
            borderWidth: 1.5,
            tension: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true, backgroundColor: colors.text, titleColor: colors.text, bodyColor: colors.text },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 10 } } },
          y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text, precision: 0, font: { size: 10 } } },
        },
      },
    }),
    [trend, locale],
  )

  const categoryBuild = useMemo(
    () => (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line',
      data: {
        labels: categoryTrend.map((point) => point.day.slice(5)),
        datasets: XGET_CATEGORIES.map((category, index) => ({
          label: t(CATEGORY_LABEL_KEYS[category]),
          data: categoryTrend.map((point) => point[category] ?? 0),
          borderColor: colors.identities[index % colors.identities.length] ?? colors.palette[index % colors.palette.length],
          backgroundColor: colors.identities[index % colors.identities.length] ?? colors.palette[index % colors.palette.length],
          pointRadius: categoryTrend.length <= 2 ? 3 : 0,
          pointHoverRadius: 3,
          borderWidth: 1.5,
          tension: 0,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true, backgroundColor: colors.text, titleColor: colors.text, bodyColor: colors.text },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 10 } } },
          y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text, precision: 0, font: { size: 10 } } },
        },
      },
    }),
    [categoryTrend, locale],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <BarChart3 size={16} className="text-[var(--accent)]" />
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('development.xget.stats.title')}</h2>
          <Badge>{t('development.xget.stats.subtitle')}</Badge>
        </div>
        <Segmented
          value={range === 'all' ? 'all' : String(range) as RangeKey}
          options={RANGE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
          onChange={(next) => switchRange(next === 'all' ? 'all' : (Number(next) as 7 | 30))}
          size="sm"
          label={t('development.xget.stats.title')}
        />
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4 py-10 text-center">
          <p className="text-[length:var(--text-13)] text-[var(--danger)]">{error ?? t('development.xget.stats.load_failed')}</p>
          <Button variant="secondary" size="sm" onClick={() => void fetchStats(range)}>
            {t('development.xget.common.retry')}
          </Button>
        </div>
      ) : loading && !summary ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {kpis.map((kpi, index) => {
              const Icon = kpi.icon
              const color = identities[index % identities.length] ?? identities[0]!
              return (
                <div key={kpi.label} className="flex items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--r-md)]" style={{ color, backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }}>
                    <Icon size={19} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[length:var(--text-20)] leading-tight font-bold tabular text-[var(--text-primary)]">{kpi.value}</span>
                    <span className="mt-0.5 block truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{kpi.label}</span>
                  </span>
                </div>
              )
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
                <TrendingUp size={15} className="text-[var(--accent)]" />
                <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('development.xget.stats.trend')}</h3>
              </header>
              <div className="p-3">
                {trend.length > 0 ? (
                  <ChartCanvas height="h-40" label={t('development.xget.stats.chart_trend_label')} build={trendBuild} />
                ) : (
                  <Empty compact title={t('development.xget.stats.empty')} description={t('development.xget.stats.empty_hint')} />
                )}
              </div>
            </section>

            <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
                <Activity size={15} className="text-[var(--accent)]" />
                <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('development.xget.stats.top_platforms')}</h3>
              </header>
              <div className="space-y-2 p-3">
                {topPlatforms.length > 0 ? (
                  topPlatforms.map((platform, index) => {
                    const meta = XGET_PLATFORM_BY_KEY[platform.platform as keyof typeof XGET_PLATFORM_BY_KEY]
                    return (
                      <div key={platform.platform} className="flex items-center gap-2">
                        <span className="w-4 shrink-0 text-right font-mono text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]">{index + 1}</span>
                        {meta ? (
                          <PlatformIcon platformKey={meta.key} category={meta.category} size="sm" />
                        ) : (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-raised)] text-[length:var(--text-10)] text-[var(--text-tertiary)]">?</span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                          {meta?.name ?? t('development.xget.stats.unknown_platform')}
                        </span>
                        <span className="w-24 shrink-0">
                          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-raised)]">
                            <span className="block h-full rounded-full" style={{ width: `${Math.round((platform.count / maxCount) * 100)}%`, backgroundColor: identities[index % identities.length] }} />
                          </span>
                        </span>
                        <span className="w-20 shrink-0 text-right text-[length:var(--text-11)] tabular text-[var(--text-primary)]">
                          {formatNumber(platform.count)}
                          <span className="ml-1 text-[var(--text-tertiary)]">{platform.pct}%</span>
                        </span>
                      </div>
                    )
                  })
                ) : (
                  <Empty compact title={t('development.xget.stats.empty')} description={t('development.xget.stats.empty_hint')} />
                )}
              </div>
            </section>
          </div>

          <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
              <PieChart size={15} className="text-[var(--accent)]" />
              <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('development.xget.stats.category_trend')}</h3>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {CATEGORY_ORDER.map((category, index) => (
                  <span key={category} className="inline-flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: identities[index % identities.length] }} />
                    {t(CATEGORY_LABEL_KEYS[category])}
                  </span>
                ))}
              </div>
            </header>
            <div className={cn('p-3')}>
              {categoryTrend.length > 0 ? (
                <ChartCanvas height="h-44" label={t('development.xget.stats.chart_category_label')} build={categoryBuild} />
              ) : (
                <Empty compact title={t('development.xget.stats.empty')} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
