// @vitest-environment jsdom
/**
 * What a message row says when the facts beside it change.
 *
 * Five things a reader used to be left without, all of them the same shape of mistake. The branch door
 * and the two rows that write into a note were read out of a store during render, so the row kept
 * answering from a snapshot until something else redrew it. The model's name hung off the token counts,
 * so a provider that reports none hid who answered. An approval, a replay and an answer history each
 * swallowed whatever went wrong, leaving a card, a button or a pager that looked dead.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AssistantAnswerVersion, AssistantMessage, ToolActivity } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import type { MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { AssistantBubble, ToolCallList } from './MessageParts'
import { MessageRow } from './ChatView'
import { useAssistant } from './assistant-store'

/**
 * The menu is captured rather than clicked through.
 *
 * Which rows a message offers is the fact under test, and the panel's own placement work has nothing to
 * do with it, so the shared `Menu` is asked to write what it was handed where the case can read it.
 */
let menuItems: MenuItem[] = []
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return {
    ...actual,
    Menu: (props: { items?: MenuItem[] }) => {
      menuItems = props.items ?? []
      return null
    },
  }
})

const PREVIOUS = () => t('assistant.chat.previous')
const ROW_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz11'

const ids = () => menuItems.map((item) => item.id)
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const byName = (name: string) => buttons()
  .find((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').includes(name))
const click = (node: HTMLButtonElement | undefined) => {
  expect(node, 'the control is not drawn').toBeTruthy()
  act(() => { node!.click() })
}
/** A press that lets the stored promise settle, which is what puts an answer on screen. */
async function press(node: HTMLButtonElement | undefined) {
  expect(node, 'the control is not drawn').toBeTruthy()
  await act(async () => {
    node!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function turn(id: string, role: AssistantMessage['role'], content: string): AssistantMessage {
  return {
    id,
    conversationId: 'c1',
    role,
    content,
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
  }
}

function approvalTool(): ToolActivity {
  return {
    id: 't1',
    name: 'delete_note',
    status: 'success',
    approval: {
      id: 'a1',
      tool: 'delete_note',
      conversationId: 'c1',
      targetId: ROW_NOTE,
      targetLabel: 'The quarterly plan',
      status: 'pending',
      error: null,
      createdAt: 1,
      expiresAt: 2,
    },
  }
}

const REMOTE_CALL: ToolActivity = {
  id: 't1',
  name: 'mcp_abc123_resolve-library-id',
  status: 'success',
  args: '{\n  "query": "react-query"\n}',
  result: 'the-library-id',
}

let root: Root
let host: HTMLElement

function mount(node: React.ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(node) })
}

/**
 * What a pointer is told when it rests on a control, and nothing about where that lands: jsdom lays
 * nothing out, so the anchor's own box is stated first — the measurement `Tooltip` refuses to place a
 * panel without. `mouseover` is the entry React reads, and the panel sits behind the component's own
 * delay, which fake timers step over. The answer is every panel left standing, so a control with no
 * tooltip answers an empty list rather than a null the test has to guess at.
 */
function toldBy(node: HTMLButtonElement | undefined): string[] {
  expect(node, 'the control is not drawn').toBeTruthy()
  node!.getBoundingClientRect = () => ({
    top: 10, left: 10, right: 38, bottom: 38, x: 10, y: 10, width: 28, height: 28, toJSON: () => ({}),
  }) as DOMRect
  vi.useFakeTimers()
  act(() => { node!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  act(() => { vi.advanceTimersByTime(600) })
  const told = [...document.body.querySelectorAll('[role="tooltip"]')].map((panel) => panel.textContent ?? '')
  act(() => {
    node!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.documentElement }))
  })
  vi.useRealTimers()
  return told
}

const bubble = (over: Partial<React.ComponentProps<typeof AssistantBubble>> = {}) => createElement(AssistantBubble, {
  text: 'THE ANSWER',
  reasoning: '',
  tools: [],
  error: null,
  streaming: false,
  messageId: 'm1',
  ...over,
})

const originalAssistant = useAssistant.getState()
const originalUi = useUi.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  // The toolbar offers read-aloud only where the browser can speak; jsdom has no engine, so the control
  // would carry the "this browser cannot read" description instead of the tooltip under test.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {} })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class {} })
  menuItems = []
  useAssistant.setState({ ...originalAssistant, activeId: 'c1' })
  useUi.setState({ ...originalUi, activeNoteId: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
  useAssistant.setState(originalAssistant, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
})

describe('a row that has to notice something outside itself', () => {
  it('offers the branch the moment there is something below the turn to keep', async () => {
    useAssistant.setState({ messages: [turn('m1', 'user', 'first question')] })
    mount(createElement(MessageRow, { message: turn('m1', 'user', 'first question') }))
    click(byName(t('assistant.chat.edit_message')))
    // The newest turn has nothing after it, so there is nothing to keep — the row is right to say so.
    expect(byName(t('assistant.chat.edit_keep_branch'))).toBeUndefined()

    // An answer lands. The dialog is already open and nothing else about the row changed, which is exactly
    // where reading the store during render left the door shut.
    await act(async () => {
      useAssistant.setState({ messages: [turn('m1', 'user', 'first question'), turn('m2', 'assistant', 'an answer')] })
      await Promise.resolve()
    })
    expect(byName(t('assistant.chat.edit_keep_branch')), 'the branch door never appeared').toBeTruthy()
  })

  it('grows the two rows that write into a note once a note is open beside the thread', async () => {
    mount(bubble())
    click(byName(t('assistant.chat.message_actions')))
    expect(ids()).not.toContain('insert-into-note')
    expect(ids()).not.toContain('embed-in-note')

    await act(async () => {
      useUi.setState({ activeNoteId: ROW_NOTE })
      await Promise.resolve()
    })
    expect(ids()).toContain('insert-into-note')
    expect(ids()).toContain('embed-in-note')

    // Closing the note takes both back: a row that cannot write anywhere is a row the reader has to
    // discover the truth about by pressing it.
    await act(async () => {
      useUi.setState({ activeNoteId: null })
      await Promise.resolve()
    })
    expect(ids()).not.toContain('insert-into-note')
    expect(ids()).not.toContain('embed-in-note')
  })
})

describe('the answer-version pager', () => {
  it('sends one request however fast the arrows are pressed', () => {
    const loadVersions: Mock<() => Promise<AssistantAnswerVersion[]>> = vi.fn(() => new Promise(() => {}))
    mount(bubble({ versionCount: 2, loadVersions }))
    const back = byName(PREVIOUS())
    act(() => {
      back?.click()
      back?.click()
      back?.click()
    })
    expect(loadVersions).toHaveBeenCalledTimes(1)
  })

  it('says what refused, and asks the route again when the reader says retry', async () => {
    const loadVersions: Mock<() => Promise<AssistantAnswerVersion[]>> = vi.fn(async () => {
      throw new Error('the history route refused')
    })
    mount(bubble({ versionCount: 2, loadVersions }))
    await press(byName(PREVIOUS()))
    expect(document.body.textContent).toContain(t('assistant.memory.history_failed'))
    expect(document.body.textContent).toContain('the history route refused')
    // The arrows are not the only way back: retry asks the route again rather than moving the page.
    await press(byName(t('common.retry')))
    expect(loadVersions).toHaveBeenCalledTimes(2)
  })
})

describe('what an answer says about itself', () => {
  it('names the model even when the provider reported no tokens', () => {
    mount(bubble({ usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1200, modelLabel: 'deepseek-chat' }))
    expect(host.textContent).toContain('deepseek-chat')
    // A zero report is not a stat worth showing; the name is, and it never was.
    expect(host.textContent).not.toContain(t('assistant.chat.tokens'))
  })

  it('names the model when the answer carries no usage at all', () => {
    mount(bubble({ usage: null, modelLabel: 'qwen-max' }))
    expect(host.textContent).toContain('qwen-max')
  })

  it('keeps the cost and the model together when there is a cost to say', () => {
    mount(bubble({ usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 1000, modelLabel: 'deepseek-chat' }))
    expect(host.textContent).toContain(t('assistant.chat.tokens'))
    expect(host.textContent).toContain('deepseek-chat')
  })
})

describe('what a pointer is told about the icon-only controls', () => {
  const ICON_ONLY = [
    'assistant.chat.copy',
    'assistant.chat.keep',
    'assistant.chat.rate_up',
    'assistant.chat.rate_down',
    'assistant.chat.read_aloud',
    'assistant.chat.save_to_note',
    'assistant.chat.regenerate',
    'assistant.chat.message_actions',
  ] as const

  it('names every control that carries no word, in the app tooltip and nowhere else', () => {
    mount(bubble({ onRate: () => {}, onRetry: () => {}, retryLabel: 'assistant.chat.regenerate' }))
    for (const key of ICON_ONLY) {
      const control = byName(t(key))
      expect(control, `${key} is not drawn`).toBeTruthy()
      expect(toldBy(control), `${key} tells a pointer nothing`).toEqual([t(key)])
      // The name stays on the control, which is what a screen reader reads; the panel is the pointer's
      // convenience, so wiring it up as a description as well would say the same words twice.
      expect(control!.getAttribute('aria-label'), `${key} lost its name`).toBe(t(key))
      expect(control!.getAttribute('aria-describedby'), `${key} would be read twice`).toBeNull()
      expect(control!.getAttribute('title'), `${key} still carries the browser's own hint`).toBeNull()
    }
  })

  it('says which mark the answer already carries, and that this press takes it back', () => {
    mount(bubble({ onRate: () => {}, savedAt: 1_700_000_000_000, feedback: 'down' }))
    const star = byName(t('assistant.chat.unkeep'))
    expect(toldBy(star), 'a kept answer never said it could be unkept').toEqual([t('assistant.chat.unkeep')])
    expect(star!.getAttribute('aria-pressed'), 'the star is not drawn as pressed').toBe('true')
    const down = byName(t('assistant.chat.rate_down'))
    expect(toldBy(down), 'the thumb already down never said the verdict can be taken back').toEqual([t('assistant.chat.rate_down_undo')])
    expect(down!.getAttribute('aria-pressed')).toBe('true')
    // The thumb beside it holds nothing, so it names its own verdict rather than a cancellation.
    const up = byName(t('assistant.chat.rate_up'))
    expect(toldBy(up)).toEqual([t('assistant.chat.rate_up')])
    expect(up!.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a press that did not land', () => {
  it('leaves the reason on the approval card instead of a card waiting forever', async () => {
    useAssistant.setState({ decideAction: vi.fn(async () => { throw new Error('the action was refused') }) })
    mount(bubble({ tools: [approvalTool()] }))
    await press(byName(t('assistant.approval.approve')))
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent, 'the failed approval said nothing').toContain('the action was refused')
    // The card is still there and its buttons are pressable again: the reader can try, or leave.
    expect(byName(t('assistant.approval.approve'))?.disabled).toBe(false)
  })

  it('refuses to replay into a conversation that is not open', async () => {
    const replay = vi.fn(async () => ({ ok: true, error: '', result: 'answered again' }))
    useAssistant.setState({ activeId: null, replayMcpTool: replay })
    mount(createElement(ToolCallList, { tools: [REMOTE_CALL], messageId: 'm1' }))
    click(byName(t('assistant.chat.tools_group')))
    click(document.body.querySelector<HTMLButtonElement>('button[data-tool-chip="mcp_abc123_resolve-library-id"]') ?? undefined)
    await press(byName(t('assistant.chat.replay')))
    // An empty conversation id is a request the route can only guess at, and a card that says "ran again"
    // about a call that was never made.
    expect(replay).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(t('assistant.toast.failed'))
    expect(document.body.textContent).not.toContain(t('assistant.chat.replay_result'))
  })
})
