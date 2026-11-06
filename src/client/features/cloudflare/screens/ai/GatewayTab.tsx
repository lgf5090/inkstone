/**
 * The gateway tab is an operator view, not a chat surface: it shows the local quota gate, the
 * weighted scheduler order, issued keys, request evidence and the two OpenAI entry points. Reads are
 * live; the only writes are key issuance/revocation and an explicit reconciliation run.
 */
import { useEffect, useMemo, useState } from 'react'
import { Activity, KeyRound, Plus, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { LoadingBlock } from '../../../../components/feedback'
import { Field, Input, Checkbox } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { CopyButton } from '../../../../components/copy-button'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import {
  aiGatewayApi,
  type GatewayKeyView,
  type GatewayLogView,
  type GatewayOverview,
  type GatewayReconcileView,
} from '../../api/ai-gateway'
import { useCfT } from '../../i18n'
import { AiEmpty, AiError, AiPanel } from './AiPanel'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'

type StatusFilter = '' | 'success' | 'error' | 'quota' | 'upstream' | 'auth'
type FormatFilter = '' | 'chat' | 'responses' | 'embedding' | 'image'

function when(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function number(value: number): string {
  return value.toLocaleString()
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'active' || status === 'success') return 'success'
  if (status === 'cooling' || status === 'quota') return 'warning'
  if (status === 'auth_error' || status === 'exhausted_today' || status === 'error') return 'danger'
  return 'neutral'
}

function accountName(id: string, overview: GatewayOverview | null): string {
  if (!id) return '—'
  return overview?.accounts.find((account) => account.id === id)?.name ?? id
}

export function GatewayTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [overview, setOverview] = useState<GatewayOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [keyLimit, setKeyLimit] = useState('0')
  const [keyModels, setKeyModels] = useState<string[]>([])
  const [createdKey, setCreatedKey] = useState<{ token: string; record: GatewayKeyView } | null>(null)

  const [logs, setLogs] = useState<GatewayLogView[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [logPage, setLogPage] = useState(1)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('')
  const [keyFilter, setKeyFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [logReload, setLogReload] = useState(0)

  const [history, setHistory] = useState<GatewayReconcileView[]>([])
  const [access, setAccess] = useState<Awaited<ReturnType<typeof aiGatewayApi.access>> | null>(null)

  const logPages = Math.max(1, Math.ceil(logTotal / 20))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayApi.overview()
      .then((body) => { if (!cancelled) { setOverview(body); setError(null) } })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    let cancelled = false
    setLogLoading(true)
    aiGatewayApi.logs({
      page: logPage,
      pageSize: 20,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(formatFilter ? { format: formatFilter } : {}),
      ...(keyFilter ? { keyId: keyFilter } : {}),
      ...(accountFilter ? { accountId: accountFilter } : {}),
    })
      .then((body) => { if (!cancelled) { setLogs(body.items); setLogTotal(body.total); setLogError(null) } })
      .catch((reason: unknown) => { if (!cancelled) setLogError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLogLoading(false) })
    return () => { cancelled = true }
  }, [logPage, statusFilter, formatFilter, keyFilter, accountFilter, logReload])

  useEffect(() => {
    let cancelled = false
    aiGatewayApi.reconcileHistory({ page: 1, pageSize: 10 })
      .then((body) => { if (!cancelled) setHistory(body.items) })
      .catch(() => { if (!cancelled) setHistory([]) })
    aiGatewayApi.access()
      .then((body) => { if (!cancelled) setAccess(body) })
      .catch(() => { if (!cancelled) setAccess(null) })
    return () => { cancelled = true }
  }, [reload])

  const keyOptions = useMemo(() => [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    ...(overview?.keys ?? []).map((key) => ({ value: key.id, label: `${key.name} (${key.prefix}…)` })),
  ], [overview, t])
  const accountOptions = useMemo(() => [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    ...(overview?.accounts ?? []).map((account) => ({ value: account.id, label: account.name })),
  ], [overview, t])
  const statusOptions = [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    { value: 'success', label: 'success' },
    { value: 'error', label: 'error' },
    { value: 'quota', label: 'quota' },
    { value: 'upstream', label: 'upstream' },
    { value: 'auth', label: 'auth' },
  ]
  const formatOptions = [
    { value: '', label: t('cloudflare.ai_gateway.all') },
    { value: 'chat', label: t('cloudflare.ai_gateway.format_chat') },
    { value: 'embedding', label: t('cloudflare.ai_gateway.format_embedding') },
    { value: 'image', label: t('cloudflare.ai_gateway.format_image') },
    { value: 'responses', label: t('cloudflare.ai_gateway.format_responses') },
  ]
  const modelOptions = [
    { value: 'qwen3', label: 'qwen3' },
    { value: 'glm-4.7-flash', label: 'glm-4.7-flash' },
    { value: 'llama-3.1-8b', label: 'llama-3.1-8b' },
    { value: 'llama-3.3-70b', label: 'llama-3.3-70b' },
    { value: 'bge-small', label: 'bge-small' },
    { value: 'bge-base', label: 'bge-base' },
    { value: 'bge-large', label: 'bge-large' },
    { value: 'bge-m3', label: 'bge-m3' },
    { value: 'flux', label: 'flux' },
    { value: 'sd15-img2img', label: 'sd15-img2img' },
  ]

  async function createKey(): Promise<void> {
    setBusy(true)
    try {
      const created = await aiGatewayApi.createKey({
        name: keyName.trim(),
        ...(keyModels.length > 0 ? { allowedModels: keyModels } : {}),
        dailyRequestLimit: Number(keyLimit) || 0,
      })
      setCreatedKey({ token: created.token, record: created.key })
      setKeyOpen(false)
      setKeyName('')
      setKeyLimit('0')
      setKeyModels([])
      setReload((value) => value + 1)
      toast({ title: t('cloudflare.ai_gateway.key_created'), tone: 'success' })
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function revokeKey(key: GatewayKeyView): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.ai_gateway.revoke'),
      description: `${key.name} (${key.prefix}…)`,
      confirmLabel: t('cloudflare.ai_gateway.revoke'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await aiGatewayApi.revokeKey(key.id)
      toast({ title: t('cloudflare.ai_gateway.revoke'), tone: 'success' })
      setReload((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function reconcile(): Promise<void> {
    setBusy(true)
    try {
      await aiGatewayApi.reconcile()
      toast({ title: t('cloudflare.ai_gateway.reconcile'), tone: 'success' })
      setReload((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const curlBase = access?.baseUrl ?? '/api/gateway/v1'
  const curlChat = `curl ${curlBase}/chat/completions \\\n  -H "Authorization: Bearer gw_your_key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"qwen3","messages":[{"role":"user","content":"hello"}]}'`
  const curlResponses = `curl ${curlBase}/responses \\\n  -H "Authorization: Bearer gw_your_key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"qwen3","input":"hello","max_output_tokens":256}'`

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.ai_tabs.gateway')}
          </h2>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_gateway.limit_hint', {
              limit: number(overview?.limit ?? 9_500),
              hard: number(overview?.hardLimit ?? 10_000),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={loading} onClick={() => setReload((value) => value + 1)}>
            {uiT('common.refresh')}
          </Button>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => { void reconcile() }}>
            {t('cloudflare.ai_gateway.reconcile')}
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setKeyOpen(true)}>
            {t('cloudflare.ai_gateway.create_key')}
          </Button>
        </div>
      </div>

      {error ? <AiError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
      {loading && !overview ? <LoadingBlock /> : null}

      {overview ? (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { key: 'accounts', label: t('cloudflare.ai_gateway.accounts'), value: number(overview.accounts.length), icon: ShieldCheck },
              { key: 'used', label: t('cloudflare.ai_gateway.used'), value: number(overview.totals.used), icon: Zap },
              { key: 'remaining', label: t('cloudflare.ai_gateway.remaining'), value: number(overview.totals.remaining), icon: Activity },
              { key: 'keys', label: t('cloudflare.ai_gateway.active_keys'), value: number(overview.keys.length), icon: KeyRound },
            ].map((kpi) => {
              const Icon = kpi.icon
              return (
                <div key={kpi.key} className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{kpi.label}</span>
                    <span className="text-[length:var(--text-20)] leading-none font-semibold tabular-nums text-[var(--text-primary)]">{kpi.value}</span>
                  </div>
                  <Icon size={22} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                </div>
              )
            })}
          </div>

          <AiPanel title={t('cloudflare.ai_gateway.accounts')} bodyClassName="p-0">
            {overview.accounts.length === 0 ? <AiEmpty>{t('cloudflare.ai_gateway.empty_accounts')}</AiEmpty> : (
              <TableScroll label={t('cloudflare.ai_gateway.accounts')}>
                <Table>
                  <THead><Tr>
                    <Th>{t('cloudflare.ai_gateway.account')}</Th>
                    <Th>{t('cloudflare.ai_gateway.status')}</Th>
                    <Th>{t('cloudflare.ai_gateway.used')}</Th>
                    <Th>{t('cloudflare.ai_gateway.remaining')}</Th>
                    <Th>{t('cloudflare.ai_gateway.requests')}</Th>
                    <Th>{t('cloudflare.ai_gateway.schedule_score')}</Th>
                  </Tr></THead>
                  <TBody>
                    {overview.accounts.map((account) => (
                      <Tr key={account.id}>
                        <Td className="truncate">{account.name}</Td>
                        <Td>
                          <Badge tone={statusTone(account.status)}>
                            {t(`cloudflare.ai_gateway.status_${account.status}` as 'cloudflare.ai_gateway.status_active')}
                          </Badge>
                          {account.errorCode ? <span className="ml-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{account.errorCode}</span> : null}
                        </Td>
                        <Td className="tabular-nums">{number(account.usedNeurons)}</Td>
                        <Td className="tabular-nums">{number(account.remainingNeurons)}</Td>
                        <Td className="tabular-nums">{number(account.requests)}</Td>
                        <Td className="tabular-nums">{account.scheduleScore.toFixed(0)}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </AiPanel>

          <AiPanel title={t('cloudflare.ai_gateway.active_keys')} bodyClassName="p-0">
            {overview.keys.length === 0 ? <AiEmpty>{t('cloudflare.ai_gateway.empty_keys')}</AiEmpty> : (
              <TableScroll label={t('cloudflare.ai_gateway.active_keys')}>
                <Table>
                  <THead><Tr>
                    <Th>{t('cloudflare.ai_gateway.key_name')}</Th>
                    <Th>{t('cloudflare.ai_gateway.key_prefix')}</Th>
                    <Th>{t('cloudflare.ai_gateway.allowed_models')}</Th>
                    <Th>{t('cloudflare.ai_gateway.daily_limit')}</Th>
                    <Th>{t('cloudflare.ai_gateway.today_requests')}</Th>
                    <Th>{t('cloudflare.ai_gateway.today_neurons')}</Th>
                    <Th>{uiT('common.more_actions')}</Th>
                  </Tr></THead>
                  <TBody>
                    {overview.keys.map((key) => (
                      <Tr key={key.id}>
                        <Td className="truncate">{key.name}</Td>
                        <Td className="font-mono text-[length:var(--text-11-5)]">{key.prefix}…</Td>
                        <Td className="text-[length:var(--text-11-5)]">{key.allowedModels.join(', ') || t('cloudflare.ai_gateway.models_all')}</Td>
                        <Td className="tabular-nums">{key.dailyRequestLimit || '∞'}</Td>
                        <Td className="tabular-nums">{number(key.todayRequests)}</Td>
                        <Td className="tabular-nums">{number(key.todayNeurons)}</Td>
                        <Td>
                          <IconButton label={t('cloudflare.ai_gateway.revoke')} size="xs" disabled={busy} onClick={() => { void revokeKey(key) }}>
                            <KeyRound size={13} />
                          </IconButton>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </AiPanel>

          <AiPanel title={t('cloudflare.ai_gateway.logs')} bodyClassName="p-0">
            <div className="flex flex-wrap items-end gap-2 border-b border-[var(--border-subtle)] p-3">
              <div className="w-36"><SelectMenu label={t('cloudflare.ai_gateway.filter_status')} value={statusFilter} options={statusOptions} onChange={(value) => setStatusFilter(value as StatusFilter)} /></div>
              <div className="w-36"><SelectMenu label={t('cloudflare.ai_gateway.filter_format')} value={formatFilter} options={formatOptions} onChange={(value) => setFormatFilter(value as FormatFilter)} /></div>
              <div className="w-44"><SelectMenu label={t('cloudflare.ai_gateway.filter_key')} value={keyFilter} options={keyOptions} onChange={setKeyFilter} /></div>
              <div className="w-44"><SelectMenu label={t('cloudflare.ai_gateway.filter_account')} value={accountFilter} options={accountOptions} onChange={setAccountFilter} /></div>
            </div>
            {logError ? <AiError message={logError} onRetry={() => setLogReload((value) => value + 1)} /> : null}
            {logLoading ? <LoadingBlock /> : logs.length === 0 ? <AiEmpty>{t('cloudflare.ai_gateway.empty_logs')}</AiEmpty> : (
              <TableScroll label={t('cloudflare.ai_gateway.logs')}>
                <Table>
                  <THead><Tr>
                    <Th>{t('cloudflare.ai_gateway.checked_at')}</Th>
                    <Th>{t('cloudflare.ai_gateway.key')}</Th>
                    <Th>{t('cloudflare.ai_gateway.account')}</Th>
                    <Th>{t('cloudflare.ai_gateway.format')}</Th>
                    <Th>{t('cloudflare.ai_gateway.model')}</Th>
                    <Th>{t('cloudflare.ai_gateway.status')}</Th>
                    <Th>{t('cloudflare.ai_gateway.tokens')}</Th>
                    <Th>{t('cloudflare.ai_gateway.neurons')}</Th>
                    <Th>{t('cloudflare.ai_gateway.duration')}</Th>
                  </Tr></THead>
                  <TBody>
                    {logs.map((log) => (
                      <Tr key={log.id}>
                        <Td className="whitespace-nowrap">{when(log.createdAt)}</Td>
                        <Td className="truncate">{log.keyName}</Td>
                        <Td className="truncate">{accountName(log.accountId, overview)}</Td>
                        <Td>{log.format}{log.stream ? ' · SSE' : ''}</Td>
                        <Td className="truncate font-mono text-[length:var(--text-11-5)]">{log.model}</Td>
                        <Td><Badge tone={statusTone(log.status)}>{log.status}</Badge></Td>
                        <Td className="tabular-nums">{number(log.promptTokens)}/{number(log.completionTokens)}</Td>
                        <Td className="tabular-nums">{number(log.actualNeurons)}</Td>
                        <Td className="tabular-nums">{number(log.durationMs)} {t('cloudflare.ai_gateway.ms')}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
            <div className="flex items-center justify-end gap-2 p-2">
              <Button size="sm" variant="secondary" disabled={logPage <= 1} onClick={() => setLogPage((value) => Math.max(1, value - 1))}>
                {t('cloudflare.ai_gateway.prev')}
              </Button>
              <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">{logPage} / {logPages}</span>
              <Button size="sm" variant="secondary" disabled={logPage >= logPages} onClick={() => setLogPage((value) => value + 1)}>
                {t('cloudflare.ai_gateway.next')}
              </Button>
            </div>
          </AiPanel>

          <AiPanel title={t('cloudflare.ai_gateway.reconcile_history')} bodyClassName="p-0">
            {history.length === 0 ? <AiEmpty>{t('cloudflare.ai_gateway.empty_reconcile')}</AiEmpty> : (
              <TableScroll label={t('cloudflare.ai_gateway.reconcile_history')}>
                <Table>
                  <THead><Tr>
                    <Th>{t('cloudflare.ai_gateway.account')}</Th>
                    <Th>{t('cloudflare.ai_gateway.checked_at')}</Th>
                    <Th>{t('cloudflare.ai_gateway.authoritative')}</Th>
                    <Th>{t('cloudflare.ai_gateway.local')}</Th>
                    <Th>{t('cloudflare.ai_gateway.delta')}</Th>
                    <Th>{t('cloudflare.ai_gateway.outcome')}</Th>
                  </Tr></THead>
                  <TBody>
                    {history.map((row) => (
                      <Tr key={row.id}>
                        <Td>{row.accountId}</Td>
                        <Td className="whitespace-nowrap">{when(row.checkedAt)}</Td>
                        <Td className="tabular-nums">{number(row.authoritative)}</Td>
                        <Td className="tabular-nums">{number(row.localEffective)}</Td>
                        <Td className="tabular-nums">{number(row.delta)}</Td>
                        <Td><Badge tone={row.outcome === 'over' ? 'danger' : row.outcome === 'error' ? 'warning' : 'neutral'}>{row.outcome}</Badge></Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
          </AiPanel>

          <AiPanel title={t('cloudflare.ai_gateway.access')}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('cloudflare.ai_gateway.access_base')}</span>
                <code className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 font-mono text-[length:var(--text-11-5)]">{curlBase}</code>
                <CopyButton text={curlBase} label={uiT('common.copy')} />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.ai_gateway.access_curl_chat')}</span>
                  <CopyButton text={curlChat} label={uiT('common.copy')} />
                </div>
                <pre className="overflow-x-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] whitespace-pre-wrap break-all">{curlChat}</pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.ai_gateway.access_curl_responses')}</span>
                  <CopyButton text={curlResponses} label={uiT('common.copy')} />
                </div>
                <pre className="overflow-x-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] whitespace-pre-wrap break-all">{curlResponses}</pre>
              </div>
            </div>
          </AiPanel>
        </>
      ) : null}

      <Modal open={keyOpen} onClose={() => setKeyOpen(false)} title={t('cloudflare.ai_gateway.create_key')} width={560}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setKeyOpen(false)}>{uiT('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!keyName.trim()} onClick={() => { void createKey() }}>
              {t('cloudflare.ai_gateway.create_key')}
            </Button>
          </>
        )}>
        <div className="space-y-3">
          <Field label={t('cloudflare.ai_gateway.key_name')}>
            <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} />
          </Field>
          <div>
            <p className="mb-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('cloudflare.ai_gateway.allowed_models')}</p>
            <div className="flex flex-wrap gap-3">
              {modelOptions.map((model) => (
                <Checkbox
                  key={model.value}
                  checked={keyModels.includes(model.value)}
                  label={model.label}
                  onChange={(next) => setKeyModels((current) => next ? [...current, model.value] : current.filter((value) => value !== model.value))}
                />
              ))}
            </div>
          </div>
          <Field label={t('cloudflare.ai_gateway.daily_limit')}>
            <Input type="number" min={0} value={keyLimit} onChange={(event) => setKeyLimit(event.target.value)} />
          </Field>
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('cloudflare.ai_gateway.no_limit')}</p>
        </div>
      </Modal>

      <Modal open={createdKey !== null} onClose={() => setCreatedKey(null)} title={t('cloudflare.ai_gateway.key_created')} width={620}
        footer={<Button variant="primary" onClick={() => setCreatedKey(null)}>{uiT('common.close')}</Button>}>
        {createdKey ? (
          <div className="space-y-3">
            <p className="text-[length:var(--text-12)] text-[var(--status-warning)]">{t('cloudflare.ai_gateway.key_once')}</p>
            <div className="flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-[length:var(--text-12)]">{createdKey.token}</code>
              <CopyButton text={createdKey.token} label={uiT('common.copy')} />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
