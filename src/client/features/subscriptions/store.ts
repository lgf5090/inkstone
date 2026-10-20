/**
 * The subscription app's state, and the only place it is written.
 *
 * Two rules shape it. A mutation never guesses what the server did — every write answers with the
 * subscription it produced, and that answer replaces the row in place, so a screen and a database
 * cannot disagree about a date the server rolled forward. And a write that moves money reloads the
 * bundle instead of patching the overview by hand: the dashboard's totals are a year of receipts
 * aggregated in the account's time zone, and a second implementation of that arithmetic in the browser
 * is a second answer waiting to be wrong.
 */
import { create } from 'zustand'
import { api, type PaymentPatch, type SettingsPatch } from '../../lib/api'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import type {
  BulkAction,
  ChannelKind,
  ChannelState,
  LabelEntry,
  LabelKind,
  NotifyLogEntry,
  NotifyLogFilter,
  ReminderRule,
  ReminderRuleInput,
  RenewOptions,
  ScheduleLogEntry,
  SubscriptionBundle,
  SubscriptionDetail,
  SubscriptionInput,
  SubscriptionItem,
  SubscriptionOverview,
  SubscriptionSettings,
} from '@shared/subscriptions/model'

export type SubscriptionsView = 'overview' | 'list' | 'logs' | 'trash'

export type StatusFilter = 'all' | 'soon' | 'expired' | 'disabled'

export interface ListFilter {
  status: StatusFilter
  category: string | null
  query: string
}

export interface SubscriptionLogs {
  notify: NotifyLogEntry[]
  schedule: ScheduleLogEntry[]
  loading: boolean
  error: string | null
}

interface SubscriptionsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  items: SubscriptionItem[]
  /** The trash, loaded on demand — the bundle carries only its count. */
  trashItems: SubscriptionItem[]
  trashCount: number
  types: LabelEntry[]
  categories: LabelEntry[]
  settings: SubscriptionSettings | null
  channels: ChannelState[]
  overview: SubscriptionOverview | null

  view: SubscriptionsView
  filter: ListFilter
  selectedId: string | null
  detail: SubscriptionDetail | null
  detailLoading: boolean
  logs: SubscriptionLogs
  saving: boolean
  /** A refresh of the exchange rates is in flight, so the button does not start a second one. */
  refreshingRates: boolean

  load: () => Promise<void>
  select: (id: string | null) => Promise<void>
  setView: (view: SubscriptionsView) => void
  setFilter: (patch: Partial<ListFilter>) => void

  create: (input: SubscriptionInput) => Promise<SubscriptionDetail | null>
  update: (id: string, input: SubscriptionInput) => Promise<SubscriptionDetail | null>
  trash: (id: string) => Promise<boolean>
  loadTrash: () => Promise<void>
  restore: (id: string) => Promise<boolean>
  purge: (id: string) => Promise<boolean>
  emptyTrash: () => Promise<boolean>

  selection: string[]
  toggleSelected: (id: string) => void
  clearSelection: () => void
  bulk: (action: BulkAction, category?: string) => Promise<number>
  importRows: (rows: Record<string, unknown>[]) => Promise<{ created: number; skipped: Array<{ row: number; reason: string }> } | null>
  toggle: (id: string, isActive: boolean) => Promise<void>
  renew: (id: string, options: RenewOptions) => Promise<SubscriptionDetail | null>
  testNotify: (id: string) => Promise<void>

  saveRules: (id: string, rules: ReminderRuleInput[]) => Promise<ReminderRule[] | null>
  applyPreset: (id: string) => Promise<ReminderRule[] | null>
  addRule: (id: string, rule: ReminderRuleInput) => Promise<ReminderRule | null>
  updateRule: (id: string, ruleId: string, patch: ReminderRuleInput) => Promise<ReminderRule | null>
  deleteRule: (id: string, ruleId: string) => Promise<boolean>
  acknowledgeRule: (id: string, ruleId: string) => Promise<boolean>

  updatePayment: (id: string, paymentId: string, patch: PaymentPatch) => Promise<SubscriptionDetail | null>
  deletePayment: (id: string, paymentId: string) => Promise<SubscriptionDetail | null>

  saveSettings: (patch: SettingsPatch) => Promise<boolean>
  saveChannel: (kind: ChannelKind, input: { enabled?: boolean; config: Record<string, unknown> }) => Promise<boolean>
  clearChannel: (kind: ChannelKind) => Promise<boolean>
  testChannel: (kind: ChannelKind) => Promise<void>
  rotateInboundToken: () => Promise<{ token: string; hint: string } | null>

  addLabel: (kind: LabelKind, name: string) => Promise<boolean>
  setLabelStyle: (kind: LabelKind, name: string, style: { icon?: string | null; color?: string | null }) => Promise<boolean>
  renameLabel: (kind: LabelKind, from: string, to: string) => Promise<boolean>
  removeLabel: (kind: LabelKind, name: string) => Promise<boolean>

  loadLogs: (filter?: NotifyLogFilter) => Promise<void>
  refresh: () => Promise<void>
  /** Take a fresh day of rates from the feed, then redraw every number that used the old one. */
  refreshRates: () => Promise<void>
}

