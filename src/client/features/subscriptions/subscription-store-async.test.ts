import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type NotifyLogEntry, type SubscriptionBundle, type SubscriptionDetail, type SubscriptionItem, type SubscriptionOverview } from '@shared/subscriptions/model'
import { useSubscriptions } from './store'

const mocks = vi.hoisted(() => ({
  bundle: vi.fn(),
  detail: vi.fn(),
  toggle: vi.fn(),
  notifyLogs: vi.fn(),
  scheduleLogs: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: { subscriptions: mocks } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function item(id: string, isActive = true): SubscriptionItem {
  return {
    id, name: id, customType: '', category: '', amount: 10, currency: 'CNY', startDate: null,
    expiryDate: '2027-01-01T00:00:00.000Z', periodValue: 1, periodUnit: 'month', subscriptionMode: 'cycle',
    useLunar: false, isActive, autoRenew: false, notes: '', lastPaymentDate: null, trialEndsAt: null,
    deletedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    daysRemaining: 10, hoursRemaining: 240, trialDaysRemaining: null, nextReminderAt: null,
    paymentCount: 0, paidByCurrency: [],
  }
}

function detail(id: string, isActive = true): SubscriptionDetail {
  return { item: item(id, isActive), payments: [], rules: [], nextReminder: null, upcoming: [], yearlySpend: [] }
}

function bundle(items: SubscriptionItem[], overview = {} as SubscriptionOverview): SubscriptionBundle {
  return { items, types: [], categories: [], settings: { ...DEFAULT_SETTINGS }, channels: [], overview, trashCount: 0 }
}

function log(id: string): NotifyLogEntry {
  return {
    id, subscriptionId: 's1', subscriptionName: 'A', ruleId: 'r1', channel: 'inapp', status: 'success',
    title: id, body: id, error: '', detail: '', createdAt: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSubscriptions.setState({
    status: 'ready', error: null, items: [], trashItems: [], trashCount: 0, types: [], categories: [],
    settings: { ...DEFAULT_SETTINGS }, channels: [], overview: null, view: 'list',
    filter: { status: 'all', category: null, query: '', sort: 'expiry' }, selectedId: null,
    detail: null, detailLoading: false, detailDrawerOpen: false, logs: { notify: [], schedule: [], loading: false, error: null },
    saving: false, refreshingRates: false, selection: [],
  })
})

describe('subscription store request ordering', () => {
  it('opens the mobile detail drawer for an external deep link', async () => {
    mocks.detail.mockResolvedValue(detail('a'))
    await useSubscriptions.getState().openDetail('a')
    expect(useSubscriptions.getState().detailDrawerOpen).toBe(true)
    expect(useSubscriptions.getState().detail?.item.id).toBe('a')
  })

  it('keeps the newest selected detail when an older request finishes last', async () => {
    const first = deferred<SubscriptionDetail>()
    const second = deferred<SubscriptionDetail>()
    mocks.detail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const oldRequest = useSubscriptions.getState().select('a')
    const newRequest = useSubscriptions.getState().select('b')
    second.resolve(detail('b'))
    await newRequest
    first.resolve(detail('a'))
    await oldRequest
    expect(useSubscriptions.getState().detail?.item.id).toBe('b')
  })

  it('keeps the newest bundle when an older refresh finishes last', async () => {
    const first = deferred<SubscriptionBundle>()
    const second = deferred<SubscriptionBundle>()
    mocks.bundle.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const oldRequest = useSubscriptions.getState().refresh()
    const newRequest = useSubscriptions.getState().refresh()
    second.resolve(bundle([item('new')]))
    await newRequest
    first.resolve(bundle([item('old')]))
    await oldRequest
    expect(useSubscriptions.getState().items.map((entry) => entry.id)).toEqual(['new'])
  })

  it('refreshes the overview after a subscription is stopped', async () => {
    const overview = { active: { active: 0, total: 1, expiringSoon: 0 } } as SubscriptionOverview
    useSubscriptions.setState({ items: [item('a')], overview: { active: { active: 1, total: 1, expiringSoon: 0 } } as SubscriptionOverview })
    mocks.toggle.mockResolvedValue(detail('a', false))
    mocks.bundle.mockResolvedValue(bundle([item('a', false)], overview))
    await useSubscriptions.getState().toggle('a', false)
    expect(mocks.bundle).toHaveBeenCalledTimes(1)
    expect(useSubscriptions.getState().overview).toBe(overview)
  })

  it('keeps the newest log filter when an older request finishes last', async () => {
    const first = deferred<{ logs: NotifyLogEntry[] }>()
    const second = deferred<{ logs: NotifyLogEntry[] }>()
    mocks.notifyLogs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    mocks.scheduleLogs.mockResolvedValue({ logs: [] })
    const oldRequest = useSubscriptions.getState().loadLogs({ status: 'failed' })
    const newRequest = useSubscriptions.getState().loadLogs({ status: 'success' })
    second.resolve({ logs: [log('new')] })
    await newRequest
    first.resolve({ logs: [log('old')] })
    await oldRequest
    expect(useSubscriptions.getState().logs.notify.map((entry) => entry.id)).toEqual(['new'])
  })
})
