// @vitest-environment jsdom
/**
 * The money one plan has cost, drawn where the plan is read.
 *
 * The dashboard counts the account; this panel counts a single row, and the two are only trustworthy while
 * they mean the same thing. Pinned here: the receipts are counted per year and per currency rather than
 * merged into a number with no unit, and the yearly projection is the price the plan quotes times the times
 * it charges — not a sum of what happened to arrive.
 *
 * What jsdom cannot tell anyone: how wide the strip gets when four years of history wrap, and whether the
 * chips stay legible against the panel's background.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type PaymentRecord,
  type SubscriptionDetail as Detail,
  type SubscriptionItem,
  type YearSpend,
} from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionDetail, type DetailCallbacks } from './SubscriptionDetail'
import { useSubscriptions } from './store'

const NO_CALLBACKS: DetailCallbacks = {
  onEdit: () => {}, onRenew: () => {}, onToggle: () => {}, onTrash: () => {},
  onAddRule: () => {}, onPresetRules: () => {},
  onUpdateRule: () => {}, onDeleteRule: () => {}, onAcknowledgeRule: () => {},
  onEditPayment: () => {}, onDeletePayment: () => {},
}

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'streaming',
    category: 'media',
    amount: 60,
    currency: 'CNY',
    startDate: null,
    expiryDate: '2026-11-01T00:00:00.000Z',
    periodValue: 1,
    periodUnit: 'month',
    subscriptionMode: 'cycle',
    useLunar: false,
    isActive: true,
    autoRenew: true,
    notes: '',
    lastPaymentDate: null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    daysRemaining: 10,
    hoursRemaining: 240,
    nextReminderAt: null,
    paymentCount: 0,
    paidTotal: 0,
    ...overrides,
  }
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'p1',
    subscriptionId: 'sub-1',
    paidAt: '2026-05-10T00:00:00.000Z',
    amount: 60,
    currency: 'CNY',
    kind: 'auto',
    note: '',
    periodStart: null,
    periodEnd: null,
    ...overrides,
  }
}

function spend(overrides: Partial<YearSpend> = {}): YearSpend {
  return { year: 2026, currency: 'CNY', amount: 120, receipts: 2, ...overrides }
}

function detail(overrides: { item?: Partial<SubscriptionItem>, yearlySpend?: YearSpend[], payments?: PaymentRecord[] } = {}): Detail {
  return {
    item: item(overrides.item ?? {}),
    payments: overrides.payments ?? [],
    rules: [],
    nextReminder: null,
    upcoming: [],
    yearlySpend: overrides.yearlySpend ?? [],
  }
}

let root: Root | null = null
let host: HTMLElement

const chips = () => [...document.querySelectorAll<HTMLElement>('[data-yearly-spend] > li')].map((node) => node.textContent ?? '')

async function show(value: Detail): Promise<void> {
  await act(async () => {
    root!.render(createElement(SubscriptionDetail, { detail: value, loading: false, onClose: () => {}, callbacks: NO_CALLBACKS }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useSubscriptions.setState({ types: [], categories: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host.remove()
  document.body.innerHTML = ''
})

describe('the receipts counted', () => {
  it('draws one line per year and per currency, with how many receipts made it', async () => {
    await show(detail({
      yearlySpend: [spend(), spend({ currency: 'USD', amount: 15, receipts: 1 }), spend({ year: 2025, amount: 60, receipts: 1 })],
    }))
    expect(chips()).toHaveLength(3)
    expect(chips()[0]).toContain('2026')
    expect(chips()[0]).toContain('¥120.00')
    expect(chips()[0]).toContain(t('subscriptions.payments.receipts', { count: 2 }))
    expect(chips()[1]).toContain('$15.00')
    expect(chips()[2]).toContain('2025')
    expect(chips()[2]).toContain('¥60.00')
  })

  it('says nothing about a plan nobody has paid for yet', async () => {
    await show(detail({ yearlySpend: [], payments: [] }))
    expect(document.querySelector('[data-yearly-spend]')).toBeNull()
  })
})

describe('the year a plan commits to', () => {
  it('projects twelve months from the price the plan quotes', async () => {
    await show(detail({ item: { amount: 60, periodValue: 3, periodUnit: 'month' } }))
    expect(document.body.textContent).toContain(t('subscriptions.detail.cost_per_year'))
    expect(document.body.textContent).toContain('¥240.00')
  })

  it('converts a dollar price in dollars, not in the account total currency', async () => {
    await show(detail({ item: { amount: 15, currency: 'USD', periodValue: 1, periodUnit: 'year' } }))
    expect(document.body.textContent).toContain('$15.00')
  })

  it('refuses to project a price that was never recorded', async () => {
    await show(detail({ item: { amount: null } }))
    expect(document.body.textContent).not.toContain(t('subscriptions.detail.cost_per_year'))
  })
})
