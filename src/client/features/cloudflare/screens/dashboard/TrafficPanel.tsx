/**
 * Zone traffic: four series over the same window, drawn with the app's own SVG chart.
 *
 * The account selector lists the accounts the quota read already returned, and the domain selector
 * asks the route for zones in that account only. A zone that is not in the answer never reaches the
 * chart, which is the same ownership check the route makes again on the server.
 */
import { useEffect, useState } from 'react'
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { Segmented } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { useCfT, type CloudflareMessageKey } from '../../i18n'
import {
  getDashboardTraffic,
  getDashboardZones,
  type DashboardTrafficResponse,
  type DashboardTrafficSeries,
  type DashboardZone,
} from '../../api/dashboard'
import { cfErrorDetail, cfErrorText } from '../../api/client'
import { formatBytes, formatNumber } from '../../lib/format'
import { LineChart } from '../../components/LineChart'
import { Panel, PanelEmpty, PanelError } from './Panel'

type DayRange = '1' | '7' | '14' | '30'
const DAY_RANGES: readonly DayRange[] = ['1', '7', '14', '30']

interface Metric {
  key: keyof DashboardTrafficSeries
  labelKey: CloudflareMessageKey
  color: string
  isBytes: boolean
}

const METRICS: readonly Metric[] = [
  { key: 'requests', labelKey: 'cloudflare.dashboard.traffic.requests', color: 'var(--chart-1)', isBytes: false },
  { key: 'visitors', labelKey: 'cloudflare.dashboard.traffic.visitors', color: 'var(--chart-2)', isBytes: false },
  { key: 'pageViews', labelKey: 'cloudflare.dashboard.traffic.page_views', color: 'var(--chart-3)', isBytes: false },
  { key: 'bytes', labelKey: 'cloudflare.dashboard.traffic.bytes', color: 'var(--chart-4)', isBytes: true },
]

function formatMetric(value: number, isBytes: boolean): string {
  if (isBytes) return formatBytes(value)
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}

export function TrafficPanel({ accounts }: { accounts: readonly AccountQuotaView[] }) {
  const tcf = useCfT()
  const [accountId, setAccountId] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [days, setDays] = useState<DayRange>('14')
  const [zones, setZones] = useState<DashboardZone[]>([])
  const [zonesLoading, setZonesLoading] = useState(false)
  const [zonesError, setZonesError] = useState<string | null>(null)
  const [zonesReload, setZonesReload] = useState(0)
  const [traffic, setTraffic] = useState<DashboardTrafficResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [trafficReload, setTrafficReload] = useState(0)

  const effectiveAccountId = accounts.some((account) => account.account_id === accountId)
    ? accountId
    : accounts[0]?.account_id ?? ''
  const effectiveZoneId = zones.some((zone) => zone.id === zoneId)
    ? zoneId
    : zones[0]?.id ?? ''

  useEffect(() => {
    setZoneId('')
    setZones([])
  }, [effectiveAccountId])

  useEffect(() => {
    if (!effectiveAccountId) {
      setZones([])
      return
    }
    let cancelled = false
    setZonesLoading(true)
    setZonesError(null)
    void getDashboardZones(effectiveAccountId)
      .then((body) => {
        if (!cancelled) setZones(body.zones)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setZones([])
        setZonesError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setZonesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveAccountId, zonesReload])

  useEffect(() => {
    if (!effectiveAccountId || !effectiveZoneId) {
      setTraffic(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setTraffic(null)
    void getDashboardTraffic({
      accountId: effectiveAccountId,
      zoneId: effectiveZoneId,
      days: Number(days),
    })
      .then((body) => {
        if (!cancelled) setTraffic(body)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setError(failure)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveAccountId, effectiveZoneId, days, trafficReload])

  const accountOptions = accounts.map((account) => ({
    value: account.account_id,
    label: account.account_name,
  }))
  const zoneOptions = zones.map((zone) => ({ value: zone.id, label: zone.name }))
  const rangeOptions = DAY_RANGES.map((value) => ({
    value,
    label: value === '1'
      ? tcf('cloudflare.dashboard.traffic.range24h')
      : tcf('cloudflare.dashboard.traffic.range_days', { days: Number(value) }),
  }))

  return (
    <Panel
      title={tcf('cloudflare.dashboard.traffic.title')}
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <SelectMenu
            label={tcf('cloudflare.dashboard.traffic.select_account')}
            value={effectiveAccountId}
            options={accountOptions}
            onChange={(value) => {
              setAccountId(value)
              setZoneId('')
              setZones([])
            }}
            disabled={accountOptions.length === 0}
            placeholder={tcf('cloudflare.dashboard.traffic.select_account')}
            size="sm"
            width={190}
            className="w-40"
          />
          <SelectMenu
            label={tcf('cloudflare.dashboard.traffic.select_domain')}
            value={effectiveZoneId}
            options={zoneOptions}
            onChange={setZoneId}
            disabled={zoneOptions.length === 0 || zonesLoading}
            placeholder={tcf('cloudflare.dashboard.traffic.select_domain')}
            size="sm"
            width={210}
            className="w-44"
          />
          <Segmented
            value={days}
            options={rangeOptions}
            onChange={setDays}
            size="sm"
            label={tcf('cloudflare.dashboard.traffic.title')}
          />
        </div>
      )}
      bodyClassName="space-y-3"
    >
      {zonesError ? (
        <PanelError message={zonesError} onRetry={() => setZonesReload((value) => value + 1)} />
      ) : null}
      {error ? (
        <PanelError
          message={cfErrorText(error)}
          detail={cfErrorDetail(error)}
          onRetry={() => setTrafficReload((value) => value + 1)}
        />
      ) : null}

      {!effectiveAccountId ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.no_account_data')}</PanelEmpty>
      ) : zonesLoading && zones.length === 0 ? (
        <LoadingBlock />
      ) : !effectiveZoneId ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.traffic.empty')}</PanelEmpty>
      ) : loading && !traffic ? (
        <LoadingBlock />
      ) : !traffic || traffic.labels.length === 0 ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.traffic.empty')}</PanelEmpty>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {METRICS.map((metric) => {
            const values = traffic.series[metric.key]
            const total = values.reduce((sum, value) => sum + value, 0)
            return (
              <div
                key={metric.key}
                className="flex flex-col gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ backgroundColor: metric.color }}
                  />
                  <span className="text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                    {tcf(metric.labelKey)}
                  </span>
                  <span className="ml-auto rounded-full bg-[var(--bg-sunken)] px-1.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-secondary)]">
                    {formatMetric(total, metric.isBytes)}
                  </span>
                </div>
                <LineChart
                  data={traffic.labels.map((label, index) => ({
                    label,
                    value: values[index] ?? 0,
                  }))}
                  color={metric.color}
                  height={96}
                  formatValue={(value) => formatMetric(value, metric.isBytes)}
                  label={tcf(metric.labelKey)}
                  stretch
                  tooltip
                />
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
