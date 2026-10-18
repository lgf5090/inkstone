// @vitest-environment jsdom
/**
 * Where the thread's size is said, and what the box the reader writes in is not allowed to carry.
 *
 * The reading used to be drawn inside the composer, under the words being typed: a measurement in the one
 * place that has to stay quiet, and one the reader complained about by name. It now hangs in the header, as
 * a ring, beside the title, the project and the note the thread came from. Both halves are pinned — the ring
 * present where it belongs, and no meter anywhere in the box — because the quiet way for this change to
 * come undone is for one of the two to be put back.
 *
 * jsdom lays nothing out: the assertions read which subtree carries the control, the names the controls
 * announce and the panel a press is owed, never a position or a size.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantModel } from '@shared/assistant'
import { DEFAULT_ASSISTANT_SETTINGS, formatTokenStep } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ChatView } from './ChatView'
import { useAssistant } from './assistant-store'

const asked = vi.fn(async (_options: { title?: string, tone?: string }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, tone?: string }) => asked(options) }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: async () => ({ results: [] }),
    tags: { list: async () => ({ tags: [] }) },
    folders: { list: async () => ({ folders: [] }) },
    notes: {},
    assistant: {
      skills: async () => ({ skills: [] }),
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      conversationArtifacts: async () => ({ artifacts: [] }),
    },
  },
}))

// The stored answers are replaced by their own text: what is read here is the chrome around the transcript,
// and a real bubble would drag half the reading surface in to say the same thing.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  const AssistantBubble = ((props: { content?: string }): ReactNode =>
    createElement('div', { 'data-found-answer': true }, props.content ?? '')) as unknown as typeof actual.AssistantBubble
  return { ...actual, AssistantBubble }
})

vi.mock('../share/ConversationSharePanel', () => ({
  ConversationSharePanel: (() => null) as unknown,
}))

type AssistantState = ReturnType<typeof useAssistant.getState>
const originalState = useAssistant.getState()

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'deepseek-flash', label: 'DeepSeek Flash',
    temperature: 0.7, maxOutputTokens: 8_192, enabled: true, reasoning: 'auto', contextTokens: 65_536, vision: true,
    purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: 57_344, modalities: [], topP: null,
    customParams: [], protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '',
    ...over,
  }
}

function message(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: 'm-page', conversationId: 'c1', role: 'user', content: 'x'.repeat(400), reasoning: '', tools: [],
    attachments: [], status: 'complete', error: null, createdAt: 1_700_000_000_000, source: 'chat', ...over,
  }
}

/** The thread the view is shown: three loaded turns, and older ones behind a page that was never asked for. */
async function mountView(over: Partial<AssistantState> = {}): Promise<void> {
  await act(async () => {
    useAssistant.setState({
      ...originalState,
      view: 'chat',
      activeId: 'c1',
      conversations: [{ id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number]],
      messages: [message({ id: 'm1' }), message({ id: 'm2' }), message({ id: 'm3' })],
      messagesReady: true,
      messagesHasMore: true,
      messagesHasNewer: false,
      messagesLoadingMore: false,
      turn: null,
      remoteStreaming: false,
      pending: [],
      turnTools: [],
      turnScopes: [],
      fileIndex: {},
      canvasOpen: false,
      ephemeral: false,
      focusMessageId: null,
      models: [model()],
      settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
      loadMcpServers: vi.fn(async () => undefined),
      loadSkills: vi.fn(async () => undefined),
      loadTaxonomy: vi.fn(async () => undefined),
      loadFlagged: vi.fn(async () => undefined),
      setConversationQuery: vi.fn(async () => undefined),
      openConversation: vi.fn(async () => undefined),
      loadEarlierMessages: vi.fn(async () => undefined),
      ...over,
    } as Partial<AssistantState>)
    root.render(createElement(ChatView))
  })
}

let root: Root
let host: HTMLElement

const box = () => {
  const field = document.body.querySelector<HTMLTextAreaElement>('textarea')
  expect(field, 'the composer box is not drawn').toBeTruthy()
  return field!.parentElement!
}
const ring = () => document.body.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${t('assistant.context.meter_label')}"]`)
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const named = (name: string) => buttons().find((node) => node.getAttribute('aria-label') === name)
const click = async (node: Element | null, what: string): Promise<void> => {
  expect(node, what).toBeTruthy()
  await act(async () => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const panel = () => document.body.querySelector<HTMLElement>('[role="note"]')

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(originalState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the reading leaves the box', () => {
  it('draws no meter between the words being typed and the row under them', async () => {
    await mountView()
    expect(box().querySelector('[role="progressbar"]'), 'a meter is drawn inside the composer box').toBeNull()
    expect(box().textContent, 'the meter’s words are still printed in the box').not.toContain(t('assistant.context.meter_label'))
    expect(box().textContent).not.toContain(t('assistant.context.meter_scope'))
  })

  it('wears the ring in the header row instead', async () => {
    await mountView()
    const used = 3 * 104
    expect(ring(), 'the header carries no context ring').toBeTruthy()
    expect(ring()!.closest('.h-9'), 'the ring is not in the header row').toBeTruthy()
    expect(box().contains(ring()!), 'the ring is still inside the composer box').toBe(false)
    expect(ring()!.getAttribute('aria-valuenow')).toBe(String(Math.min(100, Math.round((used / 49_152) * 100))))
    expect(named(t('assistant.context.ring_summary', { used: formatTokenStep(used), limit: formatTokenStep(49_152) })),
      'the header control does not name itself with the reading').toBeTruthy()
  })

  it('opens the panel from the header, and says there what the number cannot see', async () => {
    await mountView()
    const trigger = ring()!.closest('button')
    expect(panel(), 'a panel is drawn before anything is pressed').toBeNull()
    await click(trigger, 'the ring is not drawn')
    expect(panel(), 'the press did not open the panel').toBeTruthy()
    expect(panel()?.textContent).toContain(t('assistant.context.meter_older'))
    expect(panel()?.textContent).toContain(t('assistant.context.meter_scope'))
  })

  it('says nothing when the model on screen states no window at all', async () => {
    await mountView({ models: [model({ contextTokens: null, maxInputTokens: null, maxOutputTokens: null })] })
    expect(ring(), 'the header stopped drawing the ring').toBeTruthy()
    expect(ring()!.getAttribute('aria-valuenow'), 'an invented budget was announced').toBeNull()
    expect(named(t('assistant.context.ring_unknown')), 'the control claims a number it does not have').toBeTruthy()
    await click(ring()!.closest('button'), 'the ring is not drawn')
    // The digits of the thread, and the fraction the clamp used to dress them in, are both absent.
    expect(panel()?.textContent).not.toContain('312')
    expect(panel()?.textContent, 'a reading nobody stated was printed as a fraction').not.toContain('/')
    expect(panel()?.textContent).not.toContain(t('assistant.context.meter_warning'))
  })
})
