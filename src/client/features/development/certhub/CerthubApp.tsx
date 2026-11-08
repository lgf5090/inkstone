import { useEffect, useMemo, useState } from 'react'
import { BadgeCheck, Download, FileKey2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { request } from '../../../lib/api'
import { navigateToPath, usePathname } from '../../../lib/app-history'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useBreakpoint } from '../../../lib/hooks'
import { useUi } from '../../../store/ui'
import { Badge, Button, SectionLabel } from '../../../components/primitives'
import { Checkbox, Field, Input, Switch, Textarea } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Empty, LoadingBlock, Skeleton } from '../../../components/feedback'
import { Modal, confirm, prompt } from '../../../components/overlay'
import { Tabs } from '../../../components/tabs'
import { CopyButton } from '../../../components/copy-button'
import { TagPill } from '../../../components/TagChip'
import type {
  CerthubAccountView,
  CerthubAction,
  CerthubCa,
  CerthubConfigView,
  CerthubDnsProviderView,
  CerthubEventView,
  CerthubKeyAlgorithm,
  CerthubOrderStatus,
  CerthubOrderSummary,
  CerthubOrderView,
  CerthubOverview,
  CerthubSettingsView,
  CerthubTokenView,
} from '../../../../shared/development/certhub/types'

const BASE = '/api/development/certhub'
const CA_OPTIONS: Array<{ value: CerthubCa; label: string; disabled?: boolean }> = [
  { value: 'lets-encrypt', label: "Let's Encrypt" },
  { value: 'google-trust', label: 'Google Trust' },
  { value: 'zerossl', label: 'ZeroSSL' },
  { value: 'sslcom', label: 'SSL.com' },
  { value: 'buypass', label: 'Buypass', disabled: true },
]
const ALGORITHM_OPTIONS: Array<{ value: CerthubKeyAlgorithm; label: string }> = [
  { value: 'eccp256', label: 'ECC P-256' },
  { value: 'eccp384', label: 'ECC P-384' },
  { value: 'rsa2048', label: 'RSA 2048' },
]
const STATUS_TONES: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  creating_order: 'accent',
  awaiting_dns: 'warning',
  awaiting_http: 'warning',
  validating: 'accent',
  ready: 'accent',
  finalizing: 'accent',
  issued: 'success',
  failed: 'danger',
  revoked: 'danger',
  expired: 'danger',
  canceled: 'neutral',
}

function statusKey(status: string): string {
  return `development.certhub.status.${status}`
}

function toastError(error: unknown): void {
  useUi.getState().toast({
    title: error instanceof Error ? error.message : t('development.certhub.error.generic'),
    tone: 'danger',
  })
}

async function api<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  const response = await request<{ ok: true; data: T }>(`${BASE}${path}`, options)
  return response.data
}

type ModuleView = 'overview' | 'certificates' | 'detail' | 'apply' | 'accounts' | 'dns' | 'settings' | 'api' | 'admin'

function viewForPath(pathname: string): { view: ModuleView; id: string } {
  const rest = pathname.replace(/^\/development\/certhub/, '')
  if (!rest || rest === '/') return { view: 'overview', id: '' }
  if (rest.startsWith('/certificates/')) return { view: 'detail', id: rest.slice('/certificates/'.length) }
  if (rest.startsWith('/certificates')) return { view: 'certificates', id: '' }
  if (rest.startsWith('/new')) return { view: 'apply', id: '' }
  if (rest.startsWith('/accounts')) return { view: 'accounts', id: '' }
  if (rest.startsWith('/dns')) return { view: 'dns', id: '' }
  if (rest.startsWith('/settings')) return { view: 'settings', id: '' }
  if (rest.startsWith('/api')) return { view: 'api', id: '' }
  if (rest.startsWith('/admin')) return { view: 'admin', id: '' }
  return { view: 'overview', id: '' }
}

