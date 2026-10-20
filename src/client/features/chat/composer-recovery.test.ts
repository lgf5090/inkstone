// @vitest-environment jsdom
/**
 * What a reader keeps when a turn is refused — and the four states around it that the view used to own badly.
 *
 * These are all client-side promises no store record explains. A question the worker never took has to come
 * back whole: the words the reader typed, the files they waited on an upload for, and the chips they pinned,
 * and none of it may be paid for by throwing away what they typed while waiting. A control that can do
 * nothing must not look pressable, and must not send a request whose id is empty. Emptying the thread is
 * asked for, not assumed. One conversation list, not two copies that cannot see each other. And the find
 * panel's marks have to be re-made over a *transcript*, which a summed length cannot name.
 *
 * The view is mounted whole wherever the defect lives in the view; the composer alone where it lives in the
 * composer, and the revision as the pure function it is because the panel wants only the number it derives.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantMessage, type AssistantModel } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatComposer, ChatView } from './ChatView'

/** How the turn's own request answers: refused outright, or aborted by the reader pressing Stop. */
const harness = vi.hoisted(() => ({
  run: null as null | {
    apply: (event: Record<string, unknown>) => void
    resolve: () => void
    reject: (error: Error) => void
  },
}))

vi.mock('./stream', () => ({
  streamAssistantTurn: (_input: unknown, onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      harness.run = {
        apply: (event) => onEvent(event),
        resolve,
        reject,
      }
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
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
      updateModel: vi.fn(async () => ({})),
    },
  },
}))

// A live turn is drawn beside the composer in these cases; what is under test is the composer's and the
// view's own state, not the reading surface that renders an answer.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  return {
    ...actual,
    AssistantBubble: ((props: { text?: string }): ReactNode =>
      createElement('div', { 'data-answer': props.text ?? '' })) as unknown,
  }
})

type LiveTurn = NonNullable<ReturnType<typeof useAssistant.getState>['turn']>
type AssistantState = ReturnType<typeof useAssistant.getState>

const original = useAssistant.getState()
const updateModel = vi.fn(async (_id: string, _body: Record<string, unknown>) => true)
const activateModel = vi.fn(async () => true)
const startTemporaryConversation = vi.fn()

let root: Root
let host: HTMLElement
let viewportWidth = 1024

const ATTACHMENT = {
  localId: 'l1',
  id: 'a1',
  filename: 'shot.png',
  mime: 'image/png',
  size: 10,
  kind: 'image' as const,
  progress: 1,
  status: 'ready' as const,
}

function row(over: Partial<AssistantMessage> = {}): AssistantMessage {
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

function resetState(over: Partial<AssistantState> = {}): void {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantState['conversations'][number]],
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
    models: [],
    providers: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    mcpServers: [],
    mcpCatalog: [],
    ephemeral: false,
    canvasOpen: false,
    focusMessageId: null,
    updateModel,
    activateModel,
    startTemporaryConversation,
    // The after-turn refreshes are not the subject; the mock api has no route behind most of them.
    loadMcpServers: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    loadConversations: vi.fn(async () => undefined),
    loadArtifacts: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>)
}

async function mountView(over: Partial<AssistantState> = {}): Promise<void> {
  resetState(over)
  await act(async () => { root.render(createElement(ChatView)) })
}

async function mountComposer(over: Partial<AssistantState> = {}, onSend: (text: string) => Promise<boolean> = async () => true): Promise<void> {
  resetState(over)
  await act(async () => {
    root.render(createElement(ChatComposer, {
      streaming: false,
      sendOnEnter: true,
      onSend,
      onStop: () => useAssistant.getState().stop(),
      disabled: false,
    }))
  })
}

const box = () => document.body.querySelector<HTMLTextAreaElement>('textarea')!
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byAria = (label: string) => buttons().find((node) => node.getAttribute('aria-label') === label)
const text = () => document.body.textContent ?? ''
const lists = () => [...document.body.querySelectorAll<HTMLElement>(`nav[aria-label="${t('assistant.chat.list')}"]`)]

