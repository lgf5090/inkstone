// @vitest-environment jsdom
/**
 * The chat view's own state, and the two races that live beside it.
 *
 * Everything here is what the reader feels and no store record explains: a historical answer that is
 * parsed again for no reason (the rows are memoised precisely so that cannot happen, and a callback built
 * per row defeats it), a thread that stops following a reply that is still thinking, an interaction mode
 * that outlives the conversation it was entered for, a trigger panel whose older lookup answers last and
 * wins, an index that turns into NaN when the panel has nothing to offer, and the citations an answer was
 * built on reaching the bubble of the turn that is still on screen.
 *
 * The view is mounted whole because these are the view's states — none of them is reachable from a store.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantMessage, type AssistantSource } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatComposer, ChatView } from './ChatView'

const harness = vi.hoisted(() => ({
  /** What `api.search` answers with, decided per case; the `@` trigger's only lookup. */
  search: null as null | ((query: string, limit: number) => Promise<{ results: Array<{ note: { id: string, title: string } }> }>),
  /** Every answer bubble the view rendered, counted by the id the row carries. */
  bubbles: new Map<string, { renders: number, onRetry?: (() => void) | undefined, sources?: unknown }>(),
}))

/** The confirm host is not mounted here, so the one dialog under test is answered by hand. */
const asked = vi.fn(async (_options: { title?: string, tone?: string }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, tone?: string }) => asked(options) }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    search: (query: string, limit: number) =>
      (harness.search ?? (async () => ({ results: [] })))(query, limit),
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

// The bubble is stood in for a counter: what is being measured is which rows the view re-rendered, and a
// real one would parse Markdown and pull in half the reading surface to say the same thing.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  interface Spied {
    messageId?: string
    onRetry?: (() => void) | undefined
    [key: string]: unknown
  }
  const AssistantBubble = (props: Spied): ReactNode => {
    const id = props.messageId ?? 'live'
    const seen = harness.bubbles.get(id) ?? { renders: 0 }
    seen.renders += 1
    seen.onRetry = props.onRetry
    seen.sources = props.sources
    harness.bubbles.set(id, seen)
    return createElement(
      'div',
      { 'data-answer': id },
      props.onRetry ? createElement('button', { type: 'button', onClick: () => props.onRetry?.() }, 'retry') : null,
    )
  }
  return { ...actual, AssistantBubble }
})

// The panel says which thread it was opened for and which turns it covers, which is the whole subject.
vi.mock('../share/ConversationSharePanel', () => ({
  ConversationSharePanel: ((props: { conversationId: string, messageIds?: readonly string[] }): ReactNode =>
    createElement('div', {
      'data-share-panel': props.conversationId,
      'data-scope': (props.messageIds ?? []).join(','),
    })) as unknown,
}))

type LiveTurn = NonNullable<ReturnType<typeof useAssistant.getState>['turn']>
type AssistantState = ReturnType<typeof useAssistant.getState>

const original = useAssistant.getState()
const sendTurn = vi.fn(async (_text: string, _options?: Record<string, unknown>) => true)

let root: Root
let host: HTMLElement

function liveTurn(over: Partial<LiveTurn> = {}): LiveTurn {
  return {
    conversationId: 'c1',
    userText: '',
    attachments: [],
    assistantId: null,
    text: '',
    reasoning: '',
    tools: [],
    stage: undefined,
    error: null,
    done: false,
    ...over,
  }
}

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

const THREAD = [
  message({ id: 'm-question', content: 'What did I ask?' }),
  message({ id: 'm-old', role: 'assistant', content: 'An answer the reader already read.' }),
  message({ id: 'm-new', role: 'assistant', content: 'The newest answer.' }),
]

async function mountView(over: Partial<AssistantState> = {}): Promise<void> {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [
      { id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number],
      { id: 'c2', title: 'Second thread', updatedAt: 1 } as AssistantState['conversations'][number],
    ],
    messages: THREAD,
    messagesReady: true,
    messagesHasMore: false,
    messagesHasNewer: false,
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
    send: sendTurn,
    // Nothing in these cases goes to the network; the view's own state is the subject.
    loadMcpServers: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>)
  await act(async () => { root.render(createElement(ChatView)) })
}

async function mountComposer(): Promise<void> {
  useAssistant.setState({
    ...original,
    pending: [],
    skills: [],
    models: [],
    providers: [],
    settings: null,
    turnTools: [],
    turnScopes: [],
    mcpServers: [],
    mcpCatalog: [],
    loadSkills: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
  } as Partial<AssistantState>)
  await act(async () => {
    root.render(createElement(ChatComposer, {
      streaming: false,
      sendOnEnter: true,
      onSend: async () => true,
      onStop: () => undefined,
      disabled: false,
    }))
  })
}

