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
import { initI18n } from '../../lib/i18n'
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
    committedYearly: 3600,
    trials: [],
    priceChanges: [],
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

function mountChart(): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(createElement(OverviewView, {
      overview: overview(),
      loading: false,
      currency: 'CNY',
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
