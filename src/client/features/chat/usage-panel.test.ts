// @vitest-environment jsdom
/**
 * The usage screen.
 *
 * What a reader comes here for is a number they can act on, so what is pinned is the arithmetic and the
 * honesty around it: the tokens of a window, a cost per currency, and the models left out of that cost
 * because nobody has priced them. The chart is the library's own business — jsdom has no canvas, which is
 * also the case the panel has to survive.
 *
 * The screen has two views and the split is the point of one of them: a window's numbers follow the range
 * control, the account's totals cannot follow anything or they would not be totals.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStats, AssistantUsageOverview } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { api } from '../../lib/api'
import { UsagePanel } from './AssistantUsagePanel'

const STATS: AssistantStats = {
  range: '7',
  from: '2026-10-10',
  to: '2026-10-16',
  total: { requests: 12, inputTokens: 2_500_000, outputTokens: 500_000, toolCalls: 4, scheduledRuns: 0, embeddings: 0, errors: 1 },
  days: [
    { day: '2026-10-10', requests: 5, inputTokens: 1_000_000, outputTokens: 200_000, toolCalls: 2, scheduledRuns: 0, embeddings: 0, errors: 0 },
    { day: '2026-10-12', requests: 7, inputTokens: 1_500_000, outputTokens: 300_000, toolCalls: 2, scheduledRuns: 0, embeddings: 0, errors: 1 },
  ],
  models: [
    { label: 'deepseek-chat', requests: 10, inputTokens: 2_000_000, outputTokens: 400_000, toolCalls: 4, errors: 0, currency: 'CNY', cost: 3.2 },
    { label: 'local-llama', requests: 2, inputTokens: 500_000, outputTokens: 100_000, toolCalls: 0, errors: 1, currency: '', cost: null },
  ],
  conversations: [{ id: 'c1', title: 'Planning', requests: 8, inputTokens: 1_000_000, outputTokens: 200_000, updatedAt: 1_700_000_000_000 }],
  // The same two days the charts read: one bar per day, already split both ways so the grouping switch
  // costs no second request.
  series: [
    {
      day: '2026-10-10',
      requests: 5,
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      costs: [{ currency: 'CNY', amount: 1.2 }],
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', requests: 5, inputTokens: 1_000_000, outputTokens: 200_000, costs: [{ currency: 'CNY', amount: 1.2 }], unpriced: false }],
      keys: [{ id: 'p1:', label: 'DeepSeek', requests: 5, inputTokens: 1_000_000, outputTokens: 200_000, costs: [{ currency: 'CNY', amount: 1.2 }], unpriced: false }],
    },
    {
      day: '2026-10-12',
      requests: 7,
      inputTokens: 1_500_000,
      outputTokens: 300_000,
      costs: [{ currency: 'CNY', amount: 2 }],
      models: [
        { id: 'deepseek-chat', label: 'deepseek-chat', requests: 5, inputTokens: 1_000_000, outputTokens: 200_000, costs: [{ currency: 'CNY', amount: 1.2 }], unpriced: false },
        { id: 'local-llama', label: 'local-llama', requests: 2, inputTokens: 500_000, outputTokens: 100_000, costs: [], unpriced: true },
      ],
      keys: [{ id: 'p1:', label: 'DeepSeek', requests: 7, inputTokens: 1_500_000, outputTokens: 300_000, costs: [{ currency: 'CNY', amount: 2 }], unpriced: false }],
    },
  ],
  keys: [
    { providerId: 'p1', providerLabel: 'DeepSeek', keyId: '', keyLabel: 'DeepSeek', requests: 10, inputTokens: 2_000_000, outputTokens: 400_000, toolCalls: 4, errors: 0, costs: [{ currency: 'CNY', amount: 3.2 }], unpriced: false },
    { providerId: 'p2', providerLabel: 'Local', keyId: '', keyLabel: 'Local', requests: 2, inputTokens: 500_000, outputTokens: 100_000, toolCalls: 0, errors: 1, costs: [], unpriced: true },
  ],
  spend: [{ currency: 'CNY', amount: 3.2 }],
  modelOptions: ['deepseek-chat', 'local-llama'],
  unpricedModels: 1,
  generatedAt: 1_700_000_000_000,
  limits: DEFAULT_ASSISTANT_SETTINGS.limits,
}

const OVERVIEW: AssistantUsageOverview = {
  totalTokens: 4_200_000,
  peakDay: '2026-10-12',
  peakTokens: 1_800_000,
  longestTurnMs: 125_000,
  currentStreak: 2,
  longestStreak: 5,
  activity: [
    { day: '2026-10-10', tokens: 1_200_000 },
    { day: '2026-10-11', tokens: 1_200_000 },
    { day: '2026-10-12', tokens: 1_800_000 },
  ],
}

vi.mock('../../lib/api', () => ({
  api: {
    assistant: {
      stats: vi.fn(async () => STATS),
      usageOverview: vi.fn(async () => ({ overview: OVERVIEW })),
    },
  },
}))

let rendered: RenderedElement | null = null

const text = () => rendered!.container.textContent ?? ''
const buttons = () => [...rendered!.container.querySelectorAll<HTMLButtonElement>('button')]
const byText = (label: string) => buttons().find((node) => node.textContent?.trim() === label)
const radiogroup = (label: string) => rendered!.container.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`)

/** Switches the screen to its account view, which is where the totals live. */
async function openAccount(): Promise<void> {
  await vi.waitFor(() => expect(radiogroup(t('assistant.stats.view'))).toBeTruthy(), { timeout: 5000, interval: 10 })
  act(() => {
    [...radiogroup(t('assistant.stats.view'))!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === t('assistant.stats.view_account'))?.click()
  })
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
})

