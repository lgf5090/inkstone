/**
 * The relay's own request log, and the AI workspace's landing view.
 *
 * Cloudflare's AI Gateway logs only exist when a request was explicitly routed through a gateway.
 * This table is the opposite: every request the self-hosted relay served, whichever account answered
 * it, recorded at the moment it finished. It is the first place to look when usage or failures need
 * an explanation.
 */
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { DatePicker } from '../../../../components/date-picker'
import { Field } from '../../../../components/form'
import { Button, Badge } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { LoadingBlock } from '../../../../components/feedback'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import {
  aiGatewayApi,
  type GatewayLogView,
  type GatewayOverview,
} from '../../api/ai-gateway'
import { useCfT, type CloudflareMessageKey } from '../../i18n'
import { formatNumber } from '../../lib/format'
import { AiEmpty, AiError, AiPanel } from './AiPanel'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'

type StatusFilter = '' | 'success' | 'error' | 'quota' | 'auth' | 'upstream' | 'client_abort'

const PAGE_SIZE = 20

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

function startOfDay(date: string): number | undefined {
  if (!date) return undefined
  const value = new Date(`${date}T00:00:00`).getTime()
  return Number.isFinite(value) ? value : undefined
}

function endOfDay(date: string): number | undefined {
  if (!date) return undefined
  const value = new Date(`${date}T23:59:59.999`).getTime()
  return Number.isFinite(value) ? value : undefined
}

const STATUS_LABEL: Record<string, CloudflareMessageKey> = {
  success: 'cloudflare.ai_gateway.log_status_success',
  quota: 'cloudflare.ai_gateway.log_status_quota',
  error: 'cloudflare.ai_gateway.log_status_error',
  auth: 'cloudflare.ai_gateway.log_status_auth',
  upstream: 'cloudflare.ai_gateway.log_status_upstream',
  client_abort: 'cloudflare.ai_gateway.log_status_client_abort',
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'success') return 'success'
  if (status === 'quota') return 'warning'
  if (status === 'auth' || status === 'upstream' || status === 'error') return 'danger'
  return 'neutral'
}

function httpTone(status: number): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status >= 200 && status < 300) return 'success'
  if (status === 429) return 'warning'
  if (status >= 400) return 'danger'
  return 'neutral'
}

