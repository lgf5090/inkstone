/**
 * The gateway tab is an operator view, not a chat surface: it shows the local quota gate, the
 * weighted scheduler order, issued keys, the per-account routing switches and the two OpenAI entry
 * points. Request evidence moved to the request-log tab, which is the workspace's landing view.
 */
import { useEffect, useState } from 'react'
import { Activity, KeyRound, Plus, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { LoadingBlock } from '../../../../components/feedback'
import { Field, Input, Checkbox, Switch } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { CopyButton } from '../../../../components/copy-button'
import { cn } from '../../../../lib/cn'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import {
  aiGatewayApi,
  type GatewayKeyView,
  type GatewayOverview,
  type GatewayReconcileView,
  type GatewayRoutingView,
} from '../../api/ai-gateway'
import { useCfT } from '../../i18n'
import { AiEmpty, AiError, AiPanel } from './AiPanel'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'

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

  const [history, setHistory] = useState<GatewayReconcileView[]>([])
  const [access, setAccess] = useState<Awaited<ReturnType<typeof aiGatewayApi.access>> | null>(null)
  const [routing, setRouting] = useState<GatewayRoutingView[]>([])
  const [routingDrafts, setRoutingDrafts] = useState<Record<string, { enabled: boolean; gatewayId: string; collectLogPayload: boolean }>>({})
  const [routingBusy, setRoutingBusy] = useState<string | null>(null)
  const [routingError, setRoutingError] = useState<string | null>(null)

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
    aiGatewayApi.reconcileHistory({ page: 1, pageSize: 10 })
      .then((body) => { if (!cancelled) setHistory(body.items) })
      .catch(() => { if (!cancelled) setHistory([]) })
    aiGatewayApi.access()
      .then((body) => { if (!cancelled) setAccess(body) })
      .catch(() => { if (!cancelled) setAccess(null) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    let cancelled = false
    aiGatewayApi.routing()
      .then((body) => {
        if (cancelled) return
        setRouting(body.items)
        setRoutingDrafts(Object.fromEntries(body.items.map((item) => [item.accountId, {
          enabled: item.enabled,
          gatewayId: item.gatewayId,
          collectLogPayload: item.collectLogPayload,
        }])))
        setRoutingError(null)
      })
      .catch((reason: unknown) => { if (!cancelled) setRoutingError(cfErrorText(reason)) })
    return () => { cancelled = true }
  }, [reload])

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
    { value: 'whisper', label: 'whisper' },
    { value: 'aura-1', label: 'aura-1' },
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

  function setRoutingDraft(accountId: string, next: Partial<{ enabled: boolean; gatewayId: string; collectLogPayload: boolean }>): void {
    setRoutingDrafts((current) => ({
      ...current,
      [accountId]: { ...(current[accountId] ?? { enabled: false, gatewayId: '', collectLogPayload: false }), ...next },
    }))
  }

  async function saveRouting(accountId: string): Promise<void> {
    const draft = routingDrafts[accountId]
    if (!draft) return
    setRoutingBusy(accountId)
    try {
      const saved = await aiGatewayApi.saveRouting(accountId, draft)
      setRouting((current) => current.map((item) => (item.accountId === accountId ? saved : item)))
      setRoutingDraft(accountId, {
        enabled: saved.enabled,
        gatewayId: saved.gatewayId,
        collectLogPayload: saved.collectLogPayload,
      })
      toast({ title: t('cloudflare.ai_gateway.routing_saved'), tone: 'success' })
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setRoutingBusy(null)
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

          <AiPanel title={t('cloudflare.ai_gateway.routing_title')} bodyClassName="p-0">
            <p className="border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('cloudflare.ai_gateway.routing_hint')}
            </p>
            {routingError ? <AiError message={routingError} onRetry={() => setReload((value) => value + 1)} /> : null}
            {routing.length === 0 ? <AiEmpty>{t('cloudflare.ai_gateway.empty_accounts')}</AiEmpty> : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {routing.map((item) => {
                  const draft = routingDrafts[item.accountId] ?? {
                    enabled: item.enabled,
                    gatewayId: item.gatewayId,
                    collectLogPayload: item.collectLogPayload,
                  }
                  const payloadOn = draft.enabled && draft.collectLogPayload
                  return (
                    <li key={item.accountId} className="flex flex-col gap-3 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                          {item.accountName}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                            {t('cloudflare.ai_gateway.routing_switch')}
                          </span>
                          <Switch
                            checked={draft.enabled}
                            label={t('cloudflare.ai_gateway.routing_switch')}
                            onChange={(next) => setRoutingDraft(item.accountId, {
                              enabled: next,
                              collectLogPayload: next ? draft.collectLogPayload : false,
                            })}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Field label={t('cloudflare.ai_gateway.routing_gateway_id')}>
                          <Input
                            value={draft.gatewayId}
                            disabled={!draft.enabled}
                            placeholder={t('cloudflare.ai_gateway.routing_gateway_id_placeholder')}
                            onChange={(event) => setRoutingDraft(item.accountId, { gatewayId: event.target.value })}
                          />
                        </Field>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={draft.collectLogPayload}
                              disabled={!draft.enabled}
                              label={t('cloudflare.ai_gateway.routing_payload')}
                              onChange={(next) => setRoutingDraft(item.accountId, { collectLogPayload: next })}
                            />
                            <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                              {t('cloudflare.ai_gateway.routing_payload')}
                            </span>
                          </div>
                          <p className={cn(
                            'text-[length:var(--text-11)]',
                            payloadOn ? 'text-[var(--status-warning)]' : 'text-[var(--text-tertiary)]',
                          )}>
                            {payloadOn
                              ? t('cloudflare.ai_gateway.routing_payload_warning')
                              : t('cloudflare.ai_gateway.routing_payload_hint')}
                          </p>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="primary"
                          loading={routingBusy === item.accountId}
                          disabled={routingBusy === item.accountId || (draft.enabled && !draft.gatewayId.trim())}
                          onClick={() => { void saveRouting(item.accountId) }}
                        >
                          {uiT('common.save')}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
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
