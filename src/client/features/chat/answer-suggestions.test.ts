// @vitest-environment jsdom
/**
 * The three follow-up questions a naming pass leaves under a fresh conversation's first answer.
 *
 * Two halves are pinned here, and each is the half that goes quietly wrong.
 *
 * The first is where the chips are drawn. They are the answer's own, but only the newest settled answer of
 * the thread on screen has a next turn to ask them into, so an older answer, a reply still arriving, a turn
 * the model failed and an earlier version paged back into view all hold nothing. A group drawn on every
 * answer would offer a question that gets answered by the whole thread while looking like it continued the
 * turn under it.
 *
 * The second is how they get there. The frame that carries them names the row they belong to, and the store
 * writes them onto that row where it already stands — it does not read the thread again, because a reload
 * takes the loaded page and the reader's place in it away from under a thread they may be typing into. That
 * is the whole difference between chips that appear and chips that appear after a jolt, so the case below
 * counts the transcript reads rather than trusting that one is not made.
 *
 * jsdom lays nothing out: every claim about a long question is about the class that draws it, never about
 * the box it would have been painted in.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, ChatStreamEvent } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { canAskNextAnswer, MessageRow } from './ChatView'
import { AssistantBubble } from './MessageParts'
import type { StreamTurnInput } from './stream'
import { useAssistant } from './assistant-store'

interface Run {
  input: StreamTurnInput
  apply: (event: ChatStreamEvent) => void
  signal: AbortSignal
  resolve: () => void
}

const harness = vi.hoisted(() => ({
  /** Every send's stream, in the order the store asked for them, held open until the case lets it close. */
  runs: [] as {
    input: StreamTurnInput
    apply: (event: ChatStreamEvent) => void
    signal: AbortSignal
    resolve: () => void
  }[],
  /** How many times the transcript has been read back off the server. */
  threadReads: 0,
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
      conversation: async (id: string) => {
        harness.threadReads++
        return { conversation: { id, ephemeral: false }, messages: [], attachments: [], streaming: false }
      },
      conversationArtifacts: async () => ({ artifacts: [] }),
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      skills: async () => ({ skills: [] }),
    },
  },
}))

// The transport held open by the file: the case decides what the naming pass says and when the stream ends.
vi.mock('./stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stream')>()
  return {
    ...actual,
    streamAssistantTurn: (
      input: StreamTurnInput,
      apply: (event: ChatStreamEvent) => void,
      signal: AbortSignal,
    ) => new Promise<void>((resolve) => {
      harness.runs.push({ input, apply, signal, resolve })
    }),
  }
})

const QUESTIONS = ['When was the harbour built?', 'Why were the tide gates replaced?', 'Who funded it?']

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'The harbour was built in 1686 at the mouth of the bay.',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
    ...over,
  }
}

let root: Root
let host: HTMLElement
const send = vi.fn(async (_text: string) => true)

/** The chip group, found by the accessible name it has to carry rather than by any group the row draws. */
function group(): HTMLElement | null {
  return [...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
    .find((node) => node.getAttribute('aria-label') === t('assistant.chat.ask_next')) ?? null
}
/** Any button on the screen holding one of the stored questions, inside a group or outside one. */
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const chipButtons = () => buttons().filter((node) => QUESTIONS.some((question) => node.textContent === question))
const chips = () => [...group()?.querySelectorAll<HTMLButtonElement>('button') ?? []]

/** Mount the row the way the transcript does — the newest settled answer being the one that may offer chips. */
function mountRow(over: Partial<AssistantMessage> = {}, canAskNext = true): void {
  act(() => {
    root.render(createElement(MessageRow, {
      message: message({ suggestions: QUESTIONS, ...over }),
      canAskNext,
      onRetry: () => undefined,
    }))
  })
}

/** The absence claim, both ways: no group, and no stray chip drawn by something that skipped the group. */
function expectNoChips(why: string): void {
  expect(group(), why).toBeNull()
  expect(chipButtons(), `${why} — the chips are there with no group over them`).toHaveLength(0)
}

const original = useAssistant.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.threadReads = 0
  send.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useAssistant.setState({ ...original, send })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
})

