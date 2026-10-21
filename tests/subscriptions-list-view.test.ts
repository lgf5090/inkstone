import { describe, expect, it } from 'vitest'
import {
  categoryCounts,
  categoryList,
  countItems,
  groupItems,
  groupOf,
  matchesFilter,
  visibleItems,
} from '../src/client/features/subscriptions/list-view'
import type { SubscriptionItem } from '../src/shared/subscriptions/model'

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
    daysRemaining: 10,
    hoursRemaining: 240,
    nextReminderAt: null,
    paymentCount: 0,
    paidTotal: 0,
    ...overrides,
  }
}

const ALL = { status: 'all' as const, category: null, query: '', sort: 'expiry' as const }

/** Enough of a rate table for the money orderings: yuan is the base, and these are the codes below. */
const RATES = { CNY: 1, USD: 7 }

describe('grouping', () => {
  it('sorts a row into the bucket its distance names', () => {
    expect(groupOf(item({ daysRemaining: -2 }))).toBe('expired')
    expect(groupOf(item({ daysRemaining: 0 }))).toBe('week')
    expect(groupOf(item({ daysRemaining: 7 }))).toBe('week')
    expect(groupOf(item({ daysRemaining: 8 }))).toBe('month')
    expect(groupOf(item({ daysRemaining: 30 }))).toBe('month')
    expect(groupOf(item({ daysRemaining: 31 }))).toBe('later')
  })

  it('puts a stopped subscription in its own bucket whatever its date says', () => {
    expect(groupOf(item({ isActive: false, daysRemaining: -30 }))).toBe('disabled')
  })

  it('drops empty buckets and orders the rest', () => {
    const groups = groupItems([
      item({ id: 'a', daysRemaining: 40 }),
      item({ id: 'b', daysRemaining: 3 }),
      item({ id: 'c', daysRemaining: 1 }),
      item({ id: 'd', daysRemaining: -1 }),
    ])
    expect(groups.map((entry) => entry.group)).toEqual(['expired', 'week', 'later'])
    expect(groups[1]!.items.map((entry) => entry.id)).toEqual(['c', 'b'])
  })
})

describe('filtering', () => {
  it('keeps only the rows the status names', () => {
    const rows = [
      item({ id: 'active', daysRemaining: 30 }),
      item({ id: 'soon', daysRemaining: 3 }),
      item({ id: 'expired', daysRemaining: -1 }),
      item({ id: 'off', isActive: false }),
    ]
    expect(visibleItems(rows, { ...ALL, status: 'soon' }, RATES).map((row) => row.id)).toEqual(['soon'])
    expect(visibleItems(rows, { ...ALL, status: 'expired' }, RATES).map((row) => row.id)).toEqual(['expired'])
    expect(visibleItems(rows, { ...ALL, status: 'disabled' }, RATES).map((row) => row.id)).toEqual(['off'])
    expect(visibleItems(rows, ALL, RATES)).toHaveLength(4)
  })

  /**
   * The four orderings the toolbar offers, on three plans chosen so each one answers differently.
   *
   * The money ones are the reason this list exists in a shared file at all: a $60-a-month plan is the
   * dearest of the three and the cheapest at face value, so an ordering that skipped the rate table would
   * put it last and read as though the app did not know what a dollar was.
   */
  it('orders by date, by what a month costs, by one charge, or by name', () => {
    const rows = [
      item({ id: 'dear', name: 'Adobe', amount: 150, currency: 'CNY', periodValue: 1, periodUnit: 'month', daysRemaining: 40 }),
      item({ id: 'costly', name: 'Figma', amount: 60, currency: 'USD', periodValue: 1, periodUnit: 'month', daysRemaining: 5 }),
      item({ id: 'yearly', name: 'Office', amount: 360, currency: 'CNY', periodValue: 1, periodUnit: 'year', daysRemaining: 200 }),
    ]
    expect(visibleItems(rows, ALL, RATES).map((row) => row.id)).toEqual(['costly', 'dear', 'yearly'])
    // ¥420 a month, then ¥150, then ¥30 — the yearly plan is the cheap one once a year is twelve months.
    expect(visibleItems(rows, { ...ALL, sort: 'cost' }, RATES).map((row) => row.id)).toEqual(['costly', 'dear', 'yearly'])
    // One charge: $60 is ¥420, the annual ¥360 is next, the monthly ¥150 last.
    expect(visibleItems(rows, { ...ALL, sort: 'amount' }, RATES).map((row) => row.id)).toEqual(['costly', 'yearly', 'dear'])
    expect(visibleItems(rows, { ...ALL, sort: 'name' }, RATES).map((row) => row.id)).toEqual(['dear', 'costly', 'yearly'])
  })

  it('does not reorder the rows the rail counted, and leaves an unpriced code last rather than guessing', () => {
    const rows = [
      item({ id: 'first', daysRemaining: 1 }),
      item({ id: 'second', daysRemaining: 2 }),
    ]
    visibleItems(rows, ALL, RATES)
    expect(rows.map((row) => row.id)).toEqual(['first', 'second'])

    const unpriced = item({ id: 'odd', name: 'Zetta', amount: 99, currency: 'JPY', periodValue: 1, periodUnit: 'month', daysRemaining: 3 })
    expect(visibleItems([unpriced, rows[0]!], { ...ALL, sort: 'cost' }, RATES).map((row) => row.id)).toEqual(['first', 'odd'])
  })

  it('matches a category among several', () => {
    const row = item({ category: 'family, work' })
    expect(categoryList(row)).toEqual(['family', 'work'])
    expect(matchesFilter(row, { ...ALL, category: 'work' })).toBe(true)
    expect(matchesFilter(row, { ...ALL, category: 'other' })).toBe(false)
  })

  it('searches name, type, category and notes', () => {
    const row = item({ name: 'Netflix', notes: 'shared with family' })
    expect(matchesFilter(row, { ...ALL, query: 'netf' })).toBe(true)
    expect(matchesFilter(row, { ...ALL, query: 'STREAMING' })).toBe(true)
    expect(matchesFilter(row, { ...ALL, query: 'shared' })).toBe(true)
    expect(matchesFilter(row, { ...ALL, query: 'spotify' })).toBe(false)
  })
})

describe('counts', () => {
  it('counts the rail the same way the list filters', () => {
    const rows = [
      item({ id: 'a', daysRemaining: 30 }),
      item({ id: 'b', daysRemaining: 2 }),
      item({ id: 'c', daysRemaining: 7 }),
      item({ id: 'd', daysRemaining: -4 }),
      item({ id: 'e', isActive: false }),
    ]
    expect(countItems(rows)).toEqual({ all: 5, soon: 2, expired: 1, disabled: 1 })
  })

  it('counts a shared category once per subscription', () => {
    const counts = categoryCounts([
      item({ id: 'a', category: 'family, work' }),
      item({ id: 'b', category: 'work' }),
    ])
    expect(counts).toEqual([
      { name: 'work', count: 2 },
      { name: 'family', count: 1 },
    ])
  })
})
