// @vitest-environment jsdom
/**
 * The usage screen.
 *
 * What a reader comes here for is a number they can act on, so what is pinned is the arithmetic and the
 * honesty around it: the tokens of a window, a cost per currency, and the models left out of that cost
 * because nobody has priced them. The chart is the library's own business — jsdom has no canvas, which is
 * also the case the panel has to survive.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStats } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
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
  spend: [{ currency: 'CNY', amount: 3.2 }],
  unpricedModels: 1,
  generatedAt: 1_700_000_000_000,
  limits: DEFAULT_ASSISTANT_SETTINGS.limits,
}

vi.mock('../../lib/api', () => ({
  api: { assistant: { stats: vi.fn(async () => STATS) } },
}))

let rendered: RenderedElement | null = null

const text = () => rendered!.container.textContent ?? ''

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

  it('names the money, and says which models are not in it', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain('CNY'), { timeout: 5000, interval: 10 })
    // A cheap window shows fractions of a unit, so the fourth decimal is not noise.
    expect(text()).toContain('CNY 3.20')
    expect(text()).toContain(t('assistant.stats.unpriced', { count: 1 }))
    expect(text()).toContain(t('assistant.stats.no_price'))
  })

  it('lists each model with its own share, and the days as cells', async () => {
    rendered = renderElement(createElement(UsagePanel))
    await act(async () => { await Promise.resolve() })
    await vi.waitFor(() => expect(text()).toContain('deepseek-chat'), { timeout: 5000, interval: 10 })
    expect(text()).toContain('local-llama')
    expect(text()).toContain('Planning')
    // One cell per day of the window, whatever the window's length — the map is drawn from the range, not
    // from the days that happen to have usage, or a quiet week would look like a short one.
    expect(rendered.container.querySelectorAll('[role="group"][aria-label] span[title]').length).toBe(7)
  })
})