describe('the usage screen', () => {
  it('adds the window up, and shortens the token counts it prints', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain(t('assistant.stats.requests')), { timeout: 5000, interval: 10 })
    expect(text()).toContain('12')
    // 2.5M in, 0.5M out: the scale a reader can take in, not the seven digits underneath it.
    expect(text()).toContain('2.5M')
    expect(text()).toContain('500K')
  })

  it('names the money, and says how much of it was left out', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain('CNY'), { timeout: 5000, interval: 10 })
    // A cheap window shows fractions of a unit, so the fourth decimal is not noise.
    expect(text()).toContain('CNY 3.20')
    expect(text()).toContain(t('assistant.stats.unpriced', { count: 1 }))
  })

  it('draws the cost chart in one named currency, grouped by model or by key from the same answer', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain(t('assistant.stats.cost_chart')), { timeout: 5000, interval: 10 })
    // The currency the bars are drawn in is named: a window priced in two is two bills, and stacking them
    // would be adding different money together.
    expect(text()).toContain(`${t('assistant.stats.cost_chart')} (CNY)`)
    const toggle = radiogroup(t('assistant.stats.group_by'))
    expect(toggle, 'the grouping switch is not rendered').toBeTruthy()
    expect(toggle!.textContent).toContain(t('assistant.stats.filter_key'))
    // Both splits travel on the one series, so switching the grouping is a redraw rather than a request.
    const calls = vi.mocked(api.assistant.stats).mock.calls.length
    act(() => {
      [...toggle!.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === t('assistant.stats.filter_key'))?.click()
    })
    expect(vi.mocked(api.assistant.stats).mock.calls.length).toBe(calls)
  })

  it('gives each busy model its own pair of charts, and names the conversation that spent most', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain('deepseek-chat'), { timeout: 5000, interval: 10 })
    expect(text()).toContain('local-llama')
    expect(text()).toContain('Planning')
    // One cost chart plus a pair of canvases per model: that is what "its own pair" means, and the library
    // is what draws them.
    expect(rendered.container.querySelectorAll('canvas').length).toBe(5)
  })

  it('keeps the account totals out of the range control, which no window can narrow', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await openAccount()
    expect(text()).toContain('4,200,000')
    expect(text()).toContain('1,800,000')
    // 125 s read the way a reader says it.
    expect(text()).toContain(t('assistant.stats.minutes', { count: 2 }))
    expect(text()).toContain(t('assistant.stats.days', { count: 2 }))
    expect(text()).toContain(t('assistant.stats.days', { count: 5 }))
  })

  it('says which models are unpriced rather than counting them as free', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await openAccount()
    await vi.waitFor(() => expect(text()).toContain('deepseek-chat'), { timeout: 5000, interval: 10 })
    expect(text()).toContain(t('assistant.stats.no_price'))
  })

  it('measures the activity map three ways over one grid of days', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await openAccount()
    const map = () => rendered!.container.querySelector(`[role="group"][aria-label="${t('assistant.stats.heatmap')}"]`)
    expect(map(), 'the activity map is not rendered').toBeTruthy()
    const cells = () => [...map()!.querySelectorAll('span[title]')]
    // Whole weeks of squares, including the days with nothing on them: a map that skipped them would show
    // a shape the reader never had.
    expect(cells().length % 7).toBe(0)
    expect(cells().some((cell) => cell.getAttribute('title')?.includes('2026-10-12'))).toBe(true)
    const byDay = cells().length
    // The switch changes what a square means, not how many there are — it is one grid read three ways.
    for (const mode of ['assistant.stats.heat_weekly', 'assistant.stats.heat_cumulative'] as const) {
      act(() => {
        [...radiogroup(t('assistant.stats.heat_mode'))!.querySelectorAll<HTMLButtonElement>('button')]
          .find((node) => node.textContent?.trim() === t(mode))?.click()
      })
      expect(cells().length).toBe(byDay)
    }
  })

  it('offers the account view as a switch, so neither view has to be scrolled past to reach the other', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain(t('assistant.stats.title')), { timeout: 5000, interval: 10 })
    expect(text()).not.toContain(t('assistant.stats.total_tokens'))
    await openAccount()
    expect(text()).toContain(t('assistant.stats.total_tokens'))
    expect(text()).not.toContain(t('assistant.stats.cost_chart'))
    act(() => { byText(t('assistant.stats.view_detail'))?.click() })
    await act(async () => { await Promise.resolve() })
    expect(text()).toContain(t('assistant.stats.cost_chart'))
  })
})
