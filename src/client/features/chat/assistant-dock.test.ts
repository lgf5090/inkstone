// @vitest-environment jsdom
/**
 * The docked assistant.
 *
 * What is pinned here is the three things the panel promises and nothing about how a reply is drawn: it
 * shows the same thread the chat tab does, it points the next turn at the note on screen even when the
 * chat tab was last told otherwise, and it can be closed from inside itself.
 *
 * The composer's own wiring is covered where it lives; a stub stands in for it here so a mount does not
 * pull in the model picker, the trigger panel and their fetches.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { AssistantDock } from './AssistantDock'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      skills: vi.fn(async () => ({ skills: [] })),
      settings: vi.fn(async () => ({ settings: null, models: [] })),
      conversations: vi.fn(async () => ({ conversations: [] })),
    },
  },
}))

vi.mock('./ChatView', () => ({
  ChatComposer: ({ onManage }: { onManage?: (view: string) => void }) =>
    createElement('button', { type: 'button', 'data-composer': '1', onClick: () => onManage?.('settings') }, 'composer'),
  MessageRow: ({ message }: { message: AssistantMessage }) => createElement('p', { 'data-row': message.id }, message.content),
  UserBubble: ({ text }: { text: string }) => createElement('p', { 'data-live-user': '1' }, text),
}))

const ANSWER: AssistantMessage = {
  id: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  content: 'It says the opposite of what the heading promises.',
  reasoning: '',
  tools: [],
  attachments: [],
  status: 'complete',
  error: null,
  source: 'chat',
  usage: null,
  durationMs: 10,
  modelLabel: 'test',
  feedback: undefined,
  sources: [],
  createdAt: 1,
}

const assistantOriginal = useAssistant.getState()
let uiOriginal = useUi.getState()
let root: Root
let host: HTMLElement

async function show(patch: Partial<ReturnType<typeof useAssistant.getState>>): Promise<void> {
  useAssistant.setState({ ...assistantOriginal, ...patch })
  await act(async () => { root.render(createElement(AssistantDock)) })
}

beforeEach(async () => {
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
  useAssistant.setState(assistantOriginal, true)
  useUi.setState(uiOriginal, true)
  uiOriginal = useUi.getState()
  vi.clearAllMocks()
})

describe('the docked assistant', () => {
  it('shows the thread the chat tab would show', async () => {
    await show({ loaded: true, activeId: 'c1', messages: [ANSWER], messagesReady: true })
    expect(document.body.textContent).toContain(ANSWER.content)
  })

  it('points the next turn at the open note, whatever the chat tab was set to', async () => {
    useUi.setState({ assistantDockOpen: true })
    useAssistant.setState({ noteContextOn: false })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    expect(useAssistant.getState().noteContextOn).toBe(true)
  })

  it('closes itself', async () => {
    useUi.setState({ assistantDockOpen: true })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    const close = [...document.body.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.dock.close'))
    expect(close, 'the close control is missing').toBeTruthy()
    act(() => { close!.click() })
    expect(useUi.getState().assistantDockOpen).toBe(false)
  })

  it('says the open note is in context before the first question', async () => {
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    expect(document.body.textContent).toContain(t('assistant.dock.hint'))
  })
})