const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea')!
const scroller = () => document.querySelector<HTMLDivElement>('section div.no-scrollbar')
const renders = (id: string) => harness.bubbles.get(id)?.renders ?? 0
const sourcesOf = (id: string) => harness.bubbles.get(id)?.sources
const rowButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byText = (text: string) => rowButtons().find((node) => node.textContent?.includes(text))
const byAria = (label: string) => rowButtons().find((node) => node.getAttribute('aria-label') === label)
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [data-row]')].map((node) => node.textContent?.trim())
const markedOption = () => document.querySelector('[role="listbox"] [role="option"][aria-selected="true"]')?.textContent?.trim()
const isBusy = () => [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] p')].some((node) => node.textContent?.includes(t('common.loading')))

async function click(node: Element | null | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/**
 * Types into the controlled box the way the browser does: value first, then the event React reads.
 *
 * The settle inside the act lets the trigger lookup answer under the same act, which is the only way a
 * case can tell "the response arrived" from "the response is still owed".
 */
async function type(text: string): Promise<void> {
  const field = box()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, text)
    field.setSelectionRange(text.length, text.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A key as the reader pressed it, handed back so the case can read what the view did with it. */
function pressKey(key: string, init: KeyboardEventInit = {}, node: Element = box()): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { node.dispatchEvent(event) })
  return event
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  harness.bubbles.clear()
  harness.search = null
  asked.mockClear()
  asked.mockResolvedValue(true)
  sendTurn.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('a memoised answer row', () => {
  it('is not re-rendered, and keeps one callback identity, when the view re-renders', async () => {
    await mountView()
    expect(renders('m-old'), 'an older answer never reached the thread').toBeGreaterThan(0)
    const before = renders('m-old')
    const oldRetry = harness.bubbles.get('m-old')?.onRetry
    // Any store write the view subscribes to: a token of a live turn, a list refresh, an attachment.
    await act(async () => { useAssistant.setState({ conversations: [...useAssistant.getState().conversations] }) })
    expect(renders('m-old') - before, 'the view re-rendered a historical answer').toBe(0)
    expect(renders('m-new') - before, 'the view re-rendered the newest answer').toBe(0)
    expect(harness.bubbles.get('m-old')?.onRetry, 'the row was handed a new callback').toBe(oldRetry)
  })

  it('asks the newest answer again straight out, and an older one only after confirming', async () => {
    await mountView()
    await click(document.querySelector<HTMLElement>('[data-answer="m-new"] button'), 'the newest answer’s retry')
    expect(asked, 'the newest answer was confirmed before being asked again').not.toHaveBeenCalled()
    expect(sendTurn).toHaveBeenCalledWith('', { retry: true })

    await click(document.querySelector<HTMLElement>('[data-answer="m-old"] button'), 'an older answer’s retry')
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.chat.regenerate_middle_title'), tone: 'danger' }))
    expect(sendTurn).toHaveBeenLastCalledWith('', { retry: true, messageId: 'm-old' })
  })
})

describe('a thread that is still being written', () => {
  it('keeps following the bottom while the reasoning stream grows', async () => {
    await mountView({ messages: [], turn: liveTurn({ reasoning: 'thinking about it' }) })
    const el = scroller()
    expect(el, 'the thread has no scroller').toBeTruthy()
    // jsdom lays nothing out and stores no scroll position, so the box states both by hand.
    let applied = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 4_000 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => applied, set: (value: number) => { applied = value } })
    expect(applied).toBe(0)

    await act(async () => {
      useAssistant.setState({ turn: liveTurn({ reasoning: 'thinking about it, and then some more' }) })
    })
    expect(applied, 'the thread stopped following the reader during the reasoning').toBe(4_000)
  })
})

describe('switching the conversation', () => {
  it('leaves no interaction state of the thread that was left behind', async () => {
    await mountView({ messages: [message({ id: 'm-question', content: 'What did I ask?' })] })

    await click(byAria(t('assistant.chat.message_actions')), 'the turn’s menu')
    await click(byText(t('assistant.chat.select_messages')), 'the menu’s pick-this-turn row')
    expect(document.body.querySelector('[role="toolbar"]'), 'picking never opened').toBeTruthy()

    await click(byAria(t('assistant.chat.message_actions')), 'the turn’s menu')
    await click(byText(t('assistant.chat.share_message')), 'the menu’s share row')
    expect(document.body.querySelector<HTMLElement>('[data-share-panel]')?.dataset.sharePanel).toBe('c1')
    expect(document.body.querySelector<HTMLElement>('[data-share-panel]')?.dataset.scope).toBe('m-question')

    // Ctrl/Cmd+F is the reader's own reflex, and the panel it opens belongs to this thread only.
    pressKey('f', { ctrlKey: true })
    expect(document.body.querySelector('[role="search"]'), 'the find panel never opened').toBeTruthy()

    await act(async () => { useAssistant.setState({ activeId: 'c2', messages: [] }) })
    expect(document.body.querySelector('[role="toolbar"]'), 'the picker survived the switch').toBeNull()
    expect(document.body.querySelector('[data-share-panel]'), 'the share panel survived the switch').toBeNull()
    expect(document.body.querySelector('[role="search"]'), 'the find panel survived the switch').toBeNull()
  })
})

