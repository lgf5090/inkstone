// @vitest-environment jsdom
/**
 * The half answer a killed worker left on its own run lease, as the transcript has to say it.
 *
 * A Worker isolate run out of CPU never reaches the `finally` that files an answer, so the thread ends up
 * holding the claim that turn made and the fragment its renewals carried — and no assistant row at all. The
 * conversation read reports both, and this file is about what the screen is then allowed to claim:
 *
 * - the words are drawn, because a reader who was shown a thread with nothing in it lost them anyway;
 * - the reason is drawn with them, because an unfinished reply with no word about it is indistinguishable
 *   from a finished one, which is the one thing this surface may not look like;
 * - the ceiling is named when the excerpt is itself shorter than what was written;
 * - and the continue control is *not* offered, because a continuation reads the newest stored row
 *   (`routes/assistant.ts` refuses one whose last row is not an assistant answer with words in it) and a
 *   fragment living only on a lease is exactly the case that refusal is for. `tests/assistant-run-partial.test.ts`
 *   pins that refusal over the wire; the assertion here is that the screen does not promise past it.
 *
 * jsdom lays nothing out, so every claim below is about structure, role and accessible name.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, RUN_PARTIAL_MAX_CHARS, type AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatView } from './ChatView'

const DRAFT = 'the first half of an answer, written before the worker died'

const harness = vi.hoisted(() => ({
  /** What the conversation route last answered with, per read. */
  read: { streaming: false, partialText: null as string | null, partialTruncated: false },
  reads: 0,
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
      conversationBranches: async () => ({ parent: null, siblings: [] }),
      conversationArtifacts: async () => ({ artifacts: [] }),
      conversation: async () => {
        harness.reads++
        return {
          conversation: { id: 'c1', title: 'Interrupted thread', updatedAt: 2, ephemeral: false },
          messages: [{
            id: 'q1',
            conversationId: 'c1',
            role: 'user' as const,
            content: 'Tell me the whole story.',
            reasoning: '',
            tools: [],
            attachments: [],
            status: 'complete' as const,
            error: null,
            createdAt: 1_700_000_000_000,
            source: 'chat' as const,
          }],
          attachments: [],
          streaming: harness.read.streaming,
          partialText: harness.read.partialText,
          partialTruncated: harness.read.partialTruncated,
          hasMore: false,
          nextBefore: null,
          hasNewer: false,
        }
      },
    },
  },
}))

type AssistantState = ReturnType<typeof useAssistant.getState>
const original = useAssistant.getState()

let root: Root
let host: HTMLElement

function question(): AssistantMessage {
  return {
    id: 'q1',
    conversationId: 'c1',
    role: 'user',
    content: 'Tell me the whole story.',
    reasoning: '',
    tools: [],
    attachments: [],
    status: 'complete',
    error: null,
    createdAt: 1_700_000_000_000,
    source: 'chat',
  }
}

function baseState(over: Partial<AssistantState> = {}): Partial<AssistantState> {
  return {
    ...original,
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'Interrupted thread', updatedAt: 2 } as AssistantState['conversations'][number]],
    messages: [question()],
    messagesReady: true,
    messagesError: null,
    messagesHasMore: false,
    messagesHasNewer: false,
    messagesLoadingMore: false,
    turn: null,
    remoteStreaming: false,
    remotePartial: null,
    remotePartialTruncated: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    canvasOpen: false,
    ephemeral: false,
    focusMessageId: null,
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    loadMcpServers: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadTaxonomy: vi.fn(async () => undefined),
    loadFlagged: vi.fn(async () => undefined),
    loadArtifacts: vi.fn(async () => undefined),
    loadConversations: vi.fn(async () => undefined),
    setConversationQuery: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    ...over,
  } as Partial<AssistantState>
}

async function mount(over: Partial<AssistantState> = {}): Promise<void> {
  useAssistant.setState(baseState(over))
  await act(async () => { root.render(createElement(ChatView)) })
}

