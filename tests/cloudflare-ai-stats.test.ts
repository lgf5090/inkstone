/**
 * The AI statistics tab, mounted the way the app mounts it.
 *
 * The page is mostly arithmetic drawn as shapes, so the cases pin the arithmetic and the shapes that
 * carry it: five headline numbers from one usage answer, a bar per model whose length is its share of
 * the busiest model, and one ring per account. The numbers are asserted as text because a bar width or
 * a ring angle is not something a screen reader — or this environment — can read.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatsTab } from '../src/client/features/cloudflare/screens/ai/StatsTab'
import { cfT } from '../src/client/features/cloudflare/i18n'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

const USAGE = [
  {
    accountId: 'a1',
    accountName: 'Alpha',
    totalNeurons: 1543,
    models: [
      { modelId: '@cf/black-forest-labs/flux-2', neurons: 1400, requests: 3 },
      { modelId: '@cf/deepgram/aura-2-en', neurons: 143, requests: 2 },
    ],
  },
  {
    accountId: 'a2',
    accountName: 'Beta',
    totalNeurons: 0,
    models: [],
  },
]

vi.mock('../src/client/features/cloudflare/api/ai', () => ({
  aiApi: {
    usage: vi.fn(async () => USAGE),
  },
}))

let root: Root
let container: HTMLDivElement

async function mount(): Promise<void> {
  act(() => { root.render(createElement(StrictMode, null, createElement(StatsTab))) })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => { await new Promise((resolve) => { window.setTimeout(resolve, 0) }) })
  }
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/** The widths the ranking bars were given, in the order the ranking shows them. */
function barWidths(): string[] {
  const panel = [...document.querySelectorAll('section')]
    .find((node) => (node.getAttribute('aria-label') ?? '') === cfT('cloudflare.ai_stats.model_ranking'))
  return [...(panel?.querySelectorAll('span[aria-hidden="true"] > span') ?? [])]
    .map((bar) => (bar as HTMLElement).style.width)
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('the AI statistics tab', () => {
  it('counts five headline numbers from one usage answer', async () => {
    await mount()
    // Accounts, the quota those accounts add up to, requests, distinct models, and the average.
    expect(text()).toContain(cfT('cloudflare.ai_stats.total_accounts'))
    expect(text()).toContain(cfT('cloudflare.ai_stats.total_quota'))
    expect(text()).toContain(cfT('cloudflare.ai_stats.avg_per_account'))
    expect(text()).toContain('20,000')
    expect(text()).toContain('772')
    expect(text()).toContain('2')
  })

  it('draws one bar per ranked model, sized against the busiest one', async () => {
    await mount()
    const widths = barWidths().map((width) => Number.parseFloat(width))
    expect(widths).toHaveLength(2)
    expect(widths[0]).toBe(100)
    expect(widths[1]).toBeCloseTo((143 / 1400) * 100, 6)
  })

  it('draws a ring per account that names its own rate', async () => {
    await mount()
    const labels = [...document.querySelectorAll('[role=img]')].map((node) => node.getAttribute('aria-label') ?? '')
    expect(labels.some((label) => label === 'Alpha: 15%')).toBe(true)
    expect(labels.some((label) => label === 'Beta: 0%')).toBe(true)
  })
})