async function click(node: HTMLButtonElement | null | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Types into the controlled box the way the browser does: value first, then the event React reads. */
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

function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { box().dispatchEvent(event) })
  return event
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** The request the send just made, as the store handed it to the stream. */
async function nextRun() {
  await act(async () => { await vi.waitFor(() => expect(harness.run).toBeTruthy()) })
  const run = harness.run!
  harness.run = null
  return run
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
  asked.mockClear()
  asked.mockResolvedValue(true)
  updateModel.mockClear()
  activateModel.mockClear()
  startTemporaryConversation.mockClear()
  harness.run = null
  viewportWidth = 1024
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: viewportWidth })
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

describe('a turn the worker never took', () => {
  it('brings the words, the uploaded file and the pins back together', async () => {
    await mountView({
      pending: [ATTACHMENT],
      turnTools: ['search_notes'],
      turnScopes: [{ kind: 'tag', id: 't1', name: 'work' }],
    })
    await type('question with a picture')
    pressKey('Enter')
    const run = await nextRun()
    expect(useAssistant.getState().pending, 'the draft was never taken by the turn').toEqual([])

    run.reject(new Error('network down'))
    await flush()

    await vi.waitFor(() => expect(box().value).toBe('question with a picture'))
    const state = useAssistant.getState()
    expect(state.pending.map((entry) => entry.id), 'the uploaded file was thrown away').toEqual(['a1'])
    expect(state.turnTools, 'the pinned tool was thrown away').toEqual(['search_notes'])
    expect(state.turnScopes, 'the pinned scope was thrown away').toEqual([{ kind: 'tag', id: 't1', name: 'work' }])
  })

  it('brings them back when the reader pressed Stop before the first frame', async () => {
    await mountView({ pending: [ATTACHMENT], turnTools: ['search_notes'], turnScopes: [{ kind: 'tag', id: 't1', name: 'work' }] })
    await type('a question stopped before it left')
    pressKey('Enter')
    await nextRun()
    expect(useAssistant.getState().pending, 'the draft was never taken by the turn').toEqual([])

    await act(async () => { useAssistant.getState().stop() })
    await flush()

    await vi.waitFor(() => expect(box().value).toBe('a question stopped before it left'))
    const state = useAssistant.getState()
    expect(state.pending.map((entry) => entry.id), 'a Stop press is an abort, and an abort lost the upload').toEqual(['a1'])
    expect(state.turnTools).toEqual(['search_notes'])
    expect(state.turnScopes).toEqual([{ kind: 'tag', id: 't1', name: 'work' }])
  })

  it('lets the draft go once the worker took the turn', async () => {
    await mountView({ pending: [ATTACHMENT] })
    await type('a question that was answered')
    pressKey('Enter')
    const run = await nextRun()
    await act(async () => {
      run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' })
      run.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await vi.waitFor(() => expect(box().value).toBe(''))
    expect(useAssistant.getState().pending, 'an accepted turn handed its attachments back').toEqual([])
  })

  it('keeps what the reader typed while waiting, and adds the refused words back', async () => {
    const gate = deferred<boolean>()
    await mountComposer({}, (message) => {
      expect(message).toBe('the refused question')
      return gate.promise
    })
    await type('the refused question')
    pressKey('Enter')
    await flush()
    expect(box().value, 'the composer kept the words of a turn it believed was sent').toBe('')

    await type('words typed while waiting')
    await act(async () => { gate.resolve(false) })
    await flush()

    expect(box().value, 'the refused words were swallowed by the draft typed after them').toContain('the refused question')
    expect(box().value).toContain('words typed while waiting')
  })
})

describe('the model chip with nothing answering', () => {
  it('is not pressable, says why, and sends no request', async () => {
    await mountComposer({ models: [], providers: [], settings: null })
    const chip = byAria(`${t('assistant.composer.model')}: ${t('assistant.composer.model_none')}`)
    expect(chip, 'the model chip is not drawn').toBeTruthy()
    expect(chip!.disabled, 'a chip with no model behind it is still pressable').toBe(true)

    await click(chip, 'the model chip')
    expect(updateModel, 'the chip asked for a model that is not there').not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="menu"], [role="listbox"]'), 'a menu opened over no model at all').toBeNull()
    expect(text(), 'the row never says why it cannot be used').toContain(t('assistant.composer.model_none_hint'))
  })

  it('still switches picture input for the model that is answering', async () => {
    await mountComposer({ models: [model()], providers: [] })
    const chip = buttons().find((node) => node.getAttribute('aria-label')?.startsWith(t('assistant.composer.model')))
    await click(chip, 'the model chip')
    const vision = buttons().find((node) => node.getAttribute('role') === 'menuitemcheckbox')
    expect(vision, 'the picture row is not drawn').toBeTruthy()
    expect(vision!.getAttribute('aria-checked'), 'the row does not read the model it belongs to').toBe('true')

    await click(vision, 'the picture row')
    expect(updateModel).toHaveBeenCalledWith('model-1', { vision: false })
  })
})

describe('starting a temporary chat', () => {
  it('asks before the current thread is emptied, and only then', async () => {
    await mountView({ messages: [row({ id: 'm-question', content: 'What did I ask?' })] })
    const start = byAria(t('assistant.chat.temporary_start'))

    await act(async () => { asked.mockResolvedValueOnce(false) })
    await click(start, 'the temporary chat button')
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.chat.temporary_confirm_title'),
      tone: 'danger',
    }))
    expect(startTemporaryConversation, 'a refused dialog still emptied the thread').not.toHaveBeenCalled()

    await act(async () => { asked.mockResolvedValueOnce(true) })
    await click(start, 'the temporary chat button')
    expect(startTemporaryConversation).toHaveBeenCalledTimes(1)
  })
})

