/**
 * The AI statistics tab: today's usage per account, the share ring, the model ranking and one card
 * per account. Usage comes from one route, so the tab owns a single load and one retry.
 */
import { useEffect, useMemo, useState } from 'react'
import { Activity, Boxes, RefreshCw, Users, Zap } from 'lucide-react'
import type { AiUsageAccount } from '../../api/ai'
import { aiApi } from '../../api/ai'
import { cfErrorText } from '../../api/client'
import { useCfT } from '../../i18n'
import { formatNeurons, formatNumber, percentLabel, percentOf } from '../../lib/format'
import { sharePercent, shortModelId, NEURON_QUOTA } from './options'
import { Badge, Button } from '../../../../components/primitives'
import { Empty, LoadingBlock } from '../../../../components/feedback'
import { Table, TableScroll, TBody, THead, Th, Td, Tr } from '../../components/Table'
import { UsageRing } from '../../components/UsageRing'
import { AiEmpty, AiError, AiPanel } from './AiPanel'

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const

interface ModelTotal {
  modelId: string
  neurons: number
  requests: number
}

function accountRequests(account: AiUsageAccount): number {
  return account.models.reduce((sum, model) => sum + (model.requests || 0), 0)
}

function ShareRing({
  accounts,
  totalNeurons,
  totalQuota,
  label,
}: {
  accounts: readonly AiUsageAccount[]
  totalNeurons: number
  totalQuota: number
  label: string
}) {
  const size = 176
  const stroke = 18
  const radius = (size - stroke) / 2
  const center = size / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = accounts.map((account, index) => {
    const length = totalNeurons > 0 ? (account.totalNeurons / totalNeurons) * circumference : 0
    const segment = { account, index, length, offset, color: PALETTE[index % PALETTE.length] }
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
        aria-label={`${label}: ${formatNeurons(totalNeurons)} / ${formatNumber(totalQuota)} (${percentLabel(totalNeurons, totalQuota)})`}
      >
        <title>{`${label}: ${formatNumber(totalNeurons)} / ${formatNumber(totalQuota)}`}</title>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--border-subtle)" strokeWidth={stroke} />
        {segments.map((segment) => (
          <circle
            key={segment.account.accountId}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={segment.color}
            strokeWidth={stroke}
            strokeDasharray={`${segment.length} ${circumference - segment.length}`}
            strokeDashoffset={-segment.offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center">
        <span className="text-[length:var(--text-22)] font-semibold tabular-nums text-[var(--text-primary)]">
          {formatNeurons(totalNeurons)}
        </span>
        <span className="px-6 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">
          / {formatNumber(totalQuota)} · {percentLabel(totalNeurons, totalQuota)}
        </span>
      </div>
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

  const kpis = [
    { key: 'accounts', label: t('cloudflare.ai_stats.total_accounts'), value: formatNumber(rows.length), icon: Users },
    { key: 'neurons', label: t('cloudflare.ai_stats.total_neurons'), value: formatNeurons(totals.neurons), icon: Zap },
    { key: 'requests', label: t('cloudflare.ai_stats.total_requests'), value: formatNumber(totals.requests), icon: Activity },
    { key: 'models', label: t('cloudflare.ai_stats.active_models'), value: formatNumber(totals.models), icon: Boxes },
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
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
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

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <AiPanel title={t('cloudflare.ai_stats.account_share')}>
              <div className="flex flex-col items-center gap-4 md:flex-row md:items-start">
                <ShareRing
                  accounts={rows}
                  totalNeurons={totals.neurons}
                  totalQuota={totalQuota}
                  label={t('cloudflare.ai_stats.account_share')}
                />
                <ul className="min-w-0 flex-1 space-y-1.5">
                  {rows.map((account, index) => (
                    <li key={account.accountId} className="flex min-w-0 items-center gap-2 text-[length:var(--text-12)]">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: PALETTE[index % PALETTE.length] }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={account.accountName}>
                        {account.accountName}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
                        {sharePercent(account.totalNeurons, totals.neurons)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-3 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('cloudflare.ai_stats.share_hint')}
              </p>
            </AiPanel>

            <AiPanel title={t('cloudflare.ai_stats.model_ranking')}>
              {ranking.length === 0 ? (
                <AiEmpty>{t('cloudflare.compact_card.no_data')}</AiEmpty>
              ) : (
                <TableScroll label={t('cloudflare.ai_stats.model_ranking')}>
                  <Table>
                    <THead>
                      <tr>
                        <Th>{t('cloudflare.ai_stats.model_ranking')}</Th>
                        <Th className="text-right">{t('cloudflare.ai_stats.neurons')}</Th>
                        <Th className="text-right">{t('cloudflare.ai_stats.requests_short')}</Th>
                        <Th className="text-right">{t('cloudflare.ai_stats.share')}</Th>
                      </tr>
                    </THead>
                    <TBody>
                      {ranking.map((model) => (
                        <Tr key={model.modelId}>
                          <Td title={model.modelId}>{shortModelId(model.modelId)}</Td>
                          <Td className="text-right tabular-nums">{formatNeurons(model.neurons)}</Td>
                          <Td className="text-right tabular-nums">{formatNumber(model.requests)}</Td>
                          <Td className="text-right tabular-nums">
                            {sharePercent(model.neurons, totals.neurons)}%
                          </Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </AiPanel>
          </div>

          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((account, index) => {
              const used = percentOf(account.totalNeurons, NEURON_QUOTA)
              const tone = used >= 95 ? 'danger' : used >= 80 ? 'warning' : 'neutral'
              return (
                <li
                  key={account.accountId}
                  className="flex min-w-0 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]" title={account.accountName}>
                        {account.accountName}
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
                        {formatNeurons(account.totalNeurons)} / {formatNumber(NEURON_QUOTA)} {t('cloudflare.ai_stats.neurons')}
                        {' · '}
                        {t('cloudflare.ai_stats.share')} {sharePercent(account.totalNeurons, totals.neurons)}%
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {used >= 80 ? <Badge tone={tone}>{percentLabel(account.totalNeurons, NEURON_QUOTA)}</Badge> : null}
                      <UsageRing
                        used={account.totalNeurons}
                        limit={NEURON_QUOTA}
                        color={PALETTE[index % PALETTE.length]}
                        label={account.accountName}
                      />
                    </div>
                  </div>
                  {account.warning ? (
                    <p className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{account.warning}</p>
                  ) : null}
                  <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
                    <div className="mb-1 flex items-center justify-between text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                      <span>{t('cloudflare.ai.model_detail', { count: account.models.length })}</span>
                      <span className="tabular-nums">
                        {formatNumber(accountRequests(account))} {t('cloudflare.ai_stats.requests_short')}
                      </span>
                    </div>
                    {account.models.length === 0 ? (
                      <AiEmpty>{t('cloudflare.compact_card.no_data')}</AiEmpty>
                    ) : (
                      <ul className="space-y-1">
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
        </>
      )}
    </div>
  )
}
