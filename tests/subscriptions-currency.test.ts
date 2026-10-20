import { describe, expect, it } from 'vitest'
import {
  FALLBACK_RATES,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  convertToBase,
  expenseByMonth,
  getExpenseByCategory,
  getExpenseByType,
  getRecentPayments,
  getUpcomingRenewals,
  mergeCnyRates,
  rateTableFor,
  type PaymentSample,
} from '../src/shared/subscriptions/currency'
import type { SubscriptionItem } from '../src/shared/subscriptions/model'

const SHANGHAI = 'Asia/Shanghai'
const NOW = new Date('2026-05-24T04:00:00Z')

function item(overrides: Partial<SubscriptionItem> = {}): SubscriptionItem {
  return {
    id: 'sub-1',
    name: 'Netflix',
    customType: 'streaming',
    category: 'family',
    amount: 60,
    currency: 'CNY',
    startDate: null,
    expiryDate: '2026-06-01T00:00:00.000Z',
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
    daysRemaining: 8,
    hoursRemaining: 192,
    nextReminderAt: null,
    paymentCount: 0,
    paidTotal: 0,
    ...overrides,
  }
}

function payment(overrides: Partial<PaymentSample> = {}): PaymentSample {
  return {
    subscriptionId: 'sub-1',
    paidAt: Date.parse('2026-05-10T00:00:00Z'),
    amount: 60,
    currency: 'CNY',
    note: '',
    ...overrides,
  }
}

describe('conversion', () => {
  /**
   * The direction is the whole test.
   *
   * `FALLBACK_RATES.USD` is 6.98, meaning "one dollar costs 6.98 yuan", and the conversion divided by
   * it — so a ten-dollar subscription was reported as ¥1.43. The live feed was read the other way round
   * and happened to work, which is why the bug survived: it only showed on the fallback path, and for
   * the three currencies the feed does not publish at all.
   */
  it('multiplies by a "one unit costs N CNY" rate', () => {
    expect(convertToBase(100, 'CNY', FALLBACK_RATES)).toBe(100)
    expect(convertToBase(10, 'USD', FALLBACK_RATES)).toBeCloseTo(69.8, 6)
    expect(convertToBase(100, 'JPY', FALLBACK_RATES)).toBeCloseTo(4.4, 6)
    expect(convertToBase(0, 'USD', FALLBACK_RATES)).toBe(0)
    expect(convertToBase(-5, 'USD', FALLBACK_RATES)).toBe(0)
  })

  it('leaves an unknown code at face value rather than guessing a rate', () => {
    expect(convertToBase(50, 'BRL', FALLBACK_RATES)).toBe(50)
  })

  it('inverts the feed, which answers per one yuan', () => {
    // Frankfurter with base=CNY says 1 yuan buys 0.14 dollars, i.e. 1 dollar costs 7.14 yuan.
    const merged = mergeCnyRates({ USD: 0.139, JPY: 20.5 })
    expect(merged.USD).toBeCloseTo(1 / 0.139, 6)
    expect(merged.JPY).toBeCloseTo(1 / 20.5, 6)
    expect(merged.CNY).toBe(1)
  })

  it('keeps the fallback for a code the feed does not carry, and pins CNY', () => {
    const merged = mergeCnyRates({ USD: 0.2, CNY: 9, XXX: 'nope' })
    expect(merged.USD).toBeCloseTo(5, 6)
    expect(merged.TWD).toBe(0.22)
    expect(merged.CNY).toBe(1)
    expect(merged.XXX).toBeUndefined()
  })

  it('re-expresses a table against the account base, with the base itself at one', () => {
    const usd = rateTableFor(FALLBACK_RATES, 'USD')
    expect(usd.USD).toBeCloseTo(1, 10)
    expect(usd.CNY).toBeCloseTo(1 / 6.98, 10)
    expect(convertToBase(100, 'CNY', usd)).toBeCloseTo(100 / 6.98, 6)
    // An unknown base leaves the table alone rather than dividing by zero.
    expect(rateTableFor(FALLBACK_RATES, 'BRL')).toBe(FALLBACK_RATES)
  })
})