const notices = () => [...document.body.querySelectorAll<HTMLElement>('[role="alert"]')]
const answerBodies = () => [...document.body.querySelectorAll<HTMLElement>('[data-answer-body]')]
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const continueButton = () => buttons().find((node) => (node.getAttribute('aria-label') ?? '') === t('assistant.chat.continue'))

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installTestGlobals()
  await initI18n()
  harness.read = { streaming: false, partialText: null, partialTruncated: false }
  harness.reads = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the transcript’s copy of an interrupted turn', () => {
  it('draws the words and says where they came from', async () => {
    await mount({ remotePartial: DRAFT })
    // The fragment is on the screen as model output, not as a status line about a missing answer.
    expect(answerBodies().some((node) => (node.textContent ?? '').includes(DRAFT)),
      'the half answer never reached the transcript').toBe(true)
    // And it cannot be read as a finished reply: the notice is the bubble's own alert, the same channel a
    // reply cut off at its output cap uses, and it names the worker rather than the model.
    const text = notices().map((node) => node.textContent ?? '').join('\n')
    expect(text).toContain(t('assistant.chat.remote_partial_stopped'))
    expect(notices()).toHaveLength(1)
  })

  it('offers no control that finishes an answer it cannot finish', async () => {
    // The rule the row-level control follows: an assistant row with words in it, and the newest one. A
    // draft has no row, so the button would start a turn the worker answers with a refusal.
    await mount({ remotePartial: DRAFT })
    expect(continueButton(), 'the screen promised a continuation the route refuses').toBeUndefined()
    // Nor a retry, which would spend the reader's budget on a different question.
    expect(buttons().some((node) => (node.getAttribute('aria-label') ?? '').includes(t('assistant.chat.retry')))).toBe(false)
  })

  it('names the ceiling when the excerpt is itself cut to it', async () => {
    await mount({ remotePartial: 'x'.repeat(RUN_PARTIAL_MAX_CHARS), remotePartialTruncated: true })
    const text = notices().map((node) => node.textContent ?? '').join('\n')
    expect(text).toContain(t('assistant.chat.remote_partial_cut', { limit: RUN_PARTIAL_MAX_CHARS }))
    expect(text).toContain(String(RUN_PARTIAL_MAX_CHARS))
    // The untruncated sentence is the one that leaves the second fact out; drawing both would read as one
    // long claim about a fragment that was whole.
    expect(text).not.toContain(t('assistant.chat.remote_partial_stopped'))
  })

  it('keeps a reply the server still holds out of the interrupted surface', async () => {
    // A live claim means an arriving answer, not a corpse: showing its draft under the interrupted notice
    // would tell the reader the writer is gone on the one evidence that says it is not.
    await mount({ remoteStreaming: true, remotePartial: DRAFT })
    expect(answerBodies().some((node) => (node.textContent ?? '').includes(DRAFT)),
      'a live turn was reported as an interrupted one').toBe(false)
    expect(notices().map((node) => node.textContent ?? '').join('\n'))
      .not.toContain(t('assistant.chat.remote_partial_stopped'))
    // The waiting line is what that state draws, and it stays the only thing said about it.
    expect(document.body.textContent).toContain(t('assistant.chat.remote_streaming'))
  })

  it('steps aside for a turn this tab is writing', async () => {
    await mount({
      remotePartial: DRAFT,
      turn: {
        token: 1, conversationId: 'c1', userText: '', assistantId: null, text: 'arriving', reasoning: '',
        attachments: [], tools: [], stage: 'generating', error: null, done: false, startedAt: 1, finishedAt: null, usage: null,
      },
    })
    expect(answerBodies().some((node) => (node.textContent ?? '').includes(DRAFT))).toBe(false)
  })
})

describe('the read that feeds it', () => {
  /** Drive the store's own open of the thread through the mocked conversation route. */
  async function open(over: Partial<typeof harness.read>): Promise<void> {
    harness.read = { streaming: false, partialText: null, partialTruncated: false, ...over }
    useAssistant.setState({ ...baseState(), openConversation: original.openConversation })
    await act(async () => { await useAssistant.getState().openConversation('c1') })
  }

  it('keeps the fragment a read reports with no live turn', async () => {
    await open({ partialText: DRAFT })
    const state = useAssistant.getState()
    expect(state.remoteStreaming, 'a claim nobody holds was reported as a live turn').toBe(false)
    expect(state.remotePartial).toBe(DRAFT)
    expect(state.remotePartialTruncated).toBe(false)
  })

  it('reports the ceiling it was told about', async () => {
    await open({ partialText: 'x'.repeat(RUN_PARTIAL_MAX_CHARS), partialTruncated: true })
    expect(useAssistant.getState().remotePartialTruncated).toBe(true)
  })

  it('keeps nothing from a read whose turn is still being held', async () => {
    await open({ streaming: true, partialText: DRAFT })
    expect(useAssistant.getState().remotePartial).toBeNull()
  })

  it('drops the fragment of the thread the reader left', async () => {
    useAssistant.setState(baseState({ remotePartial: DRAFT, remotePartialTruncated: true }))
    await open({})
    expect(useAssistant.getState().remotePartial, 'one thread’s draft was carried into the next read').toBeNull()
    expect(useAssistant.getState().remotePartialTruncated).toBe(false)
  })

  it('asks the route for the thread rather than inventing a row for the draft', async () => {
    await open({ partialText: DRAFT })
    const state = useAssistant.getState()
    expect(harness.reads).toBeGreaterThan(0)
    // The transcript's rows are the server's: a fragment shown here has no row, and the store may not
    // manufacture one — filing it is the next claim's job, on the server, under the reader's own account.
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.role).toBe('user')
  })
})