describe('the composer’s trigger panel', () => {
  it('applies only the newest lookup, whichever answer arrives last', async () => {
    const stale = deferred<{ results: Array<{ note: { id: string, title: string } }> }>()
    harness.search = (query) => (query === 'old'
      ? stale.promise
      : Promise.resolve({ results: [{ note: { id: 'n-new', title: `row for ${query}` } }] }))
    await mountComposer()

    await type('@old')
    await type('@new')
    expect(options()).toEqual(['row for new'])

    await act(async () => { stale.resolve({ results: [{ note: { id: 'n-old', title: 'the stale answer' } }] }) })
    expect(options(), 'a stale response overwrote the rows the reader is looking at').toEqual(['row for new'])
  })

  it('leaves the loading indicator to the request that is still in flight', async () => {
    const first = deferred<{ results: Array<{ note: { id: string, title: string } }> }>()
    const second = deferred<{ results: Array<{ note: { id: string, title: string } }> }>()
    harness.search = (query) => (query === 'a' ? first.promise : query === 'ab' ? second.promise : Promise.resolve({ results: [] }))
    await mountComposer()

    await type('@a')
    await type('@ab')
    expect(isBusy(), 'the panel stopped saying it was working').toBe(true)

    await act(async () => { first.resolve({ results: [] }) })
    expect(isBusy(), 'an older response cleared the indicator a newer request is holding').toBe(true)

    await act(async () => { second.resolve({ results: [{ note: { id: 'n', title: 'the newest row' } }] }) })
    expect(options()).toEqual(['the newest row'])
    expect(isBusy()).toBe(false)
  })

  it('hands the arrows back to the text box when there is nothing to pick', async () => {
    harness.search = async () => ({ results: [] })
    await mountComposer()
    await type('@half')
    expect(document.body.querySelector('[role="listbox"]'), 'the panel did not open').toBeTruthy()
    expect(options(), 'the panel offered a row it does not have').toHaveLength(0)

    const down = pressKey('ArrowDown')
    expect(down.defaultPrevented, 'the panel swallowed a key it had nothing to answer').toBe(false)

    // Stepping out of the trigger is what Enter means with no row to pick, and the words stay.
    const enter = pressKey('Enter')
    expect(enter.defaultPrevented, 'Enter reached the send binding under an open trigger').toBe(true)
    expect(box().value, 'the half-typed mention was thrown out of the composer').toBe('@half')
  })

  it('still steps and picks while there are rows to answer with', async () => {
    harness.search = async () => ({
      results: [{ note: { id: 'a', title: 'Alpha' } }, { note: { id: 'b', title: 'Beta' } }],
    })
    await mountComposer()
    await type('@')
    expect(options()).toEqual(['Alpha', 'Beta'])
    expect(markedOption()).toBe('Alpha')

    expect(pressKey('ArrowDown').defaultPrevented, 'the panel gave the arrow back while it had rows').toBe(true)
    expect(markedOption()).toBe('Beta')
    pressKey('Enter')
    expect(box().value).toBe('[[Beta]]')
  })
})

describe('the citations an answer was built on', () => {
  const PAGE: AssistantSource = { url: 'https://example.com/a', title: 'A page' }

  it('reaches the bubble of the turn still on screen, not only the one read back later', async () => {
    // The worker files the citations on the row it writes, and the row is what the next read returns.
    // Until then this turn's own record is the only place they exist, so a searched answer that has
    // just landed has to be drawn with them — otherwise the reader is shown a claim that came from
    // outside the vault with nothing saying where.
    await mountView({ turn: liveTurn({ done: true, text: 'It says so here.', sources: [PAGE] }) })
    expect(sourcesOf('live')).toEqual([PAGE])
  })

  it('reaches a stored answer too, which is the copy the thread is reopened to', async () => {
    await mountView({ messages: [...THREAD, message({ id: 'm-cited', role: 'assistant', content: 'Sourced.', sources: [PAGE] })] })
    expect(sourcesOf('m-cited')).toEqual([PAGE])
  })
})
