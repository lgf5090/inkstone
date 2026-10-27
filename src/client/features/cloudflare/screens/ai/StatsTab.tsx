/**
 * The AI statistics tab: five headline numbers, the usage rings, the model ranking and one card per
 * account.
 *
 * The ring pair is the point of the page. The outer ring is how today's neurons divide between the
 * accounts, the inner one is how much of the combined quota that whole is, and the small rings answer
 * the question a reader actually acts on — how close each account is to its own 10,000. The bars rank
 * models across accounts. Every shape is printed with its number beside it: an angle or a length is
 * something a reader may not be able to resolve, and a colour never carries a value on its own.
 */
import { useEffect, useMemo, useState } from 'react'
import { Activity, Boxes, Gauge, RefreshCw, Users, Zap } from 'lucide-react'
import type { AiUsageAccount } from '../../api/ai'
import { aiApi } from '../../api/ai'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { formatNeurons, formatNumber, percentLabel, percentOf } from '../../lib/format'
import { quotaTone } from '../../lib/quota-view'
import { sharePercent, shortModelId, NEURON_QUOTA } from './options'
import { Badge, Button } from '../../../../components/primitives'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { AiEmpty, AiError, AiPanel } from './AiPanel'

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const

/** Below this share of the quota an account is comfortable, above it worth a colour. */
const WARN_RATE = 70
const DANGER_RATE = 90

interface ModelTotal {
  modelId: string
  neurons: number
  requests: number
}

function accountRequests(account: AiUsageAccount): number {
  return account.models.reduce((sum, model) => sum + (model.requests || 0), 0)
}

/** The two rings: today's neurons split by account, inside the slice of the combined quota they are. */
function UsageRings({
  accounts,
  totalNeurons,
  totalQuota,
  shareLabel,
  rateLabel,
}: {
  accounts: readonly AiUsageAccount[]
  totalNeurons: number
  totalQuota: number
  shareLabel: string
  rateLabel: string
}) {
  const size = 176
  const stroke = 16
  const innerStroke = 10
  const outerRadius = (size - stroke) / 2
  const innerRadius = outerRadius - stroke / 2 - 10 - innerStroke / 2
  const center = size / 2
  const outerCircumference = 2 * Math.PI * outerRadius
  const innerCircumference = 2 * Math.PI * innerRadius
  const totalRate = totalQuota > 0 ? Math.min((totalNeurons / totalQuota) * 100, 100) : 0

  let offset = 0
  const segments = accounts.map((account, index) => {
    const length = totalNeurons > 0 ? (account.totalNeurons / totalNeurons) * outerCircumference : 0
    const segment = { account, length, offset, color: PALETTE[index % PALETTE.length] }
    offset += length
    return segment
  })

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${shareLabel}: ${formatNeurons(totalNeurons)} / ${formatNumber(totalQuota)} (${percentLabel(totalNeurons, totalQuota)}); ${rateLabel}`}
      >
        <title>{`${shareLabel}: ${formatNeurons(totalNeurons)} / ${formatNumber(totalQuota)} (${percentLabel(totalNeurons, totalQuota)})`}</title>
        <circle cx={center} cy={center} r={outerRadius} fill="none" stroke="var(--border-subtle)" strokeWidth={stroke} />
        {segments.map((segment) => (
          <circle
            key={segment.account.accountId}
            cx={center}
            cy={center}
            r={outerRadius}
            fill="none"
            stroke={segment.color}
            strokeWidth={stroke}
            strokeDasharray={`${segment.length} ${outerCircumference - segment.length}`}
            strokeDashoffset={-segment.offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ))}
        <circle cx={center} cy={center} r={innerRadius} fill="none" stroke="var(--border-subtle)" strokeWidth={innerStroke} />
        <circle
          cx={center}
          cy={center}
          r={innerRadius}
          fill="none"
          stroke={quotaTone(totalRate)}
          strokeWidth={innerStroke}
          strokeDasharray={`${(innerCircumference * totalRate) / 100} ${innerCircumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
        <span className="text-[length:var(--text-22)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
          {percentLabel(totalNeurons, totalQuota)}
        </span>
        <span className="px-6 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">
          {formatNeurons(totalNeurons)} / {formatNumber(totalQuota)} ⚡
        </span>
      </div>
    </div>
  )
}

