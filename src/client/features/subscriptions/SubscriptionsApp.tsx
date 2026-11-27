/**
 * The subscription app: the frame the rail, the list, the dashboard and the detail panel share.
 *
 * It owns nothing but the wiring — every rule lives in the store or in a component — and it owns the
 * responsive decision the other containers make too: three panes when there is room, one pane and a
 * drawer when there is not. Loading is on mount rather than at boot, so a reader who never opens this
 * tab does not pay for a library they will not look at.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react'
import { CheckSquare, CircleHelp, LayoutGrid, List, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Sparkles, Tags, Wallet } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useSession } from '../../store/session'
import { DEFAULT_LAYOUT, PANEL_WIDTHS, useUi } from '../../store/ui'
import { Resizer } from '../shell/Resizer'
import { useBreakpoint, useMediaQuery } from '../../lib/hooks'
import { AssistantDock } from '../chat/AssistantDock'
import { NotificationsBell } from '../chat/NotificationCenter'
import { Button, IconButton } from '../../components/primitives'
import { LoadingBlock } from '../../components/feedback'
import { Drawer, Modal, Tooltip, confirm } from '../../components/overlay'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { formatAmount } from '@shared/subscriptions/format'
import { FALLBACK_RATES } from '@shared/subscriptions/currency'
import { NEW_RULE_DRAFT, hourIsOpen } from '@shared/subscriptions/model'
import { formatLocalDate, getNowInTimezone } from '@shared/subscriptions/time'
import { LIST_SORTS } from '@shared/subscriptions/sort'
import { useSubscriptions } from './store'
import { countItems, visibleItems } from './list-view'
import { FilterRail } from './FilterRail'
import { SubscriptionList, type SubscriptionActions } from './SubscriptionList'
import { SubscriptionGrid } from './SubscriptionGrid'
import { SORT_LABEL } from './subscription-parts'
import { SubscriptionDetail } from './SubscriptionDetail'
import { BulkBar } from './BulkBar'
import { useLabelSuggestions } from './label-identity'
import type { PaymentRecord, SubscriptionDetail as Detail, SubscriptionItem } from '@shared/subscriptions/model'

const OverviewView = lazy(() => import('./OverviewView').then((module) => ({ default: module.OverviewView })))
const SubscriptionCalendar = lazy(() => import('./SubscriptionCalendar').then((module) => ({ default: module.SubscriptionCalendar })))
const LogsView = lazy(() => import('./LogsView').then((module) => ({ default: module.LogsView })))
const SubscriptionForm = lazy(() => import('./SubscriptionForm').then((module) => ({ default: module.SubscriptionForm })))
const RenewDialog = lazy(() => import('./RenewDialog').then((module) => ({ default: module.RenewDialog })))
const PaymentDialog = lazy(() => import('./PaymentDialog').then((module) => ({ default: module.PaymentDialog })))
const TrashView = lazy(() => import('./TrashView').then((module) => ({ default: module.TrashView })))
const LabelManagerDialog = lazy(() => import('./LabelManagerDialog').then((module) => ({ default: module.LabelManagerDialog })))
const SubscriptionSettings = lazy(() => import('./SubscriptionSettings').then((module) => ({ default: module.SubscriptionSettings })))

/** Where the filter rail earns its column, and where the detail panel earns a third one. */
const NEEDS_RAIL_QUERY = '(min-width: 1024px)'
const NEEDS_PANEL_QUERY = '(min-width: 1280px)'

