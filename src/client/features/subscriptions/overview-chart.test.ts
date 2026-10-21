// @vitest-environment jsdom
/**
 * The six-month bar chart, as boxes with heights.
 *
 * The chart once rendered six month labels and no bars at all: each bar's height was a percentage of its
 * column, and the column also carries the label, so it was sized by its content — and a percentage height
 * against a content-sized parent is zero. Nothing threw, nothing warned, and the dashboard simply had no
 * chart in it. These assert the shape that fixed it: pixel heights, scaled against the plot.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubscriptionOverview } from '@shared/subscriptions/model'
import { formatAmount } from '@shared/subscriptions/format'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { OverviewView } from './OverviewView'
import { useSubscriptions } from './store'

const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
const AMOUNTS = [0, 120, 0, 240, 60, 300]

function overview(overrides: Partial<SubscriptionOverview> = {}): SubscriptionOverview {
  return {
    monthly: { amount: 300, trend: 400, direction: 'up' },
    yearly: { amount: 720, monthlyAverage: 60 },
    active: { active: 3, total: 3, expiringSoon: 1 },
    recentPayments: [],
    upcoming: [],
    byType: [],
    byCategory: [],
    months: MONTHS.map((month, index) => ({ month, amount: AMOUNTS[index] })),
    timezone: 'Asia/Shanghai',
    scheduler: null,
    history: [],
    budget: { limit: 200, amount: 300, over: true },
    yearlyBudget: { limit: null, amount: 720, over: false, monthsLeft: 3, perMonthLeft: null },
    categoryBudgets: [],
    committedYearly: 3600,
    trials: [],
    priceChanges: [],
    rates: { source: 'feed', at: Date.parse('2026-10-21T00:00:00Z'), base: 'CNY', basePriced: true, unpriced: [], pinned: [], table: { CNY: 1 } },
    ...overrides,
  }
}

let root: Root | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useSubscriptions.setState({ types: [], categories: [] })
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

/** The chart's `role=img` block: it is a picture of six numbers, described rather than read cell by cell. */
function chart(): HTMLElement {
  const host = document.querySelector<HTMLElement>('[role=img]')
  expect(host, 'the month chart is not rendered').toBeTruthy()
  return host!
}

function bars(): HTMLElement[] {
  return [...chart().querySelectorAll<HTMLElement>('[title]')] as HTMLElement[]
}

function plotHeights(): string[] {
  return bars().map((bar) => (bar.parentElement as HTMLElement).style.height)
}

function mountChart(overrides: Partial<SubscriptionOverview> = {}): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(createElement(OverviewView, {
      overview: overview(overrides),
      loading: false,
      currency: 'CNY',
      refreshingRates: false,
      onRefreshRates: () => {},
      onOpenItem: () => {},
      onOpenLogs: () => {},
      onAdd: () => {},
    }))
  })
}

describe('the month chart', () => {
  it('draws one bar per month, and every bar states a height that can resolve', () => {
    mountChart()
    const found = bars()
    expect(found).toHaveLength(MONTHS.length)
    for (const bar of found) expect(bar.getAttribute('title'), 'each bar says what it costs').toBeTruthy()
    for (const bar of found) {
      expect(bar.style.height, 'a percentage against a content-sized column is zero, which is how the chart vanished').toMatch(/^\d+px$/)
    }
    for (const height of plotHeights()) expect(height).toMatch(/^\d+px$/)
  })

  it('scales the peak month to the whole plot and draws nothing for a month with no receipts', () => {
    mountChart()
    const found = bars()
    const plot = Number.parseInt(plotHeights()[0]!, 10)
    expect(Number.parseInt(found[5]!.style.height, 10), 'the tallest month fills the plot').toBe(plot)
    expect(Number.parseInt(found[3]!.style.height, 10)).toBe(Math.round((240 / 300) * plot))
    // A stub here used to be two pixels, and five of them joined into a line that read as an axis.
    expect(Number.parseInt(found[0]!.style.height, 10)).toBe(0)
    expect(Number.parseInt(found[2]!.style.height, 10)).toBe(0)
  })

  it('names the chart once instead of reading six numbers at a reader who cannot see them', () => {
    mountChart()
    const block = chart()
    expect(block.getAttribute('aria-label')).toBeTruthy()
    expect(bars().every((bar) => bar.getAttribute('title'))).toBe(true)
  })
})

describe('the rates strip', () => {
  const words = () => (document.body.textContent || '').replace(/\s+/g, ' ')

  it('says whose rates these are and which currency the totals are added up in', () => {
    mountChart()
    expect(words()).toContain('Rates from the daily currency service')
    expect(words()).toContain('Totals in CNY')
    // A table that priced everything has nothing to apologise for.
    expect(words()).not.toContain('No rate for')
  })

  it('names the currencies left out of every total, and the base left out too', () => {
    mountChart({
      rates: { source: 'approximate', at: null, base: 'SGD', basePriced: false, unpriced: ['SGD', 'THB'], pinned: ['USD'], table: { CNY: 1 } },
    })
    expect(words()).toContain('No rate for SGD, THB')
    expect(words()).toContain('SGD has no rate either')
    expect(words()).toContain('Pinned: USD')
  })
})

describe('the yearly card', () => {
  const words = () => (document.body.textContent || '').replace(/\s+/g, ' ')

  it('shows the yearly ceiling beside what the year has cost, and what the rest of it can afford', () => {
    mountChart({ yearlyBudget: { limit: 1200, amount: 400, over: false, monthsLeft: 8, perMonthLeft: 100 } })
    expect(words()).toContain(`/ ${formatAmount(1200, 'CNY')}`)
    expect(words()).toContain(`${formatAmount(100, 'CNY')} a month until year end`)
    expect(words()).not.toContain('Over the yearly budget')
  })

  it('marks the year spent once the receipts pass the ceiling, and stops promising room', () => {
    mountChart({ yearlyBudget: { limit: 1200, amount: 1300, over: true, monthsLeft: 8, perMonthLeft: null } })
    expect(words()).toContain('Over the yearly budget')
    expect(words()).not.toContain('a month until year end')
  })

  it('says nothing about a ceiling the reader never set', () => {
    mountChart()
    expect(words()).not.toContain('a month until year end')
    expect(words()).not.toContain('Over the yearly budget')
  })
})

describe('the category ceilings', () => {
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-category-ceilings] > li')]
  const words = () => (document.body.textContent || '').replace(/\s+/g, ' ')

  it('lists every ceiling the account set, with what the year has spent against it', () => {
    mountChart({
      categoryBudgets: [
        { label: 'family', limit: 500, amount: 600, over: true },
        { label: 'books', limit: 100, amount: 0, over: false },
      ],
    })
    const found = rows()
    expect(found).toHaveLength(2)
    expect(words()).toContain(t('subscriptions.overview.category_ceilings'))
    expect(found[0]!.textContent).toBe(`family${formatAmount(600, 'CNY')} / ${formatAmount(500, 'CNY')}`)
    expect(found[0]!.querySelector('span:last-child')!.className).toContain('danger')
    expect(found[1]!.querySelector('span:last-child')!.className).not.toContain('danger')
  })

  it('draws nothing about ceilings when the account set none', () => {
    mountChart()
    expect(rows()).toHaveLength(0)
    expect(words()).not.toContain(t('subscriptions.overview.category_ceilings'))
  })
})
