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
  ChannelKind,
  ChannelState,
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

export type SubscriptionsView = 'overview' | 'list' | 'logs'

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
  categories: string[]
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

  load: () => Promise<void>
  select: (id: string | null) => Promise<void>
  setView: (view: SubscriptionsView) => void
  setFilter: (patch: Partial<ListFilter>) => void

  create: (input: SubscriptionInput) => Promise<SubscriptionDetail | null>
  update: (id: string, input: SubscriptionInput) => Promise<SubscriptionDetail | null>
  remove: (id: string) => Promise<boolean>
  toggle: (id: string, isActive: boolean) => Promise<void>
  renew: (id: string, options: RenewOptions) => Promise<SubscriptionDetail | null>
  testNotify: (id: string) => Promise<void>

  saveRules: (id: string, rules: ReminderRuleInput[]) => Promise<ReminderRule[] | null>
  applyPreset: (id: string) => Promise<ReminderRule[] | null>
  addRule: (id: string, rule: ReminderRuleInput) => Promise<ReminderRule | null>
  updateRule: (id: string, ruleId: string, patch: ReminderRuleInput) => Promise<ReminderRule | null>
  deleteRule: (id: string, ruleId: string) => Promise<boolean>

  updatePayment: (id: string, paymentId: string, patch: PaymentPatch) => Promise<SubscriptionDetail | null>
  deletePayment: (id: string, paymentId: string) => Promise<SubscriptionDetail | null>

  saveSettings: (patch: SettingsPatch) => Promise<boolean>
  saveChannel: (kind: ChannelKind, input: { enabled?: boolean; config: Record<string, unknown> }) => Promise<boolean>
  clearChannel: (kind: ChannelKind) => Promise<boolean>
  testChannel: (kind: ChannelKind) => Promise<void>
  rotateInboundToken: () => Promise<{ token: string; hint: string } | null>

  loadLogs: (filter?: NotifyLogFilter) => Promise<void>
  refresh: () => Promise<void>
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

  async remove(id) {
    try {
      await api.subscriptions.remove(id)
      set({
        items: get().items.filter((item) => item.id !== id),
        selectedId: get().selectedId === id ? null : get().selectedId,
        detail: get().detail?.item.id === id ? null : get().detail,
      })
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
    categories: bundle.categories,
    settings: bundle.settings,
    channels: bundle.channels,
    overview: bundle.overview,
  })
}

function mergeRules(detail: SubscriptionDetail | null, id: string, rules: ReminderRule[]): SubscriptionDetail | null {
  return detail && detail.item.id === id ? { ...detail, rules } : detail
}
