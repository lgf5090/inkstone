// @vitest-environment jsdom
/**
 * Two turns at once, and what each of them is allowed to write.
 *
 * A streamed turn outlives the screen it was asked from: the reader can walk to another conversation
 * and ask something there while the first answer is still arriving. What keeps that honest is the
 * token each send puts on its turn — the events of the older stream find a different token on screen
 * and are dropped instead of appended to it — plus the rule that a turn's `finally` settles only the
 * turn it started.
 *
 * The stopped-answer case sits beside it: the words the reader watched arrive are theirs even when the
 * worker's row comes back blank, so adopting the stored thread must not erase them. And a turn that is
 * being written in another tab is a state this tab has to leave on its own, which is what the remote
 * watch is for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import {
  REMOTE_WATCH_MAX_MS,
  REMOTE_WATCH_POLL_MS,
  useAssistant,
  stopRemoteStreamWatch,
} from './assistant-store'

interface Run {
  input: Record<string, unknown>
  apply: (event: { type: string } & Record<string, unknown>) => void
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
}

const harness = vi.hoisted(() => ({
  /** Every send's stream, in the order the store asked for them. */
  runs: [] as Run[],
  /** What `api.assistant.conversation` answers with, changed per case. */
  detail: { messages: [] as unknown[], streaming: false },
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      conversation: vi.fn(async (id: string) => ({
        conversation: { id, ephemeral: false },
        messages: harness.detail.messages,
        attachments: [],
        streaming: harness.detail.streaming,
      })),
      conversationArtifacts: vi.fn(async () => ({ artifacts: [] })),
      cancel: vi.fn(async () => ({ cancelled: true })),
    },
  },
}))

// The transport, held open by the test: each case decides what each stream emits and when it ends.
vi.mock('./stream', () => ({
  streamAssistantTurn: (
    input: Record<string, unknown>,
    apply: (event: { type: string } & Record<string, unknown>) => void,
    signal: AbortSignal,
  ) => new Promise<void>((resolve, reject) => {
    harness.runs.push({ input, apply, signal, resolve, reject })
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }),
}))

const original = useAssistant.getState()

function reset(patch: Partial<ReturnType<typeof useAssistant.getState>> = {}): void {
  useAssistant.setState({
    ...original,
    activeId: null,
    messages: [],
    messagesReady: true,
    turn: null,
    remoteStreaming: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    // The after-turn refreshes reach for routes these cases do not exercise.
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
    ...patch,
  })
}

/** Waits for the next send to reach the transport and hands back its run. */
async function nextRun(): Promise<Run> {
  await vi.waitFor(() => expect(harness.runs.length).toBeGreaterThan(0))
  return harness.runs[harness.runs.length - 1]!
}

function assistantRow(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm-answer',
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    reasoning: '',
    tools: [],
    attachments: [],
    status: 'cancelled',
    error: null,
    createdAt: 1,
    source: 'chat',
    ...over,
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.detail = { messages: [], streaming: false }
  reset()
})

afterEach(() => {
  stopRemoteStreamWatch()
  vi.useRealTimers()
  vi.clearAllMocks()
  useAssistant.setState(original, true)
})

describe('two turns at once', () => {
  it('does not let a stream that outlived its conversation write into the next thread', async () => {
    reset({ activeId: 'a' })
    const first = useAssistant.getState().send('first question')
    const runA = await nextRun()
    runA.apply({ type: 'start', conversationId: 'a', assistantMessageId: 'm-a' })
    runA.apply({ type: 'text', delta: 'A words' })
    expect(useAssistant.getState().turn?.text).toBe('A words')

    // The reader moves to another thread and asks there while A is still arriving.
    await useAssistant.getState().openConversation('b')
    expect(useAssistant.getState().turn, 'the view of A should be dropped, not carried into B').toBeNull()
    const second = useAssistant.getState().send('second question')
    const runB = await nextRun()
    runB.apply({ type: 'start', conversationId: 'b', assistantMessageId: 'm-b' })
    runB.apply({ type: 'text', delta: 'B words' })

    // The old stream keeps going. None of it belongs to the turn on screen.
    runA.apply({ type: 'text', delta: ' and more A' })
    runA.apply({ type: 'done', finalMessage: assistantRow({ id: 'm-a', content: 'A words and more A', status: 'complete' }) })
    runA.resolve()
    await first

    const afterOld = useAssistant.getState()
    expect(afterOld.turn?.text, 'the older stream contaminated the newer turn').toBe('B words')
    expect(afterOld.turn?.done, 'the older stream settled the newer turn').toBe(false)

    runB.apply({ type: 'done' })
    runB.resolve()
    await second
    expect(useAssistant.getState().turn).toBeNull()
  })

  it('stops only its own turn, leaving a newer one running', async () => {
    reset({ activeId: 'a' })
    const first = useAssistant.getState().send('first question')
    const runA = await nextRun()
    runA.apply({ type: 'start', conversationId: 'a', assistantMessageId: 'm-a' })
    runA.apply({ type: 'text', delta: 'half of A' })

    useAssistant.getState().stop()
    expect(runA.signal.aborted, 'stop did not abort the turn it was shown').toBe(true)

    // A new question goes out before the stopped request has finished unwinding.
    const second = useAssistant.getState().send('second question')
    const runB = await nextRun()
    expect(runB.signal.aborted, 'the new turn was aborted by the old stop').toBe(false)
    await first

    runB.apply({ type: 'start', conversationId: 'a', assistantMessageId: 'm-b' })
    runB.apply({ type: 'text', delta: 'the new answer' })
    const state = useAssistant.getState()
    expect(state.turn?.text).toBe('the new answer')
    expect(state.turn?.done, 'the old turn settled the new one').toBe(false)

    runB.apply({ type: 'done' })
    runB.resolve()
    await second
  })
})