/** One account's own quota, as a ring with the rate in the middle. */
function AccountRateRing({
  used,
  limit,
  color,
  label,
  size = 92,
}: {
  used: number
  limit: number
  color: string
  label: string
  size?: number
}) {
  const stroke = 8
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const percent = percentOf(used, limit)
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label}: ${percentLabel(used, limit)}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border-subtle)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[length:var(--text-13)] font-semibold tabular-nums text-[var(--text-primary)]">
        {percentLabel(used, limit)}
      </span>
    </div>
  )
}

export function StatsTab() {
  const t = useCfT()
  const [usage, setUsage] = useState<AiUsageAccount[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiApi.usage()
      .then((rows) => {
        if (cancelled) return
        setUsage(rows)
        setError(null)
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        setError(cfErrorText(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [reload])

  const rows = usage ?? []
  const totals = useMemo(() => {
    let neurons = 0
    let requests = 0
    const models = new Set<string>()
    for (const account of rows) {
      neurons += account.totalNeurons
      requests += accountRequests(account)
      for (const model of account.models) models.add(model.modelId)
    }
    return { neurons, requests, models: models.size }
  }, [rows])
  const totalQuota = rows.length * NEURON_QUOTA
  const perAccount = rows.length > 0 ? Math.round(totals.neurons / rows.length) : 0

  const ranking = useMemo(() => {
    const merged = new Map<string, ModelTotal>()
    for (const account of rows) {
      for (const model of account.models) {
        const total = merged.get(model.modelId) ?? { modelId: model.modelId, neurons: 0, requests: 0 }
        total.neurons += model.neurons || 0
        total.requests += model.requests || 0
        merged.set(model.modelId, total)
      }
    }
    return [...merged.values()].sort((left, right) => right.neurons - left.neurons).slice(0, 8)
  }, [rows])
  const busiestModel = Math.max(1, ...ranking.map((model) => model.neurons))

  const kpis = [
    { key: 'accounts', label: t('cloudflare.ai_stats.total_accounts'), value: formatNumber(rows.length), icon: Users },
    { key: 'quota', label: t('cloudflare.ai_stats.total_quota'), value: formatNumber(totalQuota), icon: Zap },
    { key: 'requests', label: t('cloudflare.ai_stats.total_requests'), value: formatNumber(totals.requests), icon: Activity },
    { key: 'models', label: t('cloudflare.ai_stats.active_models'), value: formatNumber(totals.models), icon: Boxes },
    { key: 'avg', label: t('cloudflare.ai_stats.avg_per_account'), value: formatNeurons(perAccount), icon: Gauge },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={13} />}
          loading={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {error ? <AiError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}

      {loading && usage === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        error ? null : (
          <Empty
            art="select"
            compact
            title={t('cloudflare.compact_card.no_data')}
            description={t('cloudflare.ai_stats.share_hint')}
          />
        )
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {kpis.map((kpi) => {
              const Icon = kpi.icon
              return (
                <div
                  key={kpi.key}
                  className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {kpi.label}
                    </span>
                    <span className="text-[length:var(--text-20)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
                      {kpi.value}
                    </span>
                  </div>
                  <Icon size={24} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                </div>
              )
            })}
          </div>

          <div className="grid shrink-0 grid-cols-1 gap-3 lg:grid-cols-2">
            <AiPanel
              title={t('cloudflare.ai_stats.account_share')}
              actions={(
                <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('cloudflare.ai_stats.share_hint')}
                </span>
              )}
              className="flex flex-col"
              bodyClassName="flex flex-1 flex-col justify-center gap-5 md:flex-row md:items-center md:gap-6"
            >
              <UsageRings
                accounts={rows}
                totalNeurons={totals.neurons}
                totalQuota={totalQuota}
                shareLabel={t('cloudflare.ai_stats.account_share')}
                rateLabel={t('cloudflare.ai_stats.share_hint')}
              />
              <ul className="grid w-full min-w-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((account, index) => (
                  <li key={account.accountId} className="flex min-w-0 flex-col items-center gap-1.5">
                    <AccountRateRing
                      used={account.totalNeurons}
                      limit={NEURON_QUOTA}
                      color={PALETTE[index % PALETTE.length]}
                      label={account.accountName}
                    />
                    <span
                      className="max-w-full truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]"
                      title={account.accountName}
                    >
                      {account.accountName}
                    </span>
                    <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
                      {formatNeurons(account.totalNeurons)} / {formatNumber(NEURON_QUOTA)} {t('cloudflare.ai_stats.neurons')}
                    </span>
                  </li>
                ))}
              </ul>
            </AiPanel>

            <AiPanel
              title={t('cloudflare.ai_stats.model_ranking')}
              actions={(
                <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('cloudflare.ai_stats.top_models', { count: ranking.length })}
                </span>
              )}
              className="flex flex-col"
              bodyClassName="flex flex-1 flex-col justify-center gap-2.5"
            >
              {ranking.length === 0 ? (
                <AiEmpty>{t('cloudflare.compact_card.no_data')}</AiEmpty>
              ) : (
                ranking.map((model) => (
                  <div key={model.modelId} className="flex items-center gap-2.5">
                    <span
                      className="w-40 shrink-0 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]"
                      title={model.modelId}
                    >
                      {shortModelId(model.modelId)}
                    </span>
                    <span aria-hidden="true" className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                      <span
                        className="block h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${(model.neurons / busiestModel) * 100}%` }}
                      />
                    </span>
                    <span className="w-36 shrink-0 text-right text-[length:var(--text-11-5)] whitespace-nowrap tabular-nums text-[var(--text-tertiary)]">
                      {formatNeurons(model.neurons)} ⚡ · {formatNumber(model.requests)} {t('cloudflare.ai_stats.requests_short')}
                    </span>
                  </div>
                ))
              )}
            </AiPanel>
          </div>

          <div className="flex min-h-56 flex-1 flex-col">
          <ul
            className="grid min-h-0 flex-1 auto-rows-fr gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))' }}
          >
            {rows.map((account, index) => {
              const rate = percentOf(account.totalNeurons, NEURON_QUOTA)
              const tone = rate >= DANGER_RATE ? 'danger' : rate >= WARN_RATE ? 'warning' : 'neutral'
              return (
                <li
                  key={account.accountId}
                  className="flex min-h-0 min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-5 shrink-0 rounded-full bg-[var(--bg-sunken)] text-center text-[length:var(--text-10-5)] leading-5 tabular-nums text-[var(--text-tertiary)]"
                      >
                        {index + 1}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]"
                        title={account.accountName}
                      >
                        {account.accountName}
                      </span>
                    </span>
                    <Badge tone={tone}>{percentLabel(account.totalNeurons, NEURON_QUOTA)}</Badge>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={rate}
                    aria-label={`${account.accountName}: ${percentLabel(account.totalNeurons, NEURON_QUOTA)}`}
                    className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg-sunken)]"
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${rate}%`, backgroundColor: quotaTone(rate) }}
                    />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                    <span className="tabular-nums">
                      <span className="font-medium text-[var(--text-primary)]">{formatNeurons(account.totalNeurons)}</span>
                      {' / '}{formatNumber(NEURON_QUOTA)} {t('cloudflare.ai_stats.neurons')}
                    </span>
                    <span className="tabular-nums">
                      {t('cloudflare.ai_stats.share')} {sharePercent(account.totalNeurons, totals.neurons)}%
                    </span>
                  </div>
                  {account.warning ? (
                    <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {t(account.warning === 'zero' ? 'cloudflare.ai_stats.warning_zero' : 'cloudflare.ai_stats.warning_local_estimate')}
                    </p>
                  ) : null}
                  <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-[var(--border-subtle)] pt-2">
                    <div className="mb-1 flex shrink-0 items-center justify-between text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <span>{t('cloudflare.ai.model_detail', { count: account.models.length })}</span>
                      <span className="tabular-nums">
                        {formatNumber(accountRequests(account))} {t('cloudflare.ai_stats.requests_short')}
                      </span>
                    </div>
                    {account.models.length === 0 ? (
                      <AiEmpty>{t('cloudflare.compact_card.no_data')}</AiEmpty>
                    ) : (
                      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                        {account.models.map((model) => (
                          <li key={model.modelId} className="flex min-w-0 items-center justify-between gap-2 text-[length:var(--text-11-5)]">
                            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={model.modelId}>
                              {shortModelId(model.modelId)}
                            </span>
                            <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
                              {formatNeurons(model.neurons)} · {formatNumber(model.requests)} {t('cloudflare.ai.requests')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          </div>
        </>
      )}
    </div>
  )
}
