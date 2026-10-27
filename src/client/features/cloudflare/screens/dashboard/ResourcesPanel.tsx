/**
 * Resources and today's usage for one account.
 *
 * A product Cloudflare would not answer shows an em dash instead of a zero. The ring is only drawn
 * when there is a number behind it; a ring at 0% would be a claim the route never made.
 */
import { useEffect, useState } from 'react'
import {
  Database,
  ExternalLink,
  FileCode,
  Globe,
  KeyRound,
  Network,
  TableProperties,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { SelectMenu } from '../../../../components/select-menu'
import { useCfT, type CloudflareMessageKey } from '../../i18n'
import {
  getDashboardResources,
  type DashboardResourcesResponse,
  type ResourceCountKey,
  type UsageKey,
} from '../../api/dashboard'
import { cfErrorText } from '../../api/client'
import { formatBytes, formatNumber } from '../../lib/format'
import { UsageRing } from '../../components/UsageRing'
import { Panel, PanelEmpty, PanelError } from './Panel'

interface ServiceCard {
  countKey: ResourceCountKey
  usageKey: UsageKey
  icon: LucideIcon
  labelKey: CloudflareMessageKey
  usageLabelKey: CloudflareMessageKey
  isBytes: boolean
}

const SERVICE_CARDS: readonly ServiceCard[] = [
  {
    countKey: 'workers',
    usageKey: 'workers_requests',
    icon: Zap,
    labelKey: 'cloudflare.dashboard.resources.workers',
    usageLabelKey: 'cloudflare.dashboard.resources.today_requests',
    isBytes: false,
  },
  {
    countKey: 'r2',
    usageKey: 'r2_storage',
    icon: Database,
    labelKey: 'cloudflare.dashboard.resources.r2',
    usageLabelKey: 'cloudflare.dashboard.resources.storage',
    isBytes: true,
  },
  {
    countKey: 'd1',
    usageKey: 'd1_writes',
    icon: TableProperties,
    labelKey: 'cloudflare.dashboard.resources.d1',
    usageLabelKey: 'cloudflare.dashboard.resources.today_writes',
    isBytes: false,
  },
  {
    countKey: 'kv',
    usageKey: 'kv_reads',
    icon: KeyRound,
    labelKey: 'cloudflare.dashboard.resources.kv',
    usageLabelKey: 'cloudflare.dashboard.resources.today_reads',
    isBytes: false,
  },
]

const COUNT_ONLY = [
  { key: 'domains', icon: Globe, labelKey: 'cloudflare.dashboard.resources.domains' },
  { key: 'pages', icon: FileCode, labelKey: 'cloudflare.dashboard.resources.pages' },
  { key: 'dns', icon: Network, labelKey: 'cloudflare.dashboard.resources.dns' },
] as const satisfies ReadonlyArray<{
  key: ResourceCountKey
  icon: LucideIcon
  labelKey: CloudflareMessageKey
}>

function formatUsage(value: number, isBytes: boolean): string {
  if (isBytes) return formatBytes(value)
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
}

const CHART_SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'] as const

export function ResourcesPanel({ accounts }: { accounts: readonly AccountQuotaView[] }) {
  const tcf = useCfT()
  const [accountId, setAccountId] = useState('')
  const [data, setData] = useState<DashboardResourcesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const effectiveAccountId = accounts.some((account) => account.account_id === accountId)
    ? accountId
    : accounts[0]?.account_id ?? ''

  useEffect(() => {
    if (!effectiveAccountId) {
      setData(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void getDashboardResources(effectiveAccountId)
      .then((body) => {
        if (!cancelled) setData(body)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setError(cfErrorText(failure))
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveAccountId, reload])

  const accountOptions = accounts.map((account) => ({
    value: account.account_id,
    label: account.account_name,
  }))
  const countFor = (key: ResourceCountKey): number | null =>
    data?.counts.find((item) => item.key === key)?.count ?? null
  const usageFor = (key: UsageKey) =>
    data?.usage.find((item) => item.key === key) ?? null
  const totalRequests = usageFor('workers_requests')

  return (
    <Panel
      title={tcf('cloudflare.dashboard.resources.title')}
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="https://dash.cloudflare.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            {tcf('cloudflare.dashboard.resources.goto_console')}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
          <SelectMenu
            label={tcf('cloudflare.dashboard.resources.select_account')}
            value={effectiveAccountId}
            options={accountOptions}
            onChange={setAccountId}
            disabled={accountOptions.length === 0}
            placeholder={tcf('cloudflare.dashboard.resources.select_account')}
            size="sm"
            width={190}
            className="w-40"
          />
        </div>
      )}
      bodyClassName="space-y-3"
    >
      {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {!effectiveAccountId ? (
        <PanelEmpty>{tcf('cloudflare.dashboard.no_account_data')}</PanelEmpty>
      ) : loading && !data ? (
        <LoadingBlock />
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {SERVICE_CARDS.map((card, index) => {
              const count = countFor(card.countKey)
              const usage = usageFor(card.usageKey)
              const Icon = card.icon
              return (
                <div
                  key={card.countKey}
                  className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      <Icon size={13} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{tcf(card.labelKey)}</span>
                    </span>
                    <span className="text-[length:var(--text-20)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
                      {count === null ? '—' : formatNumber(count)}
                    </span>
                    <span className="truncate text-[length:var(--text-11)] leading-none tabular-nums text-[var(--text-primary)]">
                      {usage?.value == null ? '—' : (
                        <>
                          {formatUsage(usage.value, card.isBytes)}
                          <span className="text-[var(--text-tertiary)]">
                            {' / '}
                            {formatUsage(usage.limit, card.isBytes)}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {tcf(card.usageLabelKey)}
                    </span>
                  </div>
                  {usage?.value != null ? (
                    <UsageRing
                      used={usage.value}
                      limit={usage.limit}
                      color={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]}
                      size={58}
                      label={tcf(card.labelKey)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-[58px] shrink-0 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]"
                    >
                      —
                    </span>
                  )}
                </div>
              )
            })}

            <div className="flex items-center justify-around gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              {COUNT_ONLY.map((entry) => {
                const Icon = entry.icon
                const count = countFor(entry.key)
                return (
                  <div key={entry.key} className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center">
                    <Icon size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                    <span className="text-[length:var(--text-20)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
                      {count === null ? '—' : formatNumber(count)}
                    </span>
                    <span className="max-w-full truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {tcf(entry.labelKey)}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <Zap size={13} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{tcf('cloudflare.dashboard.resources.total_requests')}</span>
                </span>
                <span className="text-[length:var(--text-20)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
                  {totalRequests?.value == null ? '—' : formatUsage(totalRequests.value, false)}
                </span>
                <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {tcf('cloudflare.dashboard.resources.today')}
                </span>
              </div>
              {totalRequests?.value != null ? (
                <UsageRing
                  used={totalRequests.value}
                  limit={totalRequests.limit}
                  color="var(--chart-5)"
                  size={58}
                  label={tcf('cloudflare.dashboard.resources.total_requests')}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex size-[58px] shrink-0 items-center justify-center text-[length:var(--text-12)] text-[var(--text-quaternary)]"
                >
                  —
                </span>
              )}
            </div>
          </div>
        </>
      ) : (
        <PanelEmpty>{tcf('cloudflare.dashboard.no_account_data')}</PanelEmpty>
      )}
    </Panel>
  )
}
