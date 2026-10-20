// @vitest-environment jsdom
/**
 * The multi-model workspace: one main thread, one ephemeral fork per side pane, one shared send.
 *
 * The cases pin the boundaries that make the grid safe rather than the pixels: switching on a layout
 * creates only the panes that are missing, a side turn names its own conversation and model and is asked
 * without tools, a close takes that pane's thread with it, and the arrangement survives a return to the
 * thread. The view cases pin the four layouts the design asks for.
 */
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation, type AssistantMessage, type AssistantModel } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { useMultiModel } from './multi-model-store'
import { MultiModelMenu, MultiModelView } from './MultiModelView'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  create: vi.fn(),
  conversation: vi.fn(),
  remove: vi.fn(),
  stream: vi.fn(),
  confirm: vi.fn(),
  setLayout: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      assistant: {
        ...actual.api.assistant,
        createConversation: mocks.create,
        forkConversation: mocks.fork,
        conversation: mocks.conversation,
        deleteConversation: mocks.remove,
      },
    },
  }
})

vi.mock('./stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stream')>()
  return { ...actual, streamAssistantTurn: mocks.stream }
})

vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: mocks.confirm }
})

const originalAssistant = useAssistant.getState()
const originalMulti = useMultiModel.getState()
let sideSeq = 0
let root: Root | null = null
let host: HTMLElement | null = null

function model(over: Partial<AssistantModel> = {}): AssistantModel {
  return {
    id: 'm1', providerId: 'p1', model: 'model-1', label: 'Model One', icon: '', temperature: null,
    maxOutputTokens: null, enabled: true, reasoning: 'auto', contextTokens: null, vision: true, purpose: 'chat',
    kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
    protocol: null, fallbackModelId: null, inputPrice: null, outputPrice: null, priceCurrency: '', pricePeriods: [],
    ...over,
  }
}

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'ask-1', conversationId: 'main', role: 'user', content: 'prior ask', tools: [], status: 'complete',
    error: null, createdAt: 1, source: 'chat', ...over,
  }
}