export function RequestsTab() {
  const t = useCfT()
  const [overview, setOverview] = useState<GatewayOverview | null>(null)
  const [models, setModels] = useState<Array<{ id: string; worker_model: string }>>([])
  const [logs, setLogs] = useState<GatewayLogView[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const [status, setStatus] = useState<StatusFilter>('')
  const [accountId, setAccountId] = useState('')
  const [model, setModel] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    let cancelled = false
    aiGatewayApi.overview()
      .then((body) => { if (!cancelled) setOverview(body) })
      .catch(() => { if (!cancelled) setOverview(null) })
    aiGatewayApi.access()
      .then((body) => { if (!cancelled) setModels(body.models) })
      .catch(() => { if (!cancelled) setModels([]) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayApi.logs({
      page,
      pageSize: PAGE_SIZE,
      ...(status ? { status } : {}),
      ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}),
      ...(startOfDay(from) !== undefined ? { since: startOfDay(from) } : {}),
      ...(endOfDay(to) !== undefined ? { until: endOfDay(to) } : {}),
    })
      .then((body) => {
        if (cancelled) return
        setLogs(body.items)
        setTotal(body.total)
        setError(null)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, status, accountId, model, from, to, reload])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const statusOptions = useMemo(() => [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    { value: 'success', label: t('cloudflare.ai_gateway.log_status_success') },
    { value: 'quota', label: t('cloudflare.ai_gateway.log_status_quota') },
    { value: 'error', label: t('cloudflare.ai_gateway.log_status_error') },
    { value: 'auth', label: t('cloudflare.ai_gateway.log_status_auth') },
    { value: 'upstream', label: t('cloudflare.ai_gateway.log_status_upstream') },
    { value: 'client_abort', label: t('cloudflare.ai_gateway.log_status_client_abort') },
  ], [t])
  const accountOptions = useMemo(() => [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    ...(overview?.accounts ?? []).map((account) => ({ value: account.id, label: account.name })),
  ], [overview, t])
  const modelOptions = useMemo(() => [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    ...models.map((entry) => ({ value: entry.id, label: entry.id })),
  ], [models, t])

  function resetFilters(): void {
    setStatus('')
    setAccountId('')
    setModel('')
    setFrom('')
    setTo('')
    setPage(1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.ai_gateway.logs')}
          </h2>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_gateway.logs_scope_note')}
          </p>
        </div>
        <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={loading} onClick={() => setReload((value) => value + 1)}>
          {uiT('common.refresh')}
        </Button>
      </div>

      {error ? <AiError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}

      <AiPanel title={t('cloudflare.ai_gateway.filters')} bodyClassName="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('cloudflare.ai_gateway.filter_account')} className="w-44">
            <SelectMenu
              label={t('cloudflare.ai_gateway.filter_account')}
              value={accountId}
              options={accountOptions}
              onChange={(value) => { setAccountId(value); setPage(1) }}
            />
          </Field>
          <Field label={t('cloudflare.ai_gateway.filter_model')} className="w-44">
            <SelectMenu
              label={t('cloudflare.ai_gateway.filter_model')}
              value={model}
              options={modelOptions}
              onChange={(value) => { setModel(value); setPage(1) }}
            />
          </Field>
          <Field label={t('cloudflare.ai_gateway.filter_status')} className="w-40">
            <SelectMenu
              label={t('cloudflare.ai_gateway.filter_status')}
              value={status}
              options={statusOptions}
              onChange={(value) => { setStatus(value as StatusFilter); setPage(1) }}
            />
          </Field>
          <Field label={t('cloudflare.ai_gateway.filter_from')} className="w-40">
            <DatePicker label={t('cloudflare.ai_gateway.filter_from')} value={from} onChange={(value) => { setFrom(value); setPage(1) }} />
          </Field>
          <Field label={t('cloudflare.ai_gateway.filter_to')} className="w-40">
            <DatePicker label={t('cloudflare.ai_gateway.filter_to')} value={to} onChange={(value) => { setTo(value); setPage(1) }} />
          </Field>
          <Button size="sm" variant="secondary" onClick={resetFilters}>
            {t('cloudflare.ai_gateway.filters_reset')}
          </Button>
        </div>
      </AiPanel>

      <AiPanel title={t('cloudflare.ai_gateway.logs')} bodyClassName="p-0">
        {loading && logs.length === 0 ? <LoadingBlock /> : logs.length === 0 ? (
          <AiEmpty>{t('cloudflare.ai_gateway.empty_logs')}</AiEmpty>
        ) : (
          <TableScroll label={t('cloudflare.ai_gateway.logs')}>
            <Table>
              <THead><Tr>
                <Th>{t('cloudflare.ai_gateway.checked_at')}</Th>
                <Th>{t('cloudflare.ai_gateway.account')}</Th>
                <Th>{t('cloudflare.ai_gateway.model')}</Th>
                <Th>{t('cloudflare.ai_gateway.status')}</Th>
                <Th>{t('cloudflare.ai_gateway.http_status')}</Th>
                <Th>{t('cloudflare.ai_gateway.tokens')}</Th>
                <Th>{t('cloudflare.ai_gateway.neurons')}</Th>
                <Th>{t('cloudflare.ai_gateway.duration')}</Th>
                <Th>{t('cloudflare.ai_gateway.key')}</Th>
              </Tr></THead>
              <TBody>
                {logs.map((log) => (
                  <Tr key={log.id}>
                    <Td className="whitespace-nowrap">{when(log.createdAt)}</Td>
                    <Td className="truncate">
                      {overview?.accounts.find((account) => account.id === log.accountId)?.name ?? (log.accountId || '—')}
                    </Td>
                    <Td className="truncate font-mono text-[length:var(--text-11-5)]">{log.model}</Td>
                    <Td><Badge tone={statusTone(log.status)}>{STATUS_LABEL[log.status] ? t(STATUS_LABEL[log.status]) : log.status}</Badge></Td>
                    <Td><Badge tone={httpTone(log.httpStatus)}>{log.httpStatus}</Badge></Td>
                    <Td className="tabular-nums">{formatNumber(log.promptTokens)}/{formatNumber(log.completionTokens)}</Td>
                    <Td className="tabular-nums">{formatNumber(log.actualNeurons)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{formatNumber(log.durationMs)} {t('cloudflare.ai_gateway.ms')}</Td>
                    <Td className="truncate">{log.keyName}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] p-2">
          <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
            {t('cloudflare.ai_gateway.log_total', { count: formatNumber(total) })}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              {t('cloudflare.ai_gateway.prev')}
            </Button>
            <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">{page} / {pages}</span>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
              {t('cloudflare.ai_gateway.next')}
            </Button>
          </div>
        </div>
      </AiPanel>
    </div>
  )
}
