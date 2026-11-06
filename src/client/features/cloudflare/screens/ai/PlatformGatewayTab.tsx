/**
 * The Cloudflare-hosted AI Gateway tab: gateways, logs, routing, BYOK, spending limit, analytics and
 * logpush, all read-only. The account is the one the Cloudflare app already stores; this screen never
 * handles a token.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { LoadingBlock } from '../../../../components/feedback'
import { Checkbox, Field, Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { Badge, Button } from '../../../../components/primitives'
import { DatePicker } from '../../../../components/date-picker'
import { SelectMenu } from '../../../../components/select-menu'
import { CopyButton } from '../../../../components/copy-button'
import { cfErrorText } from '../../api/client'
import { accountsApi } from '../../api/accounts'
import {
  aiGatewayPlatformApi,
  type PlatformAnalytics,
  type PlatformGateway,
  type PlatformLog,
  type PlatformLogDetail,
  type PlatformPage,
  type PlatformProviderConfig,
  type PlatformRoute,
  type PlatformRouteDeployment,
  type PlatformRouteVersion,
  type PlatformSpendingLimit,
} from '../../api/ai-gateway-platform'
import { useCfT } from '../../i18n'
import { useUi } from '../../../../store/ui'
import { AiEmpty, AiError, AiPanel } from './AiPanel'
import { Table, TableScroll, TBody, Td, Th, THead, Tr } from '../../components/Table'

type Section = 'overview' | 'logs' | 'routing' | 'providers' | 'billing' | 'analytics' | 'logpush'

const SECTIONS: Section[] = ['overview', 'logs', 'routing', 'providers', 'billing', 'analytics', 'logpush']

const SECTION_LABELS = {
  overview: 'cloudflare.ai_platform.section_overview',
  logs: 'cloudflare.ai_platform.section_logs',
  routing: 'cloudflare.ai_platform.section_routing',
  providers: 'cloudflare.ai_platform.section_providers',
  billing: 'cloudflare.ai_platform.section_billing',
  analytics: 'cloudflare.ai_platform.section_analytics',
  logpush: 'cloudflare.ai_platform.section_logpush',
} as const

function isoDay(value: string, endOfDay = false): string {
  if (!value) return ''
  return `${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`
}

function when(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function number(value: number): string {
  return value.toLocaleString()
}

function permissionText(error: unknown, fallback: string): string {
  const details = (error as { details?: { upstream_status?: number } } | null)?.details
  if (details?.upstream_status === 403) return fallback
  return cfErrorText(error)
}

function GatewayField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[length:var(--text-11)] tracking-wide text-[var(--text-quaternary)] uppercase">{label}</dt>
      <dd className="mt-0.5 text-[length:var(--text-12-5)] break-words text-[var(--text-primary)]">{children}</dd>
    </div>
  )
}

function Pager({
  page,
  onPage,
  label,
}: {
  page: PlatformPage<unknown>
  onPage: (page: number) => void
  label: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
          ‹
        </Button>
        <span>
          {page.page} / {page.totalPages}
        </span>
        <Button size="sm" variant="secondary" disabled={page.page >= page.totalPages} onClick={() => onPage(page.page + 1)}>
          ›
        </Button>
      </div>
    </div>
  )
}

export function PlatformGatewayTab() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [search, setSearch] = useState('')
  const [reload, setReload] = useState(0)
  const [gateways, setGateways] = useState<PlatformPage<PlatformGateway> | null>(null)
  const [gatewayPage, setGatewayPage] = useState(1)
  const [gatewaysError, setGatewaysError] = useState<string | null>(null)
  const [gatewaysLoading, setGatewaysLoading] = useState(false)
  const [gatewayId, setGatewayId] = useState('')
  const [gateway, setGateway] = useState<PlatformGateway | null>(null)
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const [gatewayLoading, setGatewayLoading] = useState(false)
  const [section, setSection] = useState<Section>('overview')
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [draftId, setDraftId] = useState('')
  const [draftCache, setDraftCache] = useState('60')
  const [draftInterval, setDraftInterval] = useState('0')
  const [draftLimit, setDraftLimit] = useState('0')
  const [draftLogs, setDraftLogs] = useState(true)

  useEffect(() => {
    let cancelled = false
    accountsApi.list({ pageSize: 100, filter: 'active' })
      .then((body) => {
        if (cancelled) return
        const usable = body.accounts.filter((account) => account.cf_account_id && !account.is_demo)
        setAccounts(usable)
        setAccountId((current) => current || usable[0]?.id || '')
      })
      .catch(() => { if (!cancelled) setAccounts([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setGatewaysLoading(true)
    aiGatewayPlatformApi.gateways(accountId, { search, page: gatewayPage, perPage: 20 })
      .then((body) => {
        if (cancelled) return
        setGateways(body)
        setGatewaysError(null)
        setGatewayId((current) => (body.items.some((item) => item.id === current) ? current : (body.items[0]?.id ?? '')))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setGateways(null)
        setGatewayId('')
        setGatewaysError(permissionText(error, t('cloudflare.ai_platform.permission_denied')))
      })
      .finally(() => { if (!cancelled) setGatewaysLoading(false) })
    return () => { cancelled = true }
  }, [accountId, search, gatewayPage, reload, t])

  useEffect(() => {
    if (!accountId || !gatewayId) {
      setGateway(null)
      return
    }
    let cancelled = false
    setGatewayLoading(true)
    aiGatewayPlatformApi.gateway(accountId, gatewayId)
      .then((body) => { if (!cancelled) { setGateway(body); setGatewayError(null) } })
      .catch((error: unknown) => {
        if (cancelled) return
        setGateway(null)
        setGatewayError(permissionText(error, t('cloudflare.ai_platform.permission_denied')))
      })
      .finally(() => { if (!cancelled) setGatewayLoading(false) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, reload, t])

  const accountOptions = useMemo(() => accounts.map((account) => ({
    value: account.id,
    label: `${account.name}${account.cf_account_id ? '' : ` (${t('cloudflare.ai_platform.no_cf_account_id')})`}`,
  })), [accounts, t])

  const selectedAccount = accounts.find((account) => account.id === accountId) ?? null
  const cfAccountId = selectedAccount?.cf_account_id ?? ''

  async function submitCreate(): Promise<void> {
    if (!accountId || createBusy) return
    setCreateBusy(true)
    try {
      const created = await aiGatewayPlatformApi.createGateway(accountId, {
        id: draftId.trim(),
        cache_ttl: Number(draftCache) || 0,
        collect_logs: draftLogs,
        rate_limiting_interval: Number(draftInterval) || 0,
        rate_limiting_limit: Number(draftLimit) || 0,
      })
      toast({ title: t('cloudflare.ai_platform.created_toast', { id: created.gateway.id }), tone: 'success' })
      setCreateOpen(false)
      setDraftId('')
      setGatewayId(created.gateway.id)
      setReload((value) => value + 1)
    } catch (error) {
      toast({ title: permissionText(error, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.ai_platform.title')}
          </h2>
          <p className="mt-0.5 max-w-[70ch] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_platform.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.account')}</span>
          <SelectMenu
            label={t('cloudflare.ai_platform.account')}
            value={accountId}
            options={accountOptions}
            onChange={(value) => { setAccountId(value); setGatewayPage(1); setGatewayId('') }}
            width={220}
            disabled={accountOptions.length === 0}
          />
          <Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw aria-hidden="true" className="mr-1 size-3.5" />
            {t('cloudflare.ai_platform.refresh')}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!accountId}>
            <Plus aria-hidden="true" className="mr-1 size-3.5" />
            {t('cloudflare.ai_platform.create_gateway')}
          </Button>
        </div>
      </header>

      {accountOptions.length === 0 ? (
        <AiPanel title={t('cloudflare.ai_platform.gateways')}>
          <AiEmpty>
            {t('cloudflare.ai_platform.no_account')} {t('cloudflare.ai_platform.no_account_hint')}
          </AiEmpty>
        </AiPanel>
      ) : (
        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(260px,340px)_1fr]">
          <AiPanel title={t('cloudflare.ai_platform.gateways')} className="min-w-0" bodyClassName="space-y-2">
            <Input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setGatewayPage(1) }}
              placeholder={t('cloudflare.ai_platform.search')}
              aria-label={t('cloudflare.ai_platform.search')}
            />
            {gatewaysLoading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
            {gatewaysError ? <AiError message={gatewaysError} onRetry={() => setReload((value) => value + 1)} /> : null}
            {!gatewaysLoading && !gatewaysError && gateways && gateways.items.length === 0 ? (
              <AiEmpty>
                {t('cloudflare.ai_platform.empty_gateways')} {t('cloudflare.ai_platform.empty_gateways_hint')}
              </AiEmpty>
            ) : null}
            <div role="list" className="flex flex-col gap-1">
              {(gateways?.items ?? []).map((item) => {
                const active = item.id === gatewayId
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setGatewayId(item.id)}
                    className={`min-h-10 rounded-[var(--r-sm)] border px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{item.id}</span>
                      {item.collect_logs ? <Badge tone="accent">{t('cloudflare.ai_platform.section_logs')}</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {t('cloudflare.ai_platform.created')}: {when(item.created_at)}
                    </span>
                  </button>
                )
              })}
            </div>
            {gateways ? (
              <Pager page={gateways} onPage={setGatewayPage} label={t('cloudflare.ai_platform.page', { page: gateways.page, pages: gateways.totalPages })} />
            ) : null}
          </AiPanel>

          <div className="flex min-w-0 flex-col gap-3">
            {!gatewayId ? (
              <AiPanel title={t('cloudflare.ai_platform.gateways')}>
                <AiEmpty>{t('cloudflare.ai_platform.select_gateway')}</AiEmpty>
              </AiPanel>
            ) : gatewayLoading ? (
              <AiPanel title={gatewayId}>
                <LoadingBlock label={t('cloudflare.ai_platform.loading')} />
              </AiPanel>
            ) : gatewayError ? (
              <AiPanel title={gatewayId}>
                <AiError message={gatewayError} onRetry={() => setReload((value) => value + 1)} />
              </AiPanel>
            ) : gateway ? (
              <>
                <nav aria-label={t('cloudflare.ai_platform.section_nav')} className="flex flex-wrap gap-1">
                  {SECTIONS.map((entry) => {
                    const active = entry === section
                    return (
                      <button
                        key={entry}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setSection(entry)}
                        className={`min-h-8 rounded-full border px-3 text-[length:var(--text-11-5)] ${
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                        }`}
                      >
                        {t(SECTION_LABELS[entry])}
                      </button>
                    )
                  })}
                </nav>
                {section === 'overview' ? <OverviewSection accountId={accountId} gateway={gateway} cfAccountId={cfAccountId} onChanged={() => setReload((value) => value + 1)} /> : null}
                {section === 'logs' ? <LogsSection accountId={accountId} gatewayId={gateway.id} /> : null}
                {section === 'routing' ? <RoutingSection accountId={accountId} gatewayId={gateway.id} cfAccountId={cfAccountId} /> : null}
                {section === 'providers' ? <ProvidersSection accountId={accountId} gatewayId={gateway.id} /> : null}
                {section === 'billing' ? <BillingSection accountId={accountId} /> : null}
                {section === 'analytics' ? <AnalyticsSection accountId={accountId} gatewayId={gateway.id} /> : null}
                {section === 'logpush' ? <LogpushSection gateway={gateway} /> : null}
              </>
            ) : null}
          </div>
        </div>
      )}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('cloudflare.ai_platform.create_gateway')}
        width={560}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{t('cloudflare.ai_platform.cancel')}</Button>
            <Button onClick={() => { void submitCreate() }} disabled={createBusy || !draftId.trim()}>
              {createBusy ? t('cloudflare.ai_platform.saving') : t('cloudflare.ai_platform.save')}
            </Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <Field label={t('cloudflare.ai_platform.gateway_id')}>
            <Input value={draftId} onChange={(event) => setDraftId(event.target.value)} placeholder="parity-panel-verify" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('cloudflare.ai_platform.cache_ttl')}>
              <Input type="number" min={0} value={draftCache} onChange={(event) => setDraftCache(event.target.value)} />
            </Field>
            <Field label={t('cloudflare.ai_platform.rate_interval')}>
              <Input type="number" min={0} value={draftInterval} onChange={(event) => setDraftInterval(event.target.value)} />
            </Field>
            <Field label={t('cloudflare.ai_platform.rate_limit')}>
              <Input type="number" min={0} value={draftLimit} onChange={(event) => setDraftLimit(event.target.value)} />
            </Field>
          </div>
          <Checkbox checked={draftLogs} onChange={setDraftLogs} label={t('cloudflare.ai_platform.collect_logs')} />
        </div>
      </Modal>
    </div>
  )
}

function OverviewSection({ accountId, gateway, cfAccountId, onChanged }: {
  accountId: string
  gateway: PlatformGateway
  cfAccountId: string
  onChanged: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [provider, setProvider] = useState('workers-ai')
  const [endpoint, setEndpoint] = useState('')
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cache, setCache] = useState('0')
  const [interval, setIntervalValue] = useState('0')
  const [limit, setLimit] = useState('0')
  const [attempts, setAttempts] = useState('0')
  const [delay, setDelay] = useState('0')
  const [collect, setCollect] = useState(true)

  function openEdit(): void {
    setCache(String(gateway.cache_ttl ?? 0))
    setIntervalValue(String(gateway.rate_limiting_interval ?? 0))
    setLimit(String(gateway.rate_limiting_limit ?? 0))
    setAttempts(String(gateway.retry_max_attempts ?? 0))
    setDelay(String(gateway.retry_delay ?? 0))
    setCollect(gateway.collect_logs)
    setEditOpen(true)
  }

  async function submitEdit(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await aiGatewayPlatformApi.updateGateway(accountId, gateway.id, {
        cache_ttl: Number(cache) || 0,
        rate_limiting_interval: Number(interval) || 0,
        rate_limiting_limit: Number(limit) || 0,
        retry_max_attempts: Number(attempts) || undefined,
        retry_delay: Number(delay) || undefined,
        collect_logs: collect,
      })
      toast({ title: t('cloudflare.ai_platform.updated_toast'), tone: 'success' })
      setEditOpen(false)
      onChanged()
    } catch (error) {
      toast({ title: permissionText(error, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeGateway(): Promise<void> {
    const accepted = await confirm({
      title: t('cloudflare.ai_platform.delete_gateway'),
      description: t('cloudflare.ai_platform.delete_gateway_hint', { id: gateway.id }),
      confirmLabel: t('cloudflare.ai_platform.delete'),
      tone: 'danger',
    })
    if (!accepted) return
    try {
      await aiGatewayPlatformApi.deleteGateway(accountId, gateway.id)
      toast({ title: t('cloudflare.ai_platform.deleted_toast'), tone: 'success' })
      onChanged()
    } catch (error) {
      toast({ title: permissionText(error, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    }
  }

  useEffect(() => {
    let cancelled = false
    aiGatewayPlatformApi.gatewayUrl(accountId, gateway.id, provider)
      .then((body) => { if (!cancelled) { setEndpoint(body.url); setEndpointError(null) } })
      .catch((error: unknown) => {
        if (cancelled) return
        setEndpoint('')
        setEndpointError(permissionText(error, t('cloudflare.ai_platform.plan_unsupported')))
      })
    return () => { cancelled = true }
  }, [accountId, gateway.id, provider, t])

  const providerOptions = [
    { value: 'workers-ai', label: 'Workers AI' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google-ai-studio', label: 'Google AI Studio' },
  ]

  return (
    <>
    <AiPanel
      title={t('cloudflare.ai_platform.section_overview')}
      actions={(
        <span className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={openEdit}>
            <Pencil aria-hidden="true" className="mr-1 size-3.5" />
            {t('cloudflare.ai_platform.edit')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { void removeGateway() }}>
            <Trash2 aria-hidden="true" className="mr-1 size-3.5" />
            {t('cloudflare.ai_platform.delete')}
          </Button>
        </span>
      )}
      bodyClassName="space-y-3"
    >
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <GatewayField label={t('cloudflare.ai_platform.gateway_id')}>{gateway.id}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.created')}>{when(gateway.created_at)}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.modified')}>{when(gateway.modified_at)}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.cache_ttl')}>
          {gateway.cache_ttl ? `${gateway.cache_ttl}s` : t('cloudflare.ai_platform.cache_disabled')}
          {gateway.cache_invalidate_on_update ? ` · ${t('cloudflare.ai_platform.cache_invalidate')}` : ''}
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.rate_limit')}>
          {gateway.rate_limiting_limit
            ? t('cloudflare.ai_platform.rate_limit_value', {
              limit: gateway.rate_limiting_limit,
              interval: gateway.rate_limiting_interval ?? 0,
            })
            : '—'}
          {gateway.rate_limiting_technique ? ` · ${gateway.rate_limiting_technique}` : ''}
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.retry')}>
          {gateway.retry_max_attempts
            ? t('cloudflare.ai_platform.retry_value', {
              attempts: gateway.retry_max_attempts,
              delay: gateway.retry_delay ?? 0,
              backoff: gateway.retry_backoff ?? 'constant',
            })
            : '—'}
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.workers_billing')}>{gateway.workers_ai_billing_mode ?? 'postpaid'}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.log_management')}>
          {gateway.log_management ? `${gateway.log_management} · ${gateway.log_management_strategy ?? ''}` : '—'}
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.collect_logs')}>
          <Badge tone={gateway.collect_logs ? 'success' : 'neutral'}>{gateway.collect_logs ? 'on' : 'off'}</Badge>
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.authenticated')}>
          <Badge tone={gateway.authentication ? 'success' : 'neutral'}>{gateway.authentication ? 'on' : 'off'}</Badge>
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.byok_only')}>
          <Badge tone={gateway.byok_only ? 'warning' : 'neutral'}>{gateway.byok_only ? 'on' : 'off'}</Badge>
        </GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.zdr')}>
          <Badge tone={gateway.zdr ? 'success' : 'neutral'}>{gateway.zdr ? 'on' : 'off'}</Badge>
        </GatewayField>
      </dl>
      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border-subtle)] pt-3">
        <Field label={t('cloudflare.ai_platform.endpoint_provider')} className="w-44">
          <SelectMenu label={t('cloudflare.ai_platform.endpoint_provider')} value={provider} options={providerOptions} onChange={setProvider} width={200} />
        </Field>
        {endpointError ? <AiError message={endpointError} /> : null}
        {endpoint ? (
          <div className="flex min-w-0 flex-1 items-end gap-2">
            <Field label={t('cloudflare.ai_platform.endpoint')} className="min-w-0 flex-1">
              <Input readOnly value={endpoint} aria-label={t('cloudflare.ai_platform.endpoint')} className="font-mono" />
            </Field>
            <CopyButton text={endpoint} label={t('cloudflare.ai_platform.copy')} />
          </div>
        ) : null}
      </div>
      {cfAccountId ? null : <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.no_cf_account_id')}</p>}
    </AiPanel>
    <Modal
      open={editOpen}
      onClose={() => setEditOpen(false)}
      title={t('cloudflare.ai_platform.edit_gateway')}
      width={560}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setEditOpen(false)}>{t('cloudflare.ai_platform.cancel')}</Button>
          <Button onClick={() => { void submitEdit() }} disabled={busy}>
            {busy ? t('cloudflare.ai_platform.saving') : t('cloudflare.ai_platform.save')}
          </Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('cloudflare.ai_platform.cache_ttl')}>
            <Input type="number" min={0} value={cache} onChange={(event) => setCache(event.target.value)} />
          </Field>
          <Field label={t('cloudflare.ai_platform.rate_interval')}>
            <Input type="number" min={0} value={interval} onChange={(event) => setIntervalValue(event.target.value)} />
          </Field>
          <Field label={t('cloudflare.ai_platform.rate_limit')}>
            <Input type="number" min={0} value={limit} onChange={(event) => setLimit(event.target.value)} />
          </Field>
          <Field label={t('cloudflare.ai_platform.retry_attempts')}>
            <Input type="number" min={0} max={5} value={attempts} onChange={(event) => setAttempts(event.target.value)} />
          </Field>
          <Field label={t('cloudflare.ai_platform.retry_delay')}>
            <Input type="number" min={0} max={60000} value={delay} onChange={(event) => setDelay(event.target.value)} />
          </Field>
        </div>
        <Checkbox checked={collect} onChange={setCollect} label={t('cloudflare.ai_platform.collect_logs')} />
      </div>
    </Modal>
    </>
  )
}

function LogsSection({ accountId, gatewayId }: { accountId: string; gatewayId: string }) {
  const t = useCfT()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [applied, setApplied] = useState(0)
  const [result, setResult] = useState<PlatformPage<PlatformLog> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<PlatformLogDetail | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayPlatformApi.logs(accountId, gatewayId, {
      page,
      perPage: 20,
      status,
      provider,
      model,
      from: isoDay(from),
      to: isoDay(to, true),
    })
      .then((body) => { if (!cancelled) { setResult(body); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        setResult(null)
        setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, page, applied, status, provider, model, from, to, t])

  const statusOptions = [
    { value: '', label: t('cloudflare.ai_platform.logs_all') },
    { value: 'success', label: t('cloudflare.ai_platform.logs_success') },
    { value: 'error', label: t('cloudflare.ai_platform.logs_error') },
  ]

  return (
    <AiPanel title={t('cloudflare.ai_platform.section_logs')} bodyClassName="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('cloudflare.ai_platform.logs_status')} className="w-36">
          <SelectMenu label={t('cloudflare.ai_platform.logs_status')} value={status} options={statusOptions} onChange={(value) => { setStatus(value); setPage(1); setApplied((n) => n + 1) }} width={180} />
        </Field>
        <Field label={t('cloudflare.ai_platform.logs_provider')} className="w-44">
          <Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="workers-ai" />
        </Field>
        <Field label={t('cloudflare.ai_platform.logs_model')} className="w-52">
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t('cloudflare.ai_platform.logs_model_placeholder')} />
        </Field>
        <Field label={t('cloudflare.ai_platform.logs_from')} className="w-40">
          <DatePicker label={t('cloudflare.ai_platform.logs_from')} value={from} onChange={(value) => { setFrom(value); setPage(1); setApplied((n) => n + 1) }} />
        </Field>
        <Field label={t('cloudflare.ai_platform.logs_to')} className="w-40">
          <DatePicker label={t('cloudflare.ai_platform.logs_to')} value={to} onChange={(value) => { setTo(value); setPage(1); setApplied((n) => n + 1) }} />
        </Field>
        <Button size="sm" onClick={() => { setPage(1); setApplied((n) => n + 1) }}>{t('cloudflare.ai_platform.logs_apply')}</Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { setStatus(''); setProvider(''); setModel(''); setFrom(''); setTo(''); setPage(1); setApplied((n) => n + 1) }}
        >
          {t('cloudflare.ai_platform.logs_reset')}
        </Button>
      </div>
      {loading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
      {error ? <AiError message={error} onRetry={() => setApplied((n) => n + 1)} /> : null}
      {!loading && !error && result && result.items.length === 0 ? (
        <AiEmpty>
          {t('cloudflare.ai_platform.logs_empty')} {t('cloudflare.ai_platform.logs_empty_hint')}
        </AiEmpty>
      ) : null}
      {result && result.items.length > 0 ? (
        <TableScroll label={t('cloudflare.ai_platform.section_logs')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.ai_platform.logs_time')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_status')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_provider')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_model')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_duration')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_tokens')}</Th>
                <Th>{t('cloudflare.ai_platform.logs_cost')}</Th>
              </Tr>
            </THead>
            <TBody>
              {result.items.map((log) => (
                <Tr key={log.id}>
                  <Td>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => {
                      aiGatewayPlatformApi.log(accountId, gatewayId, log.id)
                        .then(setDetail)
                        .catch((reason: unknown) => setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported'))))
                    }}
                    >
                      {when(log.created_at)}
                    </button>
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <Badge tone={log.success ? 'success' : 'danger'}>{log.success ? t('cloudflare.ai_platform.logs_success') : t('cloudflare.ai_platform.logs_error')}</Badge>
                      {log.cached ? <Badge tone="accent">{t('cloudflare.ai_platform.logs_cached')}</Badge> : null}
                    </span>
                  </Td>
                  <Td>{log.provider || '—'}</Td>
                  <Td className="max-w-[16rem] truncate" title={log.model}>{log.model || '—'}</Td>
                  <Td>{t('cloudflare.ai_platform.duration_ms', { value: log.duration })}</Td>
                  <Td>{number(log.tokens_in ?? 0)} / {number(log.tokens_out ?? 0)}</Td>
                  <Td>{typeof log.cost === 'number' ? log.cost : '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      ) : null}
      {result ? <Pager page={result} onPage={setPage} label={t('cloudflare.ai_platform.page', { page: result.page, pages: result.totalPages })} /> : null}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={t('cloudflare.ai_platform.logs_detail')}
        width={820}
      >
        {detail ? <LogDetail accountId={accountId} gatewayId={gatewayId} log={detail} /> : null}
      </Modal>
    </AiPanel>
  )
}

function LogDetail({ accountId, gatewayId, log }: { accountId: string; gatewayId: string; log: PlatformLogDetail }) {
  const t = useCfT()
  const [kind, setKind] = useState<'request' | 'response' | 'none'>('none')
  const [payload, setPayload] = useState<{ body: string; truncated: boolean; size: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (kind === 'none') { setPayload(null); return }
    let cancelled = false
    aiGatewayPlatformApi.logPayload(accountId, gatewayId, log.id, kind)
      .then((body) => { if (!cancelled) { setPayload(body); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        const details = (reason as { details?: { upstream_status?: number } } | null)?.details
        if (details?.upstream_status === 404) { setPayload({ body: '', truncated: false, size: 0 }); setError(null) }
        else setError(cfErrorText(reason))
      })
    return () => { cancelled = true }
  }, [accountId, gatewayId, log.id, kind])

  return (
    <div className="space-y-3">
      <dl className="grid gap-2 sm:grid-cols-2">
        <GatewayField label={t('cloudflare.ai_platform.gateway_id')}>{log.id}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.logs_time')}>{when(log.created_at)}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.logs_provider')}>{log.provider || '—'}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.logs_model')}>{log.model || '—'}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.logs_duration')}>{t('cloudflare.ai_platform.duration_ms', { value: log.duration })}</GatewayField>
        <GatewayField label={t('cloudflare.ai_platform.logs_tokens')}>{number(log.tokens_in ?? 0)} / {number(log.tokens_out ?? 0)}</GatewayField>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={kind === 'request' ? 'primary' : 'secondary'} onClick={() => setKind('request')}>
          {t('cloudflare.ai_platform.logs_request')}
        </Button>
        <Button size="sm" variant={kind === 'response' ? 'primary' : 'secondary'} onClick={() => setKind('response')}>
          {t('cloudflare.ai_platform.logs_response')}
        </Button>
      </div>
      {error ? <AiError message={error} /> : null}
      {kind !== 'none' && payload ? (
        <div className="space-y-1">
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('cloudflare.ai_platform.logs_payload_size', { size: number(payload.size) })}
            {payload.truncated ? ` · ${t('cloudflare.ai_platform.logs_payload_truncated')}` : ''}
          </p>
          <pre className="max-h-[50vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)] whitespace-pre-wrap break-words">
            {payload.body}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function RoutingSection({ accountId, gatewayId, cfAccountId }: { accountId: string; gatewayId: string; cfAccountId: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [routes, setRoutes] = useState<PlatformRoute[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openRoute, setOpenRoute] = useState<PlatformRoute | null>(null)

  async function removeRoute(route: PlatformRoute): Promise<void> {
    const accepted = await confirm({
      title: t('cloudflare.ai_platform.delete_route'),
      description: t('cloudflare.ai_platform.delete_route_hint', { name: route.name || route.id }),
      confirmLabel: t('cloudflare.ai_platform.delete'),
      tone: 'danger',
    })
    if (!accepted) return
    try {
      await aiGatewayPlatformApi.deleteRoute(accountId, gatewayId, route.id)
      toast({ title: t('cloudflare.ai_platform.deleted_toast'), tone: 'success' })
      setRoutes((current) => current.filter((item) => item.id !== route.id))
    } catch (reason) {
      toast({ title: permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayPlatformApi.routes(accountId, gatewayId)
      .then((body) => { if (!cancelled) { setRoutes(body.items); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        setRoutes([])
        setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, t])

  const dashboard = cfAccountId
    ? `https://dash.cloudflare.com/${encodeURIComponent(cfAccountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`
    : ''

  return (
    <AiPanel
      title={t('cloudflare.ai_platform.section_routing')}
      actions={dashboard ? (
        <a href={dashboard} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[length:var(--text-11-5)] text-[var(--accent)]">
          {t('cloudflare.ai_platform.routing_dashboard')}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
      bodyClassName="space-y-3"
    >
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.routing_read_only')}</p>
      {loading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
      {error ? <AiError message={error} /> : null}
      {!loading && !error && routes.length === 0 ? (
        <AiEmpty>
          {t('cloudflare.ai_platform.routing_empty')} {t('cloudflare.ai_platform.routing_empty_hint')}
        </AiEmpty>
      ) : null}
      {routes.length > 0 ? (
        <TableScroll label={t('cloudflare.ai_platform.section_routing')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.ai_platform.routing_route')}</Th>
                <Th>{t('cloudflare.ai_platform.modified')}</Th>
                <Th>{t('cloudflare.ai_platform.routing_active')}</Th>
                <Th>{t('cloudflare.ai_platform.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {routes.map((route) => (
                <Tr key={route.id}>
                  <Td>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpenRoute(route)}>
                      {route.name || route.id}
                    </button>
                  </Td>
                  <Td>{when(route.modified_at)}</Td>
                  <Td>{route.deployment?.version_id ? <Badge tone="success">{route.deployment.version_id.slice(0, 8)}</Badge> : '—'}</Td>
                  <Td>
                    <Button size="sm" variant="secondary" onClick={() => { void removeRoute(route) }}>
                      <Trash2 aria-hidden="true" className="mr-1 size-3.5" />
                      {t('cloudflare.ai_platform.delete')}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      ) : null}
      <Modal open={openRoute !== null} onClose={() => setOpenRoute(null)} title={openRoute?.name ?? ''} width={760}>
        {openRoute ? <RouteDetail accountId={accountId} gatewayId={gatewayId} route={openRoute} /> : null}
      </Modal>
    </AiPanel>
  )
}

function RouteDetail({ accountId, gatewayId, route }: { accountId: string; gatewayId: string; route: PlatformRoute }) {
  const t = useCfT()
  const [versions, setVersions] = useState<PlatformRouteVersion[]>([])
  const [deployments, setDeployments] = useState<PlatformRouteDeployment[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      aiGatewayPlatformApi.routeVersions(accountId, gatewayId, route.id),
      aiGatewayPlatformApi.routeDeployments(accountId, gatewayId, route.id),
    ])
      .then(([versionBody, deploymentBody]) => {
        if (cancelled) return
        setVersions(versionBody.items)
        setDeployments(deploymentBody.items)
        setError(null)
      })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, route.id])

  return (
    <div className="space-y-3">
      {error ? <AiError message={error} /> : null}
      <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('cloudflare.ai_platform.routing_versions')}</h3>
      {versions.length === 0 ? <AiEmpty>{t('cloudflare.ai_platform.routing_empty')}</AiEmpty> : (
        <TableScroll label={t('cloudflare.ai_platform.routing_versions')}>
          <Table>
            <THead><Tr><Th>{t('cloudflare.ai_platform.id')}</Th><Th>{t('cloudflare.ai_platform.routing_active')}</Th><Th>{t('cloudflare.ai_platform.routing_created')}</Th></Tr></THead>
            <TBody>
              {versions.map((version) => (
                <Tr key={version.version_id}>
                  <Td className="font-mono">{version.version_id}</Td>
                  <Td>{version.active === 'true' ? <Badge tone="success">{t('cloudflare.ai_platform.routing_active')}</Badge> : '—'}</Td>
                  <Td>{when(version.created_at)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}
      <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('cloudflare.ai_platform.routing_deployments')}</h3>
      {deployments.length === 0 ? <AiEmpty>{t('cloudflare.ai_platform.routing_empty')}</AiEmpty> : (
        <TableScroll label={t('cloudflare.ai_platform.routing_deployments')}>
          <Table>
            <THead><Tr><Th>{t('cloudflare.ai_platform.id')}</Th><Th>{t('cloudflare.ai_platform.routing_version')}</Th><Th>{t('cloudflare.ai_platform.routing_created')}</Th></Tr></THead>
            <TBody>
              {deployments.map((deployment) => (
                <Tr key={deployment.deployment_id}>
                  <Td className="font-mono">{deployment.deployment_id}</Td>
                  <Td className="font-mono">{deployment.version_id}</Td>
                  <Td>{when(deployment.created_at)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      )}
    </div>
  )
}

function ProvidersSection({ accountId, gatewayId }: { accountId: string; gatewayId: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [result, setResult] = useState<PlatformPage<PlatformProviderConfig> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [alias, setAlias] = useState('')
  const [slug, setSlug] = useState('openai')
  const [secret, setSecret] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayPlatformApi.providerConfigs(accountId, gatewayId)
      .then((body) => { if (!cancelled) { setResult(body); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        setResult(null)
        setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, reload, t])

  async function createProvider(): Promise<void> {
    if (busy || !alias.trim() || !slug.trim() || !secret.trim()) return
    setBusy(true)
    try {
      await aiGatewayPlatformApi.createProviderConfig(accountId, gatewayId, {
        alias: alias.trim(),
        provider_slug: slug.trim(),
        secret: secret.trim(),
      })
      toast({ title: t('cloudflare.ai_platform.provider_created'), tone: 'success' })
      setCreateOpen(false)
      setAlias('')
      setSecret('')
      setReload((value) => value + 1)
    } catch (reason) {
      toast({ title: permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    <AiPanel
      title={t('cloudflare.ai_platform.section_providers')}
      actions={(
        <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" className="mr-1 size-3.5" />
          {t('cloudflare.ai_platform.provider_create')}
        </Button>
      )}
      bodyClassName="space-y-3"
    >
      {loading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
      {error ? <AiError message={error} /> : null}
      {!loading && !error && result && result.items.length === 0 ? (
        <AiEmpty>
          {t('cloudflare.ai_platform.providers_empty')} {t('cloudflare.ai_platform.providers_empty_hint')}
        </AiEmpty>
      ) : null}
      {result && result.items.length > 0 ? (
        <TableScroll label={t('cloudflare.ai_platform.section_providers')}>
          <Table>
            <THead>
              <Tr>
                <Th>{t('cloudflare.ai_platform.providers_alias')}</Th>
                <Th>{t('cloudflare.ai_platform.providers_slug')}</Th>
                <Th>{t('cloudflare.ai_platform.providers_secret')}</Th>
                <Th>{t('cloudflare.ai_platform.providers_default')}</Th>
                <Th>{t('cloudflare.ai_platform.modified')}</Th>
              </Tr>
            </THead>
            <TBody>
              {result.items.map((provider) => (
                <Tr key={provider.id}>
                  <Td>{provider.alias}</Td>
                  <Td>{provider.provider_slug}</Td>
                  <Td className="font-mono">{provider.secret_preview}</Td>
                  <Td>{provider.default_config ? <Badge tone="accent">{t('cloudflare.ai_platform.providers_default')}</Badge> : '—'}</Td>
                  <Td>{when(provider.modified_at)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableScroll>
      ) : null}
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.providers_no_delete')}</p>
    </AiPanel>
    <Modal
      open={createOpen}
      onClose={() => setCreateOpen(false)}
      title={t('cloudflare.ai_platform.provider_create')}
      width={520}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCreateOpen(false)}>{t('cloudflare.ai_platform.cancel')}</Button>
          <Button onClick={() => { void createProvider() }} disabled={busy || !alias.trim() || !secret.trim()}>
            {busy ? t('cloudflare.ai_platform.saving') : t('cloudflare.ai_platform.save')}
          </Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.ai_platform.providers_alias')}>
          <Input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="openai-main" />
        </Field>
        <Field label={t('cloudflare.ai_platform.providers_slug')}>
          <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="openai" />
        </Field>
        <Field label={t('cloudflare.ai_platform.providers_secret')} hint={t('cloudflare.ai_platform.providers_no_delete')}>
          <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
      </div>
    </Modal>
    </>
  )
}

function BillingSection({ accountId }: { accountId: string }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const [limit, setLimit] = useState<PlatformSpendingLimit | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayPlatformApi.spendingLimit(accountId)
      .then((body) => { if (!cancelled) { setLimit(body); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        setLimit(null)
        setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, reload, t])

  async function clearLimit(): Promise<void> {
    const accepted = await confirm({
      title: t('cloudflare.ai_platform.billing_clear'),
      description: t('cloudflare.ai_platform.billing_clear_hint'),
      confirmLabel: t('cloudflare.ai_platform.delete'),
      tone: 'danger',
    })
    if (!accepted) return
    try {
      await aiGatewayPlatformApi.clearSpendingLimit(accountId)
      toast({ title: t('cloudflare.ai_platform.limit_cleared'), tone: 'success' })
      setReload((value) => value + 1)
    } catch (reason) {
      toast({ title: permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')), tone: 'danger' })
    }
  }

  return (
    <AiPanel title={t('cloudflare.ai_platform.section_billing')} bodyClassName="space-y-3">
      {loading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
      {error ? <AiError message={error} /> : null}
      {!loading && !error && limit ? (
        limit.enabled ? (
          <p className="flex flex-wrap items-center gap-2 text-[length:var(--text-12-5)] text-[var(--text-primary)]">
            <Badge tone="success">{t('cloudflare.ai_platform.billing_enabled')}</Badge>
            {t('cloudflare.ai_platform.billing_amount', {
              amount: limit.config.amount ?? 0,
              duration: limit.config.duration ?? '—',
              strategy: limit.config.strategy ?? '—',
            })}
            <Button size="sm" variant="secondary" onClick={() => { void clearLimit() }}>{t('cloudflare.ai_platform.billing_clear')}</Button>
          </p>
        ) : (
          <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.billing_disabled')}</p>
        )
      ) : null}
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.billing_deprecated')}</p>
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.billing_note')}</p>
    </AiPanel>
  )
}

function AnalyticsSection({ accountId, gatewayId }: { accountId: string; gatewayId: string }) {
  const t = useCfT()
  const [days, setDays] = useState(7)
  const [analytics, setAnalytics] = useState<PlatformAnalytics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    aiGatewayPlatformApi.analytics(accountId, gatewayId, days)
      .then((body) => { if (!cancelled) { setAnalytics(body); setError(null) } })
      .catch((reason: unknown) => {
        if (cancelled) return
        setAnalytics(null)
        setError(permissionText(reason, t('cloudflare.ai_platform.plan_unsupported')))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [accountId, gatewayId, days, t])

  const rangeOptions = [
    { value: '1', label: t('cloudflare.ai_platform.analytics_1d') },
    { value: '7', label: t('cloudflare.ai_platform.analytics_7d') },
    { value: '30', label: t('cloudflare.ai_platform.analytics_30d') },
  ]
  const max = Math.max(1, ...(analytics?.series.map((point) => point.requests) ?? [0]))

  return (
    <AiPanel
      title={t('cloudflare.ai_platform.section_analytics')}
      actions={<SelectMenu label={t('cloudflare.ai_platform.analytics_range')} value={String(days)} options={rangeOptions} onChange={(value) => setDays(Number(value))} width={160} />}
      bodyClassName="space-y-3"
    >
      {loading ? <LoadingBlock label={t('cloudflare.ai_platform.loading')} /> : null}
      {error ? <AiError message={error} /> : null}
      {!loading && !error && analytics ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.analytics_requests')}</p>
              <p className="mt-0.5 text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{number(analytics.requests)}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.analytics_errors')}</p>
              <p className="mt-0.5 text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{number(analytics.errors)}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.analytics_cost')}</p>
              <p className="mt-0.5 text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{analytics.cost}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.analytics_cached')}</p>
              <p className="mt-0.5 text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{number(analytics.cachedTokensIn + analytics.cachedTokensOut)}</p>
            </div>
          </div>
          {analytics.series.length === 0 ? (
            <AiEmpty>
              {t('cloudflare.ai_platform.analytics_empty')} {t('cloudflare.ai_platform.analytics_empty_hint')}
            </AiEmpty>
          ) : (
            <div role="img" aria-label={t('cloudflare.ai_platform.analytics_requests')} className="space-y-1">
              {analytics.series.slice(-24).map((point) => (
                <div key={point.label} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{point.label}</span>
                  <span className="h-2 min-w-0 flex-1 rounded-full bg-[var(--bg-sunken)]">
                    <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.round((point.requests / max) * 100)}%` }} />
                  </span>
                  <span className="w-12 shrink-0 text-right text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{number(point.requests)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </AiPanel>
  )
}

function LogpushSection({ gateway }: { gateway: PlatformGateway }) {
  const t = useCfT()
  return (
    <AiPanel title={t('cloudflare.ai_platform.section_logpush')} bodyClassName="space-y-2">
      <p className="flex items-center gap-2 text-[length:var(--text-12-5)] text-[var(--text-primary)]">
        <Badge tone={gateway.logpush ? 'success' : 'neutral'}>{gateway.logpush ? 'on' : 'off'}</Badge>
        {gateway.logpush ? t('cloudflare.ai_platform.logpush_on') : t('cloudflare.ai_platform.logpush_off')}
      </p>
      {gateway.logpush_public_key ? (
        <p className="break-all font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{gateway.logpush_public_key}</p>
      ) : null}
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('cloudflare.ai_platform.logpush_note')}</p>
    </AiPanel>
  )
}