describe('monthly and yearly totals', () => {
  it('reports a rise against last month', () => {
    const result = calculateMonthlyExpense([
      payment({ paidAt: Date.parse('2026-05-10T00:00:00Z'), amount: 120 }),
      payment({ paidAt: Date.parse('2026-04-10T00:00:00Z'), amount: 60 }),
    ], SHANGHAI, FALLBACK_RATES, NOW)
    expect(result).toEqual({ amount: 120, trend: 100, direction: 'up' })
  })

  it('reports a fall as a positive magnitude with a downward direction', () => {
    const result = calculateMonthlyExpense([
      payment({ paidAt: Date.parse('2026-05-10T00:00:00Z'), amount: 30 }),
      payment({ paidAt: Date.parse('2026-04-10T00:00:00Z'), amount: 60 }),
    ], SHANGHAI, FALLBACK_RATES, NOW)
    expect(result).toEqual({ amount: 30, trend: 50, direction: 'down' })
  })

  it('is flat with no history', () => {
    expect(calculateMonthlyExpense([], SHANGHAI, FALLBACK_RATES, NOW))
      .toEqual({ amount: 0, trend: 0, direction: 'flat' })
  })

  it('averages the year over the months elapsed', () => {
    const result = calculateYearlyExpense([
      payment({ paidAt: Date.parse('2026-01-10T00:00:00Z'), amount: 60 }),
      payment({ paidAt: Date.parse('2026-05-10T00:00:00Z'), amount: 60 }),
    ], SHANGHAI, FALLBACK_RATES, NOW)
    expect(result.amount).toBe(120)
    expect(result.monthlyAverage).toBe(24)
  })

  it('attributes a month by the reader zone, not by UTC', () => {
    const result = calculateMonthlyExpense([
      payment({ paidAt: Date.parse('2026-04-30T17:00:00Z'), amount: 60 }),
    ], SHANGHAI, FALLBACK_RATES, NOW)
    expect(result.amount).toBe(60)
  })
})

describe('lists', () => {
  it('finds payments from the last seven days, newest first', () => {
    const recent = getRecentPayments([item()], [
      payment({ paidAt: Date.parse('2026-05-23T00:00:00Z'), amount: 10 }),
      payment({ paidAt: Date.parse('2026-05-20T00:00:00Z'), amount: 20 }),
      payment({ paidAt: Date.parse('2026-05-01T00:00:00Z'), amount: 30 }),
    ], SHANGHAI, NOW)
    expect(recent.map((entry) => entry.amount)).toEqual([10, 20])
    expect(recent[0]!.name).toBe('Netflix')
  })

  it('lists renewals inside the week, soonest first, ignoring stopped subscriptions', () => {
    const soon = getUpcomingRenewals([
      item({ id: 'a', name: 'A', expiryDate: '2026-05-26T00:00:00Z' }),
      item({ id: 'b', name: 'B', expiryDate: '2026-05-25T00:00:00Z' }),
      item({ id: 'c', name: 'C', expiryDate: '2026-06-30T00:00:00Z' }),
      item({ id: 'd', name: 'D', expiryDate: '2026-05-25T00:00:00Z', isActive: false }),
    ], SHANGHAI, NOW)
    expect(soon.map((entry) => entry.name)).toEqual(['B', 'A'])
  })

  it('groups by type and by category, splitting a shared category', () => {
    const items = [
      item({ id: 'sub-1', customType: 'streaming', category: 'family,work' }),
      item({ id: 'sub-2', customType: 'storage', category: 'work' }),
    ]
    const payments = [
      payment({ subscriptionId: 'sub-1', amount: 100 }),
      payment({ subscriptionId: 'sub-2', amount: 100 }),
    ]
    const byType = getExpenseByType(items, payments, SHANGHAI, FALLBACK_RATES, NOW)
    expect(byType.map((entry) => [entry.label, entry.amount])).toEqual([['streaming', 100], ['storage', 100]])

    const byCategory = getExpenseByCategory(items, payments, SHANGHAI, FALLBACK_RATES, NOW)
    const work = byCategory.find((entry) => entry.label === 'work')
    const family = byCategory.find((entry) => entry.label === 'family')
    expect(work?.amount).toBe(150)
    expect(family?.amount).toBe(50)
    expect(byCategory.reduce((total, entry) => total + entry.amount, 0)).toBe(200)
  })
})

describe('the six-month series', () => {
  it('keeps empty months as zero rather than dropping them', () => {
    const series = expenseByMonth([
      payment({ paidAt: Date.parse('2026-05-10T00:00:00Z'), amount: 60 }),
      payment({ paidAt: Date.parse('2026-01-10T00:00:00Z'), amount: 30 }),
    ], SHANGHAI, FALLBACK_RATES, NOW, 6)
    expect(series.map((entry) => entry.month)).toEqual([
      '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
    ])
    expect(series.map((entry) => entry.amount)).toEqual([0, 30, 0, 0, 0, 60])
  })
})
