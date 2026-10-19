/**
 * The subscription app: the frame the rail, the list, the dashboard and the detail panel share.
 *
 * It owns nothing but the wiring — every rule lives in the store or in a component — and it owns the
 * responsive decision the other containers make too: three panes when there is room, one pane and a
 * drawer when there is not. Loading is on mount rather than at boot, so a reader who never opens this
 * tab does not pay for a library they will not look at.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { CircleHelp, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Wallet } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { Drawer, Modal, Tooltip, confirm } from '../../components/overlay'
import { Input } from '../../components/form'
import { formatAmount } from '@shared/subscriptions/format'
import { useSubscriptions } from './store'
import { countItems, visibleItems } from './list-view'
import { FilterRail } from './FilterRail'
import { SubscriptionList } from './SubscriptionList'
import { SubscriptionDetail } from './SubscriptionDetail'
import { OverviewView } from './OverviewView'
import { LogsView } from './LogsView'
import { SubscriptionForm } from './SubscriptionForm'
import { RenewDialog } from './RenewDialog'
import { PaymentDialog } from './PaymentDialog'
import { SubscriptionSettings } from './SubscriptionSettings'
import type { PaymentRecord, SubscriptionDetail as Detail, SubscriptionItem } from '@shared/subscriptions/model'

export function SubscriptionsApp(): ReactElement {
  const userId = useSession((state) => state.user?.id ?? null)
  const status = useSubscriptions((state) => state.status)
  const error = useSubscriptions((state) => state.error)
  const items = useSubscriptions((state) => state.items)
  const categories = useSubscriptions((state) => state.categories)
  const settings = useSubscriptions((state) => state.settings)
  const channels = useSubscriptions((state) => state.channels)
  const overview = useSubscriptions((state) => state.overview)
  const view = useSubscriptions((state) => state.view)
  const filter = useSubscriptions((state) => state.filter)
  const selectedId = useSubscriptions((state) => state.selectedId)
  const detail = useSubscriptions((state) => state.detail)
  const detailLoading = useSubscriptions((state) => state.detailLoading)
  const logs = useSubscriptions((state) => state.logs)
  const saving = useSubscriptions((state) => state.saving)
  const loadLogs = useSubscriptions((state) => state.loadLogs)

  const [railOpen, setRailOpen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches)
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches)
  const [panelWide, setPanelWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches)
  const [formOpen, setFormOpen] = useState(false)
  const [renewTarget, setRenewTarget] = useState<Detail | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<PaymentRecord | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [detailDrawer, setDetailDrawer] = useState(false)

  useEffect(() => {
    void useSubscriptions.getState().load()
  }, [userId])

  useEffect(() => {
    const wideQuery = window.matchMedia('(min-width: 1024px)')
    const panelQuery = window.matchMedia('(min-width: 1280px)')
    const onWide = (): void => setWide(wideQuery.matches)
    const onPanel = (): void => setPanelWide(panelQuery.matches)
    wideQuery.addEventListener('change', onWide)
    panelQuery.addEventListener('change', onPanel)
    return () => {
      wideQuery.removeEventListener('change', onWide)
      panelQuery.removeEventListener('change', onPanel)
    }
  }, [])

  const visible = useMemo(() => visibleItems(items, filter), [items, filter])
  const counts = useMemo(() => countItems(items), [items])
  const overviewCurrency = 'CNY'

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (event.key === 'n') {
        event.preventDefault()
        setFormOpen(true)
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        document.getElementById('subscriptions-search')?.focus()
        return
      }
      if (event.key === '[') {
        event.preventDefault()
        setRailOpen(open => !open)
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
        return
      }
      if (event.key === 'r' && detail) {
        event.preventDefault()
        setRenewTarget(detail)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [detail])

  const openDetail = (id: string): void => {
    void useSubscriptions.getState().select(id)
    if (!panelWide) setDetailDrawer(true)
  }

  const onDelete = async (item: SubscriptionItem): Promise<void> => {
    const ok = await confirm({
      title: t('subscriptions.delete'),
      description: t('subscriptions.delete_confirm', { name: item.name }),
      confirmLabel: t('subscriptions.delete'),
      tone: 'danger',
    })
    if (ok) await useSubscriptions.getState().remove(item.id)
  }

  const onDeletePayment = async (payment: PaymentRecord): Promise<void> => {
    if (!detail) return
    const ok = await confirm({
      title: t('subscriptions.payments.delete'),
      description: t('subscriptions.payments.delete_confirm'),
      confirmLabel: t('subscriptions.delete'),
      tone: 'danger',
    })
    if (ok) await useSubscriptions.getState().deletePayment(detail.item.id, payment.id)
  }

  const header = (
    <header data-print="hide" className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
      <IconButton label={railOpen ? t('subscriptions.rail.collapse') : t('subscriptions.rail.expand')} size="sm" onClick={() => setRailOpen(open => !open)}>
        {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
      </IconButton>
      <Wallet size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
      <h1 className="min-w-0 shrink-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{t('subscriptions.title')}</h1>
      {overview && (
        <span className="hidden shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)] sm:inline">
          {formatAmount(overview.monthly.amount, overviewCurrency)}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Input
          id="subscriptions-search"
          aria-label={t('subscriptions.search')}
          value={filter.query}
          placeholder={t('subscriptions.search')}
          leading={<Search size={13} />}
          onChange={(event) => useSubscriptions.getState().setFilter({ query: event.target.value })}
          className="h-7 w-40 text-[length:var(--text-11-5)] lg:w-52"
        />
        <Tooltip label={t('subscriptions.keys.title')} side="bottom">
          <IconButton label={t('subscriptions.keys.title')} size="sm" onClick={() => setKeysOpen(true)}><CircleHelp size={15} /></IconButton>
        </Tooltip>
        <Tooltip label={t('subscriptions.view.settings')} side="bottom">
          <IconButton label={t('subscriptions.view.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /></IconButton>
        </Tooltip>
        <Tooltip label={t('subscriptions.add')} side="bottom">
          <IconButton label={t('subscriptions.add')} size="sm" onClick={() => void useSubscriptions.getState().select(null).then(() => setFormOpen(true))}><Plus size={16} /></IconButton>
        </Tooltip>
      </div>
    </header>
  )

  if (IS_DEMO_MODE) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-subscriptions-app="">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('app.tabs.subscriptions')}</p>
            <p className="mt-1.5 text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">{t('subscriptions.demo_notice')}</p>
          </div>
        </div>
      </section>
    )
  }

  const detailPanel = (
    <SubscriptionDetail
      detail={detail}
      loading={detailLoading}
      onClose={() => { void useSubscriptions.getState().select(null); setDetailDrawer(false) }}
      callbacks={{
        onEdit: () => setFormOpen(true),
        onRenew: () => { if (detail) setRenewTarget(detail) },
        onToggle: () => { if (detail) void useSubscriptions.getState().toggle(detail.item.id, !detail.item.isActive) },
        onDelete: () => { if (detail) void onDelete(detail.item) },
        onAddRule: () => {
          if (!detail) return
          void useSubscriptions.getState().addRule(detail.item.id, { type: 'before_expiry', value: 3, unit: 'days' })
        },
        onPresetRules: () => { if (detail) void useSubscriptions.getState().applyPreset(detail.item.id) },
        onUpdateRule: (rule, patch) => { if (detail) void useSubscriptions.getState().updateRule(detail.item.id, rule.id, patch) },
        onDeleteRule: (rule) => { if (detail) void useSubscriptions.getState().deleteRule(detail.item.id, rule.id) },
        onEditPayment: (payment) => setPaymentTarget(payment),
        onDeletePayment: (payment) => void onDeletePayment(payment),
      }}
    />
  )

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-subscriptions-app="">
      {header}

      <div className="relative flex min-h-0 flex-1">
        {railOpen && wide && (
          <div className="w-[220px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            <FilterRail
              view={view}
              status={filter.status}
              category={filter.category}
              items={items}
              counts={counts}
              channels={channels}
              onView={(next) => useSubscriptions.getState().setView(next)}
              onStatus={(next) => useSubscriptions.getState().setFilter({ status: next })}
              onCategory={(next) => useSubscriptions.getState().setFilter({ category: next })}
              onSettings={() => setSettingsOpen(true)}
            />
          </div>
        )}

        <main className="min-w-0 flex-1">
          {view === 'overview' && (
            <OverviewView
              overview={overview}
              loading={status === 'loading'}
              currency={overviewCurrency}
              onOpenItem={openDetail}
              onOpenLogs={() => { useSubscriptions.getState().setView('logs') }}
              onAdd={() => setFormOpen(true)}
            />
          )}
          {view === 'list' && (
            <SubscriptionList
              items={visible}
              selectedId={selectedId}
              loading={status === 'loading'}
              onSelect={openDetail}
              onAdd={() => setFormOpen(true)}
              actions={{
                onEdit: (item) => { void useSubscriptions.getState().select(item.id).then(() => setFormOpen(true)) },
                onRenew: (item) => {
                  void useSubscriptions.getState().select(item.id).then(() => {
                    const next = useSubscriptions.getState().detail
                    if (next) setRenewTarget(next)
                  })
                },
                onToggle: (item) => void useSubscriptions.getState().toggle(item.id, !item.isActive),
                onDelete: (item) => void onDelete(item),
                onTest: (item) => void useSubscriptions.getState().testNotify(item.id),
              }}
            />
          )}
          {view === 'logs' && <LogsView logs={logs} items={items} onLoad={loadLogs} />}
        </main>

        {panelWide && selectedId && (
          <aside className="w-[380px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]">
            {detailPanel}
          </aside>
        )}
      </div>

      {!panelWide && (
        <Drawer open={detailDrawer && Boolean(selectedId)} onClose={() => setDetailDrawer(false)} side="right" width={380} ariaLabel={t('subscriptions.detail.info')}>
          {detailPanel}
        </Drawer>
      )}

      {!wide && railOpen && (
        <Drawer open onClose={() => setRailOpen(false)} side="left" width={240} ariaLabel={t('subscriptions.rail.all')}>
          <FilterRail
            view={view}
            status={filter.status}
            category={filter.category}
            items={items}
            counts={counts}
            channels={channels}
            onView={(next) => { useSubscriptions.getState().setView(next); setRailOpen(false) }}
            onStatus={(next) => useSubscriptions.getState().setFilter({ status: next })}
            onCategory={(next) => useSubscriptions.getState().setFilter({ category: next })}
            onSettings={() => { setSettingsOpen(true); setRailOpen(false) }}
          />
        </Drawer>
      )}

      {formOpen && (
        <SubscriptionForm
          key={detail?.item.id ?? 'new'}
          open
          detail={detail}
          timezone={settings?.timezone ?? 'Asia/Shanghai'}
          categories={categories}
          types={[...new Set(items.map((item) => item.customType).filter(Boolean))]}
          saving={saving}
          onClose={() => setFormOpen(false)}
          onSubmit={async (input) => {
            const current = useSubscriptions.getState().detail
            const result = current
              ? await useSubscriptions.getState().update(current.item.id, input)
              : await useSubscriptions.getState().create(input)
            return result !== null
          }}
        />
      )}

      {renewTarget && (
        <RenewDialog
          open
          detail={renewTarget}
          timezone={settings?.timezone ?? 'Asia/Shanghai'}
          saving={saving}
          onClose={() => setRenewTarget(null)}
          onSubmit={async (options) => {
            const result = await useSubscriptions.getState().renew(renewTarget.item.id, options)
            return result !== null
          }}
        />
      )}

      {paymentTarget && detail && (
        <PaymentDialog
          payment={paymentTarget}
          timezone={settings?.timezone ?? 'Asia/Shanghai'}
          saving={saving}
          onClose={() => setPaymentTarget(null)}
          onSubmit={async (patch) => {
            const result = await useSubscriptions.getState().updatePayment(detail.item.id, paymentTarget.id, patch)
            return result !== null
          }}
        />
      )}

      {settingsOpen && settings && (
        <Modal open onClose={() => setSettingsOpen(false)} title={t('subscriptions.settings.title')} width={720} bodyClassName="px-4 py-3">
          <SubscriptionSettings
            settings={settings}
            channels={channels}
            onClose={() => setSettingsOpen(false)}
            onSaveSettings={(patch) => useSubscriptions.getState().saveSettings(patch)}
            onSaveChannel={(kind, input) => useSubscriptions.getState().saveChannel(kind, input)}
            onClearChannel={(kind) => useSubscriptions.getState().clearChannel(kind)}
            onTestChannel={(kind) => useSubscriptions.getState().testChannel(kind)}
            onRotateToken={() => useSubscriptions.getState().rotateInboundToken()}
            onDiagnostics={() => setDiagnosticsOpen(true)}
          />
        </Modal>
      )}

      {diagnosticsOpen && (
        <DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} />
      )}

      {keysOpen && (
        <Modal open onClose={() => setKeysOpen(false)} title={t('subscriptions.keys.title')} width={420} bodyClassName="px-4 py-3">
          <ul className="space-y-1.5 text-[length:var(--text-12)]">
            {[
              ['n', t('subscriptions.add')],
              ['/', t('subscriptions.search')],
              ['r', t('subscriptions.renew.confirm')],
              ['[', t('subscriptions.rail.collapse')],
              ['?', t('subscriptions.keys.title')],
            ].map(([key, label]) => (
              <li key={key} className="flex items-center justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{label}</span>
                <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{key}</kbd>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--danger)]">{error ?? t('subscriptions.error.load')}</span>
          <Button size="sm" onClick={() => void useSubscriptions.getState().load()}>{t('subscriptions.error.retry')}</Button>
        </div>
      )}
    </section>
  )
}

/**
 * The time-zone diagnostic the reference project served at `/debug`.
 *
 * Computed in the browser because that is where the question is asked: a reader whose reminders arrive
 * at the wrong hour wants to know what this deployment thinks the hour is, and the answer is the same
 * arithmetic the scheduler runs, shown rather than described.
 */
function DiagnosticsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const settings = useSubscriptions((state) => state.settings)
  const detail = useSubscriptions((state) => state.detail)
  const timezone = settings?.timezone ?? 'Asia/Shanghai'
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now)
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  const open = (settings?.notificationHours.length ?? 0) === 0 || settings?.notificationHours.includes('*') || settings?.notificationHours.includes(hour)

  return (
    <Modal open onClose={onClose} title={t('subscriptions.diagnostics.title')} width={440} bodyClassName="px-4 py-3">
      <dl className="space-y-2 text-[length:var(--text-12)]">
        <Row label={t('subscriptions.diagnostics.utc')} value={now.toISOString().slice(0, 19).replace('T', ' ')} />
        <Row label={t('subscriptions.diagnostics.local', { timezone })} value={`${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}:${pick('second')}`} />
        <Row label={t('subscriptions.diagnostics.hour')} value={hour} />
        <Row label={t('subscriptions.diagnostics.window')} value={(settings?.notificationHours ?? []).join(', ') || t('subscriptions.diagnostics.all_day')} />
        <Row label={t('subscriptions.diagnostics.in_window')} value={open ? t('subscriptions.diagnostics.yes') : t('subscriptions.diagnostics.no')} tone={open ? 'success' : 'danger'} />
        {detail?.nextReminder && <Row label={t('subscriptions.diagnostics.next_fire')} value={detail.nextReminder.nextFireTime.slice(0, 16).replace('T', ' ')} />}
      </dl>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={onClose}>{t('subscriptions.settings.close')}</Button>
      </div>
    </Modal>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--text-tertiary)]">{label}</dt>
      <dd className={cn('tabular-nums', tone === 'success' ? 'text-[var(--success)]' : tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]')}>{value}</dd>
    </div>
  )
}
