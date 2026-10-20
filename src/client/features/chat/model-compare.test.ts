// @vitest-environment jsdom
/**
 * Opt-in comparison of one question across two models.
 *
 * The feature spends roughly twice the tokens of a normal turn, and the product is self-hosted and
 * self-billed, so every case here is really about one of four promises: that nothing happens until the
 * reader turns it on, that the cost is confirmed per turn in words that name both models, that the second
 * answer never touches the thread it was asked in, and that asking for a second model never moves the
 * reader's own. The last two are checked from both ends — the request it sends (a throwaway ephemeral
 * thread, its own model named on the body, never the reader's own id) and the state it writes (its own
 * record, with its own abort handle, and no settings write at all).
 *
 * jsdom lays nothing out, so "side by side" is asserted as the structure that produces it — one labelled
 * group holding two labelled groups, each naming its own model and holding only its own answer — rather
 * than as geometry. Where a column sits at 768px is a CSS question no headless browser can answer.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation, type AssistantModel } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { compareChoices, useAssistant } from './assistant-store'
import { ChatView } from './ChatView'

interface Run {
  input: Record<string, unknown>
  apply: (event: Record<string, unknown>) => void
  signal: AbortSignal
  resolve: () => void
}

const harness = vi.hoisted(() => ({
  /** Every stream the store asked for, in order: the thread's own answer first, then the comparison. */
  runs: [] as Run[],
  /**
   * What `api.assistant.saveSettings` was pointed at, in order.
   *
   * A comparison used to be made by moving the reader's own model setting to the second model and putting
   * it back, and every case that leaves this list non-empty is that race coming back: another request in
   * the flip window resolving the wrong model, a settings patch interleaving with the restore, or a closed
   * tab leaving the reader on a model they never picked. The turn names its model on the request instead,
   * so the correct answer for every case here is an empty list.
   */
  settingsWrites: [] as Record<string, unknown>[],
  /** How many requests had gone out at the moment the cost was asked about. Zero is the promise. */
  runsAtAsk: [] as number[],
}))

/** The confirm overlay is not mounted in these cases, so the dialog is answered by hand. */
const asked = vi.fn(async (_options: { title?: string, description?: ReactNode }) => true)
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string, description?: ReactNode }) => asked(options) }
})

vi.mock('./stream', () => ({
  streamAssistantTurn: (
    input: Record<string, unknown>,
    apply: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ) => new Promise<void>((resolve) => {
    harness.runs.push({ input, apply, signal, resolve })
    signal.addEventListener('abort', () => resolve())
  }),
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
      saveSettings: vi.fn(async (patch: Record<string, unknown>) => {
        harness.settingsWrites.push(patch)
        return { settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: patch.activeModelId } }
      }),
    },
  },
}))

// The reading surface is not the subject; the columns around it are.
vi.mock('./MessageParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageParts')>()
  return {
    ...actual,
    AssistantBubble: ((props: { text?: string }): ReactNode =>
      createElement('div', { 'data-answer': props.text ?? '' })) as unknown,
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
    priceCurrency: '', pricePeriods: [],
    ...over,
  }
}

