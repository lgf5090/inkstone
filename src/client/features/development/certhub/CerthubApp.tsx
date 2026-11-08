import { useEffect, useMemo, useRef, useState } from 'react'
import { BadgeCheck, CalendarClock, CircleAlert, CircleCheck, CircleHelp, Clock3, Download, FileKey2, History, Plus, RefreshCw, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import { request } from '../../../lib/api'
import { navigateToPath, replaceAddress, usePathname, useSearch } from '../../../lib/app-history'
import { orderSortFromSearch } from '../../../../shared/development/certhub/sorting'
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
import { applyChallengeOptions, applyDomainErrorKey, dnsConnectionErrorKeys, dnsLabelErrorKey } from './rules'
import { eventLabel, eventStyle, eventToneText } from './events'
import { HelpButton } from './help'
import { relativeTime } from '../../../lib/time'
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
  CerthubQuotaView,
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
  pending: 'neutral',
  prepared: 'warning',
  valid: 'success',
  invalid: 'danger',
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

export function viewForPath(pathname: string): { view: ModuleView; id: string } {
  const rest = pathname.replace(/^\/development\/certhub/, '')
  if (!rest || rest === '/') return { view: 'overview', id: '' }
  if (rest.startsWith('/certificates/')) return { view: 'detail', id: rest.slice('/certificates/'.length) }
  if (rest.startsWith('/certificates')) return { view: 'certificates', id: '' }
  if (rest.startsWith('/new') || rest.startsWith('/apply')) return { view: 'apply', id: '' }
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
        <div className="flex items-center gap-1.5">
          <HelpButton topic={view === 'detail' ? 'certificates' : view} />
          <Button size="sm" icon={<Plus size={14} />} onClick={() => navigateToPath('/development/certhub/new')}>
            {t('development.certhub.cert.new')}
          </Button>
        </div>
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
  const quota = data?.quota
  const certUsage = quotaRatio(quota?.activeCerts, quota?.maxActiveCerts)
  const dailyUsage = quotaRatio(quota?.dailyUsed, quota?.dailyLimit)
  return (
    <div className="space-y-3">
      <IntroCard />
      <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]')}>
      <div className="min-w-0 space-y-3">
        <Panel title={t('development.certhub.overview.title')} subtitle={t('development.certhub.overview.subtitle')}>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {OVERVIEW_CARDS.map(({ status, icon: Icon, tone }) => (
              <div key={status} className="min-w-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
                <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  <Icon size={13} aria-hidden="true" className={cn('shrink-0', tone)} />
                  <span className="truncate">{t(statusKey(status) as never)}</span>
                </div>
                <div className={cn('mt-1 text-[length:var(--text-20)] font-semibold tabular', tone)}>{counts[status] ?? 0}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2">
            <span className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
              <CalendarClock size={13} aria-hidden="true" className={counts.expiringSoon ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]'} />
              {t('development.certhub.overview.expiring')}
            </span>
            <span className={cn('text-[length:var(--text-13)] font-semibold tabular', counts.expiringSoon ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]')}>{counts.expiringSoon ?? 0}</span>
          </div>
          <div className="mt-2 space-y-1.5 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2 text-[length:var(--text-11-5)]">
            <QuotaLine label={t('development.certhub.overview.quota_certs')} used={quota?.activeCerts ?? 0} limit={quota?.maxActiveCerts ?? 0} ratio={certUsage} />
            <QuotaLine label={t('development.certhub.overview.quota_daily')} used={quota?.dailyUsed ?? 0} limit={quota?.dailyLimit ?? 0} ratio={dailyUsage} />
          </div>
        </Panel>
        <Panel title={t('development.certhub.overview.recent_orders')}>
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
            <Empty art="notes" title={t('development.certhub.overview.empty')} description={t('development.certhub.overview.empty_hint')} action={<Button icon={<Plus size={14} />} onClick={() => navigateToPath('/development/certhub/new')}>{t('development.certhub.cert.new')}</Button>} />
          )}
        </Panel>
      </div>
      <div className="min-w-0">
        <Panel title={t('development.certhub.overview.recent')}>
          {data?.recentEvents.length ? <EventList events={data.recentEvents} /> : <Empty art="search" title={t('development.certhub.detail.no_events')} compact />}
        </Panel>
      </div>
      </div>
    </div>
  )
}

const INTRO_DISMISSED_KEY = 'certhub.intro.dismissed'

function IntroCard() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(INTRO_DISMISSED_KEY) === '1' } catch { return false }
  })
  if (dismissed) return null
  const dismiss = () => {
    try { localStorage.setItem(INTRO_DISMISSED_KEY, '1') } catch {}
    setDismissed(true)
  }
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 md:p-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <CircleHelp size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0">
          <p className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('development.certhub.intro.title')}</p>
          <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{t('development.certhub.intro.body')}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={() => navigateToPath('/development/certhub/new')}>{t('development.certhub.intro.start')}</Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>{t('development.certhub.intro.skip')}</Button>
      </div>
    </div>
  )
}

