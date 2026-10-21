import { describe, expect, it } from 'vitest'
import {
  FALLBACK_RATES,
  annualisedCost,
  calculateMonthlyExpense,
  calculateYearlyExpense,
  categoryBudgetsOf,
  convertToBase,
  expenseByMonth,
  findPriceChanges,
  monthlyEquivalent,
  priceHistory,
  getExpenseByCategory,
  getExpenseByType,
  getRecentPayments,
  getUpcomingRenewals,
  hasRate,
  mergeCnyRates,
  rateTableFor,
  renewalsPerYear,
  spendingByYear,
  unpricedCurrencies,
  yearlyBudgetOf,
  type PaymentSample,
} from '../src/shared/subscriptions/currency'
import { formatPaid } from '../src/shared/subscriptions/format'
import { normalizeBudgetCategories } from '../src/shared/subscriptions/model'
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
    paidByCurrency: [],
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

  it('counts nothing at all for a code the table cannot price', () => {
    // Adding fifty of an unpriced currency into a yuan total is a made-up number. Leaving it out is only
    // a smaller total, and the dashboard names what it left out — which is what `unpricedCurrencies` below
    // is for.
    expect(convertToBase(50, 'BRL', FALLBACK_RATES)).toBe(0)
    expect(hasRate('BRL', FALLBACK_RATES)).toBe(false)
    expect(hasRate('USD', FALLBACK_RATES)).toBe(true)
    expect(hasRate(undefined, FALLBACK_RATES)).toBe(true)
  })

  it('names the currencies a total could not price, once each and in order', () => {
    expect(unpricedCurrencies(['USD', 'BRL', 'VND', 'BRL', 'CNY'], FALLBACK_RATES)).toEqual(['BRL', 'VND'])
    expect(unpricedCurrencies(['USD', 'CNY'], FALLBACK_RATES)).toEqual([])
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

describe('a year against the ceiling set for it', () => {
  it('spreads what is left across the months still to run, this one included', () => {
    expect(yearlyBudgetOf({ amount: 400, monthlyAverage: 80 }, 1200, SHANGHAI, NOW)).toEqual({
      limit: 1200, amount: 400, over: false, monthsLeft: 8, perMonthLeft: 100,
    })
  })

  it('invents no pace when the reader set no ceiling', () => {
    expect(yearlyBudgetOf({ amount: 400, monthlyAverage: 80 }, null, SHANGHAI, NOW)).toEqual({
      limit: null, amount: 400, over: false, monthsLeft: 8, perMonthLeft: null,
    })
  })

  it('says a spent year is spent rather than promising room that is not there', () => {
    const result = yearlyBudgetOf({ amount: 1300, monthlyAverage: 260 }, 1200, SHANGHAI, NOW)
    expect(result.over).toBe(true)
    expect(result.perMonthLeft).toBeNull()
  })

  it('reads a ceiling of zero as no ceiling at all', () => {
    expect(yearlyBudgetOf({ amount: 10, monthlyAverage: 10 }, 0, SHANGHAI, NOW).limit).toBeNull()
  })

  it('counts the months left by the reader zone, not by UTC', () => {
    // Half past midnight on the first of June in Shanghai is still the 31st of May in UTC, and the
    // reader is the one whose year is running out.
    const juneEve = new Date('2026-05-31T17:30:00Z')
    expect(yearlyBudgetOf({ amount: 0, monthlyAverage: 0 }, 1200, SHANGHAI, juneEve).monthsLeft).toBe(7)
    expect(yearlyBudgetOf({ amount: 0, monthlyAverage: 0 }, 1200, 'UTC', juneEve).monthsLeft).toBe(8)
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

/**
 * The ceilings a reader names for their own categories, and the year each one is measured against.
 *
 * Two separate promises: what goes into the account's settings is only what the app can enforce with, and
 * what comes out of the dashboard lists every ceiling — including the one whose category has spent nothing.
 */
describe('a ceiling on one category', () => {
  it('keeps the names as written and the numbers as money', () => {
    expect(normalizeBudgetCategories({ streaming: '600.004', music: 200 })).toEqual({ streaming: 600, music: 200 })
  })

  it('drops what the app could not enforce, and never guesses a number in', () => {
    const tooLong = 'x'.repeat(41)
    expect(normalizeBudgetCategories({ '  ': 100, tools: 0, games: -5, art: 'cheap', [tooLong]: 100 })).toEqual({})
  })

  it('reads a missing, blank or non-object cell as no ceilings at all', () => {
    for (const raw of [null, undefined, '', '[]', [], 7]) {
      expect(normalizeBudgetCategories(raw)).toEqual({})
    }
  })

  it('lists every ceiling, including the category that has spent nothing', () => {
    const rows = categoryBudgetsOf([{ label: 'streaming', amount: 500, percentage: 100 }], { streaming: 600, books: 200 })
    expect(rows).toEqual([
      { label: 'streaming', limit: 600, amount: 500, over: false },
      { label: 'books', limit: 200, amount: 0, over: false },
    ])
  })

  it('puts the spent ones first, then the biggest, then the name', () => {
    const rows = categoryBudgetsOf([
      { label: 'a', amount: 900, percentage: 40 },
      { label: 'b', amount: 100, percentage: 10 },
      { label: 'z', amount: 50, percentage: 5 },
      { label: 'm', amount: 100, percentage: 10 },
    ], { a: 999, b: 90, z: 40, m: 90 })
    expect(rows.map((row) => row.label)).toEqual(['b', 'm', 'z', 'a'])
    expect(rows.map((row) => row.over)).toEqual([true, true, true, false])
  })

  it('says a category is over rather than promising it has room', () => {
    const rows = categoryBudgetsOf([{ label: 'games', amount: 300, percentage: 100 }], { games: 300 })
    expect(rows[0]).toEqual({ label: 'games', limit: 300, amount: 300, over: false })
  })
})

describe('what one plan costs across a year', () => {
  it('counts how many times a period charges inside twelve months', () => {
    expect(renewalsPerYear({ periodUnit: 'month', periodValue: 1 })).toBe(12)
    expect(renewalsPerYear({ periodUnit: 'month', periodValue: 3 })).toBe(4)
    expect(renewalsPerYear({ periodUnit: 'year', periodValue: 2 })).toBe(0.5)
    expect(renewalsPerYear({ periodUnit: 'day', periodValue: 7 })).toBeCloseTo(365 / 7, 6)
    // A period of zero is a typo, not a division by nothing.
    expect(renewalsPerYear({ periodUnit: 'day', periodValue: 0 })).toBe(365)
  })

  it('keeps the account projection at the same number the factor implies', () => {
    expect(annualisedCost([item({ amount: 60, periodUnit: 'month', periodValue: 1 })], FALLBACK_RATES)).toBe(720)
    expect(annualisedCost([item({ amount: 15, currency: 'USD', periodUnit: 'month', periodValue: 1 })], FALLBACK_RATES)).toBe(1_256.4)
    expect(annualisedCost([item({ amount: 60, isActive: false })], FALLBACK_RATES)).toBe(0)
  })

  it('counts a receipt in the year the account lives in', () => {
    expect(spendingByYear([
      payment({ paidAt: Date.parse('2025-12-31T16:30:00Z'), amount: 60 }),
      payment({ paidAt: Date.parse('2026-01-10T00:00:00Z'), amount: 40 }),
      payment({ paidAt: Date.parse('2026-06-10T00:00:00Z'), amount: 20 }),
    ], SHANGHAI)).toEqual([
      // Half past four on the last UTC day of 2025 is already 2026 in Shanghai.
      { year: 2026, currency: 'CNY', amount: 120, receipts: 3 },
    ])
  })

  it('keeps two currencies apart instead of adding them together', () => {
    expect(spendingByYear([
      payment({ paidAt: Date.parse('2026-02-01T00:00:00Z'), amount: 15, currency: 'USD' }),
      payment({ paidAt: Date.parse('2026-03-01T00:00:00Z'), amount: 100, currency: 'CNY' }),
      payment({ paidAt: Date.parse('2025-03-01T00:00:00Z'), amount: 90, currency: 'CNY' }),
    ], SHANGHAI)).toEqual([
      { year: 2026, currency: 'CNY', amount: 100, receipts: 1 },
      { year: 2026, currency: 'USD', amount: 15, receipts: 1 },
      { year: 2025, currency: 'CNY', amount: 90, receipts: 1 },
    ])
  })

  it('rounds the year rather than each receipt', () => {
    expect(spendingByYear([
      payment({ paidAt: Date.parse('2026-01-05T00:00:00Z'), amount: 0.005 }),
      payment({ paidAt: Date.parse('2026-02-05T00:00:00Z'), amount: 0.005 }),
    ], SHANGHAI)).toEqual([{ year: 2026, currency: 'CNY', amount: 0.01, receipts: 2 }])
  })

  it('says nothing when nothing was paid', () => {
    expect(spendingByYear([], SHANGHAI)).toEqual([])
  })
})

/**
 * The price rise a reader remembers and the receipts have to agree with.
 *
 * Two receipts in two currencies are not a price change: they are two different things being added up.
 * This is the case the comparison used to get wrong by reading the digits, which is why the mixed pair is
 * asserted to say nothing rather than to say something small.
 */
describe('the price changes in a receipt history', () => {
  it('reports a rise between two receipts in the same currency', () => {
    const changes = findPriceChanges([item()], [
      payment({ amount: 75, paidAt: Date.parse('2026-05-10T00:00:00Z') }),
      payment({ amount: 60, paidAt: Date.parse('2026-04-10T00:00:00Z') }),
    ])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ currency: 'CNY', previous: 60, current: 75, change: 25 })
  })

  it('says nothing when the two newest receipts are in different currencies', () => {
    expect(findPriceChanges([item()], [
      payment({ currency: 'USD', amount: 10, paidAt: Date.parse('2026-05-10T00:00:00Z') }),
      payment({ currency: 'CNY', amount: 60, paidAt: Date.parse('2026-04-10T00:00:00Z') }),
    ])).toEqual([])
  })

  it('looks past a receipt in another currency for the last comparable one', () => {
    const changes = findPriceChanges([item()], [
      payment({ amount: 75, paidAt: Date.parse('2026-05-10T00:00:00Z') }),
      payment({ currency: 'USD', amount: 10, paidAt: Date.parse('2026-04-20T00:00:00Z') }),
      payment({ amount: 60, paidAt: Date.parse('2026-04-10T00:00:00Z') }),
    ])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ previous: 60, current: 75 })
  })

  it('names the currency the receipts were written in, not the one the plan quotes', () => {
    const changes = findPriceChanges([item({ currency: 'CNY' })], [
      payment({ currency: 'USD', amount: 12, paidAt: Date.parse('2026-05-10T00:00:00Z') }),
      payment({ currency: 'USD', amount: 10, paidAt: Date.parse('2026-04-10T00:00:00Z') }),
    ])
    expect(changes[0]?.currency).toBe('USD')
  })
})

describe('what has been paid', () => {
  it('writes one figure per currency the receipts were paid in, dearest first', () => {
    expect(formatPaid([{ currency: 'CNY', amount: 1200 }, { currency: 'USD', amount: 60 }])).toBe('¥1200.00 + $60.00')
    expect(formatPaid([{ currency: 'CNY', amount: 60 }])).toBe('¥60.00')
    // Nothing paid is not zero paid: an empty string leaves the row saying nothing rather than a price.
    expect(formatPaid([])).toBe('')
  })
})

/**
 * The points a single plan's price curve connects.
 *
 * A line is a claim about continuity, so everything that breaks the continuity is left out rather than
 * drawn: another currency (two units, one line), a zero charge (a trial is the absence of a price, not a
 * price of nothing), and the oldest charges once the plot is full.
 */
describe('the price history of one plan', () => {
  const charge = (at: string, amount: number, currency = 'CNY') => ({ paidAt: at, amount, currency })

  it('keeps one currency, drops what was never charged, and runs oldest first', () => {
    const points = priceHistory([
      charge('2026-03-01T00:00:00.000Z', 75),
      charge('2026-02-01T00:00:00.000Z', 0),
      charge('2026-01-15T00:00:00.000Z', 9, 'USD'),
      charge('2026-01-01T00:00:00.000Z', 60),
    ], 'CNY')
    expect(points).toEqual([
      { at: '2026-01-01T00:00:00.000Z', amount: 60 },
      { at: '2026-03-01T00:00:00.000Z', amount: 75 },
    ])
  })

  it('keeps the newest charges when the history is longer than the plot', () => {
    const many = Array.from({ length: 15 }, (_, index) => charge(new Date(Date.UTC(2024, index, 1)).toISOString(), 60))
    const points = priceHistory(many, 'CNY', 12)
    expect(points).toHaveLength(12)
    expect(points[0]?.at).toBe('2024-04-01T00:00:00.000Z')
    expect(points[11]?.at).toBe('2025-03-01T00:00:00.000Z')
  })

  it('turns a numeric instant into the day the chart prints', () => {
    const points = priceHistory([{ paidAt: Date.parse('2026-05-06T04:00:00Z'), amount: 60, currency: 'CNY' }], 'CNY')
    expect(points[0]?.at.startsWith('2026-05-06')).toBe(true)
  })
})
