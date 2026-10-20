// @vitest-environment jsdom
/**
 * What a broken stream may promise, measured against the controls the transcript actually draws.
 *
 * The line a turn prints when its bytes stop arriving says two things: that the words already received
 * stay on the screen, and that the reader can press the continue control to have the answer carried on. The
 * second is a statement about this document, not about the transport, and the first is a statement about
 * what the bubble holds — so both are checked here the way a reader would check them: by rendering the
 * thread, breaking its stream, and asking whether the sentence on the screen can point at the thing it
 * names.
 *
 * Three states, and the promise is only true in one of them:
 *
 * - the half answer is filed and is the newest thing in the thread, so its row draws the control: the
 *   sentence may name it, and it is the case that has to keep saying what it says today;
 * - the break came first and the row is not on the screen yet — the bubble is kept up because the worker
 *   still holds the lease — so nothing can be pressed, and the words for that moment must not offer it;
 * - no word arrived at all, so there is no half answer kept anywhere, and a line that claims one is
 *   describing an answer that was never written.
 *
 * The fourth state the report asked about is the version pager: `MessageParts.tsx` hides the control while
 * the reader is looking at an older answer. That is checked as a row that *carries* a pager, because the
 * transcript cannot see which page the reader is on — see the last case for why the sentence has to stay
 * silent there too.
 *
 * jsdom lays nothing out: every claim below is about a node in the tree, its role and its accessible
 * name, and none about a rectangle.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation, type AssistantMessage, type AssistantModel } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatView } from './ChatView'
import { StreamDisconnectedError } from './stream'

interface Run {
  input: Record<string, unknown>
  apply: (event: Record<string, unknown>) => void
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
}

const harness = vi.hoisted(() => ({
  /** Every stream the store asked for, in order. */
  runs: [] as Run[],
  /**
   * What the thread read answers with, and whether the worker still holds the lease.
   *
   * `streaming: true` with a filed row is the window the promise is tested in: the bubble is kept up until
   * a read says the run is over, so the line and the row are on the screen together.
   */
  read: { messages: [] as unknown[], streaming: true },
}))

/** The confirm overlay is not mounted here, so a dialog would be answered by hand. */
const asked = vi.fn(async (_options: { title?: string, tone?: string }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, tone?: string }) => asked(options) }
})

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: unknown,
      readonly serverMessage?: string,
    ) {
      super(message)
      this.name = 'ApiError'
    }
  },
  CLIENT_ID: 'test-client',
  api: {
    search: async () => ({ results: [] }),
    tags: { list: async () => ({ tags: [] }) },
    folders: { list: async () => ({ folders: [] }) },
    notes: {},
    assistant: {
      skills: async () => ({ skills: [] }),
      cancel: async () => ({}),
      chatFileUrl: (id: string) => `blob:inkstone/${id}`,
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      conversationArtifacts: async () => ({ artifacts: [] }),
      conversation: async (id: string) => ({
        conversation: { id, title: 'Broken thread', updatedAt: 2, ephemeral: false },
        messages: harness.read.messages,
        attachments: [],
        streaming: harness.read.streaming,
        hasMore: false,
        nextBefore: null,
        hasNewer: false,
      }),
      deleteConversation: async () => ({}),
      updateModel: async () => ({}),
      saveSettings: async (patch: Record<string, unknown>) => ({
        settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: patch.activeModelId },
      }),
    },
  },
}))

// Only the transport is stood in for. The error the reading loop raises when the bytes give out is the
// real one, because its `name` is exactly how the store is told a broken stream apart from a refusal.
vi.mock('./stream', async () => {
  const actual = await vi.importActual<typeof import('./stream')>('./stream')
  return {
    ...actual,
    streamAssistantTurn: (
      input: Record<string, unknown>,
      apply: (event: Record<string, unknown>) => void,
      signal: AbortSignal,
    ) => new Promise<void>((resolve, reject) => {
      harness.runs.push({ input, apply, signal, resolve, reject })
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }),
  }
})

type AssistantState = ReturnType<typeof useAssistant.getState>
const original = useAssistant.getState()

const PARTIAL = 'half an answer that the bytes stopped short of'
const QUESTION = 'a long question'

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'model-1',
    providerId: 'p1',
    model: 'test-model',
    label: 'Test model',
    temperature: 0.7,
    maxOutputTokens: 8_192,
    enabled: true,
    reasoning: 'auto',
    contextTokens: null,
    vision: true,
    purpose: 'chat',
    kind: 'text',
    supportsTools: true,
    maxInputTokens: null,
    modalities: [],
    topP: null,
    customParams: [],
    protocol: null,
    fallbackModelId: null,
    inputPrice: null,
    outputPrice: null,
    priceCurrency: '', pricePeriods: [], icon: '',
    ...over,
  }
}