describe('a stopped answer', () => {
  it('keeps the words the reader watched arrive when the stored row is blank', async () => {
    reset({ activeId: 'c1' })
    const sending = useAssistant.getState().send('a long question')
    const run = await nextRun()
    run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' })
    run.apply({ type: 'text', delta: 'half an ' })
    run.apply({ type: 'text', delta: 'answer' })
    // The worker filed the stopped turn from its last completed step, so the stored answer is empty.
    harness.detail = { messages: [assistantRow()], streaming: false }

    useAssistant.getState().stop()
    await sending

    const state = useAssistant.getState()
    expect(state.turn, 'the live turn should be handed over to the stored thread').toBeNull()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.content, 'the fragment the reader chose to keep was erased').toBe('half an answer')
    expect(state.messages[0]?.status).toBe('cancelled')
  })

  it('prefers the stored answer when the worker already saved it', async () => {
    reset({ activeId: 'c1' })
    const sending = useAssistant.getState().send('a long question')
    const run = await nextRun()
    run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' })
    run.apply({ type: 'text', delta: 'half an answer' })
    harness.detail = { messages: [assistantRow({ content: 'half an answer, merged by the worker' })], streaming: false }

    useAssistant.getState().stop()
    await sending

    expect(useAssistant.getState().messages[0]?.content).toBe('half an answer, merged by the worker')
  })
})

describe('a turn being written elsewhere', () => {
  it('clears the placeholder when the other writer finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    harness.detail = { messages: [], streaming: true }
    await useAssistant.getState().openConversation('c1')
    expect(useAssistant.getState().remoteStreaming).toBe(true)

    harness.detail = { messages: [assistantRow({ content: 'written elsewhere', status: 'complete' })], streaming: false }
    await vi.advanceTimersByTimeAsync(REMOTE_WATCH_POLL_MS)
    expect(useAssistant.getState().remoteStreaming).toBe(false)
    expect(useAssistant.getState().messages[0]?.content).toBe('written elsewhere')
  })

  it('gives the composer back when the marker never clears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    harness.detail = { messages: [], streaming: true }
    await useAssistant.getState().openConversation('c1')
    expect(useAssistant.getState().remoteStreaming).toBe(true)

    await vi.advanceTimersByTimeAsync(REMOTE_WATCH_MAX_MS)
    expect(useAssistant.getState().remoteStreaming).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.chat.remote_streaming_lost') }))
    toast.mockRestore()
  })
})

describe('a request the worker never took', () => {
  it('hands the draft text, attachments and pins back', async () => {
    reset({
      activeId: 'c1',
      pending: [{ localId: 'l1', id: 'a1', filename: 'shot.png', mime: 'image/png', size: 10, kind: 'image', progress: 1, status: 'ready' }],
      turnTools: ['search_notes'],
      turnScopes: [{ kind: 'tag', id: 't1', name: 'work' }],
    })
    const sending = useAssistant.getState().send('question with a picture')
    const run = await nextRun()
    run.reject(new Error('network down'))

    expect(await sending).toBe(false)
    const state = useAssistant.getState()
    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]?.id).toBe('a1')
    expect(state.turnTools).toEqual(['search_notes'])
    expect(state.turnScopes).toEqual([{ kind: 'tag', id: 't1', name: 'work' }])
    expect(state.turn?.error).toBe('network down')
  })

  it('lets the draft go once a frame proves the worker took the turn', async () => {
    reset({
      activeId: 'c1',
      pending: [{ localId: 'l1', id: 'a1', filename: 'shot.png', mime: 'image/png', size: 10, kind: 'image', progress: 1, status: 'ready' }],
    })
    const sending = useAssistant.getState().send('question with a picture')
    const run = await nextRun()
    run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' })
    run.resolve()
    expect(await sending).toBe(true)
    expect(useAssistant.getState().pending).toEqual([])
  })
})
