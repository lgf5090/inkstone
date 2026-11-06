/**
 * One Worker's metrics over 1, 7 or 30 days, in Cloudflare's own reporting units.
 *
 * Requests, errors, subrequests and CPU quantiles come from `workersInvocationsAdaptive`; the error
 * rate is derived from those two counts and is labelled as a rate, never sent back as a Cloudflare
 * field. A failed CPU-total query hides only that card rather than blanking the rest.
 */
import { useEffect, useState } from 'react'
import { LoadingBlock } from '../../../../components/feedback'
import { Drawer } from '../../../../components/overlay'
import { Badge } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { cfErrorText } from '../../api/client'
import { workersApi, type WorkerMetrics } from '../../api/workers'
import { useCfT } from '../../i18n'
import { formatNumber } from '../../lib/format'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from '../dns/PanelError'

function micros(value: number | null): string {
  if (value === null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} s`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} ms`
  return `${value} µs`
}

export function WorkerMetricsDrawer({
  open,
  onClose,
  accountId,
  name,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  name: string
}) {
  const tcf = useCfT()
  const [days, setDays] = useState<'1' | '7' | '30'>('7')
  const [data, setData] = useState<WorkerMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void workersApi.getMetrics(accountId, name, Number(days))
      .then((value) => { if (!cancelled) setData(value) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, accountId, name, days, reload])

  const errorRate = data && data.requests > 0 ? Math.round((data.errors / data.requests) * 1000) / 10 : 0

  return (
    <Drawer open={open} onClose={onClose} width={680} title={tcf('cloudflare.workers.metrics.title', { name })}>
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {tcf('cloudflare.workers.metrics.hint')}
          </p>
          <SelectMenu
            label={tcf('cloudflare.workers.metrics.range')}
            value={days}
            options={[
              { value: '1', label: tcf('cloudflare.workers.metrics.range_1d') },
              { value: '7', label: tcf('cloudflare.workers.metrics.range_7d') },
              { value: '30', label: tcf('cloudflare.workers.metrics.range_30d') },
            ]}
            onChange={(value) => setDays(value as typeof days)}
            size="sm"
            width={150}
            className="w-36"
          />
        </div>

        {loading && !data ? <LoadingBlock /> : error && !data ? (
          <PanelError message={error} onRetry={() => setReload((value) => value + 1)} />
        ) : data ? (
          <>
            {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <MetricCard label={tcf('cloudflare.workers.metrics.requests')} value={formatNumber(data.requests)} />
              <MetricCard label={tcf('cloudflare.workers.metrics.errors')} value={formatNumber(data.errors)} tone={data.errors > 0 ? 'danger' : 'neutral'} />
              <MetricCard label={tcf('cloudflare.workers.metrics.error_rate')} value={`${errorRate}%`} />
              <MetricCard label={tcf('cloudflare.workers.metrics.subrequests')} value={formatNumber(data.subrequests)} />
              <MetricCard label={tcf('cloudflare.workers.metrics.cpu_p50')} value={micros(data.cpuP50Us)} />
              <MetricCard label={tcf('cloudflare.workers.metrics.cpu_p99')} value={micros(data.cpuP99Us)} />
              <MetricCard label={tcf('cloudflare.workers.metrics.cpu_total')} value={micros(data.cpuTotalUs)} />
            </div>

            <div className="space-y-1">
              <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
                {tcf('cloudflare.workers.metrics.status_breakdown')}
              </h3>
              {data.statusBreakdown.length === 0 ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{tcf('cloudflare.workers.metrics.no_data')}</p>
              ) : (
                <TableScroll label={tcf('cloudflare.workers.metrics.status_breakdown')}>
                  <Table>
                    <THead><Tr>
                      <Th>{tcf('cloudflare.workers.metrics.status')}</Th>
                      <Th>{tcf('cloudflare.workers.metrics.requests')}</Th>
                    </Tr></THead>
                    <TBody>
                      {data.statusBreakdown.map((row) => (
                        <Tr key={row.status}>
                          <Td><Badge tone="neutral">{row.status}</Badge></Td>
                          <Td className="tabular">{formatNumber(row.requests)}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </div>

            <div className="space-y-1">
              <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
                {tcf('cloudflare.workers.metrics.series')}
              </h3>
              {data.series.length === 0 ? (
                <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{tcf('cloudflare.workers.metrics.no_data')}</p>
              ) : (
                <TableScroll label={tcf('cloudflare.workers.metrics.series')}>
                  <Table>
                    <THead><Tr>
                      <Th>{tcf('cloudflare.workers.metrics.period')}</Th>
                      <Th>{tcf('cloudflare.workers.metrics.requests')}</Th>
                      <Th>{tcf('cloudflare.workers.metrics.errors')}</Th>
                    </Tr></THead>
                    <TBody>
                      {data.series.map((row) => (
                        <Tr key={row.label}>
                          <Td className="whitespace-nowrap text-[var(--text-secondary)]">{row.label}</Td>
                          <Td className="tabular">{formatNumber(row.requests)}</Td>
                          <Td className="tabular">{formatNumber(row.errors)}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  )
}

function MetricCard({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'danger' }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
      <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</p>
      <p className={`mt-1 text-[length:var(--text-15)] font-semibold tabular-nums ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}>
        {value}
      </p>
    </div>
  )
}