function assistantRow(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm-answer',
    conversationId: 'c1',
    role: 'assistant',
    content: PARTIAL,
    reasoning: '',
    tools: [],
    attachments: [],
    // Filed as a cancelled answer: that is what a run whose stream died under it becomes, and it is the
    // status that still draws the row's own controls.
    status: 'cancelled',
    error: null,
    createdAt: 2,
    source: 'chat',
    ...over,
  }
}

function userRow(): AssistantMessage {
  return assistantRow({ id: 'm-question', role: 'user', content: QUESTION, status: 'complete', createdAt: 1 })
}

function resetState(over: Partial<AssistantState> = {}): void {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'Broken thread', updatedAt: 2, ephemeral: false } as AssistantConversation],
    messages: [],
    messagesReady: true,
    messagesError: null,
    messagesHasMore: false,
    messagesHasNewer: false,
    turn: null,
    remoteStreaming: false,
    remotePartial: null,
    remotePartialTruncated: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    skills: [],
    models: [model()],
    providers: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    mcpServers: [],
    mcpCatalog: [],
    ephemeral: false,
    canvasOpen: false,
    focusMessageId: null,
    compareOn: false,
    compareTurn: null,
    // The after-turn refreshes reach for routes these cases do not exercise.
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
    loadMcpServers: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    loadArtifacts: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>)
}

let root: Root
let host: HTMLElement

/** Let the store finish what the last action started, including the read that follows a broken stream. */
async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

async function mount(over: Partial<AssistantState> = {}): Promise<void> {
  resetState(over)
  await act(async () => { root.render(createElement(ChatView)) })
}

/** The failure the reading loop raises when the bytes of a turn simply stop coming. */
function disconnected(): StreamDisconnectedError {
  return new StreamDisconnectedError('The assistant stream ended before the turn was answered.', {
    cause: new TypeError('Failed to fetch'),
  })
}

/**
 * Ask the thread a question, watch `words` of the answer arrive, and break its stream.
 *
 * Pass `null` for `words` for the case where nothing arrived. The read after the break is what the thread
 * comes back with, which is how the two states that have no row and have one are built apart.
 */
