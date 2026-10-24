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
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { AssistantDock } from './AssistantDock'
import { useAssistant } from './assistant-store'
import { editorAiAnchor, useEditorAi } from './editor-ai'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  // The note store stamps every local write with this, so a module mock has to answer for it.
  CLIENT_ID: 'test-client',
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
const notesOriginal = useNotes.getState()
let uiOriginal = useUi.getState()
let root: Root
let host: HTMLElement

async function show(
  patch: Partial<ReturnType<typeof useAssistant.getState>>,
  props: ComponentProps<typeof AssistantDock> = {},
): Promise<void> {
  useAssistant.setState({ ...assistantOriginal, ...patch })
  await act(async () => { root.render(createElement(AssistantDock, props)) })
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
  useNotes.setState(notesOriginal, true)
  useEditorAi.setState({ request: null })
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

  it('resizes the dock with the keyboard', async () => {
    useUi.setState({ assistantDockOpen: true, assistantDockWidth: 380 })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    const handle = document.body.querySelector<HTMLElement>(`[role="separator"][aria-label="${t('assistant.dock.resize')}"]`)
    expect(handle, 'the resize handle is missing').toBeTruthy()
    act(() => {
      handle!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(useUi.getState().assistantDockWidth).toBeGreaterThan(380)
  })

  it('says the open note is in context before the first question', async () => {
    useUi.setState({ activeNoteId: 'n1' })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    expect(document.body.textContent).toContain(t('assistant.dock.hint'))
  })

  /**
   * The empty thread is the reader's first look at what a turn will carry, so it may only name a thing
   * that is there. On the money page it used to promise the note under the reader's eyes — a note that
   * page has no way to open — and offer to summarise it.
   */
  it('names the plan the money page handed over, by the name the page used', async () => {
    await show(
      { loaded: true, activeId: null, messages: [], messagesReady: true },
      { surface: 'subscriptions', subscription: { id: 'sub-1', name: 'Netflix' } },
    )
    expect(document.body.textContent).toContain(t('assistant.dock.hint_plan', { name: 'Netflix' }))
    expect(document.body.textContent).not.toContain(t('assistant.dock.hint'))
  })

  it('claims nothing on the money page when no plan is open, and asks the page\'s own questions', async () => {
    await show(
      { loaded: true, activeId: null, messages: [], messagesReady: true },
      { surface: 'subscriptions', subscription: null },
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain(t('assistant.dock.hint_page'))
    expect(text).not.toContain(t('assistant.dock.hint'))
    expect(text).toContain(t('assistant.dock.suggest_due'))
    expect(text).not.toContain(t('assistant.dock.suggest_summary'))
  })

  it('offers to write a selection request back into the note', async () => {
    const whole = 'before the old words after'
    useNotes.setState({
      contents: { n1: whole },
      notes: { n1: { id: 'n1', title: 'A note' } as never },
    })
    useEditorAi.setState({
      request: {
        noteId: 'n1',
        action: 'rewrite',
        from: 7,
        to: 20,
        source: 'the old words',
        anchor: editorAiAnchor(whole, 7, 20),
      },
    })
    await show({
      loaded: true,
      activeId: 'c1',
      messages: [ANSWER],
      messagesReady: true,
      turn: {
        conversationId: 'c1',
        userText: 'rewrite this',
        attachments: [],
        assistantId: 'm2',
        text: 'NEW',
        reasoning: '',
        tools: [],
        stage: undefined,
        error: null,
        done: true,
      },
    })
    const press = (label: string) => {
      const button = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
      expect(button, `${label} is missing`).toBeTruthy()
      act(() => { button!.click() })
    }
    // The change is shown first, and the note is only written by the press that follows the reading.
    press(t('assistant.edit.replace'))
    expect(useNotes.getState().contents.n1).toBe(whole)
    press(t('assistant.edit.apply'))
    expect(useNotes.getState().contents.n1).toBe('before NEW after')
    // The row goes with the answer it was about: leaving it would offer to paste it again.
    expect(useEditorAi.getState().request).toBeNull()
  })

  it('shows the page an answer on screen was read from, before the thread is opened again', async () => {
    await show({
      loaded: true,
      activeId: 'c1',
      messages: [],
      messagesReady: true,
      turn: {
        conversationId: 'c1',
        userText: 'what changed this week?',
        attachments: [],
        assistantId: 'm2',
        text: 'It says so on the page.',
        reasoning: '',
        tools: [],
        stage: undefined,
        error: null,
        done: true,
        sources: [{ url: 'https://example.com/a', title: 'A page' }],
      },
    })
    // The dock is where a searched answer is most often read, so the citation has to be there from the
    // moment the words land — a claim that came from outside the vault cannot wait for a reload.
    const link = document.querySelector<HTMLAnchorElement>('a[href="https://example.com/a"]')
    expect(link, 'the dock drew the answer with nothing saying where it came from').toBeTruthy()
    expect(link!.textContent).toContain('A page')
  })

  it('carries the to-do screen and turns the note context off', async () => {
    await show({
      loaded: true,
      activeId: null,
      messages: [],
      messagesReady: true,
      todoContextOn: true,
      todoContext: {
        view: 'list',
        listId: 'L1',
        listName: 'Work',
        tagName: null,
        taskId: null,
        taskTitle: null,
        query: '',
        dueFrom: null,
        dueTo: null,
        tasks: [],
      },
    }, { surface: 'todos' })
    expect(useAssistant.getState().dockSurface).toBe('todos')
    expect(useAssistant.getState().noteContextOn).toBe(false)
    expect(useAssistant.getState().folderContextOn).toBe(false)
    expect(document.body.textContent).toContain(t('assistant.dock.hint_todo'))
    expect(document.body.textContent).toContain('Work')
  })

  it('lets the reader take the to-do screen off the next turn', async () => {
    await show({
      loaded: true,
      activeId: null,
      messages: [],
      messagesReady: true,
      todoContextOn: true,
      todoContext: {
        view: 'board',
        listId: null,
        listName: null,
        tagName: null,
        taskId: null,
        taskTitle: null,
        query: '',
        dueFrom: null,
        dueTo: null,
        tasks: [],
      },
    }, { surface: 'todos' })
    const remove = [...document.body.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.context.remove', { name: t('todo.view.board') }))
    expect(remove, 'the screen the reader cannot see is one they cannot remove').toBeTruthy()
    act(() => { remove!.click() })
    expect(useAssistant.getState().todoContextOn).toBe(false)
    expect(document.body.textContent).not.toContain(t('todo.view.board'))
  })
})

/**
 * What the dock claims about the page beside it.
 *
 * The dock is mounted by the notebook and by the money app alike, and the notebook's pointer — "the note
 * you have open" — is simply untrue while the reader is looking at their plans. These cases pin the two
 * halves of that: the notebook's pointers are not carried into the other app, and the plan the reader
 * actually opened is shown as something they can take back off.
 */
describe('the dock beside the subscriptions app', () => {
  it('does not claim the open note when it is docked in the money app', async () => {
    useUi.setState({ activeNoteId: 'n1' })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true }, { surface: 'subscriptions', subscription: null })
    expect(useAssistant.getState().noteContextOn).toBe(false)
    expect(useAssistant.getState().folderContextOn).toBe(false)
  })

  it('still points at the note on the notebook surface', async () => {
    useAssistant.setState({ noteContextOn: false })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true })
    expect(useAssistant.getState().noteContextOn).toBe(true)
  })

  it('carries the opened plan and shows it as removable', async () => {
    await show(
      { loaded: true, activeId: null, messages: [], messagesReady: true },
      { surface: 'subscriptions', subscription: { id: 'sub-1', name: 'Netflix' } },
    )
    expect(useAssistant.getState().subscriptionContext).toEqual({ id: 'sub-1', name: 'Netflix' })
    const remove = [...document.body.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.context.remove', { name: 'Netflix' }))
    expect(remove, 'the context the reader cannot see is context they cannot remove').toBeTruthy()
    act(() => { remove!.click() })
    expect(useAssistant.getState().subscriptionContext).toBeNull()
  })

  it('drops the plan from context when the reader closes it, and never offers the chip on the notebook', async () => {
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true }, { surface: 'subscriptions', subscription: { id: 'sub-1', name: 'Netflix' } })
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true }, { surface: 'subscriptions', subscription: null })
    expect(useAssistant.getState().subscriptionContext).toBeNull()
    await show({ loaded: true, activeId: null, messages: [], messagesReady: true }, { subscription: { id: 'sub-1', name: 'Netflix' } })
    expect(document.body.textContent).not.toContain('Netflix')
  })
})

  /**
   * The bug a fixed test object hides.
   *
   * The caller builds `{ id, name }` inline, so every render hands the dock a new object that says the same
   * thing. An effect that depends on that object re-runs on every render and re-attaches what the reader
   * just took off — the chip becomes impossible to remove. Mounting once with a literal cannot show it.
   */
  it('keeps the plan off after the reader removes it, even when the page re-renders', async () => {
    await show(
      { loaded: true, activeId: null, messages: [], messagesReady: true },
      { surface: 'subscriptions', subscription: { id: 'sub-1', name: 'Netflix' } },
    )
    const remove = [...document.body.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.context.remove', { name: 'Netflix' }))
    expect(remove, 'the chip is offered').toBeTruthy()
    act(() => { remove!.click() })
    expect(useAssistant.getState().subscriptionContext).toBeNull()

    // Same words, a different object, which is what a re-render from the page produces.
    await act(async () => {
      root.render(createElement(AssistantDock, { surface: 'subscriptions', subscription: { id: 'sub-1', name: 'Netflix' } }))
    })
    expect(useAssistant.getState().subscriptionContext, 'a re-render must not undo a removal').toBeNull()
    expect(document.body.textContent, 'and the chip stays off').not.toContain('Netflix')
  })

describe('the email context chip', () => {
  it('falls back to the sender when the subject is empty', async () => {
    const email = {
      accountId: 'a1',
      address: 'me@example.com',
      folderId: 'inbox',
      messageId: 'm1',
      threadId: null,
      subject: '',
      sender: 'Grace Hopper <grace@example.com>',
      recipient: null,
      date: null,
      snippet: null,
      threadCount: 1,
    }
    await show(
      { loaded: true, activeId: null, messages: [], messagesReady: true, emailContextOn: true },
      { surface: 'email', email },
    )
    expect(document.body.textContent).toContain('Grace Hopper <grace@example.com>')
  })
})
