// @vitest-environment jsdom
/**
 * Three screens whose request was refused.
 *
 * Each of these used to answer a failure with the shape of a different state: the settings shell kept its
 * spinner, the budget tab kept the spinner the usage request itself renders while in flight, and a memory's
 * history dialog answered "no earlier versions" — a sentence that teaches the reader their history is gone.
 * What is pinned here is that a refusal is now named as one, that the named refusal offers the retry, and
 * that the retry actually asks again. The wording of the success path is only checked where the fixture can
 * reach it without a whole tab's worth of wiring.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMemory } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { AssistantSettingsView } from './AssistantSettingsView'
import { BudgetTab } from './AssistantBudgetTab'
import { MemoryView } from './MemoryView'

const { settings, providers, usage, memoryHistory } = vi.hoisted(() => ({
  settings: vi.fn(async () => { throw new Error('settings offline') }),
  providers: vi.fn(async () => { throw new Error('providers offline') }),
  usage: vi.fn(async () => { throw new Error('usage offline') }),
  memoryHistory: vi.fn(async () => { throw new Error('history offline') }),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    assistant: { settings, providers, usage, memoryHistory },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

const MEMORY: AssistantMemory = {
  id: 'm1',
  content: 'Lives in Bristol',
  category: 'fact',
  source: 'manual',
  status: 'active',
  supersededBy: null,
  validFrom: null,
  validUntil: null,
  projectId: null,
  noteId: null,
  createdAt: 2,
  updatedAt: 2,
}

const EARLIER: AssistantMemory = { ...MEMORY, id: 'm0', content: 'Lived in Leeds', createdAt: 1, updatedAt: 1 }

const original = useAssistant.getState()
let rendered: RenderedElement | null = null

const alert = () => document.body.querySelector<HTMLElement>('[role="alert"]')
const retry = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((node) => node.textContent?.trim() === t('common.retry'))

/** Lets the pending rejection land, and the state it writes render. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function expectRefusal(): Promise<void> {
  await vi.waitFor(() => expect(alert(), 'the refusal is not named').toBeTruthy(), { timeout: 5000, interval: 10 })
  expect(retry(), 'the refusal offers no retry').toBeTruthy()
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the assistant settings shell', () => {
  it('says the settings were refused instead of going on spinning', async () => {
    useAssistant.setState({ ...original, settings: null })
    rendered = renderElement(createElement(AssistantSettingsView))
    await settle()
    await expectRefusal()
    expect(alert()!.textContent).toContain(t('assistant.settings.load_failed'))
    const asked = settings.mock.calls.length
    act(() => { retry()!.click() })
    await settle()
    expect(settings.mock.calls.length).toBe(asked + 1)
  })
})

describe('the budget tab', () => {
  it('names a refused usage request instead of showing its spinner', async () => {
    useAssistant.setState({ ...original, models: [], saveSettings: async () => {} })
    rendered = renderElement(createElement(BudgetTab, { settings: DEFAULT_ASSISTANT_SETTINGS }))
    await settle()
    await expectRefusal()
    expect(alert()!.textContent).toContain(t('assistant.settings.usage_failed'))
    const asked = usage.mock.calls.length
    act(() => { retry()!.click() })
    await settle()
    expect(usage.mock.calls.length).toBe(asked + 1)
  })

  it('prints the numbers and stops complaining once the retry answers', async () => {
    useAssistant.setState({ ...original, models: [], saveSettings: async () => {} })
    rendered = renderElement(createElement(BudgetTab, { settings: DEFAULT_ASSISTANT_SETTINGS }))
    await settle()
    await expectRefusal()
    usage.mockResolvedValueOnce({
      today: { requests: 3, inputTokens: 10, outputTokens: 20, toolCalls: 1, scheduledRuns: 0 },
      last7Days: { requests: 9, errors: 0 },
    } as never)
    act(() => { retry()!.click() })
    await settle()
    expect(alert()).toBeNull()
    expect(document.body.textContent).toContain('3 / ')
  })
})

describe('a memory’s history', () => {
  async function openHistory(): Promise<void> {
    useAssistant.setState({
      ...original,
      memories: [MEMORY],
      memoryCounts: { active: 1, historical: 0, review: 0 },
      memoryTotal: 1,
      memoryQuery: '',
      memoryStatus: 'all',
      reviews: [],
      projects: [],
      loadMemories: async () => {},
      loadProjects: async () => {},
      setMemoryFilter: async () => {},
    })
    rendered = renderElement(createElement(MemoryView))
    const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.memory.history'))
    expect(button, 'the history action is missing').toBeTruthy()
    act(() => { button!.click() })
    await settle()
  }

  it('says the earlier versions could not be read, rather than that there are none', async () => {
    await openHistory()
    await expectRefusal()
    expect(alert()!.textContent).toContain(t('assistant.memory.history_failed'))
    // The sentence the failure used to produce: a reader who believes it stops looking.
    expect(document.body.textContent).not.toContain(t('assistant.memory.no_earlier'))
    const asked = memoryHistory.mock.calls.length
    act(() => { retry()!.click() })
    await settle()
    expect(memoryHistory.mock.calls.length).toBe(asked + 1)
  })

  it('shows the earlier versions once the retry answers', async () => {
    await openHistory()
    await expectRefusal()
    memoryHistory.mockResolvedValueOnce({ previous: [EARLIER], next: [] } as never)
    act(() => { retry()!.click() })
    await settle()
    expect(alert()).toBeNull()
    expect(document.body.textContent).toContain(EARLIER.content)
  })
})
