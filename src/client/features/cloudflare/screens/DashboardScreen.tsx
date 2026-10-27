/**
 * The Cloudflare dashboard: quota cards, resources and usage, zone traffic, recent activity.
 *
 * The screen owns only the quota read, because every other panel needs the account list it returns.
 * Each panel then loads its own data and shows its own loading, empty and error states, so one
 * Cloudflare product being unreachable cannot blank the screen.
 */
import { useEffect, useState } from 'react'
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { Badge } from '../../../components/primitives'
import { SearchField } from '../components/SearchField'
import { SelectMenu } from '../../../components/select-menu'
import { cfErrorText } from '../api/client'
import { getQuota } from '../api/dashboard'
import { useCfT } from '../i18n'
import {
  QUOTA_RESOURCE_ORDER,
  quotaResourceLabel,
  quotaTone,
  quotaUsedPercent,
  quotaValueText,
} from '../lib/quota-view'
import { CompactAccountCard } from './dashboard/CompactAccountCard'
import { Panel, PanelEmpty, PanelError } from './dashboard/Panel'
import { ResourcesPanel } from './dashboard/ResourcesPanel'
import { TrafficPanel } from './dashboard/TrafficPanel'
import { AuditLogPanel } from './dashboard/AuditLogPanel'

type AccountSort = 'name' | 'name-desc' | 'usage-desc' | 'usage-asc'

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function maxUsage(account: AccountQuotaView): number {
  return Math.max(0, ...account.resources.map(quotaUsedPercent))
}

export function DashboardScreen() {
  const tcf = useCfT()
  const [quota, setQuota] = useState<AccountQuotaView[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<AccountSort>('name')
  const [detail, setDetail] = useState<AccountQuotaView | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void getQuota()
      .then((body) => {
        if (!cancelled) setQuota(body.accounts)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  const accounts = quota ?? []
  const withResources = accounts.filter((account) => account.resources.length > 0)
  const query = search.trim().toLowerCase()
  const visible = withResources
    .filter((account) => !query || account.account_name.toLowerCase().includes(query))
    .sort((left, right) => {
      switch (sort) {
        case 'name-desc':
          return right.account_name.localeCompare(left.account_name)
        case 'usage-desc':
          return maxUsage(right) - maxUsage(left)
        case 'usage-asc':
          return maxUsage(left) - maxUsage(right)
        default:
          return left.account_name.localeCompare(right.account_name)
      }
    })

  const aiExhausted = withResources.filter((account) => (
    account.resources.some((row) => row.resource === 'ai_neurons' && row.exhausted)
  )).length
  const browserExhausted = withResources.filter((account) => (
    account.resources.some((row) => row.resource === 'browser_render_seconds' && row.exhausted)
  )).length
  const totals = {
    ai: withResources.reduce((sum, account) => (
      sum + (account.resources.find((row) => row.resource === 'ai_neurons')?.count ?? 0)
    ), 0),
    workers: withResources.reduce((sum, account) => (
      sum + (account.resources.find((row) => row.resource === 'workers_requests')?.count ?? 0)
    ), 0),
    browser: withResources.reduce((sum, account) => (
      sum + (account.resources.find((row) => row.resource === 'browser_render_seconds')?.count ?? 0)
    ), 0),
  }

  const sortOptions = [
    { value: 'name', label: tcf('cloudflare.dashboard.sort_name_asc') },
    { value: 'name-desc', label: tcf('cloudflare.dashboard.sort_name_desc') },
    { value: 'usage-desc', label: tcf('cloudflare.dashboard.sort_usage_desc') },
    { value: 'usage-asc', label: tcf('cloudflare.dashboard.sort_usage_asc') },
  ] as const

  const detailResources = detail
    ? QUOTA_RESOURCE_ORDER
      .filter((key) => detail.resources.some((row) => row.resource === key))
      .map((key) => detail.resources.find((row) => row.resource === key)!)
    : []

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {tcf('cloudflare.dashboard.title')}
        </h1>
        <Badge tone="accent">{tcf('cloudflare.dashboard.today_quota')}</Badge>
      </header>

      <Panel
        title={tcf('cloudflare.dashboard.today_quota')}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <SelectMenu
              label={tcf('cloudflare.dashboard.sort_name_asc')}
              value={sort}
              options={sortOptions}
              onChange={setSort}
              size="sm"
              width={180}
              className="w-40"
            />
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={tcf('cloudflare.dashboard.search_accounts')}
              label={tcf('cloudflare.dashboard.search_accounts')}
              className="w-48"
            />
          </div>
        )}
        bodyClassName="space-y-3"
      >
        {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
        {loading && quota === null ? (
          <LoadingBlock />
        ) : withResources.length === 0 ? (
          error ? null : <PanelEmpty>{tcf('cloudflare.dashboard.no_account_data')}</PanelEmpty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>
                {withResources.length} {tcf('cloudflare.dashboard.accounts')}
              </Badge>
              {aiExhausted > 0 ? (
                <Badge tone="danger">
                  {tcf('cloudflare.compact_card.ai_neurons')} {aiExhausted}
                </Badge>
              ) : null}
              {browserExhausted > 0 ? (
                <Badge tone="danger">
                  {tcf('cloudflare.compact_card.browser_render')} {browserExhausted}
                </Badge>
              ) : null}
              <Badge tone="accent">
                {tcf('cloudflare.compact_card.ai_neurons')} {formatCompact(totals.ai)}
              </Badge>
              <Badge>
                {tcf('cloudflare.compact_card.workers_requests')} {formatCompact(totals.workers)}
              </Badge>
              {totals.browser > 0 ? (
                <Badge>
                  {tcf('cloudflare.compact_card.browser_render')} {tcf('cloudflare.browser_render.format_seconds', { s: formatCompact(totals.browser) })}
                </Badge>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-8">
              {visible.map((account) => (
                <CompactAccountCard
                  key={account.account_id}
                  account={account}
                  onOpen={() => setDetail(account)}
                />
              ))}
            </div>
            {visible.length === 0 ? (
              <PanelEmpty>{tcf('cloudflare.dashboard.no_account_data')}</PanelEmpty>
            ) : null}
          </>
        )}
      </Panel>

      <ResourcesPanel accounts={accounts} />
      <TrafficPanel accounts={accounts} />
      <AuditLogPanel />

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.account_name ?? ''}
        width={420}
      >
        {detailResources.length === 0 ? (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {tcf('cloudflare.compact_card.no_data')}
          </p>
        ) : (
          <div className="space-y-3">
            {detailResources.map((row) => {
              const label = quotaResourceLabel(row.resource)
              const percent = quotaUsedPercent(row)
              return (
                <div key={row.resource}>
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[length:var(--text-12)]">
                    <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
                      {label}
                      {row.exhausted ? (
                        <Badge tone="danger">{tcf('cloudflare.compact_card.exhausted')}</Badge>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-[var(--text-tertiary)]">{quotaValueText(row)}</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`${label}: ${percent}%`}
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-sunken)]"
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${percent}%`, backgroundColor: quotaTone(percent) }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}