export function CerthubApp() {
  const pathname = usePathname()
  const { view, id } = viewForPath(pathname)
  const breakpoint = useBreakpoint()
  const compact = breakpoint === 'mobile' || breakpoint === 'tablet'
  const [isOwner, setIsOwner] = useState(false)
  useEffect(() => {
    request<{ user?: { role?: string } }>('/api/auth/session')
      .then((session) => setIsOwner(session.user?.role === 'owner'))
      .catch(() => setIsOwner(false))
  }, [])
  const tabs = [
    { id: 'overview', label: t('development.certhub.nav.overview') },
    { id: 'certificates', label: t('development.certhub.nav.certificates') },
    { id: 'apply', label: t('development.certhub.nav.apply') },
    { id: 'accounts', label: t('development.certhub.nav.accounts') },
    { id: 'dns', label: t('development.certhub.nav.dns') },
    { id: 'settings', label: t('development.certhub.nav.settings') },
    { id: 'api', label: t('development.certhub.nav.api') },
    ...(isOwner ? [{ id: 'admin', label: t('development.certhub.nav.admin') }] : []),
  ] as Array<{ id: ModuleView; label: string }>
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <BadgeCheck size={18} className="text-[var(--text-secondary)]" />
          <div className="min-w-0">
            <div className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
              {t('development.certhub.module_name')}
            </div>
            <div className="truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {t('development.certhub.overview.subtitle')}
            </div>
          </div>
        </div>
        <Tabs
          value={view === 'detail' ? 'certificates' : view}
          onChange={(next: ModuleView) => navigateToPath(next === 'overview' ? '/development/certhub' : `/development/certhub/${next}`)}
          items={tabs}
          label={t('development.certhub.module_name')}
          className="max-w-full"
        />
        <Button size="sm" icon={<Plus size={14} />} onClick={() => navigateToPath('/development/certhub/new')}>
          {t('development.certhub.cert.new')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        {view === 'overview' ? <OverviewPage compact={compact} /> : null}
        {view === 'certificates' ? <CertificatesPage compact={compact} /> : null}
        {view === 'detail' ? <DetailPage id={id} compact={compact} /> : null}
        {view === 'apply' ? <ApplyPage compact={compact} /> : null}
        {view === 'accounts' ? <AccountsPage /> : null}
        {view === 'dns' ? <DnsPage compact={compact} /> : null}
        {view === 'settings' ? <SettingsPage compact={compact} /> : null}
        {view === 'api' ? <ApiPage /> : null}
        {view === 'admin' ? <AdminPage /> : null}
      </div>
    </div>
  )
}

function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 md:p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{t(statusKey(status) as never)}</Badge>
}

function formatDate(value: number | null): string {
  return value ? new Date(value).toLocaleString() : t('development.certhub.common.not_available')
}

function OverviewPage({ compact }: { compact: boolean }) {
  const [data, setData] = useState<CerthubOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    api<CerthubOverview>('/overview').then(setData).catch((reason) => setError(String(reason?.message ?? reason)))
  }
  useEffect(load, [])
  if (!data && !error) return <LoadingBlock />
  if (error) return <Empty art="search" title={t('development.certhub.error.generic')} description={error} action={<Button onClick={load}>{t('common.retry')}</Button>} />
  const counts = (data?.counts ?? {}) as Record<string, number>
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[1.4fr_1fr]')}>
      <Panel title={t('development.certhub.overview.title')} subtitle={t('development.certhub.overview.subtitle')}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {(['issued', 'awaiting_dns', 'failed', 'expired'] as CerthubOrderStatus[]).map((status) => (
            <div key={status} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
              <div className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t(statusKey(status) as never)}</div>
              <div className="mt-1 text-[length:var(--text-20)] font-semibold tabular text-[var(--text-primary)]">{counts[status] ?? 0}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('development.certhub.overview.expiring')}</span>
          <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{counts.expiringSoon ?? 0}</span>
        </div>
        <div className="mt-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('development.certhub.apply.quota')}: {data?.quota.activeCerts ?? 0}/{data?.quota.maxActiveCerts ?? 0} · {data?.quota.dailyUsed ?? 0}/{data?.quota.dailyLimit ?? 0}
        </div>
      </Panel>
      <Panel title={t('development.certhub.overview.recent')}>
        {data?.recentOrders.length ? (
          <div className="space-y-2">
            {data.recentOrders.map((order) => (
              <button key={order.id} type="button" onClick={() => navigateToPath(`/development/certhub/certificates/${order.id}`)} className="flex w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-2 py-2 text-left hover:bg-[var(--bg-hover)]">
                <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{order.primaryDomain || order.id}</span>
                <StatusBadge status={order.status} />
              </button>
            ))}
          </div>
        ) : (
          <Empty art="starred" title={t('development.certhub.overview.empty')} description={t('development.certhub.cert.empty_hint')} compact />
        )}
      </Panel>
      <Panel title={t('development.certhub.overview.recent')}>
        {data?.recentEvents.length ? <EventList events={data.recentEvents} /> : <Empty art="search" title={t('development.certhub.detail.no_events')} compact />}
      </Panel>
    </div>
  )
}