const OVERVIEW_CARDS: Array<{ status: CerthubOrderStatus; icon: LucideIcon; tone: string }> = [
  { status: 'issued', icon: CircleCheck, tone: 'text-[var(--success)]' },
  { status: 'awaiting_dns', icon: Clock3, tone: 'text-[var(--warning)]' },
  { status: 'failed', icon: CircleAlert, tone: 'text-[var(--danger)]' },
  { status: 'expired', icon: History, tone: 'text-[var(--warning)]' },
]

function quotaRatio(used = 0, limit = 0): number {
  return limit > 0 ? used / limit : 0
}

function QuotaLine({ label, used, limit, ratio }: { label: string; used: number; limit: number; ratio: number }) {
  const tone = ratio >= 1 ? 'text-[var(--danger)]' : ratio >= 0.8 ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]'
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--text-tertiary)]">{label}</span>
      <span className={cn('font-medium tabular', tone)}>{t('development.certhub.overview.quota_value', { used, limit })}</span>
    </div>
  )
}

function CertificatesPage({ compact }: { compact: boolean }) {
  const search = useSearch()
  const sort = orderSortFromSearch(search)
  const [items, setItems] = useState<CerthubOrderSummary[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const load = (cursor?: string) => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '30', sort })
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
  useEffect(() => { load() }, [status, sort])
  const statusOptions = useMemo(() => [
    { value: '', label: t('development.certhub.cert.all') },
    ...(['issued', 'awaiting_dns', 'awaiting_http', 'validating', 'failed', 'expired', 'revoked', 'canceled'] as CerthubOrderStatus[]).map((value) => ({ value, label: t(statusKey(value) as never) })),
  ], [])
  const sortOptions = useMemo(() => ([
    { value: 'updated', label: t('development.certhub.cert.sort.updated') },
    { value: 'expires', label: t('development.certhub.cert.sort.expires') },
    { value: 'name', label: t('development.certhub.cert.sort.name') },
  ]), [])
  return (
    <Panel title={t('development.certhub.cert.title')} subtitle={t('development.certhub.cert.subtitle')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('development.certhub.cert.search')} className="min-w-[200px] flex-1" />
        <Button onClick={() => load()} icon={<RefreshCw size={14} />}>{t('common.retry')}</Button>
        <SelectMenu label={t('development.certhub.cert.filter')} value={status} options={statusOptions} onChange={setStatus} size="sm" width={200} />
        <SelectMenu label={t('development.certhub.cert.sort')} value={sort} options={sortOptions} onChange={(value) => replaceAddress('/development/certhub/certificates', `sort=${value}`)} size="sm" width={200} />
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
          <Button size="sm" variant="ghost" onClick={load} icon={<RefreshCw size={14} />}>{t('development.certhub.detail.refresh')}</Button>
          {['queued', 'creating_order', 'awaiting_dns', 'awaiting_http', 'validating', 'ready', 'finalizing'].includes(order.status) ? <Button size="sm" variant="ghost" onClick={() => runAction('regenerate')}>{t('development.certhub.detail.regenerate')}</Button> : null}
          {['queued', 'creating_order', 'awaiting_dns', 'awaiting_http', 'validating', 'ready', 'finalizing'].includes(order.status) ? <Button size="sm" variant="ghost" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_cancel'), order.id)) runAction('cancel') }}>{t('development.certhub.detail.cancel')}</Button> : null}
          <CopyButton text={order.id} label={t('development.certhub.detail.copy_id')} />
          {order.status === 'issued' || order.status === 'expired' ? <Button size="sm" onClick={() => runAction('renew')}>{t('development.certhub.detail.renew')}</Button> : null}
          {order.status === 'issued' || order.status === 'expired' ? <Button size="sm" variant="danger" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_revoke'), order.id)) runAction('revoke') }}>{t('development.certhub.detail.revoke')}</Button> : null}
          {order.hasPrivateKey ? <Button size="sm" variant="ghost" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_purge'), order.id)) runAction('purge_key') }}>{t('development.certhub.detail.purge')}</Button> : null}
          {['failed', 'canceled', 'revoked', 'expired'].includes(order.status) ? <Button size="sm" variant="ghost" onClick={async () => { if (await typedConfirm(t('development.certhub.detail.confirm_delete'), order.id)) runAction('delete', { confirm: order.id }) }}>{t('development.certhub.detail.delete')}</Button> : null}
        </div>
        {order.status === 'failed' ? (
          <div className="mb-3 rounded-[var(--r-md)] border border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] p-3">
            <div className="flex items-center gap-1.5 text-[var(--danger)]">
              <CircleAlert size={14} aria-hidden="true" />
              <span className="text-[length:var(--text-12-5)] font-medium">{t('development.certhub.failure.title')}</span>
            </div>
            {order.failureMessage ? <p className="mt-1 break-words text-[length:var(--text-12)] text-[var(--text-secondary)]">{order.failureMessage}</p> : null}
            <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">{failureHint(order.failureCode)}</p>
            <div className="mt-2"><Button size="sm" onClick={() => navigateToPath('/development/certhub/new')}>{t('development.certhub.failure.retry')}</Button></div>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 text-[length:var(--text-12)]">
          <Info label={t('development.certhub.apply.ca')} value={order.ca} />
          <Info label={t('development.certhub.apply.algorithm')} value={order.keyAlgorithm} />
          <Info label={t('development.certhub.cert.issued')} value={formatDate(order.issuedAt)} />
          <Info label={t('development.certhub.cert.expires')} value={formatDate(order.certNotAfter)} />
          <Info label={t('development.certhub.accounts.fingerprint')} value={order.keyFingerprint || '-'} />
          <Info label={t('development.certhub.detail.progress')} value={t('development.certhub.detail.domain_count').replace('{count}', String(order.domains.length))} />
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
        {events.length ? <EventList events={events} subject={order.primaryDomain} /> : <Empty art="search" title={t('development.certhub.detail.no_events')} compact />}
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

export function EventList({ events, subject }: { events: CerthubEventView[]; subject?: string }) {
  return (
    <ol className="space-y-1.5">
      {events.map((event) => {
        const style = eventStyle(event.kind)
        const Icon = style.icon
        const name = eventSubject(event, subject)
        return (
          <li key={event.id} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)]">
            <div className="flex items-center gap-2">
              <Icon size={13} aria-hidden="true" className={cn('shrink-0', eventToneText(style.tone))} />
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-secondary)]">{eventLabel(event.kind)}</span>
              <time dateTime={new Date(event.createdAt).toISOString()} title={formatDate(event.createdAt)} className="shrink-0 text-[var(--text-quaternary)]">{relativeTime(event.createdAt)}</time>
            </div>
            {name ? <div className="mt-0.5 truncate pl-[21px] text-[var(--text-tertiary)]">{name}</div> : null}
          </li>
        )
      })}
    </ol>
  )
}

function eventSubject(event: CerthubEventView, fallback?: string): string {
  const detail = event.detail ?? {}
  const candidate = [detail['name'], detail['domain'], detail['fqdn'], fallback]
    .find((value) => typeof value === 'string' && value.trim())
  if (typeof candidate !== 'string') return ''
  const value = candidate.trim()
  // An event row can outlive the order it describes; a raw identifier is worse than nothing.
  return value === event.orderId || value === event.id ? '' : value
}

function failureHint(code: string | null): string {
  const key = `development.certhub.failure.${code ?? 'unknown'}`
  const text = t(key as never)
  return text === key ? t('development.certhub.failure.unknown' as never) : text
}

interface DomainForm { id: string; name: string; wildcard: boolean; primary: boolean; challengeMode: 'dns-01' | 'http-01'; dnsProviderId: string }

/**
 * One domain line of the request form. The label lives on the `Checkbox` itself: an earlier version
 * wrapped the control in a `<label>` that also printed the same string, so every checkbox read twice.
 */
export function ApplyDomainRow({ row, providers, onChange, onPrimary, onRemove }: {
  row: DomainForm
  providers: CerthubDnsProviderView[]
  onChange: (patch: Partial<DomainForm>) => void
  onPrimary: (next: boolean) => void
  onRemove?: () => void
}) {
  return (
    <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-2">
      <div className="flex items-center gap-2">
        <Input value={row.name} onChange={(event) => onChange({ name: event.target.value })} placeholder={t('development.certhub.apply.domain_placeholder')} aria-label={t('development.certhub.cert.domain')} />
        {onRemove ? <Button size="sm" variant="ghost" aria-label={t('development.certhub.apply.remove_domain')} onClick={onRemove} icon={<Trash2 size={14} />} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={row.wildcard} onChange={(next) => onChange({ wildcard: next, ...(next ? { challengeMode: 'dns-01' as const } : {}) })} label={t('development.certhub.apply.wildcard')} />
        <Checkbox checked={row.primary} onChange={onPrimary} label={t('development.certhub.apply.primary')} />
        <SelectMenu label={t('development.certhub.apply.challenge')} value={row.challengeMode} options={applyChallengeOptions(row.wildcard).map((option) => ({ value: option.value, label: t(option.labelKey as never), disabled: option.disabled }))} onChange={(value) => onChange({ challengeMode: value })} size="sm" width={200} />
        {row.challengeMode === 'dns-01' ? <SelectMenu label={t('development.certhub.apply.provider')} value={row.dnsProviderId} options={[{ value: '', label: t('development.certhub.apply.provider_none') }, ...providers.map((provider) => ({ value: provider.id, label: provider.label }))]} onChange={(value) => onChange({ dnsProviderId: value })} size="sm" width={200} /> : null}
      </div>
      {row.wildcard ? <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('development.certhub.apply.wildcard_dns_only')}</p> : null}
    </div>
  )
}

function ApplyPage({ compact }: { compact: boolean }) {
  const [domains, setDomains] = useState<DomainForm[]>([{ id: crypto.randomUUID(), name: '', wildcard: false, primary: true, challengeMode: 'dns-01', dnsProviderId: '' }])
  const [ca, setCa] = useState<CerthubCa>('lets-encrypt')
  const [algorithm, setAlgorithm] = useState<CerthubKeyAlgorithm>('eccp256')
  const [autoRenew, setAutoRenew] = useState(true)
  const [providers, setProviders] = useState<CerthubDnsProviderView[]>([])
  const [subject, setSubject] = useState({ country: '', state: '', locality: '', organization: '', organizationUnit: '' })
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [quota, setQuota] = useState<CerthubQuotaView | null>(null)
  const [captcha, setCaptcha] = useState({ enabled: false, siteKey: '' })
  const [captchaToken, setCaptchaToken] = useState('')
  const captchaRef = useRef<HTMLDivElement>(null)
  useEffect(() => { api<{ items: CerthubDnsProviderView[] }>('/dns-providers').then((data) => setProviders(data.items)).catch(() => setProviders([])) }, [])
  useEffect(() => { api<CerthubOverview>('/overview').then((data) => setQuota(data.quota)).catch(() => setQuota(null)) }, [])
  const quotaReached = Boolean(quota && ((quota.maxActiveCerts > 0 && quota.activeCerts >= quota.maxActiveCerts) || (quota.dailyLimit > 0 && quota.dailyUsed >= quota.dailyLimit)))
  useEffect(() => {
    api<{ captcha: { enabled: boolean; siteKey: string } }>('/health')
      .then((data) => setCaptcha(data.captcha))
      .catch(() => setCaptcha({ enabled: false, siteKey: '' }))
  }, [])
  useEffect(() => {
    if (!captcha.enabled || !captcha.siteKey || !captchaRef.current) return
    const scope = window as unknown as { turnstile?: { render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void } }
    let widgetId = ''
    const render = () => {
      if (!scope.turnstile || !captchaRef.current) return
      widgetId = scope.turnstile.render(captchaRef.current, { sitekey: captcha.siteKey, callback: (token: string) => setCaptchaToken(token) })
    }
    if (scope.turnstile) render()
    else {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.onload = render
      document.head.appendChild(script)
    }
    return () => {
      if (widgetId && scope.turnstile) scope.turnstile.remove(widgetId)
    }
  }, [captcha.enabled, captcha.siteKey])
  const update = (id: string, patch: Partial<DomainForm>) => setDomains((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row))
  const submit = async () => {
    // Reject a bad domain here rather than travelling to the server for the same answer: the server still
    // validates (a crafted request must not get past it), this is only the first gate.
    const rows = domains.filter((row) => row.name.trim())
    const errorKey = applyDomainErrorKey(rows)
    if (errorKey) {
      setFormError(errorKey)
      return
    }
    setFormError(null)
    if (quotaReached) {
      setFormError('development.certhub.apply.quota_reached')
      return
    }
    if (captcha.enabled && !captchaToken) {
      toastError(new Error(t('development.certhub.apply.captcha_hint')))
      return
    }
    setBusy(true)
    try {
      const result = await api<{ order: CerthubOrderView }>('/orders', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: {
          domains: rows.map((row) => ({ name: row.name, wildcard: row.wildcard, primary: row.primary, challengeMode: row.challengeMode, dnsProviderId: row.dnsProviderId || undefined })),
          ca,
          keyAlgorithm: algorithm,
          autoRenew,
          captchaToken: captcha.enabled ? captchaToken : undefined,
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
      <div className={cn('grid grid-cols-1 gap-3', !compact && 'xl:grid-cols-2')}>
        <div className="min-w-0 space-y-3">
          <SectionLabel>{t('development.certhub.apply.step_domains')}</SectionLabel>
          {domains.map((row) => (
            <ApplyDomainRow
              key={row.id}
              row={row}
              providers={providers}
              onChange={(patch) => update(row.id, patch)}
              onPrimary={(next) => setDomains((current) => current.map((entry) => ({ ...entry, primary: entry.id === row.id ? next : false })))}
              {...(domains.length > 1 ? { onRemove: () => setDomains((current) => current.filter((entry) => entry.id !== row.id)) } : {})}
            />
          ))}
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setDomains((current) => [...current, { id: crypto.randomUUID(), name: '', wildcard: false, primary: false, challengeMode: 'dns-01', dnsProviderId: '' }])}>{t('development.certhub.apply.add_domain')}</Button>
          {formError ? <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t(formError as never)}</p> : null}
        </div>
        <div className="min-w-0 space-y-3">
          <SectionLabel>{t('development.certhub.apply.step_settings')}</SectionLabel>
          <Field label={t('development.certhub.apply.ca')} hint={t('development.certhub.apply.ca_hint')}><SelectMenu label={t('development.certhub.apply.ca')} value={ca} options={CA_OPTIONS.filter((option) => !option.disabled)} onChange={setCa} /></Field>
          <Field label={t('development.certhub.apply.algorithm')} hint={t('development.certhub.apply.algorithm_hint')}><SelectMenu label={t('development.certhub.apply.algorithm')} value={algorithm} options={ALGORITHM_OPTIONS} onChange={setAlgorithm} /></Field>
          <div className="flex items-center justify-between gap-2"><span className="text-[length:var(--text-12)]">{t('development.certhub.apply.auto_renew')}</span><Switch checked={autoRenew} onChange={setAutoRenew} label={t('development.certhub.apply.auto_renew')} /></div>
          <SectionLabel>{t('development.certhub.apply.subject')}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <Input value={subject.country} onChange={(event) => setSubject({ ...subject, country: event.target.value })} aria-label={t('development.certhub.apply.subject_country')} placeholder={t('development.certhub.apply.subject_country')} maxLength={2} />
            <Input value={subject.state} onChange={(event) => setSubject({ ...subject, state: event.target.value })} aria-label={t('development.certhub.apply.subject_state')} placeholder={t('development.certhub.apply.subject_state')} />
            <Input value={subject.locality} onChange={(event) => setSubject({ ...subject, locality: event.target.value })} aria-label={t('development.certhub.apply.subject_locality')} placeholder={t('development.certhub.apply.subject_locality')} />
            <Input value={subject.organization} onChange={(event) => setSubject({ ...subject, organization: event.target.value })} aria-label={t('development.certhub.apply.subject_organization')} placeholder={t('development.certhub.apply.subject_organization')} />
            <Input value={subject.organizationUnit} onChange={(event) => setSubject({ ...subject, organizationUnit: event.target.value })} aria-label={t('development.certhub.apply.subject_organization_unit')} placeholder={t('development.certhub.apply.subject_organization_unit')} />
          </div>
          {quota ? <p className={cn('text-[length:var(--text-11-5)]', quotaReached ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]')}>{t('development.certhub.apply.quota_line', { certsUsed: quota.activeCerts, certsLimit: quota.maxActiveCerts, dailyUsed: quota.dailyUsed, dailyLimit: quota.dailyLimit })}</p> : null}
          {captcha.enabled ? <div ref={captchaRef} className="min-h-[65px]" /> : null}
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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const load = () => api<{ items: CerthubDnsProviderView[] }>('/dns-providers').then((data) => setItems(data.items)).catch(toastError)
  useEffect(() => { void load() }, [])
  const connectionErrors = (): Record<string, string> => {
    const next = dnsConnectionErrorKeys(kind, form.zoneId, form.token) as Record<string, string>
    for (const [field, key] of Object.entries(next)) next[field] = t(key as never)
    return next
  }
  const create = async () => {
    const next: Record<string, string> = { ...connectionErrors() }
    const labelKey = dnsLabelErrorKey(form.label)
    if (labelKey) next.label = t(labelKey as never)
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setBusy(true)
    try {
      await api('/dns-providers', { method: 'POST', body: { kind, label: form.label, zoneId: form.zoneId || '', zoneName: form.zoneName || '', accountEmail: form.email || '', secret: form.token || '' } })
      setForm({ label: '', zoneId: '', zoneName: '', email: '', token: '' })
      load()
    } catch (reason) { toastError(reason) } finally { setBusy(false) }
  }
  const testForm = async () => {
    const next = connectionErrors()
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setTesting(true)
    try {
      const result = await api<{ ok: boolean; degraded?: boolean }>('/dns-providers/test', {
        method: 'POST',
        body: { kind, label: form.label || 'test', zoneId: form.zoneId || '', zoneName: form.zoneName || '', accountEmail: form.email || '', secret: form.token || '' },
      })
      useUi.getState().toast({
        title: result.degraded ? t('development.certhub.dns.test_degraded') : t('development.certhub.dns.test_ok'),
        tone: result.degraded ? 'warning' : 'success',
      })
    } catch (reason) { toastError(reason) } finally { setTesting(false) }
  }
  const remove = async (provider: CerthubDnsProviderView) => {
    const value = await prompt({ title: t('development.certhub.dns.delete'), description: t('development.certhub.dns.confirm'), placeholder: provider.label, confirmLabel: t('common.delete') })
    if (value !== provider.label) return
    try { await api(`/dns-providers/${provider.id}`, { method: 'DELETE', body: { confirm: value } }); load() } catch (reason) { toastError(reason) }
  }
  const test = async (id: string) => { try { await api(`/dns-providers/${id}/test`, { method: 'POST' }); load() } catch (reason) { toastError(reason) } }
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
      <Panel title={t('development.certhub.dns.title')}>
        {items.length === 0 ? <Empty art="starred" title={t('development.certhub.dns.empty')} description={t('development.certhub.dns.empty_hint')} compact /> : (
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
          <Field label={t('development.certhub.dns.kind')}><SelectMenu label={t('development.certhub.dns.kind')} value={kind} options={[{ value: 'cloudflare', label: t('development.certhub.dns.cloudflare') }, { value: 'dcv-delegate', label: t('development.certhub.dns.dcv') }]} onChange={(value) => { setKind(value); setErrors({}) }} /></Field>
          <FormField error={errors.label} label={t('development.certhub.dns.label')}><Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></FormField>
          {kind === 'cloudflare' ? <>
            <FormField error={errors.zoneId} label={t('development.certhub.dns.zone_id')} hint={t('development.certhub.dns.zone_id_hint')}><Input value={form.zoneId} onChange={(event) => setForm({ ...form, zoneId: event.target.value })} /></FormField>
            <FormField label={t('development.certhub.dns.zone_name')}><Input value={form.zoneName} onChange={(event) => setForm({ ...form, zoneName: event.target.value })} /></FormField>
            <FormField label={t('development.certhub.dns.email')}><Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></FormField>
            <FormField error={errors.token} label={t('development.certhub.dns.token')} hint={t('development.certhub.dns.token_hint')}><Textarea value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} rows={3} /></FormField>
            {!form.token.trim() ? <p className="text-[length:var(--text-11-5)] text-[var(--warning)]">{t('development.certhub.dns.manual_only')}</p> : null}
          </> : <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('development.certhub.dns.dcv_hint')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={testForm} loading={testing} icon={<RefreshCw size={14} />}>{t('development.certhub.dns.test_connection')}</Button>
            <Button variant="primary" onClick={create} loading={busy}>{t('development.certhub.dns.add')}</Button>
          </div>
        </div>
      </Panel>
    </div>
  )
}

function FormField({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Field label={label} hint={hint}>{children}</Field>
      {error ? <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p> : null}
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
  const rotateToken = async (id: string) => {
    try {
      const result = await api<{ token: string }>(`/tokens/${id}/rotate`, { method: 'POST' })
      setRevealed(result.token)
      load()
    } catch (reason) { toastError(reason) }
  }
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
        {tokens.length ? (
          <div className="space-y-2">
            {tokens.map((token) => <TokenRow key={token.id} token={token} onRevoke={revoke} onRotate={rotateToken} />)}
          </div>
        ) : <Empty art="starred" title={t('development.certhub.settings.tokens_empty')} compact />}
      </Panel>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-2 text-[length:var(--text-12)]"><span>{label}</span><Switch checked={checked} onChange={onChange} label={label} /></div>
}

export function TokenRow({ token, onRevoke, onRotate }: { token: CerthubTokenView; onRevoke: (id: string) => void; onRotate?: (id: string) => void }) {
  const revoked = token.revokedAt !== null
  return (
    <div className={cn('rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2 text-[length:var(--text-11-5)]', revoked && 'opacity-60')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('min-w-0 truncate', revoked ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]')}>{token.name} · {token.prefix}…</span>
        {revoked
          ? <span className="shrink-0 text-[var(--text-quaternary)]">{t('development.certhub.settings.token_revoked_at', { time: formatDate(token.revokedAt) })}</span>
          : (
            <div className="flex shrink-0 items-center gap-1">
              {onRotate ? <Button size="sm" variant="ghost" onClick={() => onRotate(token.id)}>{t('development.certhub.settings.token_rotate')}</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => onRevoke(token.id)}>{t('development.certhub.settings.token_revoke')}</Button>
            </div>
          )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {token.scopes.map((scope) => (
          <span key={scope} className="rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[var(--text-quaternary)]">{t(`development.certhub.scope.${scope.replace('-', '_')}` as never)}</span>
        ))}
        {token.expiresAt ? <span className="text-[var(--text-quaternary)]">· {t('development.certhub.settings.token_expires', { time: formatDate(token.expiresAt) })}</span> : null}
      </div>
    </div>
  )
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
