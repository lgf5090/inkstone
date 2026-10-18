// @vitest-environment jsdom
/**
 * What the comparison's own column says when its bytes stop arriving.
 *
 * A comparison is a second model answering one question in a thread of its own, and its column has no
 * control that could carry a half answer on: the continue control belongs to the reader's own turn, and
 * nothing like it is drawn here. So the sentence the column prints cannot be the one the bubble prints — a
 * promise to press a button that is not on the screen is a lie about the interface, told to a reader who
 * just paid for the second answer. What the column can honestly say is three facts: this column did not
 * finish, the answer beside it is untouched, and the comparison can be asked for again.
 *
 * Both halves of that are checked from the outside. The first is checked where a reader sees it — inside
 * the group that names the comparison and its model, in the element a screen reader is told about — and
 * the second is checked by asking the same question again and watching `runComparison` be reached a second
 * time, on the model it was armed with. The browser's own text is checked to be nowhere.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation, type AssistantModel } from '@shared/assistant'
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
  /** Every stream the store asked for, in order: a turn's answer first, then that turn's comparison. */
  runs: [] as Run[],
  /**
   * Every call that reached `runComparison`, with the words it was handed.
   *
   * The promise the column prints is "ask for it again", and the only proof that promise is true is that
   * asking a second time arrives here a second time — so this is recorded by wrapping the store's own
   * implementation rather than by watching the wire, where an ordinary turn also appears.
   */
  comparisonCalls: [] as { message: string, modelId: string | null }[],
}))

/** The confirm overlay is not mounted in these cases, so the dialog is answered by hand. */
const asked = vi.fn(async (_options: { title?: string, description?: ReactNode }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, description?: ReactNode }) => asked(options) }
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
        conversation: { id, ephemeral: false },
        messages: [],
        attachments: [],
        streaming: false,
      }),
      deleteConversation: vi.fn(async () => ({})),
      updateModel: vi.fn(async () => ({})),
      saveSettings: vi.fn(async (patch: Record<string, unknown>) => ({
        settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: patch.activeModelId },
      })),
    },
  },
}))

// The transport, held by the test. Only `streamAssistantTurn` is replaced: the error the reading loop
// raises when a turn's bytes give out is imported as it is, because that name is how the store is told a
// broken stream apart from a refusal, and a stand-in for it would test the wrong half of the rule.
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
    priceCurrency: '',
    ...over,
  }
}

function resetState(over: Partial<AssistantState> = {}): void {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantConversation],
    messages: [],
    messagesReady: true,
    messagesError: null,
    messagesHasMore: false,
    messagesHasNewer: false,
    turn: null,
    remoteStreaming: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    skills: [],
    models: [model(), model({ id: 'model-2', label: 'Other model', model: 'other-model' })],
    providers: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    mcpServers: [],
    mcpCatalog: [],
    ephemeral: false,
    canvasOpen: false,
    focusMessageId: null,
    // Armed by these cases rather than by clicking the switch through: `model-compare.test.ts` owns the
    // arming, and this file starts from the state a reader has once they are armed.
    compareOn: true,
    compareModelId: 'model-2',
    compareTurn: null,
    runComparison: async (input: { message: string, model: AssistantModel, threadId: string | null }) => {
      harness.comparisonCalls.push({ message: input.message, modelId: input.model.id })
      await original.runComparison(input)
    },
    // The after-turn refreshes are not the subject, and the mock api has no route behind most of them.
    loadMcpServers: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    loadConversations: vi.fn(async () => undefined),
    loadArtifacts: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>)
}

let root: Root
let host: HTMLElement

async function mount(over: Partial<AssistantState> = {}): Promise<void> {
  resetState(over)
  await act(async () => { root.render(createElement(ChatView)) })
}

const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea')!