function resetState(over: Partial<AssistantState> = {}): void {
  useAssistant.setState({
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [
      { id: 'c1', title: 'First thread', updatedAt: 2 } as AssistantConversation,
      { id: 'c2', title: 'Second thread', updatedAt: 3 } as AssistantConversation,
    ],
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
    // Two chat models and nothing else to pick: the primary answers, the other one compares.
    models: [model(), model({ id: 'model-2', label: 'Other model', model: 'other-model' })],
    providers: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    mcpServers: [],
    mcpCatalog: [],
    ephemeral: false,
    canvasOpen: false,
    focusMessageId: null,
    compareOn: false,
    compareModelId: null,
    compareTurn: null,
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
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const chip = (label: string) => buttons().find((node) => node.getAttribute('aria-label') === label)

async function click(node: HTMLButtonElement | null | undefined, where: string): Promise<void> {
  expect(node, `${where} is not drawn`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

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

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { box().dispatchEvent(event) })
  return event
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Waits until the store has put request number `index` on the wire, and hands it back. */
async function runAt(index: number): Promise<Run> {
  await act(async () => { await vi.waitFor(() => expect(harness.runs.length).toBeGreaterThan(index)) })
  return harness.runs[index]!
}

/** Arms comparison in this thread's composer: the switch, then the second model. */
async function armComparison(): Promise<void> {
  await click(chip(`${t('assistant.compare.toggle')}: ${t('assistant.compare.off')}`), 'the compare switch')
  await click(chip(`${t('assistant.compare.model')}: ${t('assistant.compare.model_none')}`), 'the second model picker')
  const row = buttons().find((node) => node.textContent?.includes('Other model'))
  await click(row, 'the second model row')
}

/** Asks a question with comparison armed, and answers both streams up to the point of running. */
async function sendCompared(question: string): Promise<{ primary: Run, comparison: Run }> {
  await type(question)
  pressKey('Enter')
  const primary = await runAt(0)
  // The second call is let go only once the worker has taken the turn — that is when its own model has
  // been decided, and the only moment the setting can be pointed elsewhere without moving this answer.
  primary.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-primary', runToken: 1 })
  const comparison = await runAt(1)
  return { primary, comparison }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.settingsWrites.length = 0
  harness.runsAtAsk.length = 0
  asked.mockClear()
  // Answers by default — the reader says yes — and remembers how much had already gone out when asked.
  asked.mockImplementation(async () => {
    harness.runsAtAsk.push(harness.runs.length)
    return true
  })
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

describe('comparison off', () => {
  it('changes nothing about an ordinary turn', async () => {
    await mount()
    // The switch is drawn — a feature the reader cannot find is a feature that does not exist — but it
    // reads off, and nothing that follows it depends on it being there.
    expect(chip(`${t('assistant.compare.toggle')}: ${t('assistant.compare.off')}`), 'the compare switch is not drawn').toBeTruthy()
    expect(useAssistant.getState().compareOn, 'comparison is opt-in, not default').toBe(false)
    // The picker that would name a second model is not drawn at all while the switch is off.
    expect(chip(`${t('assistant.compare.model')}: ${t('assistant.compare.model_none')}`), 'the second model picker is drawn unasked').toBeUndefined()

    await type('an ordinary question')
    pressKey('Enter')
    const only = await runAt(0)
    expect(asked, 'an unarmed turn asked for a cost it never mentioned').not.toHaveBeenCalled()
    expect(harness.runs, 'a plain turn made more than one request').toHaveLength(1)
    expect(harness.settingsWrites, 'a plain turn moved the reader’s model').toEqual([])
    expect(only.input.conversationId).toBe('c1')
    expect(only.input.ephemeral, 'an ordinary turn was sent as a throwaway thread').toBeUndefined()
    // The thread's own answer is drawn as it always was: one bubble, no columns around it.
    expect(document.body.querySelector('[role="group"]')).toBeNull()
  })
})

describe('arming the comparison', () => {
  it('asks for confirmation naming both models before the turn runs', async () => {
    await mount()
    await armComparison()
    expect(useAssistant.getState().compareModelId).toBe('model-2')

    await type('a question worth asking twice')
    pressKey('Enter')
    await flush()

    expect(asked).toHaveBeenCalledTimes(1)
    const options = asked.mock.calls[0]![0]
    expect(options.title).toBe(t('assistant.compare.confirm_title'))
    const said = String(options.description)
    expect(said, 'the confirmation did not name the model answering as usual').toContain('Test model')
    expect(said, 'the confirmation did not name the second model').toContain('Other model')
    expect(said).toContain(String(t('assistant.compare.confirm_hint', { primary: 'Test model', compare: 'Other model' })).slice(-20))
    // Asked before anything went out: the reader says yes to the cost, and only then does the turn run.
    expect(harness.runsAtAsk[0], 'a request left this device before the reader agreed to the cost').toBe(0)
  })

  it('sends nothing when the reader declines', async () => {
    await mount()
    await armComparison()
    asked.mockResolvedValueOnce(false)
    await type('a question that will not be asked twice')
    pressKey('Enter')
    await flush()

    expect(harness.runs, 'a declined comparison still sent a turn').toHaveLength(0)
    expect(harness.settingsWrites, 'a declined comparison still moved the reader’s model').toEqual([])
    expect(useAssistant.getState().turn).toBeNull()
    await vi.waitFor(() => expect(box().value).toBe('a question that will not be asked twice'))
  })

  it('will not offer the model that is already answering', async () => {
    await mount()
    expect(compareChoices([{ ...model() }, { ...model({ id: 'model-2' }) }], 'model-1').map((entry) => entry.id))
      .toEqual(['model-2'])

    await armComparison()
    await click(chip(`${t('assistant.compare.model')}: Other model`), 'the second model picker')
    const rows = buttons().filter((node) => node.getAttribute('role') === 'menuitemcheckbox'
      || node.getAttribute('role') === 'menuitem')
    const labels = rows.map((node) => node.textContent ?? '')
    expect(labels.some((entry) => entry.includes('Test model')), 'the answering model was offered as the second one').toBe(false)
    expect(labels.some((entry) => entry.includes('Other model')), 'the other model is not pickable').toBe(true)
  })

  it('resets with the thread it was armed in', async () => {
    await mount()
    await armComparison()
    expect(useAssistant.getState().compareOn).toBe(true)

    await act(async () => { await useAssistant.getState().openConversation('c2') })
    expect(useAssistant.getState().compareOn, 'a second model armed for one thread followed it to another').toBe(false)
    expect(useAssistant.getState().compareModelId, 'the stale second model survived the switch').toBeNull()
    expect(chip(`${t('assistant.compare.model')}: ${t('assistant.compare.model_none')}`), 'the picker is still drawn in the new thread').toBeUndefined()
  })
})

describe('the two streams', () => {
  it('asks the second model by name, in a thread of its own, and never touches the reader’s pick', async () => {
    await mount()
    await armComparison()
    const { comparison } = await sendCompared('asked twice on purpose')

    expect(comparison.input.conversationId, 'the comparison wrote into the reader’s thread').toBeUndefined()
    expect(comparison.input.ephemeral, 'the comparison was not sent as a throwaway thread').toBe(true)
    expect(comparison.input.message).toBe('asked twice on purpose')
    // The second model is named on the request rather than borrowed from the settings row, so the reader's
    // own pick never moves and no other request can resolve it while this one is in the air.
    expect(comparison.input.modelId).toBe('model-2')
    // A comparison must not write to the vault: the thread's own answer already did whatever it did, and a
    // second model acting on its own would do it again.
    expect(comparison.input.noTools, 'the comparison was allowed to call tools').toBe(true)
    expect(harness.settingsWrites, 'naming the second model still moved the reader’s setting').toEqual([])

    // The first frame used to be the moment the setting was put back. There is nothing left to put back, so
    // the only honest thing a frame can do now is leave the reader's pick exactly where it was.
    await act(async () => { comparison.apply({ type: 'start', conversationId: 'tmp-1', assistantMessageId: 'm-cmp', runToken: 2 }) })
    await flush()
    expect(harness.settingsWrites, 'the comparison restored a setting it never wrote').toEqual([])
    expect(useAssistant.getState().settings?.activeModelId, 'the composer’s own pick changed under the reader').toBe('model-1')
  })

  it('hands the turn’s files to the thread’s answer and to the comparison not at all', async () => {
    // Why the composer is allowed to judge one model rather than both. `runComparison` names no
    // `attachments`, `./stream` drops an absent list, the route resolves an absent list to none, and the
    // comparison answers in a fresh ephemeral thread whose history has no attachment rows either — so no
    // second model is ever handed these bytes, and there is no worker sentence waiting to disagree with
    // the composer's. This is the pin against the day that changes: give the second column the turn's ids
    // and this fails long before a reader sees two columns disagree about a recording.
    await mount({
      pending: [{ localId: 'l1', id: 'att-1', filename: 'notes.md', mime: 'text/markdown', size: 512, kind: 'file', progress: 1, status: 'ready' }],
      fileIndex: {
        'att-1': { id: 'att-1', kind: 'file', filename: 'notes.md', mime: 'text/markdown', size: 512, key: 'chat/files/u/att-1.md', createdAt: 1 },
      },
    })
    await armComparison()
    const { primary, comparison } = await sendCompared('what does the file say')

    expect(primary.input.attachments, 'the thread’s own answer lost the file it was asked with').toEqual(['att-1'])
    expect(comparison.input.attachments, 'the comparison column was handed the turn’s files').toBeUndefined()
  })

  it('stops the comparison alone, leaving the thread’s own answer running', async () => {
    await mount()
    await armComparison()
    const { primary, comparison } = await sendCompared('two answers, two handles')

    await act(async () => { useAssistant.getState().stopComparison() })
    expect(comparison.signal.aborted, 'the comparison’s own stop did not stop it').toBe(true)
    expect(primary.signal.aborted, 'the comparison’s stop reached into the thread’s answer').toBe(false)
    expect(useAssistant.getState().turn?.done, 'the comparison’s stop settled the thread’s turn').toBe(false)
  })

  it('stops the thread’s answer alone, leaving the comparison running', async () => {
    await mount()
    await armComparison()
    const { primary, comparison } = await sendCompared('asked twice again')

    await act(async () => { useAssistant.getState().stop() })
    expect(primary.signal.aborted, 'the thread’s stop did not stop its own answer').toBe(true)
    expect(comparison.signal.aborted, 'the thread’s stop reached into the comparison').toBe(false)
    expect(useAssistant.getState().compareTurn?.done, 'the thread’s stop settled the comparison').toBe(false)
  })

  it('keeps each answer in its own column, named by its own model', async () => {
    await mount()
    await armComparison()
    const { primary, comparison } = await sendCompared('what does each of you say')

    await act(async () => {
      primary.apply({ type: 'text', delta: 'words from the first model' })
      primary.apply({ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } })
      comparison.apply({ type: 'start', conversationId: 'tmp-1', assistantMessageId: 'm-cmp' })
      comparison.apply({ type: 'text', delta: 'words from the second model' })
      comparison.apply({ type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } })
    })

    const grid = document.body.querySelector<HTMLElement>(`[role="group"][aria-label="${t('assistant.compare.columns')}"]`)
    expect(grid, 'the two answers are not held together in one labelled group').toBeTruthy()
    const columns = [...grid!.querySelectorAll<HTMLElement>('[role="group"]')]
    expect(columns, 'there is not one column per answer').toHaveLength(2)

    const [first, second] = columns as [HTMLElement, HTMLElement]
    const firstName = first.getAttribute('aria-label') ?? ''
    const secondName = second.getAttribute('aria-label') ?? ''
    expect(firstName).toContain('Test model')
    expect(secondName).toContain('Other model')
    const firstColumn = first.querySelector('[data-answer]') as HTMLElement
    const secondColumn = second.querySelector('[data-answer]') as HTMLElement
    // Structure, not geometry: which side of the grid a column lands on is CSS this environment cannot see.
    expect(firstColumn.getAttribute('data-answer'), 'the columns do not hold their own answers').toBe('words from the first model')
    expect(secondColumn.getAttribute('data-answer'), 'one stream wrote into the other’s column').toBe('words from the second model')
    // Each says what it spent, on its own line.
    expect(first.textContent).toContain(t('assistant.compare.tokens', { count: 30 }))
    expect(second.textContent).toContain(t('assistant.compare.tokens', { count: 15 }))

    // The comparison is not a row of the thread, and the thread's answer is not in its record.
    const state = useAssistant.getState()
    expect(state.messages, 'the comparison was filed into the thread').toHaveLength(0)
    expect(state.turn?.text).toBe('words from the first model')
    expect(state.compareTurn?.text).toBe('words from the second model')
    expect(state.compareTurn?.conversationId).toBe('tmp-1')
    expect(state.activeId).toBe('c1')
  })
})
