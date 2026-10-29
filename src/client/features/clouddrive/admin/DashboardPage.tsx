import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChartConfiguration } from 'chart.js'
import { Files, HardDrive, KeyRound, LineChart, BarChart3, RefreshCw, Share2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { Badge, Button } from '../../../components/primitives'
import { Segmented, Select } from '../../../components/form'
import { ChartCanvas, type ChartColors } from '../../../components/chart-canvas'
import { t } from '../../../lib/i18n'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminForbidden,
  AdminLoading,
  AdminPage,
  AdminStat,
  AdminMeter,
  adminT,
  formatAdminDateTime,
  formatAdminDay,
  formatAdminNumber,
  useAdminOwner,
} from './shared'
import {
  clouddriveAdminApi,
  type CloudDriveAdminActivityDay,
  type CloudDriveAdminCacheStats,
  type CloudDriveAdminOverview,
} from './api-admin'

type LoadState = 'loading' | 'ready' | 'error'
type ChartMode = 'bar' | 'line'

export function DashboardPage() {
  const owner = useAdminOwner()
  const [overview, setOverview] = useState<CloudDriveAdminOverview | null>(null)
  const [days, setDays] = useState<CloudDriveAdminActivityDay[]>([])
  const [cache, setCache] = useState<CloudDriveAdminCacheStats | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [storageId, setStorageId] = useState('all')
  const [chartMode, setChartMode] = useState<ChartMode>('bar')

  const load = useCallback(async () => {
    setState('loading')
    setError(null)
    try {
      const [nextOverview, nextActivity, nextCache] = await Promise.all([
        clouddriveAdminApi.overview(),
        clouddriveAdminApi.activity(7),
        clouddriveAdminApi.cache(),
      ])
      setOverview(nextOverview)
      setDays(nextActivity.days)
      setCache(nextCache)
      setState('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setState('error')
    }
  }, [])

  useEffect(() => {
    if (owner) void load()
  }, [load, owner])

  const capacity = overview?.capacity
  const selectedStorage = capacity?.storages.find((storage) => storage.id === storageId)
  const usedBytes = selectedStorage ? selectedStorage.usedBytes : capacity?.usedBytes ?? 0
  const quotaBytes = selectedStorage ? selectedStorage.quotaBytes : capacity?.quotaBytes ?? null
  const trashBytes = selectedStorage ? selectedStorage.trashBytes ?? null : capacity?.trashBytes ?? null
  const hasActivity = days.some((day) => day.uploads > 0 || day.shares > 0)

  const buildChart = useMemo(
    () => (colors: ChartColors): ChartConfiguration => ({
      type: chartMode,
      data: {
        labels: days.map((day) => formatAdminDay(day.date)),
        datasets: [
          {
            label: adminT('clouddrive.admin.chart.uploads'),
            data: days.map((day) => day.uploads),
            backgroundColor: colors.palette[0],
            borderColor: colors.palette[0],
            borderWidth: 2,
            tension: 0.35,
            fill: false,
          },
          {
            label: t('clouddrive.nav.shares'),
            data: days.map((day) => day.shares),
            backgroundColor: colors.palette[1],
            borderColor: colors.palette[1],
            borderWidth: 2,
            tension: 0.35,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } },
        },
        scales: {
          x: {
            ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { color: colors.text, font: { size: 10 }, precision: 0 },
            grid: { color: colors.grid },
          },
        },
      },
    }),
    [chartMode, days],
  )

  if (!owner) return <AdminForbidden />

  if (state === 'loading' && !overview) {
    return (
      <AdminPage title={t('clouddrive.nav.dashboard')}>
        <AdminLoading />
      </AdminPage>
    )
  }

  if (state === 'error' || !overview) {
    return (
      <AdminPage title={t('clouddrive.nav.dashboard')}>
        <AdminError message={error} onRetry={() => void load()} />
      </AdminPage>
    )
  }

  const counts = overview.counts
  const countCards = [
    { id: 'files', label: t('clouddrive.nav.files'), value: counts.files, icon: <Files size={15} /> },
    { id: 'shares', label: t('clouddrive.nav.shares'), value: counts.shares, icon: <Share2 size={15} /> },
    { id: 'keys', label: t('clouddrive.nav.keys'), value: counts.keys, icon: <KeyRound size={15} /> },
    { id: 'storages', label: adminT('clouddrive.admin.dashboard.storages'), value: counts.storages, icon: <HardDrive size={15} /> },
  ]

  return (
    <AdminPage
      title={t('clouddrive.nav.dashboard')}
      actions={(
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} className={state === 'loading' ? 'animate-spin' : undefined} />}
          disabled={state === 'loading'}
          onClick={() => void load()}
        >
          {t('clouddrive.toolbar.refresh')}
        </Button>
      )}
    >
      <div className="flex flex-col gap-3">
        <section aria-label={t('clouddrive.nav.dashboard')} className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {countCards.map((card) => (
            <AdminStat key={card.id} label={card.label} value={formatAdminNumber(card.value)} icon={card.icon} />
          ))}
        </section>

        <div className="grid gap-3 lg:grid-cols-2">
          <AdminCard
            title={t('clouddrive.capacity.title')}
            actions={capacity && capacity.storages.length > 0 ? (
              <div className="w-40 max-w-full">
                <Select
                  aria-label={t('clouddrive.capacity.title')}
                  className="h-8 text-[length:var(--text-11-5)]"
                  value={storageId}
                  onChange={(event) => setStorageId(event.target.value)}
                >
                  <option value="all">{adminT('clouddrive.admin.dashboard.capacity_all')}</option>
                  {capacity.storages.map((storage) => (
                    <option key={storage.id} value={storage.id}>{storage.name}</option>
                  ))}
                </Select>
              </div>
            ) : undefined}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div>
                <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.dashboard.used')}</div>
                <div className="mt-0.5 text-[length:var(--text-14)] font-semibold tabular text-[var(--text-primary)]">{formatBytes(usedBytes)}</div>
              </div>
              <div>
                <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.dashboard.quota')}</div>
                <div className="mt-0.5 text-[length:var(--text-14)] font-semibold tabular text-[var(--text-primary)]">
                  {quotaBytes == null ? adminT('clouddrive.admin.dashboard.no_quota') : formatBytes(quotaBytes)}
                </div>
              </div>
              <div>
                <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.settings.trash')}</div>
                <div className="mt-0.5 text-[length:var(--text-14)] font-semibold tabular text-[var(--text-primary)]">
                  {trashBytes == null ? '—' : formatBytes(trashBytes)}
                </div>
              </div>
            </div>
            {quotaBytes != null && quotaBytes > 0 && (
              <div className="mt-3">
                <AdminMeter
                  ratio={usedBytes / quotaBytes}
                  label={adminT('clouddrive.admin.dashboard.quota')}
                  valueText={`${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)}`}
                />
              </div>
            )}
          </AdminCard>

          <AdminCard title={adminT('clouddrive.admin.dashboard.type_distribution')}>
            {capacity && capacity.types.length > 0 ? (
              <ul className="flex flex-col gap-2.5">
                {capacity.types.map((entry) => {
                  const totalBytes = capacity.types.reduce((sum, item) => sum + item.bytes, 0)
                  const totalCount = capacity.types.reduce((sum, item) => sum + item.count, 0)
                  const weight = totalBytes > 0
                    ? entry.bytes / totalBytes
                    : totalCount > 0 ? entry.count / totalCount : 0
                  return (
                    <li key={entry.type}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[length:var(--text-11-5)]">
                        <span className="font-medium text-[var(--text-primary)]">{entry.type.toUpperCase()}</span>
                        <span className="tabular text-[var(--text-tertiary)]">
                          {formatBytes(entry.bytes)} · {adminT('clouddrive.admin.dashboard.objects', { count: formatAdminNumber(entry.count) })}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden>
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round(weight * 100)}%` }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <AdminEmpty title={adminT('clouddrive.admin.no_data')} />
            )}
          </AdminCard>
        </div>

        <AdminCard
          title={adminT('clouddrive.admin.dashboard.cache')}
          actions={<Badge tone="neutral">{adminT('clouddrive.admin.cache.isolate')}</Badge>}
          hint={adminT('clouddrive.admin.cache.isolate_hint')}
        >
          {cache ? (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { key: 'entries', label: adminT('clouddrive.admin.cache.entries'), value: formatAdminNumber(cache.entries), hint: formatBytes(cache.bytes) },
                { key: 'hits', label: adminT('clouddrive.admin.cache.hits'), value: formatAdminNumber(cache.hits) },
                { key: 'misses', label: adminT('clouddrive.admin.cache.misses'), value: formatAdminNumber(cache.misses) },
                { key: 'snapshot', label: adminT('clouddrive.admin.cache.snapshot'), value: formatAdminDateTime(cache.snapshotAt) },
              ].map((item) => (
                <div key={item.key}>
                  <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{item.label}</dt>
                  <dd className="mt-0.5 text-[length:var(--text-13)] font-semibold tabular text-[var(--text-primary)]">{item.value}</dd>
                  {item.hint && <dd className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{item.hint}</dd>}
                </div>
              ))}
            </dl>
          ) : (
            <AdminEmpty title={adminT('clouddrive.admin.no_data')} />
          )}
        </AdminCard>

        <AdminCard
          title={adminT('clouddrive.admin.dashboard.weekly_activity')}
          actions={(
            <Segmented<ChartMode>
              value={chartMode}
              size="sm"
              label={adminT('clouddrive.admin.dashboard.weekly_activity')}
              options={[
                { value: 'bar', label: <BarChart3 size={14} />, title: adminT('clouddrive.admin.chart.bar') },
                { value: 'line', label: <LineChart size={14} />, title: adminT('clouddrive.admin.chart.line') },
              ]}
              onChange={setChartMode}
            />
          )}
        >
          {days.length === 0 ? (
            <AdminEmpty title={adminT('clouddrive.admin.no_data')} />
          ) : !hasActivity ? (
            <AdminEmpty title={adminT('clouddrive.admin.chart.no_activity')} />
          ) : (
            <ChartCanvas
              height="h-56"
              label={adminT('clouddrive.admin.chart.label')}
              build={buildChart}
            />
          )}
        </AdminCard>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border-subtle)] pt-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span>{adminT('clouddrive.admin.version')}: {overview.version || '—'}</span>
          <span>{adminT('clouddrive.admin.environment')}: {overview.environment || '—'}</span>
          <span>{t('clouddrive.admin.database')}: {overview.database || '—'}</span>
          <span>{adminT('clouddrive.admin.last_updated')}: {formatAdminDateTime(overview.updatedAt)}</span>
        </footer>
      </div>
    </AdminPage>
  )
}
