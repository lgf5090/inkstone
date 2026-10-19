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

const ALL = { status: 'all' as const, category: null, query: '' }

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
    expect(visibleItems(rows, { ...ALL, status: 'soon' }).map((row) => row.id)).toEqual(['soon'])
    expect(visibleItems(rows, { ...ALL, status: 'expired' }).map((row) => row.id)).toEqual(['expired'])
    expect(visibleItems(rows, { ...ALL, status: 'disabled' }).map((row) => row.id)).toEqual(['off'])
    expect(visibleItems(rows, ALL)).toHaveLength(4)
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