describe('the chips under an answer', () => {
  it('draws the questions the answer carries as a named group of real buttons', () => {
    mountRow()
    const node = group()
    expect(node, 'the answer offers nothing it was asked to offer').toBeTruthy()
    expect(node!.getAttribute('aria-label'), 'the group introduces itself to nobody').toBe(t('assistant.chat.ask_next'))
    expect(chips().map((chip) => chip.textContent)).toEqual(QUESTIONS)
    for (const chip of chips()) {
      expect(chip.tagName).toBe('BUTTON')
      expect(chip.getAttribute('type')).toBe('button')
      // No browser hint: the chip's own words are its name, and a hover one never fires on a thumb.
      expect(chip.getAttribute('title'), 'a question hides behind a hover').toBeNull()
    }
  })

  it('pads each chip to the tap floor the rest of the footer keeps', () => {
    mountRow()
    expect(chips()).toHaveLength(3)
    for (const chip of chips()) {
      const classes = `${chip.className} `
      expect(classes, 'a chip is drawn under the tap floor with no pad over it').toMatch(/(?:^|\s)ink-tap-pad\s/)
      // The pad is an absolutely positioned child, so the control has to be its own containing block.
      expect(classes, 'the chip cannot place a tap pad').toMatch(/(?:^|\s)(?:relative|absolute)\s/)
    }
  })

  it('folds a question far longer than a chip wants to show instead of pushing the row apart', () => {
    const long = 'Why '.repeat(50)
    mountRow({ suggestions: [long] })
    const chip = chips()[0]!
    expect(chip.textContent, 'the words the reader is asked to press are not the stored ones').toBe(long)
    const inner = chip.querySelector('span')!
    expect(`${chip.className} `, 'a long chip can stretch past the bubble it belongs to').toMatch(/(?:^|\s)max-w-full\s/)
    expect(`${inner.className} `, 'a long chip is not folded inside the bubble').toMatch(/(?:^|\s)line-clamp-2\s/)
  })

  it('draws nothing for an answer whose list came back empty', () => {
    mountRow({ suggestions: [] })
    expectNoChips('an empty list still drew a group')
  })

  it('draws nothing for an answer that never had a naming pass', () => {
    act(() => {
      root.render(createElement(MessageRow, { message: message(), canAskNext: true }))
    })
    expectNoChips('a row with no `suggestions` key drew a group')
  })

  it('asks the question the chip holds, through the send path the composer uses', () => {
    mountRow()
    const chip = chips()[1]!
    act(() => { chip.click() })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(QUESTIONS[1])
  })

  it('leaves an older answer of the thread alone', () => {
    mountRow({}, false)
    expectNoChips('a follow-up was offered under an answer the thread has moved past')
    expect(canAskNextAnswer(message({ id: 'older' }), false, 'm1'), 'the gate counts an older answer as the newest').toBe(false)
  })

  it('leaves a reply that is still being written alone', () => {
    act(() => {
      root.render(createElement(AssistantBubble, {
        text: 'Half an answer',
        reasoning: '',
        tools: [],
        error: null,
        streaming: true,
        suggestions: QUESTIONS,
        canAskNext: true,
      }))
    })
    expectNoChips('chips were drawn under a turn still arriving')
    expect(canAskNextAnswer(message(), true, 'm1'), 'the gate opens while a turn is in flight').toBe(false)
  })

  it('leaves an answer the model failed alone', () => {
    mountRow({ status: 'error', error: 'The model stopped while it was working.' })
    expectNoChips('a failed answer still offered to be followed up on')
  })

  it('leaves an answer the reader stopped alone', () => {
    expect(canAskNextAnswer(message({ status: 'cancelled' }), false, 'm1'), 'the gate opens under a stopped turn').toBe(false)
    expect(canAskNextAnswer(message({ status: 'error', error: 'x' }), false, 'm1')).toBe(false)
  })

  it('holds the gate to a settled answer of this thread', () => {
    expect(canAskNextAnswer(message(), false, 'm1')).toBe(true)
    // The reader's own message is not an answer a follow-up belongs under.
    expect(canAskNextAnswer(message({ role: 'user' }), false, 'm1')).toBe(false)
  })
})

describe('the frame that carries them', () => {
  /** Ask for a turn and wait until it reaches the transport. */
  async function startTurn(messages: AssistantMessage[]): Promise<Run> {
    useAssistant.setState({
      ...original,
      activeId: 'c1',
      messages,
      messagesReady: true,
      turn: null,
      pending: [],
      turnTools: [],
      turnScopes: [],
      // The closing refreshes belong to the routes these cases do not exercise.
      loadConversations: vi.fn(async () => undefined),
      refreshAfterTurn: vi.fn(async () => undefined),
    })
    void useAssistant.getState().send('Tell me about the harbour.')
    await vi.waitFor(() => expect(harness.runs.length).toBe(1))
    return harness.runs[0]!
  }

  it('writes the questions onto the row they were stored on, without reading the thread again', async () => {
    const run = await startTurn([
      message({ id: 'other-answer', suggestions: ['An older question?'] }),
      message(),
    ])
    run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm1' })
    run.apply({ type: 'text', delta: 'The harbour was built in 1686.' })
    run.apply({
      type: 'title',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      title: 'Harbour history',
      suggestions: QUESTIONS,
    })

    const rows = useAssistant.getState().messages
    expect(rows.find((entry) => entry.id === 'm1')!.suggestions).toEqual(QUESTIONS)
    // The frame names one row, so it moves one row: the answer beside it keeps what it already had.
    expect(rows.find((entry) => entry.id === 'other-answer')!.suggestions).toEqual(['An older question?'])
    expect(harness.threadReads, 'the transcript was fetched again to show three chips').toBe(0)
    expect(useAssistant.getState().loadConversations).toHaveBeenCalled()

    await act(async () => { run.resolve() })
  })

  it('delivers the chips from a frame that says no title', async () => {
    // A pass that offered questions but named nothing — the blank title, or a thread the reader renamed
    // first — has the same place to put them, and must not be read as a rename that did not happen.
    const run = await startTurn([message()])
    run.apply({ type: 'title', conversationId: 'c1', assistantMessageId: 'm1', suggestions: QUESTIONS })
    expect(useAssistant.getState().messages[0]!.suggestions).toEqual(QUESTIONS)
    expect(harness.threadReads, 'a title-less frame went to get the thread instead').toBe(0)
    await act(async () => { run.resolve() })
  })

  it('leaves a row the thread does not hold alone', async () => {
    // The naming pass can land before the answer has been adopted into the transcript. Nothing is invented
    // for a row that is not on screen — the adopted read carries the chips the same way it carries the words.
    const run = await startTurn([message({ id: 'a-different-answer' })])
    run.apply({ type: 'title', conversationId: 'c1', assistantMessageId: 'm1', suggestions: QUESTIONS })
    const rows = useAssistant.getState().messages
    expect(rows).toHaveLength(1)
    expect(rows[0]!.suggestions).toBeUndefined()
    expect(harness.threadReads).toBe(0)
    await act(async () => { run.resolve() })
  })
})