function sideConversation(id: string): AssistantConversation {
  return {
    id, title: 'Pane', pinned: false, starred: false, archived: false, ephemeral: true, parentId: 'main',
    folderId: null, noteId: null, createdAt: 1, updatedAt: 1, messageCount: 0,
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  localStorage.clear()
  sideSeq = 0
  useMultiModel.setState(originalMulti, true)
  useAssistant.setState({
    ...originalAssistant,
    activeId: 'main',
    messagesReady: true,
    messages: [message()],
    models: [model(), model({ id: 'm2', model: 'model-2', label: 'Model Two' }), model({ id: 'm3', model: 'model-3', label: 'Model Three' })],
    providers: [],
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'm1' },
    pending: [],
    turn: null,
    send: vi.fn(async () => true),
  })
  useMultiModel.getState().syncConversation('main')
  mocks.fork.mockImplementation(async () => ({ conversation: sideConversation(`side-${++sideSeq}`), messages: [] }))
  mocks.create.mockImplementation(async () => ({ conversation: sideConversation(`side-${++sideSeq}`) }))
  mocks.conversation.mockImplementation(async (id: string) => ({
    conversation: sideConversation(id),
    messages: [message({ id: `answer-${id}`, conversationId: id, role: 'assistant', content: 'side answer' })],
    attachments: [],
    streaming: false,
  }))
  mocks.remove.mockResolvedValue({ deleted: true })
  mocks.confirm.mockResolvedValue(true)
  mocks.stream.mockImplementation(async (input: { conversationId?: string }, apply: (event: unknown) => void) => {
    const final = message({ id: `answer-${input.conversationId}`, conversationId: input.conversationId, role: 'assistant', content: 'side answer' })
    apply({ type: 'text', delta: 'side ' })
    apply({ type: 'text', delta: 'answer' })
    apply({ type: 'done', finalMessage: final })
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  useAssistant.setState(originalAssistant, true)
  useMultiModel.setState(originalMulti, true)
  localStorage.clear()
  vi.clearAllMocks()
})

describe('the multi-model workspace', () => {
  it('creates only the side panes a layout needs and forks the thread history', async () => {
    await act(async () => { await useMultiModel.getState().setLayout(2) })
    expect(useMultiModel.getState().layout).toBe(2)
    expect(useMultiModel.getState().panes).toHaveLength(1)
    expect(mocks.fork).toHaveBeenCalledWith('main', 'ask-1', expect.any(String), true)
    await act(async () => { await useMultiModel.getState().setLayout(6) })
    expect(useMultiModel.getState().layout).toBe(6)
    expect(useMultiModel.getState().panes).toHaveLength(5)
  })

  it('asks each side pane its own conversation and model, without tools', async () => {
    await act(async () => { await useMultiModel.getState().setLayout(2) })
    const pane = useMultiModel.getState().panes[0]!
    await act(async () => { await useMultiModel.getState().sendAll('same question') })
    await act(async () => { await Promise.resolve() })
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: pane.conversationId, modelId: 'm2', message: 'same question', noTools: true }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(useAssistant.getState().send).toHaveBeenCalledWith('same question')
    expect(mocks.confirm).toHaveBeenCalled()
  })

  it('takes a closed pane and its ephemeral thread away', async () => {
    await act(async () => { await useMultiModel.getState().setLayout(2) })
    const pane = useMultiModel.getState().panes[0]!
    await act(async () => { await useMultiModel.getState().closePane(pane.id) })
    expect(useMultiModel.getState().layout).toBe(0)
    expect(useMultiModel.getState().panes).toHaveLength(0)
    expect(mocks.remove).toHaveBeenCalledWith(pane.conversationId)
  })

  it('starts the main thread on the first send when the workspace opened empty', async () => {
    const openConversation = vi.fn(async (id: string | null) => {
      if (!id) return
      useAssistant.setState({ activeId: id, messages: [], messagesReady: true })
    })
    useMultiModel.getState().syncConversation(null)
    useAssistant.setState({ activeId: null, messages: [], messagesReady: true, openConversation })
    await act(async () => { await useMultiModel.getState().setLayout(2) })
    expect(useMultiModel.getState().panes[0]?.conversationId).toBeNull()
    await act(async () => { await useMultiModel.getState().sendAll('first question') })
    await act(async () => { await Promise.resolve() })
    expect(mocks.create).toHaveBeenCalled()
    expect(openConversation).toHaveBeenCalled()
    expect(useMultiModel.getState().panes[0]?.conversationId).toBeTruthy()
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'first question', noTools: true }),
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('remembers the arrangement for the thread it belongs to', async () => {
    await act(async () => { await useMultiModel.getState().setLayout(3) })
    const saved = useMultiModel.getState().panes.map((pane) => pane.conversationId)
    useMultiModel.getState().syncConversation(null)
    useMultiModel.getState().syncConversation('main')
    expect(useMultiModel.getState().layout).toBe(3)
    expect(useMultiModel.getState().panes.map((pane) => pane.conversationId)).toEqual(saved)
  })
})

describe('the pane grid', () => {
  it('draws two, three, four and six panes from the same layout state', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => {
      root!.render(createElement(MultiModelView, { messages: [message()], live: null, fileIndex: {} }))
    })
    for (const layout of [2, 3, 4, 6] as const) {
      act(() => {
        useMultiModel.setState({
          layout,
          panes: Array.from({ length: layout - 1 }, (_, index) => ({
            id: `pane-${layout}-${index}`,
            conversationId: `side-${layout}-${index}`,
            modelId: 'm2',
            messages: [],
            files: {},
            loading: false,
            error: null,
          })),
        })
      })
      expect(document.querySelectorAll('[data-multi-pane]')).toHaveLength(layout)
      expect(document.querySelector('[data-multi-layout]')?.getAttribute('data-multi-layout')).toBe(String(layout))
    }
  })

  it('offers every layout in the picker', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => {
      useMultiModel.setState({ setLayout: mocks.setLayout, layout: 0 })
      root!.render(createElement(MultiModelMenu, { layout: 0, disabled: false, hint: t('assistant.panes.hint') }))
    })
    const chip = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.getAttribute('aria-label') ?? '').startsWith(t('assistant.panes.toggle')))
    expect(chip, 'the layout picker is not drawn').toBeTruthy()
    act(() => { chip!.click() })
    expect(document.body.textContent).toContain(t('assistant.panes.columns', { count: 2 }))
    expect(document.body.textContent).toContain(t('assistant.panes.columns', { count: 3 }))
    expect(document.body.textContent).toContain(t('assistant.panes.columns', { count: 4 }))
    expect(document.body.textContent).toContain(t('assistant.panes.columns', { count: 6 }))
  })
})
