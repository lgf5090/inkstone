// @vitest-environment jsdom
/**
 * The ceiling on how much of one thread a tab keeps, and what it says about the turns above it.
 *
 * "Load earlier" is a pure append: a reader who pressed it twenty times stacked 1,200 rendered bubbles
 * into the DOM for a thread they opened at its newest turn. `MAX_LOADED_MESSAGES` is the arithmetic that
 * stops that — whole pages of `MESSAGE_PAGE_SIZE`, the most of them that still fit under the route's own
 * ceiling — and the other half of the case is that reaching a limit may not be allowed to look like the
 * conversation ended. So every case below asks both questions: did the fetch stop, and does the screen
 * still say plainly that older turns exist?
 *
 * A disabled control is only honest with its reason attached, which is why the assertions read
 * `aria-describedby` rather than merely the text somewhere near it.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, MESSAGE_PAGE_SIZE, type AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { MAX_LOADED_MESSAGES, useAssistant } from './assistant-store'
import { ChatView } from './ChatView'
import { ThreadFinder } from './ThreadFinder'

const harness = vi.hoisted(() => ({
  /** Every page the thread route was asked for, in the order it was asked. */
  pages: [] as Array<{ before?: string, limit?: string }>,
  /** Bumped per answer, so a second page never collides with the rows already on screen. */
  page: 0,
}))

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
      // The paging call the ceiling governs. It answers with a whole page, because it is the request
      // that is being counted and the rows are what a page costs.
      conversation: async (_id: string, params: { before?: string, limit?: string } = {}) => {
        harness.pages.push(params)
        const page = harness.page++
        const rows = Array.from({ length: 60 }, (_unused, index) => ({
          id: `p${page}-m${index}`,
          conversationId: 'c1',
          role: 'assistant' as const,
          content: `Answer from page ${page}`,
          reasoning: '',
          tools: [],
          attachments: [],
          status: 'complete' as const,
          error: null,
          createdAt: 1_700_000_000_000,
          source: 'chat' as const,
        }))
        return {
          conversation: { id: 'c1', title: 'First thread', updatedAt: 2 },
          messages: rows,
          attachments: [],
          streaming: false,
          hasMore: true,
          hasNewer: false,
          nextBefore: 'cursor-older',
        }
      },
    },
  },
}))

// The bubble is a stub: which rows the view drew is not the subject, and 480 of them rendering real
// Markdown would measure the renderer rather than the paging control.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  const AssistantBubble = ({ messageId }: { messageId?: string }): ReactNode =>
    createElement('div', { 'data-answer': messageId })
  return { ...actual, AssistantBubble }
})

type AssistantState = ReturnType<typeof useAssistant.getState>
const original = useAssistant.getState()

let root: Root
let host: HTMLElement

function message(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    content: '',
    reasoning: '',
    tools: [],
    attachments: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

/** A thread of `count` answers, oldest first, with ids the assertions can point at. */
function thread(count: number): AssistantMessage[] {
  return Array.from({ length: count }, (_unused, index) =>
    message({ id: `m-${index}`, role: 'assistant', content: `Answer ${index}` }))
}

function baseState(over: Partial<AssistantState> = {}): Partial<AssistantState> {
  return {
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number]],
    messagesReady: true,
    messagesError: null,
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
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    loadMcpServers: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>
}

async function mountView(over: Partial<AssistantState> = {}): Promise<void> {
  useAssistant.setState(baseState(over))
  await act(async () => { root.render(createElement(ChatView)) })
}

