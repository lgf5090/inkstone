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
import { HEAT_WEEKS } from '@shared/subscriptions/model'
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
    daily: [],
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

/**
 * The bars themselves.
 *
 * Not `role=img`: the ring in the share card is a picture too, and a query that reaches for "the image"
 * now finds a canvas instead of the month chart. These hooks name the thing they want.
 */
function bars(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-trend-bars] > div')]
}

/** The same figures written out for a reader who cannot see the bars. */
function barValues(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-trend-values] > li')]
}

function budgetLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-trend-budget]')
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
    expect(found, 'the month chart drew no bars').toHaveLength(MONTHS.length)
    for (const bar of found) expect(bar.getAttribute('title'), 'each bar says what it costs').toBeTruthy()
    for (const bar of found) {
      expect(bar.style.height, 'a percentage against a content-sized column is zero, which is how the chart vanished').toMatch(/^\d+px$/)
    }
  })

  it('scales the peak month to the whole plot and draws nothing for a month with no receipts', () => {
    mountChart()
    const found = bars()
    const plot = Number.parseInt(found[0]!.parentElement!.style.height, 10)
    expect(Number.parseInt(found[5]!.style.height, 10), 'the tallest month fills the plot').toBe(plot)
    expect(Number.parseInt(found[3]!.style.height, 10)).toBe(Math.round((240 / 300) * plot))
    // A stub here used to be two pixels, and five of them joined into a line that read as an axis.
    expect(Number.parseInt(found[0]!.style.height, 10)).toBe(0)
    expect(Number.parseInt(found[2]!.style.height, 10)).toBe(0)
  })

  it('lists the same figures for a reader who cannot see the bars', () => {
    mountChart()
    const values = barValues()
    expect(values).toHaveLength(MONTHS.length)
    expect(values[1]!.textContent).toContain('2026-06')
    expect(values[1]!.textContent).toContain('¥120.00')
    // The picture is decoration once the numbers are written out; reading both would say everything twice.
    expect(document.querySelector('[data-trend-bars]')!.closest('[aria-hidden="true"]')).toBeTruthy()
  })

  it('rules the monthly ceiling across the plot and marks the months that passed it', () => {
    mountChart()
    const line = budgetLine()
    expect(line, 'a chart about a budget with no budget line cannot be read against the number it is about').toBeTruthy()
    // The fixture's ceiling is ¥200 against a ¥300 peak, so the line sits two thirds up the plot.
    expect(line!.style.bottom).toBe('64px')
    expect(line!.textContent).toContain('¥200.00')
    const found = bars()
    expect(found[3]!.className, '240 over a 200 ceiling').toContain('danger')
    expect(found[5]!.className, '300 over a 200 ceiling').toContain('danger')
    expect(found[1]!.className).not.toContain('danger')
    expect(barValues()[3]!.textContent).toContain('over the monthly budget')
    expect(barValues()[1]!.textContent).not.toContain('over the monthly budget')
  })

  it('draws no line and no colour when the reader set no ceiling', () => {
    mountChart({ budget: { limit: null, amount: 300, over: false } })
    expect(budgetLine()).toBeNull()
    for (const bar of bars()) expect(bar.className).not.toContain('danger')
    for (const value of barValues()) expect(value.textContent).not.toContain('over the monthly budget')
  })

  it('lays a whole year out without collapsing the columns', () => {
    const months = Array.from({ length: 12 }, (_, index) => `2025-${String(index + 1).padStart(2, '0')}`)
    mountChart({ months: months.map((month) => ({ month, amount: 10 })) })
    expect(bars()).toHaveLength(12)
    expect(barValues()).toHaveLength(12)
    for (const bar of bars()) expect(bar.className, 'a fixed-width column would push the twelfth off the card').toContain('flex-1')
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

describe('the share rings', () => {
  const rings = () => [...document.querySelectorAll<HTMLElement>('[data-share-ring]')]
  const list = () => document.querySelector('[data-share-list]')

  it('draws a ring over the list without replacing it', () => {
    mountChart({
      byCategory: [
        { label: 'streaming', amount: 600, percentage: 60 },
        { label: 'tools', amount: 400, percentage: 40 },
      ],
    })
    const ring = rings()[0]
    expect(ring, 'a two-way split drew no ring').toBeTruthy()
    const canvas = ring.querySelector('canvas[role="img"]')
    expect(canvas, 'the ring is a picture that names nothing').toBeTruthy()
    expect(canvas!.getAttribute('aria-label')).toContain('By category')
    // The numbers stay written out beside it: a canvas a reader cannot see is not where the figures live.
    expect(list(), 'the ring replaced the list it is supposed to sit above').toBeTruthy()
    expect(list()!.querySelectorAll('li')).toHaveLength(2)
    expect(list()!.textContent).toContain('¥600.00')
    expect(list()!.textContent).toContain('60%')
  })

  it('draws no ring for a single slice, which is the whole total wearing a circle', () => {
    mountChart({ byCategory: [{ label: 'streaming', amount: 600, percentage: 100 }] })
    expect(rings()).toHaveLength(0)
    expect(list()!.textContent).toContain('¥600.00')
  })

  it('draws nothing at all when there is no spending to split', () => {
    mountChart({ byCategory: [], byType: [] })
    expect(rings()).toHaveLength(0)
    expect(list()).toBeNull()
    expect(document.body.textContent).toContain('Nothing charged this year')
  })
})

describe('the spending heat grid', () => {
  /** The grid is built from the real clock, so the fixture's days are counted back from today. */
  const dayKey = (back: number): string => {
    const date = new Date()
    date.setDate(date.getDate() - back)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const cells = () => [...document.querySelectorAll<HTMLElement>('[data-heat-grid] span')]
  /** A charged tile names its amount in its tooltip; a quiet one only names the day. */
  const charged = () => cells().filter((cell) => (cell.getAttribute('title') ?? '').includes('¥'))
  const summary = () => document.querySelector('[data-heat-summary]')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

  it('lays whole weeks of tiles across the window and marks only the days that charged', () => {
    mountChart({ daily: [{ date: dayKey(0), amount: 60 }, { date: dayKey(3), amount: 240 }] })
    const found = cells()
    // Whole columns of seven, at least the window's worth: the strip aligns its first column to the start
    // of the week, so it can lead with days from before the window rather than a ragged half column.
    expect(found.length % 7).toBe(0)
    expect(found.length).toBeGreaterThanOrEqual(HEAT_WEEKS * 7)
    expect(charged()).toHaveLength(2)
    // The ramp is mixed into the card's own surface, so an unoutlined quiet tile is invisible and the grid
    // stops being a grid — the spacing is the part that carries "nothing happened this week".
    expect(found.every((cell) => /ring-inset/.test(cell.className))).toBe(true)
    expect(summary()).toContain(String(HEAT_WEEKS))
    expect(summary()).toContain('2')
    expect(summary()).toContain('¥300.00')
    expect(summary()).toContain(`${dayKey(3)} ¥240.00`)
  })

  it('lists the charged days for a reader who cannot see the tiles', () => {
    mountChart({ daily: [{ date: dayKey(1), amount: 12 }] })
    const list = [...document.querySelectorAll('[data-heat-days] li')]
    expect(list).toHaveLength(1)
    expect(list[0]!.textContent).toContain(dayKey(1))
    expect(list[0]!.textContent).toContain('¥12.00')
  })

  it('says so when nothing charged, rather than drawing an empty wall', () => {
    mountChart({ daily: [] })
    expect(cells().length % 7).toBe(0)
    expect(charged()).toHaveLength(0)
    expect(cells().every((cell) => /ring-inset/.test(cell.className))).toBe(true)
    expect(document.querySelector('[data-heat-days]')).toBeNull()
    expect(summary()).toContain(String(HEAT_WEEKS))
  })
})