function report(error: unknown, fallbackKey: Parameters<typeof t>[0]): void {
  const message = error instanceof Error && error.message ? error.message : t(fallbackKey)
  useUi.getState().toast({ title: t('subscriptions.error.save'), description: message, tone: 'danger' })
}

/** Replace one row in the list, keeping the list's own order. */
function replaceItem(items: SubscriptionItem[], item: SubscriptionItem): SubscriptionItem[] {
  return items.map((entry) => (entry.id === item.id ? item : entry))
}

export const useSubscriptions = create<SubscriptionsState>()((set, get) => ({
  status: 'idle',
  error: null,
  items: [],
  trashItems: [],
  trashCount: 0,
  selection: [],
  types: [],
  categories: [],
  settings: null,
  channels: [],
  overview: null,

  view: 'list',
  filter: { status: 'all', category: null, query: '' },
  selectedId: null,
  detail: null,
  detailLoading: false,
  logs: { notify: [], schedule: [], loading: false, error: null },
  saving: false,
  refreshingRates: false,

  async load() {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      const bundle = await api.subscriptions.bundle()
      applyBundle(set, bundle)
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : t('subscriptions.error.load') })
    }
  },

  async refresh() {
    try {
      const bundle = await api.subscriptions.bundle()
      applyBundle(set, bundle)
      const selectedId = get().selectedId
      if (selectedId) await get().select(selectedId)
    } catch (error) {
      report(error, 'subscriptions.error.load')
    }
  },

  async refreshRates() {
    if (get().refreshingRates) return
    set({ refreshingRates: true })
    try {
      await api.subscriptions.refreshRates()
      // Every total on the dashboard was added with the old table, so the whole bundle is read again
      // rather than the strip being patched with the answer — two sources for one number is how the
      // headline and its own disclaimer start disagreeing.
      await get().refresh()
      useUi.getState().toast({ title: t('subscriptions.overview.rates_refreshed'), tone: 'success' })
    } catch (error) {
      useUi.getState().toast({
        title: t('subscriptions.overview.rates_failed'),
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      })
    } finally {
      set({ refreshingRates: false })
    }
  },

  async select(id) {
    if (!id) {
      set({ selectedId: null, detail: null })
      return
    }
    set({ selectedId: id, detailLoading: true })
    try {
      const detail = await api.subscriptions.detail(id)
      // A slower answer for a row the reader has already left must not replace the one they are on.
      if (get().selectedId === id) set({ detail, detailLoading: false })
    } catch (error) {
      if (get().selectedId === id) set({ detail: null, detailLoading: false })
      report(error, 'subscriptions.error.load')
    }
  },

  setView(view) {
    set({ view })
  },

  setFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  async create(input) {
    set({ saving: true })
    try {
      const detail = await api.subscriptions.create(input)
      set({ detail, selectedId: detail.item.id })
      await get().refresh()
      return detail
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    } finally {
      set({ saving: false })
    }
  },

  async update(id, input) {
    set({ saving: true })
    try {
      const detail = await api.subscriptions.update(id, input)
      set({ detail })
      await get().refresh()
      return detail
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    } finally {
      set({ saving: false })
    }
  },

  async trash(id) {
    try {
      await api.subscriptions.remove(id)
      set({
        items: get().items.filter((item) => item.id !== id),
        selectedId: get().selectedId === id ? null : get().selectedId,
        detail: get().detail?.item.id === id ? null : get().detail,
      })
      await get().refresh()
      useUi.getState().toast({
        title: t('subscriptions.trash.moved'),
        description: t('subscriptions.trash.moved_hint'),
        tone: 'success',
      })
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async loadTrash() {
    try {
      const { items } = await api.subscriptions.trashList()
      set({ trashItems: items })
    } catch (error) {
      report(error, 'subscriptions.error.load')
    }
  },

  async restore(id) {
    try {
      await api.subscriptions.restore(id)
      set({ trashItems: get().trashItems.filter((item) => item.id !== id) })
      await get().refresh()
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async purge(id) {
    try {
      await api.subscriptions.purge(id)
      set({ trashItems: get().trashItems.filter((item) => item.id !== id) })
      await get().refresh()
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async emptyTrash() {
    try {
      await api.subscriptions.emptyTrash()
      set({ trashItems: [] })
      await get().refresh()
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async toggle(id, isActive) {
    try {
      const detail = await api.subscriptions.toggle(id, isActive)
      set({
        items: replaceItem(get().items, detail.item),
        detail: get().detail?.item.id === id ? detail : get().detail,
      })
    } catch (error) {
      report(error, 'subscriptions.error.save')
    }
  },

  async renew(id, options) {
    set({ saving: true })
    try {
      const detail = await api.subscriptions.renew(id, options)
      set({ detail })
      await get().refresh()
      return detail
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    } finally {
      set({ saving: false })
    }
  },

  async testNotify(id) {
    try {
      const { result } = await api.subscriptions.testNotify(id)
      useUi.getState().toast({
        title: result.failedCount === 0 ? t('subscriptions.channel.test_ok') : t('subscriptions.channel.test_failed'),
        description: result.failedCount === 0 ? undefined : `${result.successCount}/${result.attempted}`,
        tone: result.failedCount === 0 ? 'success' : 'warning',
      })
    } catch (error) {
      report(error, 'subscriptions.error.no_channels')
    }
  },

  async saveRules(id, rules) {
    try {
      const { rules: saved } = await api.subscriptions.replaceRules(id, rules)
      set({ detail: mergeRules(get().detail, id, saved) })
      return saved
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async applyPreset(id) {
    try {
      const { rules } = await api.subscriptions.applyPresetRules(id)
      set({ detail: mergeRules(get().detail, id, rules) })
      return rules
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async addRule(id, rule) {
    try {
      const { rule: saved } = await api.subscriptions.addRule(id, rule)
      const detail = get().detail
      if (detail && detail.item.id === id) {
        set({ detail: { ...detail, rules: [...detail.rules, saved] } })
      }
      return saved
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async updateRule(id, ruleId, patch) {
    try {
      const { rule } = await api.subscriptions.updateRule(id, ruleId, patch)
      const detail = get().detail
      if (detail && detail.item.id === id) {
        set({ detail: { ...detail, rules: detail.rules.map((entry) => (entry.id === ruleId ? rule : entry)) } })
      }
      return rule
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async acknowledgeRule(id, ruleId) {
    try {
      const { rule } = await api.subscriptions.acknowledgeRule(id, ruleId)
      const detail = get().detail
      if (detail && detail.item.id === id) {
        set({
          detail: {
            ...detail,
            rules: detail.rules.map((entry) => entry.id === ruleId ? rule : entry),
            // The rule that just muted itself may have been the one the panel said was coming next.
            nextReminder: detail.nextReminder && detail.nextReminder.ruleId === ruleId ? null : detail.nextReminder,
          },
        })
      }
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async deleteRule(id, ruleId) {
    try {
      await api.subscriptions.deleteRule(id, ruleId)
      const detail = get().detail
      if (detail && detail.item.id === id) {
        set({ detail: { ...detail, rules: detail.rules.filter((entry) => entry.id !== ruleId) } })
      }
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async updatePayment(id, paymentId, patch) {
    try {
      const detail = await api.subscriptions.updatePayment(id, paymentId, patch)
      set({ detail })
      await get().refresh()
      return detail
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async deletePayment(id, paymentId) {
    try {
      const detail = await api.subscriptions.deletePayment(id, paymentId)
      set({ detail })
      await get().refresh()
      return detail
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async saveSettings(patch) {
    try {
      const { settings } = await api.subscriptions.saveSettings(patch)
      set({ settings })
      // The dashboard's numbers are computed by the server from these settings — the total currency, the
      // ceiling, a pinned rate — so a saved setting that stops at this store leaves every figure on screen
      // still saying what the older choice said. The bundle is read again for that reason.
      await get().refresh()
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async saveChannel(kind, input) {
    try {
      const { channel } = await api.subscriptions.saveChannel(kind, input)
      set({ channels: get().channels.map((entry) => (entry.kind === kind ? channel : entry)) })
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async clearChannel(kind) {
    try {
      const { channels } = await api.subscriptions.clearChannel(kind)
      set({ channels })
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async testChannel(kind) {
    try {
      const { result } = await api.subscriptions.testChannel(kind)
      useUi.getState().toast({
        title: result.success ? t('subscriptions.channel.test_ok') : t('subscriptions.channel.test_failed'),
        description: result.success ? undefined : result.error,
        tone: result.success ? 'success' : 'warning',
      })
      const bundle = await api.subscriptions.bundle()
      set({ channels: bundle.channels })
    } catch (error) {
      report(error, 'subscriptions.channel.test_failed')
    }
  },

  async rotateInboundToken() {
    try {
      const rotated = await api.subscriptions.rotateInboundToken()
      const settings = get().settings
      if (settings) set({ settings: { ...settings, inboundTokenHint: rotated.hint } })
      return rotated
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async addLabel(kind, name) {
    try {
      applyLabels(set, kind, await api.subscriptions.addLabel(kind, name))
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  /**
   * Give a label a face.
   *
   * Only the registry moves, so the list is swapped in place rather than reloaded — the subscriptions
   * that wear the face are unchanged, and a reload would throw away the reader's selection and scroll
   * for a colour change.
   */
  async setLabelStyle(kind, name, style) {
    try {
      const { label } = await api.subscriptions.setLabelStyle(kind, name, style)
      const key = kind === 'type' ? 'types' : 'categories'
      const list = get()[key]
      const known = list.some((entry) => entry.name === label.name)
      const next = known
        ? list.map((entry) => (entry.name === label.name ? label : entry))
        : [...list, label].sort((a, b) => a.name.localeCompare(b.name))
      set({ [key]: next } as Partial<SubscriptionsState>)
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  /**
   * Rename a label, and reload.
   *
   * The server rewrites every subscription that carried the old word, so the rows the browser is
   * holding are stale the moment this succeeds — unlike a style change, this one has to refetch.
   */
  async renameLabel(kind, from, to) {
    try {
      applyLabels(set, kind, await api.subscriptions.renameLabel(kind, from, to))
      await get().refresh()
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  async removeLabel(kind, name) {
    try {
      applyLabels(set, kind, await api.subscriptions.removeLabel(kind, name))
      return true
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return false
    }
  },

  toggleSelected(id) {
    const current = get().selection
    set({ selection: current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id] })
  },

  clearSelection() {
    set({ selection: [] })
  },

  /**
   * One action over the selected rows, then a full reload.
   *
   * The reload is not laziness: `deactivate` changes every countdown colour and `set_category` moves
   * rows between the rail's counts, and patching all of that locally would be a second implementation
   * of the summary that can disagree with the first.
   */
  async bulk(action, category) {
    const ids = get().selection
    if (!ids.length) return 0
    try {
      const { changed } = await api.subscriptions.bulk(ids, action, category)
      set({ selection: [] })
      await get().refresh()
      return changed
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return 0
    }
  },

  async importRows(rows) {
    if (!rows.length) return null
    try {
      const result = await api.subscriptions.importRows(rows)
      await get().refresh()
      return result
    } catch (error) {
      report(error, 'subscriptions.error.save')
      return null
    }
  },

  async loadLogs(filter = {}) {
    set({ logs: { ...get().logs, loading: true, error: null } })
    try {
      const [notify, schedule] = await Promise.all([
        api.subscriptions.notifyLogs(filter),
        api.subscriptions.scheduleLogs(20),
      ])
      set({ logs: { notify: notify.logs, schedule: schedule.logs, loading: false, error: null } })
    } catch (error) {
      set({
        logs: { ...get().logs, loading: false, error: error instanceof Error ? error.message : t('subscriptions.error.load') },
      })
    }
  },
}))

function applyBundle(set: (patch: Partial<SubscriptionsState>) => void, bundle: SubscriptionBundle): void {
  set({
    status: 'ready',
    error: null,
    items: bundle.items,
    types: bundle.types,
    categories: bundle.categories,
    settings: bundle.settings,
    channels: bundle.channels,
    overview: bundle.overview,
    trashCount: bundle.trashCount,
  })
}

function mergeRules(detail: SubscriptionDetail | null, id: string, rules: ReminderRule[]): SubscriptionDetail | null {
  return detail && detail.item.id === id ? { ...detail, rules } : detail
}

/** Swap one registry list after the server hands back the whole thing it just changed. */
function applyLabels(
  set: (patch: Partial<SubscriptionsState>) => void,
  kind: LabelKind,
  response: { labels: LabelEntry[] },
): void {
  set(kind === 'type' ? { types: response.labels } : { categories: response.labels })
}