function mountFinder(props: Parameters<typeof ThreadFinder>[0]): Promise<void> {
  return act(async () => { root.render(createElement(ThreadFinder, props)) })
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const earlierButton = () =>
  buttons().find((node) => node.textContent?.includes(t('assistant.chat.load_earlier')))
/** The sentence a disabled control is described by, read through the reference rather than by luck. */
function describedBy(node: HTMLElement): string | null {
  const id = node.getAttribute('aria-describedby')
  if (!id) return null
  return document.getElementById(id)?.textContent ?? null
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  harness.pages.length = 0
  harness.page = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the ceiling on a loaded thread', () => {
  it('counts whole pages, so a page the reader asks for is never the one the route trims', () => {
    // The arithmetic the constant claims for itself: 8 × 60 = 480, the most of `MESSAGE_PAGE_SIZE` that
    // still fits under the conversation route's own 500.
    expect(MAX_LOADED_MESSAGES % MESSAGE_PAGE_SIZE).toBe(0)
    expect(MAX_LOADED_MESSAGES).toBe(480)
    expect(MAX_LOADED_MESSAGES).toBeLessThanOrEqual(500)
  })

  it('asks for a page while the ceiling is still ahead of it', async () => {
    useAssistant.setState(baseState({
      messages: thread(MAX_LOADED_MESSAGES - MESSAGE_PAGE_SIZE),
      messagesHasMore: true,
      messagesBefore: 'cursor-here',
    }))
    await act(async () => { await useAssistant.getState().loadEarlierMessages() })
    expect(harness.pages, 'a thread below the ceiling stopped paging').toEqual([{
      limit: String(MESSAGE_PAGE_SIZE),
      before: 'cursor-here',
    }])
    expect(useAssistant.getState().messages).toHaveLength(MAX_LOADED_MESSAGES)
  })

  it('stops fetching at the ceiling and still says the older turns exist', async () => {
    useAssistant.setState(baseState({
      messages: thread(MAX_LOADED_MESSAGES),
      messagesHasMore: true,
      messagesBefore: 'cursor-here',
    }))
    await act(async () => { await useAssistant.getState().loadEarlierMessages() })
    expect(harness.pages, 'the ceiling was walked past by another page').toEqual([])
    // The server's answer is kept, not quietly rewritten to "there is nothing more above": that flag is
    // what keeps both controls and the find panel's sentence telling the truth.
    expect(useAssistant.getState().messagesHasMore, 'hitting the limit was reported as the end of the thread').toBe(true)
    expect(useAssistant.getState().messages).toHaveLength(MAX_LOADED_MESSAGES)
    expect(useAssistant.getState().messagesLoadingMore, 'a refused page left the spinner up').toBe(false)
  })

  it('keeps the control on screen, unavailable, and naming its own reason', async () => {
    await mountView({
      messages: thread(MAX_LOADED_MESSAGES),
      messagesHasMore: true,
      messagesBefore: 'cursor-here',
    })
    const control = earlierButton()
    expect(control, 'the control disappeared instead of going unavailable').toBeTruthy()
    expect(control!.disabled, 'the control still answers at the ceiling').toBe(true)
    expect(describedBy(control!), 'an unavailable control says nothing').toBe(
      t('assistant.chat.earlier_capped', { limit: MAX_LOADED_MESSAGES }),
    )
  })

  it('leaves the control answering, and says nothing about a ceiling, one page short of it', async () => {
    await mountView({
      messages: thread(MAX_LOADED_MESSAGES - MESSAGE_PAGE_SIZE),
      messagesHasMore: true,
      messagesBefore: 'cursor-here',
    })
    const control = earlierButton()
    expect(control, 'the load-earlier control is not drawn').toBeTruthy()
    expect(control!.disabled, 'a thread below the ceiling was refused its page').toBe(false)
    expect(describedBy(control!), 'a limit that was not reached was announced').toBeNull()
    expect(document.body.textContent, 'the ceiling was named before it was reached').not.toContain(
      t('assistant.chat.earlier_capped', { limit: MAX_LOADED_MESSAGES }).slice(0, 12),
    )
  })
})

describe('the find panel over a thread at its ceiling', () => {
  const scrollerRef = { current: null as HTMLElement | null }
  const props = (over: Partial<Parameters<typeof ThreadFinder>[0]> = {}): Parameters<typeof ThreadFinder>[0] => ({
    scroller: scrollerRef,
    revision: 0,
    hasEarlier: true,
    hasLater: false,
    loadingEarlier: false,
    onLoadEarlier: () => undefined,
    onJumpLatest: () => undefined,
    onClose: () => undefined,
    ...over,
  })

  /** A phrase with no hit: that is the one case the panel says the unloaded turns about. */
  async function ask(): Promise<void> {
    const field = document.body.querySelector<HTMLInputElement>('input[aria-label]')
    expect(field, 'the panel drew no search box').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(field, 'plan')
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent, 'the page is not reported as holding unloaded turns').toContain(
      t('assistant.chat.find_unloaded'),
    )
  }

  beforeEach(() => {
    const transcript = document.createElement('div')
    transcript.innerHTML = '<p>the first page, nothing the reader asked about</p>'
    document.body.append(transcript)
    scrollerRef.current = transcript
  })

  it('hands over the same unavailable control and the same reason', async () => {
    await mountFinder(props({ earlierCapped: true }))
    await ask()
    const control = earlierButton()
    expect(control, 'the panel dropped the control the thread still shows').toBeTruthy()
    expect(control!.disabled, 'the panel offers a page the store will not fetch').toBe(true)
    expect(describedBy(control!), 'the panel stopped answering without saying why').toBe(
      t('assistant.chat.earlier_capped', { limit: MAX_LOADED_MESSAGES }),
    )
  })

  it('offers the store’s own page while the ceiling is ahead', async () => {
    const onLoadEarlier = vi.fn()
    await mountFinder(props({ onLoadEarlier }))
    await ask()
    const control = earlierButton()
    expect(control!.disabled, 'a thread below the ceiling lost its page control').toBe(false)
    expect(describedBy(control!), 'a limit that does not apply was named here too').toBeNull()
    await act(async () => { control!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(onLoadEarlier, 'the panel’s control no longer reaches the store’s paging').toHaveBeenCalledTimes(1)
  })
})