describe('the conversation list', () => {
  it('is mounted once while the rail is showing', async () => {
    await mountView()
    expect(lists(), 'more than one copy of the list is mounted').toHaveLength(1)
  })

  it('is still one list with the phone drawer open over it', async () => {
    await mountView()
    await click(byAria(t('assistant.chat.history')), 'the history button')
    expect(lists(), 'the rail and the drawer each mounted their own copy').toHaveLength(1)
  })

  it('is mounted only once the phone opens it', async () => {
    viewportWidth = 400
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: viewportWidth })
    await mountView()
    expect(lists(), 'the rail is drawn on a phone').toHaveLength(0)

    await click(byAria(t('assistant.chat.history')), 'the history button')
    expect(lists(), 'the drawer has no list to show').toHaveLength(1)
  })
})

describe('the transcript the find panel marks', () => {
  it('is named by its identity, not by its size', async () => {
    const { transcriptRevision } = await import('./ChatView')
    expect(transcriptRevision, 'the revision is not derived from the thread’s identity').toBeTypeOf('function')
    const one = [row({ id: 'm1', content: 'one' })]
    const added = [row({ id: 'm1', content: 'one' }), row({ id: 'm2', content: '' })]
    const typed = [row({ id: 'm1', content: 'one!' })]
    const renamed = [row({ id: 'm9', content: 'one' })]
    const attached = [row({ id: 'm1', content: 'one', attachments: ['a1'] })]

    expect(transcriptRevision(added, null), 'a message arriving went unnoticed').not.toBe(transcriptRevision(one, null))
    expect(transcriptRevision(typed, null), 'a changed last row went unnoticed').not.toBe(transcriptRevision(one, null))
    expect(transcriptRevision(renamed, null), 'another thread of the same shape went unnoticed').not.toBe(transcriptRevision(one, null))
    expect(transcriptRevision(attached, null), 'an attachment that landed late went unnoticed').not.toBe(transcriptRevision(one, null))
    // The collision the summed version had: one row added and one character typed produced one number.
    expect(transcriptRevision(added, null)).not.toBe(transcriptRevision(typed, null))
    // A reply still arriving owns no marks yet; settling is what the panel has to re-make them over.
    const live: LiveTurn = { conversationId: 'c1', userText: '', attachments: [], assistantId: null, text: '', reasoning: '', tools: [], stage: undefined, error: null, done: false }
    expect(transcriptRevision(one, { ...live, done: false, text: 'half' })).toBe(transcriptRevision(one, { ...live, done: false, text: 'half an answer' }))
    expect(transcriptRevision(one, { ...live, done: true, text: 'half an answer' })).not.toBe(transcriptRevision(one, { ...live, done: false, text: 'half an answer' }))
  })
})