function CertificatesPage({ compact }: { compact: boolean }) {
  const [items, setItems] = useState<CerthubOrderSummary[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = (cursor?: string) => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '30' })
    if (query.trim()) params.set('q', query.trim())
    if (status) params.set('status', status)
    if (cursor) params.set('cursor', cursor)
    api<{ items: CerthubOrderSummary[]; nextCursor: string | null }>(`/orders?${params.toString()}`)
      .then((result) => {
        setItems((current) => (cursor ? [...current, ...result.items] : result.items))
        setNext(result.nextCursor)
      })
      .catch((reason) => setError(String(reason?.message ?? reason)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [status])
  const statusOptions = useMemo(() => [
    { value: '', label: t('development.certhub.cert.all') },
    ...(['issued', 'awaiting_dns', 'awaiting_http', 'validating', 'failed', 'expired', 'revoked', 'canceled'] as CerthubOrderStatus[]).map((value) => ({ value, label: t(statusKey(value) as never) })),
  ], [])
  return (
    <Panel title={t('development.certhub.cert.title')} subtitle={t('development.certhub.cert.subtitle')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('development.certhub.cert.search')} className="min-w-[200px] flex-1" />
        <Button onClick={() => load()} icon={<RefreshCw size={14} />}>{t('common.retry')}</Button>
        <SelectMenu label={t('development.certhub.cert.filter')} value={status} options={statusOptions} onChange={setStatus} size="sm" width={200} />
      </div>
      {loading && items.length === 0 ? <Skeleton className="h-40" /> : null}
      {error ? <Empty art="search" title={t('development.certhub.error.generic')} description={error} action={<Button onClick={() => load()}>{t('common.retry')}</Button>} /> : null}
      {!error && !loading && items.length === 0 ? <Empty art="starred" title={t('development.certhub.cert.empty')} description={t('development.certhub.cert.empty_hint')} action={<Button onClick={() => navigateToPath('/development/certhub/new')} icon={<Plus size={14} />}>{t('development.certhub.cert.new')}</Button>} /> : null}
      {items.length > 0 && (compact ? (
        <div className="space-y-2">
          {items.map((order) => (
            <button key={order.id} type="button" onClick={() => navigateToPath(`/development/certhub/certificates/${order.id}`)} className="flex w-full flex-col gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3 text-left">
              <div className="flex items-center justify-between gap-2"><span className="truncate text-[length:var(--text-13)] font-medium">{order.primaryDomain || order.id}</span><StatusBadge status={order.status} /></div>
              <div className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{formatDate(order.certNotAfter)}</div>
            </button>
          ))}
        </div>
      ) : (
        <table className="w-full border-collapse text-left text-[length:var(--text-12)]">
          <caption className="sr-only">{t('development.certhub.cert.title')}</caption>
          <thead className="text-[var(--text-quaternary)]">
            <tr>
              <th className="border-b border-[var(--border-subtle)] px-2 py-2">{t('development.certhub.cert.domain')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-2">{t('development.certhub.cert.status')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-2">{t('development.certhub.cert.issued')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-2">{t('development.certhub.cert.expires')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-2">{t('development.certhub.cert.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((order) => (
              <tr key={order.id} className="hover:bg-[var(--bg-hover)]">
                <td className="border-b border-[var(--border-subtle)] px-2 py-2">{order.primaryDomain || order.id}</td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-2"><StatusBadge status={order.status} /></td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-2">{formatDate(order.createdAt)}</td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-2">{formatDate(order.certNotAfter)}</td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-2"><Button size="sm" onClick={() => navigateToPath(`/development/certhub/certificates/${order.id}`)}>{t('development.certhub.cert.view')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {next ? <div className="mt-3 flex justify-center"><Button onClick={() => load(next)} loading={loading}>{t('development.certhub.cert.more')}</Button></div> : null}
    </Panel>
  )
}

function DetailPage({ id, compact }: { id: string; compact: boolean }) {
  const [order, setOrder] = useState<CerthubOrderView | null>(null)
  const [events, setEvents] = useState<CerthubEventView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pfxPassword, setPfxPassword] = useState('')
  const load = () => {
    setError(null)
    api<{ order: CerthubOrderView; events: CerthubEventView[] }>(`/orders/${id}`)
      .then((data) => { setOrder(data.order); setEvents(data.events) })
      .catch((reason) => setError(String(reason?.message ?? reason)))
  }
  useEffect(load, [id])
  useEffect(() => {
    if (!order) return
    const active = ['queued', 'creating_order', 'awaiting_dns', 'awaiting_http', 'validating', 'ready', 'finalizing'].includes(order.status)
    if (!active) return
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [order?.status, id])
  const runAction = async (action: CerthubAction, extra: Record<string, unknown> = {}) => {
    if (!order) return
    setBusy(true)
    try {
      await api(`/orders/${id}/actions`, { method: 'POST', body: { action, ...extra } })
      load()
    } catch (reason) {
      toastError(reason)
    } finally {
      setBusy(false)
    }
  }
  const askPassword = async (): Promise<string | null> => {
    const value = await prompt({
      title: t('development.certhub.detail.reauth'),
      description: t('development.certhub.detail.reauth_hint'),
      placeholder: t('development.certhub.detail.reauth'),
      confirmLabel: t('development.certhub.common.confirm'),
    })
    return value
  }
  const download = async (kind: string, exportKind?: 'zip' | 'pfx') => {
    if (!order) return
    const password = await askPassword()
    if (password === null) return
    const path = exportKind ? `/orders/${id}/export?kind=${exportKind}` : `/orders/${id}/download?kind=${kind}`
    const response = await fetch(`${BASE}${path}`, {
      headers: { 'X-Client': '1', 'X-Certhub-Reauth': password },
    })
    if (!response.ok) {
      toastError(new Error((await response.json().catch(() => null))?.error?.message ?? `HTTP ${response.status}`))
      return
    }
    if (exportKind === 'pfx') {
      const key = response.headers.get('X-Certhub-Pfx-Password') ?? ''
      setPfxPassword(key)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const name = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `${order.id}.${exportKind ?? 'pem'}`
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const typedConfirm = async (title: string, label: string): Promise<boolean> => {
    const value = await prompt({ title, description: label, placeholder: order?.id, confirmLabel: t('development.certhub.common.confirm') })
    return value === order?.id
  }
  if (!order && !error) return <LoadingBlock />
  if (error) return <Empty art="search" title={t('development.certhub.error.generic')} description={error} action={<Button onClick={load}>{t('common.retry')}</Button>} />
  if (!order) return null
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[1.5fr_1fr]')}>
      <Panel title={t('development.certhub.detail.title')} subtitle={order.primaryDomain} actions={<StatusBadge status={order.status} />}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => runAction('advance')} loading={busy} icon={<RefreshCw size={14} />}>{t('development.certhub.detail.verify')}</Button>
          {order.status === 'issued' || order.status === 'expired' ? <Button size="sm" onClick={() => runAction('renew')}>{t('development.certhub.detail.renew')}</Button> : null}
          {order.status === 'issued' || order.status === 'expired' ? <Button size="sm" variant="danger" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_revoke'), order.id)) runAction('revoke') }}>{t('development.certhub.detail.revoke')}</Button> : null}
          {order.hasPrivateKey ? <Button size="sm" variant="ghost" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_purge'), order.id)) runAction('purge_key') }}>{t('development.certhub.detail.purge')}</Button> : null}
          {['failed', 'canceled', 'revoked', 'expired'].includes(order.status) ? <Button size="sm" variant="ghost" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_delete'), order.id)) runAction('delete', { confirm: order.id }) }}>{t('development.certhub.detail.delete')}</Button> : null}
        </div>
        <div className="grid grid-cols-2 gap-2 text-[length:var(--text-12)]">
          <Info label={t('development.certhub.apply.ca')} value={order.ca} />
          <Info label={t('development.certhub.apply.algorithm')} value={order.keyAlgorithm} />
          <Info label={t('development.certhub.cert.issued')} value={formatDate(order.issuedAt)} />
          <Info label={t('development.certhub.cert.expires')} value={formatDate(order.certNotAfter)} />
          <Info label={t('development.certhub.accounts.fingerprint')} value={order.keyFingerprint || '-'} />
          <Info label={t('development.certhub.detail.progress')} value={`${order.domains.length} domains`} />
        </div>
        <div className="mt-4">
          <SectionLabel>{t('development.certhub.detail.download')}</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-2">
            {order.hasCertificate ? <Button size="sm" icon={<Download size={14} />} onClick={() => download('fullchain')}>{t('development.certhub.detail.cert')}</Button> : null}
            {order.hasPrivateKey ? <Button size="sm" icon={<FileKey2 size={14} />} onClick={() => download('key')}>{t('development.certhub.detail.key')}</Button> : null}
            {order.hasCertificate && order.hasPrivateKey ? <Button size="sm" onClick={() => download('', 'zip')}>{t('development.certhub.detail.zip')}</Button> : null}
            {order.hasCertificate && order.hasPrivateKey ? <Button size="sm" onClick={() => download('', 'pfx')}>{t('development.certhub.detail.pfx')}</Button> : null}
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {order.domains.map((domain) => (
            <div key={domain.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-[length:var(--text-12-5)]">{domain.fqdn}</span>
                <div className="flex items-center gap-2"><TagPill label={domain.challengeMode} /><StatusBadge status={domain.status} /></div>
              </div>
              <div className="mt-2 grid gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                <div className="break-all">{t('development.certhub.detail.record')}: {domain.recordName || '-'} · {domain.recordType}</div>
                <div className="flex min-w-0 items-center gap-1"><span className="truncate">{t('development.certhub.detail.record_value')}: {domain.recordValue || '-'}</span><CopyButton text={domain.recordValue} label={t('development.certhub.detail.copy')} /></div>
              </div>
              <div className="mt-2"><Button size="sm" onClick={() => runAction('verify_domain', { domainId: domain.id })}>{t('development.certhub.detail.verify')}</Button></div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title={t('development.certhub.detail.events')}>
        {events.length ? <EventList events={events} /> : <Empty art="search" title={t('development.certhub.detail.no_events')} compact />}
      </Panel>
      <Modal open={Boolean(pfxPassword)} onClose={() => setPfxPassword('')} title={t('development.certhub.detail.pfx')} width={420}>
        <div className="space-y-2 text-[length:var(--text-12)]">
          <p>{t('development.certhub.settings.token_reveal')}</p>
          <code className="block break-all rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2">{pfxPassword}</code>
          <CopyButton text={pfxPassword} label={t('common.copy')} />
        </div>
      </Modal>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2"><div className="text-[var(--text-quaternary)]">{label}</div><div className="mt-1 break-all text-[var(--text-primary)]">{value}</div></div>
}

function EventList({ events }: { events: CerthubEventView[] }) {
  return (
    <ol className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[var(--text-secondary)]">{event.kind}</span>
            <span className="text-[var(--text-quaternary)]">{formatDate(event.createdAt)}</span>
          </div>
          <div className="mt-0.5 text-[var(--text-tertiary)]">{event.messageCode}</div>
        </li>
      ))}
    </ol>
  )
}

interface DomainForm { id: string; name: string; wildcard: boolean; primary: boolean; challengeMode: 'dns-01' | 'http-01'; dnsProviderId: string }

function ApplyPage({ compact }: { compact: boolean }) {
  const [domains, setDomains] = useState<DomainForm[]>([{ id: crypto.randomUUID(), name: '', wildcard: false, primary: true, challengeMode: 'dns-01', dnsProviderId: '' }])
  const [ca, setCa] = useState<CerthubCa>('lets-encrypt')
  const [algorithm, setAlgorithm] = useState<CerthubKeyAlgorithm>('eccp256')
  const [autoRenew, setAutoRenew] = useState(true)
  const [providers, setProviders] = useState<CerthubDnsProviderView[]>([])
  const [subject, setSubject] = useState({ country: '', state: '', locality: '', organization: '', organizationUnit: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<{ items: CerthubDnsProviderView[] }>('/dns-providers').then((data) => setProviders(data.items)).catch(() => setProviders([])) }, [])
  const update = (id: string, patch: Partial<DomainForm>) => setDomains((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row))
  const submit = async () => {
    setBusy(true)
    try {
      const result = await api<{ order: CerthubOrderView }>('/orders', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: {
          domains: domains.filter((row) => row.name.trim()).map((row) => ({ name: row.name, wildcard: row.wildcard, primary: row.primary, challengeMode: row.challengeMode, dnsProviderId: row.dnsProviderId || undefined })),
          ca,
          keyAlgorithm: algorithm,
          autoRenew,
          subject: {
            country: subject.country || undefined,
            state: subject.state || undefined,
            locality: subject.locality || undefined,
            organization: subject.organization || undefined,
            organizationUnit: subject.organizationUnit || undefined,
          },
        },
      })
      navigateToPath(`/development/certhub/certificates/${result.order.id}`)
    } catch (reason) {
      toastError(reason)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel title={t('development.certhub.apply.title')} subtitle={t('development.certhub.apply.step_review')}>
      <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-2')}>
        <div className="space-y-3">
          <SectionLabel>{t('development.certhub.apply.step_domains')}</SectionLabel>
          {domains.map((row) => (
            <div key={row.id} className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-2">
              <Input value={row.name} onChange={(event) => update(row.id, { name: event.target.value })} placeholder={t('development.certhub.apply.domain_placeholder')} aria-label={t('development.certhub.cert.domain')} />
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[length:var(--text-11-5)]"><Checkbox checked={row.wildcard} onChange={(next) => update(row.id, { wildcard: next, ...(next ? { challengeMode: 'dns-01' as const } : {}) })} label={t('development.certhub.apply.wildcard')} />{t('development.certhub.apply.wildcard')}</label>
                <label className="flex items-center gap-1.5 text-[length:var(--text-11-5)]"><Checkbox checked={row.primary} onChange={(next) => setDomains((current) => current.map((entry) => ({ ...entry, primary: entry.id === row.id ? next : false })))} label={t('development.certhub.apply.primary')} />{t('development.certhub.apply.primary')}</label>
                <SelectMenu label={t('development.certhub.apply.challenge')} value={row.challengeMode} options={[{ value: 'dns-01', label: t('development.certhub.apply.dns_manual') }, { value: 'http-01', label: t('development.certhub.apply.http_manual') }]} onChange={(value) => update(row.id, { challengeMode: value })} size="sm" width={200} />
                {row.challengeMode === 'dns-01' ? <SelectMenu label={t('development.certhub.apply.provider')} value={row.dnsProviderId} options={[{ value: '', label: t('development.certhub.apply.provider_none') }, ...providers.map((provider) => ({ value: provider.id, label: provider.label }))]} onChange={(value) => update(row.id, { dnsProviderId: value })} size="sm" width={200} /> : null}
              </div>
            </div>
          ))}
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setDomains((current) => [...current, { id: crypto.randomUUID(), name: '', wildcard: false, primary: false, challengeMode: 'dns-01', dnsProviderId: '' }])}>{t('development.certhub.apply.add_domain')}</Button>
        </div>
        <div className="space-y-3">
          <SectionLabel>{t('development.certhub.apply.step_settings')}</SectionLabel>
          <Field label={t('development.certhub.apply.ca')}><SelectMenu label={t('development.certhub.apply.ca')} value={ca} options={CA_OPTIONS.filter((option) => !option.disabled)} onChange={setCa} /></Field>
          <Field label={t('development.certhub.apply.algorithm')}><SelectMenu label={t('development.certhub.apply.algorithm')} value={algorithm} options={ALGORITHM_OPTIONS} onChange={setAlgorithm} /></Field>
          <div className="flex items-center justify-between gap-2"><span className="text-[length:var(--text-12)]">{t('development.certhub.apply.auto_renew')}</span><Switch checked={autoRenew} onChange={setAutoRenew} label={t('development.certhub.apply.auto_renew')} /></div>
          <SectionLabel>{t('development.certhub.apply.subject')}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <Input value={subject.country} onChange={(event) => setSubject({ ...subject, country: event.target.value })} aria-label={t('development.certhub.apply.subject_country')} placeholder={t('development.certhub.apply.subject_country')} maxLength={2} />
            <Input value={subject.state} onChange={(event) => setSubject({ ...subject, state: event.target.value })} aria-label={t('development.certhub.apply.subject_state')} placeholder={t('development.certhub.apply.subject_state')} />
            <Input value={subject.locality} onChange={(event) => setSubject({ ...subject, locality: event.target.value })} aria-label={t('development.certhub.apply.subject_locality')} placeholder={t('development.certhub.apply.subject_locality')} />
            <Input value={subject.organization} onChange={(event) => setSubject({ ...subject, organization: event.target.value })} aria-label={t('development.certhub.apply.subject_organization')} placeholder={t('development.certhub.apply.subject_organization')} />
          </div>
          <Button variant="primary" onClick={submit} loading={busy}>{t('development.certhub.apply.submit')}</Button>
        </div>
      </div>
    </Panel>
  )
}

function AccountsPage() {
  const [accounts, setAccounts] = useState<CerthubAccountView[]>([])
  const [ca, setCa] = useState<CerthubCa>('lets-encrypt')
  const [busy, setBusy] = useState(false)
  const load = () => api<{ items: CerthubAccountView[] }>('/accounts').then((data) => setAccounts(data.items)).catch(toastError)
  useEffect(() => { void load() }, [])
  const create = async () => {
    setBusy(true)
    try { await api('/accounts', { method: 'POST', body: { ca } }); load() } catch (reason) { toastError(reason) } finally { setBusy(false) }
  }
  const rotate = async (id: string) => {
    if (!(await confirm({ title: t('development.certhub.accounts.rotate'), description: id, tone: 'danger' }))) return
    try { await api(`/accounts/${id}/rotate`, { method: 'POST' }); load() } catch (reason) { toastError(reason) }
  }
  return (
    <Panel title={t('development.certhub.accounts.title')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SelectMenu label={t('development.certhub.accounts.ca')} value={ca} options={CA_OPTIONS.filter((option) => !option.disabled)} onChange={setCa} size="sm" width={200} />
        <Button onClick={create} loading={busy} icon={<Plus size={14} />}>{t('development.certhub.accounts.create')}</Button>
      </div>
      {accounts.length === 0 ? <Empty art="starred" title={t('development.certhub.accounts.empty')} compact /> : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[length:var(--text-12-5)] font-medium"><ShieldCheck size={14} />{account.ca}</div>
                <div className="mt-1 break-all text-[length:var(--text-11)] text-[var(--text-quaternary)]">{account.keyFingerprint || '-'}</div>
              </div>
              <div className="flex items-center gap-2"><Badge tone={account.status === 'active' ? 'success' : 'danger'}>{account.status}</Badge><Button size="sm" onClick={() => rotate(account.id)}>{t('development.certhub.accounts.rotate')}</Button></div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function DnsPage({ compact }: { compact: boolean }) {
  const [items, setItems] = useState<CerthubDnsProviderView[]>([])
  const [kind, setKind] = useState<'cloudflare' | 'dcv-delegate'>('cloudflare')
  const [form, setForm] = useState({ label: '', zoneId: '', zoneName: '', email: '', token: '' })
  const [busy, setBusy] = useState(false)
  const load = () => api<{ items: CerthubDnsProviderView[] }>('/dns-providers').then((data) => setItems(data.items)).catch(toastError)
  useEffect(() => { void load() }, [])
  const create = async () => {
    setBusy(true)
    try {
      await api('/dns-providers', { method: 'POST', body: { kind, label: form.label, zoneId: form.zoneId || '', zoneName: form.zoneName || '', accountEmail: form.email || '', secret: form.token || '' } })
      setForm({ label: '', zoneId: '', zoneName: '', email: '', token: '' })
      load()
    } catch (reason) { toastError(reason) } finally { setBusy(false) }
  }
  const remove = async (provider: CerthubDnsProviderView) => {
    const value = await prompt({ title: t('development.certhub.dns.delete'), description: t('development.certhub.dns.confirm'), placeholder: provider.label, confirmLabel: t('common.delete') })
    if (value !== provider.label) return
    try { await api(`/dns-providers/${provider.id}`, { method: 'DELETE', body: { confirm: value } }); load() } catch (reason) { toastError(reason) }
  }
  const test = async (id: string) => { try { await api(`/dns-providers/${id}/test`, { method: 'POST' }); load() } catch (reason) { toastError(reason) } }
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[1fr_1fr]')}>
      <Panel title={t('development.certhub.dns.title')}>
        {items.length === 0 ? <Empty art="starred" title={t('development.certhub.dns.empty')} compact /> : (
          <div className="space-y-2">
            {items.map((provider) => (
              <div key={provider.id} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{provider.label}</span><Badge tone={provider.configured ? 'success' : 'warning'}>{provider.kind}</Badge></div>
                <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{provider.zoneName || provider.zoneId || '-'}</div>
                <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => test(provider.id)}>{t('development.certhub.dns.test')}</Button><Button size="sm" variant="danger" onClick={() => remove(provider)} icon={<Trash2 size={14} />}>{t('development.certhub.dns.delete')}</Button></div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <Panel title={t('development.certhub.dns.add')}>
        <div className="space-y-2">
          <Field label={t('development.certhub.dns.kind')}><SelectMenu label={t('development.certhub.dns.kind')} value={kind} options={[{ value: 'cloudflare', label: t('development.certhub.dns.cloudflare') }, { value: 'dcv-delegate', label: t('development.certhub.dns.dcv') }]} onChange={setKind} /></Field>
          <Field label={t('development.certhub.dns.label')}><Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></Field>
          {kind === 'cloudflare' ? <>
            <Field label={t('development.certhub.dns.zone_id')}><Input value={form.zoneId} onChange={(event) => setForm({ ...form, zoneId: event.target.value })} /></Field>
            <Field label={t('development.certhub.dns.zone_name')}><Input value={form.zoneName} onChange={(event) => setForm({ ...form, zoneName: event.target.value })} /></Field>
            <Field label={t('development.certhub.dns.email')}><Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
            <Field label={t('development.certhub.dns.token')}><Textarea value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} rows={3} /></Field>
          </> : null}
          <Button variant="primary" onClick={create} loading={busy}>{t('development.certhub.dns.add')}</Button>
        </div>
      </Panel>
    </div>
  )
}

function SettingsPage({ compact }: { compact: boolean }) {
  const [settings, setSettings] = useState<CerthubSettingsView | null>(null)
  const [tokens, setTokens] = useState<CerthubTokenView[]>([])
  const [tokenName, setTokenName] = useState('')
  const [revealed, setRevealed] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => {
    api<{ settings: CerthubSettingsView }>('/settings').then((data) => setSettings(data.settings)).catch(toastError)
    api<{ items: CerthubTokenView[] }>('/tokens').then((data) => setTokens(data.items)).catch(toastError)
  }
  useEffect(load, [])
  const save = async () => {
    if (!settings) return
    setBusy(true)
    try { await api('/settings', { method: 'PUT', body: settings }); load() } catch (reason) { toastError(reason) } finally { setBusy(false) }
  }
  const createToken = async () => {
    if (!tokenName.trim()) return
    try {
      const result = await api<{ token: string; item: CerthubTokenView }>('/tokens', { method: 'POST', body: { name: tokenName.trim() } })
      setRevealed(result.token)
      setTokenName('')
      load()
    } catch (reason) { toastError(reason) }
  }
  const revoke = async (id: string) => { if (await confirm({ title: t('development.certhub.settings.token_revoke'), tone: 'danger' })) { await api(`/tokens/${id}`, { method: 'DELETE' }).then(load).catch(toastError) } }
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[1.4fr_1fr]')}>
      <Panel title={t('development.certhub.settings.title')} actions={<Button onClick={save} loading={busy}>{t('development.certhub.settings.save')}</Button>}>
        {!settings ? <Skeleton className="h-40" /> : (
          <div className="space-y-3">
            <Field label={t('development.certhub.settings.default_ca')}><SelectMenu label={t('development.certhub.settings.default_ca')} value={settings.defaultCa} options={CA_OPTIONS.filter((option) => !option.disabled)} onChange={(value) => setSettings({ ...settings, defaultCa: value })} /></Field>
            <Field label={t('development.certhub.settings.default_algorithm')}><SelectMenu label={t('development.certhub.settings.default_algorithm')} value={settings.defaultKeyAlgorithm} options={ALGORITHM_OPTIONS} onChange={(value) => setSettings({ ...settings, defaultKeyAlgorithm: value })} /></Field>
            <Field label={t('development.certhub.settings.renew_days')}><Input type="number" min={7} max={60} value={settings.renewDaysBefore} onChange={(event) => setSettings({ ...settings, renewDaysBefore: Number(event.target.value) })} /></Field>
            <Toggle label={t('development.certhub.settings.auto_renew')} checked={settings.defaultAutoRenew} onChange={(value) => setSettings({ ...settings, defaultAutoRenew: value })} />
            <Toggle label={t('development.certhub.settings.require_reauth')} checked={settings.requireReauthForKeys} onChange={(value) => setSettings({ ...settings, requireReauthForKeys: value })} />
            <SectionLabel>{t('development.certhub.settings.notifications')}</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {([['notifyOnIssued', 'notify_issued'], ['notifyOnFailed', 'notify_failed'], ['notifyOnExpiring', 'notify_expiring'], ['notifyOnExpired', 'notify_expired']] as const).map(([key, label]) => (
                <Toggle key={key} label={t(`development.certhub.settings.${label}` as never)} checked={settings[key]} onChange={(value) => setSettings({ ...settings, [key]: value })} />
              ))}
            </div>
          </div>
        )}
      </Panel>
      <Panel title={t('development.certhub.settings.tokens')}>
        <div className="mb-2 flex gap-2"><Input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder={t('development.certhub.settings.token_name')} /><Button onClick={createToken}>{t('development.certhub.settings.token_create')}</Button></div>
        {revealed ? <div className="mb-2 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2 text-[length:var(--text-11-5)] text-[var(--accent-on-soft)]"><div>{t('development.certhub.settings.token_reveal')}</div><code className="break-all">{revealed}</code><CopyButton text={revealed} label={t('common.copy')} /></div> : null}
        {tokens.length ? tokens.map((token) => (
          <div key={token.id} className="flex items-center justify-between gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)]">
            <span className="min-w-0 truncate">{token.name} · {token.prefix}…</span>
            <Button size="sm" variant="ghost" onClick={() => revoke(token.id)}>{t('development.certhub.settings.token_revoke')}</Button>
          </div>
        )) : <Empty art="starred" title={t('development.certhub.dns.empty')} compact />}
      </Panel>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-2 text-[length:var(--text-12)]"><span>{label}</span><Switch checked={checked} onChange={onChange} label={label} /></div>
}

function ApiPage() {
  return (
    <Panel title={t('development.certhub.api.title')} subtitle={t('development.certhub.api.subtitle')}>
      <div className="space-y-2 text-[length:var(--text-12)]">
        {[
          ['POST', '/v1/orders', 'issue'],
          ['GET', '/v1/orders', 'read'],
          ['GET', '/v1/orders/:id', 'read'],
          ['GET', '/v1/orders/:id/download?kind=key', 'read-key'],
          ['POST', '/v1/orders/:id/revoke', 'revoke'],
        ].map(([method, path, scope]) => (
          <div key={path + method} className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2">
            <Badge tone={method === 'POST' ? 'accent' : 'neutral'}>{method}</Badge>
            <code className="break-all">{BASE}${path}</code>
            <Badge tone="warning">{scope}</Badge>
            <CopyButton text={`${BASE}${path}`} label={t('common.copy')} />
          </div>
        ))}
        <pre className="overflow-x-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 text-[length:var(--text-11-5)]">{'curl -H "Authorization: Bearer crt_..." ' + BASE + '/v1/orders'}</pre>
      </div>
    </Panel>
  )
}

function AdminPage() {
  const [overview, setOverview] = useState<{ counts: Array<{ status: string; c: number }>; failures24h: number; queue: CerthubConfigView } | null>(null)
  const [orders, setOrders] = useState<Array<{ id: string; user_id: string; status: string; ca: string; updated_at: number }>>([])
  const [config, setConfig] = useState<CerthubConfigView | null>(null)
  const load = () => {
    api<{ counts: Array<{ status: string; c: number }>; failures24h: number; queue: CerthubConfigView }>('/admin/overview').then(setOverview).catch(toastError)
    api<{ items: Array<{ id: string; user_id: string; status: string; ca: string; updated_at: number }> }>('/admin/orders').then((data) => setOrders(data.items)).catch(toastError)
    api<{ config: CerthubConfigView }>('/admin/config').then((data) => setConfig(data.config)).catch(toastError)
  }
  useEffect(load, [])
  return (
    <div className="grid gap-3">
      <Panel title={t('development.certhub.admin.title')} actions={<Button size="sm" onClick={load}>{t('common.retry')}</Button>}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 text-[length:var(--text-12)]">
          {(overview?.counts ?? []).map((row) => <Info key={row.status} label={row.status} value={String(row.c)} />)}
          <Info label={t('development.certhub.admin.failed')} value={String(overview?.failures24h ?? 0)} />
        </div>
      </Panel>
      <Panel title={t('development.certhub.admin.orders')}>
        <div className="space-y-1 text-[length:var(--text-11-5)]">
          {orders.map((order) => <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2"><span className="min-w-0 truncate">{order.id} · {order.user_id}</span><StatusBadge status={order.status} /></div>)}
        </div>
      </Panel>
      {config ? (
        <Panel title={t('development.certhub.admin.config')}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 text-[length:var(--text-12)]">
            <Info label={t('development.certhub.admin.enabled_cas')} value={config.enabledCas.join(', ')} />
            <Info label={t('development.certhub.admin.daily')} value={String(config.maxOrdersPerDay)} />
            <Info label={t('development.certhub.admin.monthly')} value={String(config.maxOrdersPerMonth)} />
            <Info label={t('development.certhub.admin.queue')} value={String(config.jobBatchSize)} />
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