async function breakTheStream(words: string | null): Promise<void> {
  let sending: Promise<boolean> | undefined
  // Asked inside `act`, because the store's own first write — the turn on the screen, the composer's draft
  // going with it — is what the thread then renders.
  await act(async () => { sending = useAssistant.getState().send(QUESTION) })
  // Never awaited: the send is still asleep in the chase after the worker's row when these cases assert.
  void Promise.resolve(sending).catch(() => { /* The send is still in flight while these assertions run; what it settles into is read off the store, so this promise's own outcome is nobody's evidence here. */ })
  await settle()
  const run = harness.runs[0]
  expect(run, 'the turn never reached the transport').toBeTruthy()
  await act(async () => { run!.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer', runToken: 1 }) })
  if (words !== null) await act(async () => { run!.apply({ type: 'text', delta: words }) })
  await act(async () => { run!.reject(disconnected()) })
  // The failure line, then the read that follows it and the rows it brings back: the chase writes twice
  // more before it goes to sleep, and each of those is a render.
  await settle()
  await settle()
}

/** The one alert the turn's bubble prints — the sentence this file is about. */
function failureLine(): string {
  const nodes = [...document.body.querySelectorAll<HTMLElement>('[role="alert"]')]
  expect(nodes, 'a broken stream left no failure line on the screen').toHaveLength(1)
  return nodes[0]!.textContent ?? ''
}

/** The control the sentence names, found by the accessible name it is drawn with. */
const continueButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .filter((node) => (node.getAttribute('aria-label') ?? '') === t('assistant.chat.continue'))

/** A row that can be stepped back to an older answer, which hides that control while it is being read. */
const pagerGroups = () => [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
  .filter((node) => (node.getAttribute('aria-label') ?? '') === t('assistant.chat.answer_history'))

/** The words of an answer, as the transcript draws them. */
const answerBodies = () => [...document.body.querySelectorAll<HTMLElement>('[data-answer-body]')]

/**
 * The invariant every case below is one instance of.
 *
 * A line that names a control has to have that control in the same document, and a line that claims the
 * words already received are kept has to have those words on the screen. Checked against the catalog text
 * rather than a key, because what the reader reads is text.
 */
function expectLineKeepsItsPromise(): void {
  const line = failureLine()
  if (!line.includes(t('assistant.chat.continue'))) return
  expect(continueButtons().length, `the failure line names a control the transcript does not draw: ${line}`)
    .toBeGreaterThan(0)
  expect(answerBodies().length, `the failure line claims words that no answer on the screen carries: ${line}`)
    .toBeGreaterThan(0)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.read = { messages: [userRow()], streaming: true }
  asked.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('a broken stream whose half answer is filed and newest', () => {
  it('may name the control, because the control is drawn beside it', async () => {
    // The row has landed and the worker still holds the lease, so the bubble and the row share the screen:
    // this is the one state the promise is true in, and it is the case that must not change.
    harness.read = { messages: [userRow(), assistantRow()], streaming: true }
    await mount()
    await breakTheStream(PARTIAL)

    expect(failureLine(), 'the filed half answer lost the line that tells the reader how to finish it')
      .toContain(t('assistant.chat.stream_disconnected'))
    expect(continueButtons(), 'the newest filed answer stopped drawing its control').toHaveLength(1)
    expectLineKeepsItsPromise()
  })
})

describe('a broken stream whose row is not on the screen yet', () => {
  it('names no control the reader cannot press', async () => {
    // The read answers with the thread and no assistant row: the worker has not filed the half answer,
    // so the bubble is kept up and there is nothing under it to press.
    harness.read = { messages: [userRow()], streaming: true }
    await mount()
    await breakTheStream(PARTIAL)

    expect(continueButtons(), 'a thread with no filed answer is offering to carry one on').toHaveLength(0)
    expect(failureLine(), 'the failure line names a control the transcript does not draw')
      .not.toContain(t('assistant.chat.continue'))
    expectLineKeepsItsPromise()
  })

  it('says the connection broke, which is the one thing that is true about it', async () => {
    harness.read = { messages: [userRow()], streaming: true }
    await mount()
    await breakTheStream(PARTIAL)

    const line = failureLine()
    expect(line, 'the reader was left with a bubble that stopped growing and no word why').not.toBe('')
    expect(line, 'the browser’s own sentence about a socket reached the screen').not.toContain('Failed to fetch')
  })
})

describe('a broken stream that arrived with no words at all', () => {
  it('promises no control and claims no half answer it never wrote', async () => {
    harness.read = { messages: [userRow()], streaming: true }
    await mount()
    await breakTheStream(null)

    expect(answerBodies(), 'a turn that wrote nothing has no answer kept on the screen').toHaveLength(0)
    expect(continueButtons(), 'nothing arrived, so there is nothing to carry on').toHaveLength(0)
    const line = failureLine()
    expect(line, 'the failure line names a control the transcript does not draw')
      .not.toContain(t('assistant.chat.continue'))
    expect(line, 'the failure line claims a part already received that was never received')
      .not.toContain(t('assistant.chat.stream_disconnected'))
    expectLineKeepsItsPromise()
  })
})

describe('a filed answer the reader can step back through', () => {
  it('is not promised across the page the reader may be looking at', async () => {
    // `MessageParts.tsx` hides the control while an older version of an answer is on screen, and the
    // transcript cannot see which page a row is showing — only that it can be shown. So a row that carries
    // a pager is a row a line may not point at.
    harness.read = { messages: [userRow(), assistantRow({ versionCount: 1 })], streaming: true }
    await mount()
    await breakTheStream(PARTIAL)

    expect(pagerGroups(), 'the filed answer was mounted without the pager that hides its control').toHaveLength(1)
    expect(failureLine(), 'the failure line names a control the reader can page away from')
      .not.toContain(t('assistant.chat.continue'))
    expectLineKeepsItsPromise()
  })

  it('draws no pager on the bubble that prints the line', async () => {
    // The line is printed on the turn's own bubble, which is not a stored row and so has no history to
    // look at: recorded here because it is the reason the pager above is the only version case there is.
    harness.read = { messages: [userRow(), assistantRow()], streaming: true }
    await mount()
    await breakTheStream(PARTIAL)

    const alert = document.body.querySelector<HTMLElement>('[role="alert"]')
    expect(alert, 'the failure line went missing').toBeTruthy()
    const bubble = alert!.closest<HTMLElement>('div.group')
    expect(bubble, 'the failure line is not drawn inside a bubble').toBeTruthy()
    expect(bubble!.querySelector('[role="group"]'), 'the bubble that prints the line drew a pager of its own')
      .toBeNull()
  })
})