async function type(value: string): Promise<void> {
  const field = box()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.setSelectionRange(value.length, value.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Ask the composer a question the way the reader does: the words, then Enter. */
async function ask(question: string): Promise<void> {
  await type(question)
  act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Waits until the store has put request number `index` on the wire, and hands it back. */
async function runAt(index: number): Promise<Run> {
  await act(async () => { await vi.waitFor(() => expect(harness.runs.length).toBeGreaterThan(index)) })
  return harness.runs[index]!
}

/** The failure the reading loop raises when the bytes of a turn simply stop coming. */
function disconnected(): StreamDisconnectedError {
  return new StreamDisconnectedError('The assistant stream ended before the turn was answered.', {
    cause: new TypeError('Failed to fetch'),
  })
}

/**
 * One question, asked of both models, up to the moment the comparison can be broken.
 *
 * The second call is let go by the first frame of the first, so the primary is answered here by hand and
 * left running: a half answer still arriving is the state a broken comparison is seen in.
 */
async function sendCompared(question: string): Promise<{ primary: Run, comparison: Run }> {
  await ask(question)
  const primary = await runAt(0)
  await act(async () => { primary.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-primary', runToken: 1 }) })
  await act(async () => { primary.apply({ type: 'text', delta: 'words from my own model' }) })
  const comparison = await runAt(1)
  await act(async () => { comparison.apply({ type: 'start', conversationId: 'tmp-1', assistantMessageId: 'm-cmp' }) })
  await act(async () => { comparison.apply({ type: 'text', delta: 'a sentence that stop' }) })
  return { primary, comparison }
}

/** The comparison's own column: the group that names it and the model that wrote it. */
function compareColumn(): HTMLElement {
  const grid = document.body.querySelector<HTMLElement>(`[role="group"][aria-label="${t('assistant.compare.columns')}"]`)
  expect(grid, 'the two answers are not held together in one labelled group').toBeTruthy()
  const columns = [...grid!.querySelectorAll<HTMLElement>('[role="group"]')]
  const column = columns.find((node) => (node.getAttribute('aria-label') ?? '').includes(t('assistant.compare.compare_column')))
  expect(column, 'the comparison does not have a column that says which model wrote it').toBeTruthy()
  return column!
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.comparisonCalls.length = 0
  asked.mockClear()
  asked.mockImplementation(async () => true)
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

describe('the comparison column under a broken stream', () => {
  it('says the column did not finish, in its own column and not in the answer beside it', async () => {
    await mount()
    const { comparison } = await sendCompared('what does each of you say')
    comparison.reject(disconnected())
    await flush()

    const sentence = t('assistant.compare.stream_incomplete')
    const column = compareColumn()
    expect(column.getAttribute('aria-label'), 'the column that answers is not named by the model that owes it')
      .toContain('Other model')

    // Not just text somewhere: the column's group is what tells a reader which answer this news is about,
    // and the alert is what reaches them without their having to go looking for it.
    const alert = column.querySelector<HTMLElement>('[role="alert"]')
    expect(alert, 'the comparison’s failure is not announced as one').toBeTruthy()
    expect(alert!.textContent, 'the comparison column does not say what became of this answer').toContain(sentence)
    // The bubble's own sentence is the one this column cannot borrow: it ends by pointing at the continue
    // control, and there is no such control here to press — the words would promise a button that is not
    // on the screen. Checked against the catalog text rather than its key, because the column prints text.
    expect(alert!.textContent, 'the comparison column promises a continue control it does not have')
      .not.toContain(t('assistant.chat.stream_disconnected'))

    // The sentence is the column's alone: the reader's own model is still answering, and its bubble must
    // not pick up news about a thread it is not in.
    const primary = document.body.querySelector<HTMLElement>(
      `[role="group"][aria-label="${t('assistant.compare.primary_column')}: Test model"]`,
    )
    expect(primary, 'the reader’s own column went missing').toBeTruthy()
    expect(primary!.textContent).toContain('words from my own model')
    expect(primary!.textContent, 'the comparison’s failure was written into the reader’s own answer').not.toContain(sentence)

    const state = useAssistant.getState()
    expect(state.turn?.text).toBe('words from my own model')
    expect(state.turn?.done, 'the comparison settled the thread’s own turn').toBe(false)
    expect(state.compareTurn?.error).toBe(sentence)
  })

  it('keeps the browser’s own network sentence out of the thread', async () => {
    await mount()
    const { primary, comparison } = await sendCompared('what does each of you say')
    comparison.reject(disconnected())
    await flush()

    const words = document.body.textContent ?? ''
    expect(words, 'the reader was shown the browser’s words about a socket').not.toContain('Failed to fetch')
    expect(words, 'the reading loop’s own English sentence reached the screen').not.toContain('The assistant stream ended')
    await act(async () => { primary.resolve() })
  })

  it('promises a re-run it can deliver: asking again reaches runComparison again', async () => {
    await mount()
    const { primary, comparison } = await sendCompared('ask it twice')
    comparison.reject(disconnected())
    await flush()

    // The column now says the comparison can be asked for again. Asking the same question a second time is
    // what that sentence means, so it has to arrive at the same place the first turn did — the store's own
    // `runComparison`, on the model the reader armed it with.
    expect(harness.comparisonCalls).toEqual([{ message: 'ask it twice', modelId: 'model-2' }])
    await act(async () => { primary.resolve() })
    await flush()
    await ask('ask it twice')

    // The second call is let go by the first frame of the second turn, exactly as the first one was.
    const again = await runAt(2)
    await act(async () => { again.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-primary-2', runToken: 3 }) })
    const second = await runAt(3)
    expect(harness.comparisonCalls.map((call) => call.modelId), 'the re-run did not reach runComparison')
      .toEqual(['model-2', 'model-2'])
    expect(second.input.ephemeral, 'the re-run stopped being a throwaway thread').toBe(true)
    expect(second.input.modelId).toBe('model-2')
    expect(second.input.noTools, 'the re-run was allowed to reach for tools').toBe(true)

    // And the column it writes into is the new one: the failure gives its place back to an answer.
    await act(async () => { second.apply({ type: 'text', delta: 'the answer that arrived the second time' }) })
    expect(compareColumn().textContent).toContain('the answer that arrived the second time')
    expect(compareColumn().querySelector('[role="alert"]'), 'the old failure is still announced under the new answer')
      .toBeNull()
  })

  it('does not dress the reader’s own stop of the comparison as a broken stream', async () => {
    await mount()
    const { comparison } = await sendCompared('stopped on purpose')
    await act(async () => { useAssistant.getState().stopComparison() })
    comparison.reject(new DOMException('Aborted', 'AbortError'))
    await flush()

    expect(useAssistant.getState().compareTurn?.error, 'a stop the reader pressed became news about the network')
      .toBeNull()
    expect(compareColumn().textContent).not.toContain(t('assistant.compare.stream_incomplete'))
  })
})