export function SubscriptionsApp(): ReactElement {
  const userId = useSession((state) => state.user?.id ?? null)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const subscriptionsRailWidth = useUi((state) => state.subscriptionsRailWidth)
  const subscriptionsDetailWidth = useUi((state) => state.subscriptionsDetailWidth)
  const setLayout = useUi((state) => state.setLayout)
  const isMobile = useBreakpoint() === 'mobile'
  const status = useSubscriptions((state) => state.status)
  const error = useSubscriptions((state) => state.error)
  const items = useSubscriptions((state) => state.items)
  const selection = useSubscriptions((state) => state.selection)
  const trashItems = useSubscriptions((state) => state.trashItems)
  const trashCount = useSubscriptions((state) => state.trashCount)
  const settings = useSubscriptions((state) => state.settings)
  const channels = useSubscriptions((state) => state.channels)
  const categoryEntries = useSubscriptions((state) => state.categories)
  const overview = useSubscriptions((state) => state.overview)
  const view = useSubscriptions((state) => state.view)
  const filter = useSubscriptions((state) => state.filter)
  const selectedId = useSubscriptions((state) => state.selectedId)
  const detail = useSubscriptions((state) => state.detail)
  const detailLoading = useSubscriptions((state) => state.detailLoading)
  const detailDrawer = useSubscriptions((state) => state.detailDrawerOpen)
  const setDetailDrawerOpen = useSubscriptions((state) => state.setDetailDrawerOpen)
  const logs = useSubscriptions((state) => state.logs)
  const saving = useSubscriptions((state) => state.saving)
  const refreshingRates = useSubscriptions((state) => state.refreshingRates)
  const loadLogs = useSubscriptions((state) => state.loadLogs)

  // The three-column decision the rail, the list and the detail panel share. The widths are this app's own
  // because a third column needs more room than the notebook's two: 1024px is where the filter rail plus a
  // list fits, 1280px is where a 380px detail panel joins them.
  const wide = useMediaQuery(NEEDS_RAIL_QUERY)
  const panelWide = useMediaQuery(NEEDS_PANEL_QUERY)
  const [railOpen, setRailOpen] = useState(wide)
  const [formOpen, setFormOpen] = useState(false)
  const [renewTarget, setRenewTarget] = useState<Detail | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<PaymentRecord | null>(null)
  const [refundTarget, setRefundTarget] = useState<Detail | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const typeSuggestions = useLabelSuggestions('type')
  const categorySuggestions = useLabelSuggestions('category')
  // The registry alone, not the suggestions: a ceiling on a built-in category nobody has filed a plan
  // under would be a row that reports zero forever.
  const categoryNames = useMemo(() => categoryEntries.map((entry) => entry.name), [categoryEntries])

  useEffect(() => {
    void useSubscriptions.getState().load()
  }, [userId])

  // The table the dashboard's own totals were added with, so the list orders money the same way the
  // numbers above it were. Before the bundle lands there is nothing to order by but the built-in table.
  const rateTable = overview?.rates.table ?? FALLBACK_RATES
  const visible = useMemo(() => visibleItems(items, filter, rateTable), [items, filter, rateTable])
  // One set of actions for both shapes of the same rows. Written once because a plan that can be renewed
  // from the list must be able to be renewed from a card — two definitions would drift by the next button
  // anybody adds.
  const rowActions: SubscriptionActions = {
    onEdit: (item) => { void useSubscriptions.getState().select(item.id).then(() => setFormOpen(true)) },
    onRenew: (item) => {
      void useSubscriptions.getState().select(item.id).then(() => {
        const next = useSubscriptions.getState().detail
        if (next) setRenewTarget(next)
      })
    },
    onToggle: (item) => void useSubscriptions.getState().toggle(item.id, !item.isActive),
    onTrash: (item) => void onTrash(item),
    onTest: (item) => void useSubscriptions.getState().testNotify(item.id),
  }
  const counts = useMemo(() => countItems(items), [items])
  // The account's own total currency. This used to be a literal, so an account billed entirely in
  // dollars was shown a yuan headline converted at a rate it never chose.
  const overviewCurrency = settings?.baseCurrency ?? 'CNY'

  // The bundle carries only the trash's count, so the rows are fetched when they are first looked at.
  useEffect(() => {
    if (view === 'trash' && trashItems.length === 0 && trashCount > 0) void useSubscriptions.getState().loadTrash()
  }, [view, trashItems.length, trashCount])

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
    if (!panelWide) void useSubscriptions.getState().openDetail(id)
    else void useSubscriptions.getState().select(id)
  }

  const onTrash = async (item: SubscriptionItem): Promise<void> => {
    const ok = await confirm({
      title: t('subscriptions.trash.move'),
      description: t('subscriptions.trash.confirm', { name: item.name }),
      confirmLabel: t('subscriptions.trash.move'),
    })
    if (ok) await useSubscriptions.getState().trash(item.id)
  }

  /** The one action in this app that cannot be undone, so it says so and asks for its own yes. */
  const onPurge = async (item: SubscriptionItem): Promise<void> => {
    const ok = await confirm({
      title: t('subscriptions.trash.purge'),
      description: t('subscriptions.trash.purge_confirm', { name: item.name }),
      confirmLabel: t('subscriptions.trash.purge'),
      tone: 'danger',
    })
    if (ok) await useSubscriptions.getState().purge(item.id)
  }

  const onEmptyTrash = async (): Promise<void> => {
    const ok = await confirm({
      title: t('subscriptions.trash.empty'),
      description: t('subscriptions.trash.empty_confirm', { count: trashCount }),
      confirmLabel: t('subscriptions.trash.empty'),
      tone: 'danger',
    })
    if (ok) await useSubscriptions.getState().emptyTrash()
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
    <header data-print="hide" className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1">
      <IconButton label={railOpen ? t('subscriptions.rail.collapse') : t('subscriptions.rail.expand')} size="sm" onClick={() => setRailOpen(open => !open)}>
        {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
      </IconButton>
      <Wallet size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
      <h1 className="min-w-0 shrink truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{t('subscriptions.title')}</h1>
      {overview && (
        <span className="hidden shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)] sm:inline">
          {formatAmount(overview.monthly.amount, overviewCurrency)}
        </span>
      )}
      <div className="ml-auto flex w-full min-w-0 flex-wrap items-center justify-end gap-1 sm:w-auto">
        <Input
          id="subscriptions-search"
          aria-label={t('subscriptions.search')}
          value={filter.query}
          placeholder={t('subscriptions.search')}
          leading={<Search size={13} />}
          wrapperClassName="w-auto shrink-0"
          onChange={(event) => useSubscriptions.getState().setFilter({ query: event.target.value })}
          className="h-7 w-32 text-[length:var(--text-11-5)] sm:w-40 lg:w-52"
        />
        {/* Ordering and shape belong to the rows, so neither control exists where there are none: the
            dashboard, the logs and the trash each have their own arrangement already. */}
        {(view === 'list' || view === 'grid') && (
          <>
            <SelectMenu
              label={t('subscriptions.list.sort')}
              value={filter.sort}
              options={LIST_SORTS.map((sort) => ({ value: sort, label: t(SORT_LABEL[sort]) }))}
              onChange={(sort) => useSubscriptions.getState().setFilter({ sort })}
              size="sm"
              width={140}
              align="end"
              className="w-[92px] shrink-0 text-[length:var(--text-11-5)]"
            />
            <Tooltip label={view === 'grid' ? t('subscriptions.view_list') : t('subscriptions.view_grid')} side="bottom">
              <IconButton
                label={view === 'grid' ? t('subscriptions.view_list') : t('subscriptions.view_grid')}
                size="sm"
                active={view === 'grid'}
                onClick={() => useSubscriptions.getState().setView(view === 'grid' ? 'list' : 'grid')}
              >
                {view === 'grid' ? <List size={15} /> : <LayoutGrid size={15} />}
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip label={t('subscriptions.keys.title')} side="bottom">
          {/* A touch screen has no keys to press, so the card is offered only where it can be used. */}
          <IconButton label={t('subscriptions.keys.title')} size="sm" className="hidden sm:inline-flex" onClick={() => setKeysOpen(true)}><CircleHelp size={15} /></IconButton>
        </Tooltip>
        {/* A reminder that fires while the reader is on this page has nowhere to show up otherwise: the
            bell that carries it is mounted on the chat tab alone, and the schedules that write those rows
            belong to these plans. One bell per surface, one unread count between them. */}
        <NotificationsBell
          open={notificationsOpen}
          onOpen={() => setNotificationsOpen(true)}
          onClose={() => setNotificationsOpen(false)}
        />
        {/* The dock is mounted here, but nothing on this page could open it: the only callers of
            `setAssistantDock` live in the notebook, so asking about a plan meant leaving for the chat tab
            first. This is that door. */}
        <Tooltip label={t('subscriptions.ask_assistant')} side="bottom">
          <IconButton
            label={t('subscriptions.ask_assistant')}
            size="sm"
            active={assistantDockOpen}
            onClick={() => useUi.getState().setAssistantDock(!assistantDockOpen)}
          >
            <Sparkles size={15} />
          </IconButton>
        </Tooltip>
        {/* Selecting applies to the list rows, so the press only exists where a box can appear. Offered in
            the trash or the logs it would flip to "exit selecting" and change nothing on screen. */}
        {view === 'list' && (
          <Tooltip label={selectMode ? t('subscriptions.select_exit') : t('subscriptions.select')} side="bottom">
            <IconButton
              label={selectMode ? t('subscriptions.select_exit') : t('subscriptions.select')}
              size="sm"
              active={selectMode}
              onClick={() => {
                setSelectMode((value) => !value)
                useSubscriptions.getState().clearSelection()
              }}
            >
              <CheckSquare size={15} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip label={t('subscriptions.picker.manage')} side="bottom">
          <IconButton label={t('subscriptions.picker.manage')} size="sm" onClick={() => setLabelsOpen(true)}><Tags size={15} /></IconButton>
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
      timezone={settings?.timezone ?? 'Asia/Shanghai'}
      onClose={() => { void useSubscriptions.getState().closeDetail() }}
      callbacks={{
        onEdit: () => setFormOpen(true),
        onRenew: () => { if (detail) setRenewTarget(detail) },
        onToggle: () => { if (detail) void useSubscriptions.getState().toggle(detail.item.id, !detail.item.isActive) },
        onTrash: () => { if (detail) void onTrash(detail.item) },
        onAddRule: () => {
          if (!detail) return
          void useSubscriptions.getState().addRule(detail.item.id, { ...NEW_RULE_DRAFT })
        },
        onPresetRules: () => { if (detail) void useSubscriptions.getState().applyPreset(detail.item.id) },
        onUpdateRule: (rule, patch) => { if (detail) void useSubscriptions.getState().updateRule(detail.item.id, rule.id, patch) },
        onDeleteRule: (rule) => { if (detail) void useSubscriptions.getState().deleteRule(detail.item.id, rule.id) },
        onAcknowledgeRule: (rule) => { if (detail) void useSubscriptions.getState().acknowledgeRule(detail.item.id, rule.id) },
        onEditPayment: (payment) => setPaymentTarget(payment),
        onDeletePayment: (payment) => void onDeletePayment(payment),
        onRefund: () => { if (detail) setRefundTarget(detail) },
      }}
    />
  )

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-subscriptions-app="">
      {header}

      <div className="relative flex min-h-0 flex-1">
        {railOpen && wide && (
          <>
            <div style={{ width: subscriptionsRailWidth }} className="shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              <FilterRail
                view={view}
                status={filter.status}
                category={filter.category}
                items={items}
                counts={counts}
                channels={channels}
                trashCount={trashCount}
                onView={(next) => useSubscriptions.getState().setView(next)}
                onStatus={(next) => useSubscriptions.getState().setFilter({ status: next })}
                onCategory={(next) => useSubscriptions.getState().setFilter({ category: next })}
                onSettings={() => setSettingsOpen(true)}
              />
            </div>
            <Resizer
              label={t('subscriptions.resize_rail')}
              value={subscriptionsRailWidth}
              min={PANEL_WIDTHS.subscriptionsRail.min}
              max={PANEL_WIDTHS.subscriptionsRail.max}
              onChange={(subscriptionsRailWidth) => setLayout({ subscriptionsRailWidth })}
              onReset={() => setLayout({ subscriptionsRailWidth: DEFAULT_LAYOUT.subscriptionsRailWidth })}
            />
          </>
        )}

        <main className="min-w-0 flex-1">
          {view === 'overview' && (
            <Suspense fallback={<LoadingBlock />}>
              <OverviewView
                overview={overview}
                loading={status === 'loading'}
                currency={overviewCurrency}
                refreshingRates={refreshingRates}
                onRefreshRates={() => { void useSubscriptions.getState().refreshRates() }}
                onOpenItem={openDetail}
                onOpenLogs={() => { useSubscriptions.getState().setView('logs') }}
                onAdd={() => setFormOpen(true)}
              />
            </Suspense>
          )}
          {view === 'calendar' && (
            <Suspense fallback={<LoadingBlock />}>
              <SubscriptionCalendar items={items} timezone={settings?.timezone ?? 'Asia/Shanghai'} onOpenItem={openDetail} />
            </Suspense>
          )}
          {view === 'list' && (
            <SubscriptionList
              items={visible}
              sort={filter.sort}
              selectedId={selectedId}
              loading={status === 'loading'}
              onSelect={openDetail}
              onAdd={() => setFormOpen(true)}
              actions={rowActions}
              selectMode={selectMode}
              selection={selection}
              onCheck={(id) => useSubscriptions.getState().toggleSelected(id)}
            />
          )}
          {view === 'grid' && (
            <SubscriptionGrid
              items={visible}
              selectedId={selectedId}
              loading={status === 'loading'}
              onSelect={openDetail}
              onAdd={() => setFormOpen(true)}
              actions={rowActions}
            />
          )}
          {view === 'list' && <BulkBar items={items} />}
          {view === 'trash' && (
            <Suspense fallback={<LoadingBlock />}>
              <TrashView
                items={trashItems}
                timezone={settings?.timezone ?? 'Asia/Shanghai'}
                onRestore={(item) => void useSubscriptions.getState().restore(item.id)}
                onPurge={(item) => void onPurge(item)}
                onEmpty={() => void onEmptyTrash()}
              />
            </Suspense>
          )}
          {view === 'logs' && (
            <Suspense fallback={<LoadingBlock />}>
              <LogsView logs={logs} items={items} timezone={settings?.timezone ?? 'Asia/Shanghai'} onLoad={loadLogs} />
            </Suspense>
          )}
        </main>

        {panelWide && selectedId && (
          <>
            <Resizer
              label={t('subscriptions.resize_detail')}
              value={subscriptionsDetailWidth}
              min={PANEL_WIDTHS.subscriptionsDetail.min}
              max={PANEL_WIDTHS.subscriptionsDetail.max}
              invert
              onChange={(subscriptionsDetailWidth) => setLayout({ subscriptionsDetailWidth })}
              onReset={() => setLayout({ subscriptionsDetailWidth: DEFAULT_LAYOUT.subscriptionsDetailWidth })}
            />
            <aside style={{ width: subscriptionsDetailWidth }} className="shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {detailPanel}
            </aside>
          </>
        )}

        {/* The same column the notebook mounts, under the same conditions: the assistant's thread is
            global state, so opening it here and opening it there is one conversation rather than two.
            Not on a phone, where chat already has a tab of its own. */}
        {assistantDockOpen && !isMobile && <AssistantDock surface="subscriptions" subscription={(() => {
          const open = items.find((item) => item.id === selectedId)
          return open ? { id: open.id, name: open.name } : null
        })()} />}
      </div>

      {!panelWide && (
        <Drawer open={detailDrawer && Boolean(selectedId)} onClose={() => setDetailDrawerOpen(false)} side="right" width={380} ariaLabel={t('subscriptions.detail.info')}>
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
            trashCount={trashCount}
            onView={(next) => { useSubscriptions.getState().setView(next); setRailOpen(false) }}
            onStatus={(next) => useSubscriptions.getState().setFilter({ status: next })}
            onCategory={(next) => useSubscriptions.getState().setFilter({ category: next })}
            onSettings={() => { setSettingsOpen(true); setRailOpen(false) }}
          />
        </Drawer>
      )}

      {formOpen && (
        <Suspense fallback={<LoadingBlock />}>
          <SubscriptionForm
            key={detail?.item.id ?? 'new'}
            open
            detail={detail}
            timezone={settings?.timezone ?? 'Asia/Shanghai'}
            categories={categorySuggestions}
            types={typeSuggestions}
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
        </Suspense>
      )}

      {renewTarget && (
        <Suspense fallback={<LoadingBlock />}>
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
        </Suspense>
      )}

      {paymentTarget && detail && (
        <Suspense fallback={<LoadingBlock />}>
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
        </Suspense>
      )}

      {refundTarget && (
        <Suspense fallback={<LoadingBlock />}>
          <PaymentDialog
            payment={null}
            refund
            timezone={settings?.timezone ?? 'Asia/Shanghai'}
            saving={saving}
            onClose={() => setRefundTarget(null)}
            onSubmit={async (patch) => {
              const result = await useSubscriptions.getState().addRefund(refundTarget.item.id, patch)
              return result !== null
            }}
          />
        </Suspense>
      )}

      {settingsOpen && settings && (
        <Suspense fallback={<LoadingBlock />}>
          <Modal open onClose={() => setSettingsOpen(false)} title={t('subscriptions.settings.title')} width={720} bodyClassName="px-4 py-3">
            <SubscriptionSettings
              settings={settings}
              channels={channels}
              currencies={items.map((item) => item.currency)}
              categories={categoryNames}
              onClose={() => setSettingsOpen(false)}
              onSaveSettings={(patch) => useSubscriptions.getState().saveSettings(patch)}
              onSaveChannel={(kind, input) => useSubscriptions.getState().saveChannel(kind, input)}
              onClearChannel={(kind) => useSubscriptions.getState().clearChannel(kind)}
              onTestChannel={(kind) => useSubscriptions.getState().testChannel(kind)}
              onRotateToken={() => useSubscriptions.getState().rotateInboundToken()}
              onRotateCalendarToken={() => useSubscriptions.getState().rotateCalendarToken()}
              onDiagnostics={() => setDiagnosticsOpen(true)}
            />
          </Modal>
        </Suspense>
      )}

      {labelsOpen && (
        <Suspense fallback={<LoadingBlock />}>
          <LabelManagerDialog open onClose={() => setLabelsOpen(false)} />
        </Suspense>
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
        <div role="alert" className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
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
  const clock = getNowInTimezone(timezone, now)
  const open = hourIsOpen(settings?.notificationHours ?? [], clock.hourString)

  return (
    <Modal open onClose={onClose} title={t('subscriptions.diagnostics.title')} width={440} bodyClassName="px-4 py-3">
      <dl className="space-y-2 text-[length:var(--text-12)]">
        <Row label={t('subscriptions.diagnostics.utc')} value={now.toISOString().slice(0, 19).replace('T', ' ')} />
        <Row label={t('subscriptions.diagnostics.local', { timezone })} value={clock.isoLocal} />
        <Row label={t('subscriptions.diagnostics.hour')} value={clock.hourString} />
        <Row label={t('subscriptions.diagnostics.window')} value={(settings?.notificationHours ?? []).join(', ') || t('subscriptions.diagnostics.all_day')} />
        <Row label={t('subscriptions.diagnostics.in_window')} value={open ? t('subscriptions.diagnostics.yes') : t('subscriptions.diagnostics.no')} tone={open ? 'success' : 'danger'} />
        {detail?.nextReminder && <Row label={t('subscriptions.diagnostics.next_fire')} value={formatLocalDate(detail.nextReminder.nextFireTime, timezone, 'datetime')} />}
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
