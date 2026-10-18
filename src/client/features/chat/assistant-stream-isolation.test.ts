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
 *
 * The last case is about what a frame is allowed to write rather than which turn it may write: the pages
 * a search consulted exist on the stored row, and the closing frame is the only one that carries them.
 *
 * The block at the end is about the stream dying under a turn rather than being stopped in it. That is a
 * different reader's problem: nothing refused the turn, so nothing has a reason to tell, and the one fact
 * worth saying is that the words stopped arriving — and then who keeps watching for the row the worker
 * files a moment after the break.
 *
 * The last block leaves the store behind altogether and reads bytes: a turn arrives as cuts of one buffer,
 * and the frames a cut produces are the answer the reader sees. That is where a keepalive frame — the one
 * line of this protocol with no `data:` on it — has somewhere to go wrong. It has one more, which no shape
 * of a buffer can show: alone in its chunk it leaves nothing behind to cut, so the only thing left to check
 * is whether the loop came back to the reader at all. That is what the block after it holds a reader of its
 * own for.
 *
 * Two shapes are left, and both are the transport failing outside the frame loop: a request that dies before
 * there are headers, and a turn the worker read and refused. The second is built by the same factory every
 * JSON route's failure goes through, so this file's stand-in for `lib/api` has to carry it — a mocked module
 * answers an export left out with a complaint of its own, and that complaint would be what the bubble says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantSource, ChatStreamEvent } from '@shared/assistant'
import { initI18n, t, translateApiError } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { streamAssistantTurn, type StreamTurnInput } from './stream'
import {
  REMOTE_WATCH_MAX_MS,
  REMOTE_WATCH_POLL_MS,
  useAssistant,
  stopRemoteStreamWatch,
} from './assistant-store'

interface Run {
  input: StreamTurnInput
  apply: (event: ChatStreamEvent) => void
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
}

const harness = vi.hoisted(() => ({
  /** Every send's stream, in the order the store asked for them. */
  runs: [] as Run[],
  /** What `api.assistant.conversation` answers with, changed per case. */
  detail: { messages: [] as unknown[], streaming: false },
  /** How many thread reads fail from now on: the read that follows a broken connection. */
  failingReads: 0,
  /** Set by the cases that want the real reader over a real body instead of a recorded run. */
  realBody: false,
}))

vi.mock('../../lib/api', () => {
  // Built the way `lib/api` builds it — status, code, message, and the route's own line last. A stand-in
  // that read its first argument as the message would print `0` in the bubble for every `ApiError` the
  // stream helper throws, which is not the sentence any of these cases are about.
  class ApiError extends Error {
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
  }

  return {
    ApiError,
    CLIENT_ID: 'test-client',
    // The signature the real factory has, for the one path this file lets run: a streamed turn owns its
    // response, so it reads a non-2xx itself and builds the error with this. An export left out does not
    // quietly skip the refusal — the mock's own complaint about the missing export is what arrives in the
    // bubble, which is why the case in `a turn the worker refused` says so out loud. Only the shape is
    // stood in for here: how much of a route's reason a screen may hold, and which runs of it are a
    // credential instead of a diagnosis, is `lib/api`'s policy and no copy of it belongs in a test. That
    // half is pinned where it is decided — `stream-refusal.test.ts` holds this streamed path and an
    // ordinary JSON route to the same two lines for the same body.
    routeApiError: (status: number, body: unknown): ApiError => {
      const refused = (body as { error?: { code?: string, message?: string, details?: unknown } } | null | undefined)?.error
      const code = refused?.code ?? 'unknown'
      return new ApiError(
        status,
        code,
        translateApiError(code, refused?.message ?? t('api.request_failed_status', { status })),
        refused?.details,
        refused?.message,
      )
    },
    api: {
      assistant: {
        conversation: vi.fn(async (id: string) => {
          if (harness.failingReads > 0) {
            harness.failingReads -= 1
            throw new Error('the thread read failed the way a read over a dead connection does')
          }
          return {
            conversation: { id, ephemeral: false },
            messages: harness.detail.messages,
            attachments: [],
            streaming: harness.detail.streaming,
          }
        }),
        conversationArtifacts: vi.fn(async () => ({ artifacts: [] })),
        cancel: vi.fn(async () => ({ cancelled: true })),
      },
    },
  }
})

// The transport, held open by the test: each case decides what each stream emits and when it ends.
// The two breakage cases opt into the real helper instead, so what is under test is the reading loop
// itself — a body whose frames stop arriving — and not a stand-in chosen to agree with it.
vi.mock('./stream', async () => {
  const actual = await vi.importActual<typeof import('./stream')>('./stream')
  return {
    ...actual,
    streamAssistantTurn: (
      input: StreamTurnInput,
      apply: (event: ChatStreamEvent) => void,
      signal: AbortSignal,
    ) => {
      if (harness.realBody) return actual.streamAssistantTurn(input, apply, signal)
      return new Promise<void>((resolve, reject) => {
        harness.runs.push({ input, apply, signal, resolve, reject })
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    },
  }
})

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

function userRow(): AssistantMessage {
  return assistantRow({ id: 'm-question', role: 'user', content: 'a long question', status: 'complete', createdAt: 0 })
}

/** Every string the thread surface can print for this turn, in one blob to search. */
function visibleText(): string {
  const state = useAssistant.getState()
  return JSON.stringify([
    state.messages,
    state.turn ? { text: state.turn.text, error: state.turn.error } : null,
    state.messagesError,
  ])
}

/**
 * A turn whose connection gives out under it: four frames arrive, and the read after them fails.
 *
 * The failure is raised from `pull` rather than from `start` so that it lands only once the reader has
 * taken every frame that was queued — the case is a stream that died mid-sentence, not one that never
 * began. The reason is the browser's own: a `TypeError` reading "Failed to fetch", which names no part
 * of this app and has no translation.
 */
function stubTurnThatBreaksAfterFourFrames(): void {
  const frames = [
    { type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' },
    { type: 'text', delta: 'half an ' },
    { type: 'text', delta: 'answer ' },
    { type: 'text', delta: 'that broke' },
  ]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
    },
    pull(controller) {
      controller.error(new TypeError('Failed to fetch'))
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.runs.length = 0
  harness.detail = { messages: [], streaming: false }
  harness.failingReads = 0
  harness.realBody = false
  reset()
})

afterEach(() => {
  stopRemoteStreamWatch()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
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

describe('the pages a turn’s search consulted', () => {
  it('are given to the live turn by the frame that names the stored row', async () => {
    const page: AssistantSource = { url: 'https://example.com/a', title: 'A page' }
    reset({ activeId: 'c1' })
    const sending = useAssistant.getState().send('what changed this week?')
    const run = await nextRun()
    run.apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm-answer' })
    run.apply({ type: 'text', delta: 'It says so on the page.' })
    // The citations are written on the row, and that row only comes back on the closing frame — which is
    // also the one moment the answer already on screen can be told what it was built on.
    run.apply({
      type: 'done',
      finalMessage: assistantRow({ id: 'm-answer', content: 'It says so on the page.', status: 'complete', sources: [page] }),
    })
    expect(useAssistant.getState().turn?.sources).toEqual([page])
    run.resolve()
    await sending
  })
})

describe('a connection that broke under the turn', () => {
  // The chase's own budget (`ADOPT_ATTEMPTS` × `ADOPT_POLL_MS`) is 2400ms and is not exported; this is
  // longer than it and shorter than one remote poll after it, so the hand-over is what is being watched.
  const CHASE_BUDGET_MS = 3000

  it('says the connection broke, then brings the filed row on screen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    harness.realBody = true
    stubTurnThatBreaksAfterFourFrames()
    // The read that follows the break goes out with it — the connection is not back yet — and the worker
    // has not filed the cancelled row at this moment.
    harness.failingReads = 1
    harness.detail = { messages: [userRow()], streaming: true }
    reset({ activeId: 'c1' })

    const sending = useAssistant.getState().send('a long question')
    await vi.advanceTimersByTimeAsync(0)
    await sending

    const during = useAssistant.getState()
    expect(during.turn?.text, 'the words that arrived before the break were thrown away').toBe('half an answer that broke')
    expect(during.turn?.error, 'a broken stream is not a refusal the route explained').toBe(t('assistant.chat.stream_disconnected'))
    expect(during.remoteStreaming, 'nobody was left watching for the row the worker files').toBe(true)

    // The worker files the half answer a moment later; the poll is what reads it back.
    harness.detail = { messages: [userRow(), assistantRow({ content: 'half an answer that broke' })], streaming: false }
    await vi.advanceTimersByTimeAsync(REMOTE_WATCH_POLL_MS)

    const after = useAssistant.getState()
    expect(after.messages.map((message) => message.id), 'the cancelled row never reached the screen').toContain('m-answer')
    expect(after.messages[1]?.status).toBe('cancelled')
    expect(after.turn, 'the bubble is dropped only once its row is on screen').toBeNull()
    expect(visibleText(), 'the browser’s own text was handed to the reader').not.toContain('Failed to fetch')
  })

  it('hands the thread to the conversation poll when the row misses the whole chase budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    harness.realBody = true
    stubTurnThatBreaksAfterFourFrames()
    // Every read succeeds and every one of them still says the run is going, so the chase runs out while
    // the stored row is still missing.
    harness.detail = { messages: [userRow()], streaming: true }
    reset({ activeId: 'c1' })

    const sending = useAssistant.getState().send('a long question')
    await vi.advanceTimersByTimeAsync(CHASE_BUDGET_MS)
    await sending

    const state = useAssistant.getState()
    expect(state.remoteStreaming, 'the chase gave up without leaving a poll behind').toBe(true)
    expect(state.turn?.text, 'the half answer went off the screen with the turn').toBe('half an answer that broke')

    // And the poll is really running: one more beat, with the row now filed, puts it on screen.
    harness.detail = { messages: [userRow(), assistantRow({ content: 'half an answer that broke' })], streaming: false }
    await vi.advanceTimersByTimeAsync(REMOTE_WATCH_POLL_MS)
    expect(useAssistant.getState().messages.map((message) => message.id)).toContain('m-answer')
    expect(visibleText()).not.toContain('Failed to fetch')
  })
})

describe('the frames inside one read', () => {
  /** One frame, in the exact shape the worker writes it. */
  function frame(payload: Record<string, unknown>): string {
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  /**
   * Push `chunks` through the reading loop itself and collect what it hands over, in order.
   *
   * The store is not the subject here: what is being checked is which bytes a cut of the buffer is
   * allowed to produce. `realBody` puts the helper of this very file back on the wire, so the loop under
   * test is the one `stream.ts` ships and not a stand-in that agrees with it.
   */
  async function readFrames(chunks: string[]): Promise<ChatStreamEvent[]> {
    harness.realBody = true
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
    const seen: ChatStreamEvent[] = []
    // A skipped frame is logged by design, and these cases are about what arrives, not about the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await streamAssistantTurn({ message: 'a question' }, (event) => seen.push(event), new AbortController().signal)
    warn.mockRestore()
    return seen
  }

  /** The words the reader would end up seeing, for a stream of text frames. */
  async function readAnswer(chunks: string[]): Promise<string[]> {
    return (await readFrames(chunks)).map((event) => (event.type === 'text' ? event.delta ?? '' : event.type))
  }

  it('hands over every frame that shares a read with a keepalive frame', async () => {
    // The worker writes `: keepalive\n\n` when a turn has been quiet for `KEEPALIVE_AFTER_MS`, and a
    // comment frame is the one thing in this protocol that has no `data:` line. Skipping it is the
    // correct answer; skipping the *boundary* with it is not, because the buffer is then one frame
    // shorter than the index the next cut is taken from — which cuts the sentence that follows.
    // The frames are written into one read here on purpose. A keepalive that arrives alone does the same
    // thing to that index but leaves an empty buffer behind, and the loop then never returns to the
    // reader at all: that case would not fail this file, it would hang it, so it is kept out and the loss
    // of the words is what is asserted, on the shape that can say so.
    const deltas = await readAnswer([
      ': keepalive\n\n' + frame({ type: 'text', delta: 'half an answer' }) + frame({ type: 'text', delta: 'is' }) + frame({ type: 'text', delta: 'better than nothing' }),
    ])
    expect(deltas).toEqual(['half an answer', 'is', 'better than nothing'])
  })

  it('keeps the frames of one read in order and whole', async () => {
    const events = await readFrames([
      frame({ type: 'start', conversationId: 'c1', assistantMessageId: 'm1' })
        + frame({ type: 'text', delta: 'half an ' })
        + frame({ type: 'text', delta: 'answer' })
        + frame({ type: 'done' }),
    ])
    expect(events.map((event) => event.type)).toEqual(['start', 'text', 'text', 'done'])
    expect(events.map((event) => (event.type === 'text' ? event.delta : undefined)).join('')).toBe('half an answer')
  })

  it('waits for the rest of a frame that arrives cut in half', async () => {
    const whole = frame({ type: 'text', delta: 'written across two reads' })
    const events = await readFrames([whole.slice(0, 20), whole.slice(20)])
    expect(events).toEqual([{ type: 'text', delta: 'written across two reads' }])
  })

  it('drops a frame it cannot parse and keeps every frame around it', async () => {
    // Read on its own, without the keepalive above it: a comment frame leaves this index stale in a way
    // that makes the parse-failure path below the only way out of the loop, so the two shapes are proved
    // apart rather than as one fixture that would stall on the older reader instead of failing it.
    const deltas = await readAnswer([
      frame({ type: 'text', delta: 'before' }) + 'data: no json here\n\n' + frame({ type: 'text', delta: 'after' }),
    ])
    expect(deltas).toEqual(['before', 'after'])
  })
})

describe('a keepalive that arrives in a chunk of its own', () => {
  /** How many chunks this case hands the loop at most, and the point of holding the reader itself. */
  const MAX_CHUNKS = 4
  /**
   * How many cuts taken out of an already-empty buffer count as a loop that has stopped going back to the
   * reader. A run that behaves makes none; a spin reaches this in microseconds.
   */
  const EMPTY_CUT_CAP = 500

  /**
   * Start counting cuts taken out of an already-empty buffer, and hand back the release.
   *
   * A loop that has stopped going back to the reader is the harder shape to observe, and it is the one this
   * case is about: with a stale index it cuts the same empty buffer round and round *synchronously*, so the
   * thread never yields, and no timer, race or assertion written in this case can run while it does. Leaving
   * it alone would freeze the runner beside a file that never reports — which is why the older block above
   * says it kept this shape out. So the cut itself is counted, and past the cap it throws. That breaks the
   * spin, misses the loop's own failure handler entirely, and lets the case state what happened.
   *
   * A run that behaves makes no such cut at all: every frame it splits has a line in it.
   */
  function countEmptyCuts(cuts: { count: number }): () => void {
    // The untouched method, held in the loose shape that can forward whatever the loop passes to it.
    const split = String.prototype.split as (this: unknown, separator?: unknown, limit?: unknown) => string[]
    Object.defineProperty(String.prototype, 'split', {
      configurable: true,
      writable: true,
      value(this: string, separator?: unknown, limit?: unknown): string[] {
        if (this.length === 0 && separator === '\n') {
          cuts.count += 1
          if (cuts.count > EMPTY_CUT_CAP) throw new Error(`the reading loop cut an empty buffer ${EMPTY_CUT_CAP} times over`)
        }
        return split.call(this, separator, limit)
      },
    })
    return () => {
      Object.defineProperty(String.prototype, 'split', { configurable: true, writable: true, value: split })
    }
  }

  /**
   * Read `chunks` through the loop with a reader the case bounds by hand.
   *
   * The block above can afford a real `ReadableStream`, because it wants to know which frames a cut of the
   * buffer produces. This one wants to know whether the loop comes back for the next chunk at all, and only
   * a reader of the test's own can say how many times it was asked — so `pipeThrough` is handed a reader that
   * counts, answers the chunks it was given, and reports the stream as over past them. A loop that kept
   * asking would then end here rather than wait on a reader that never answers, and its count is the failure.
   */
  async function readBounded(chunks: string[]): Promise<{ events: ChatStreamEvent[]; reads: number; cuts: number; failure: unknown }> {
    harness.realBody = true
    let reads = 0
    const reader = {
      read(): Promise<unknown> {
        reads += 1
        const chunk = reads <= chunks.length ? chunks[reads - 1] : undefined
        if (chunk === undefined || reads > MAX_CHUNKS) return Promise.resolve({ done: true })
        return Promise.resolve({ value: chunk, done: false })
      },
    }
    const response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
      headers: { 'content-type': 'text/event-stream' },
    })
    Object.defineProperty(response, 'body', { value: { pipeThrough: () => ({ getReader: () => reader }) } })
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const cuts = { count: 0 }
    const releaseCuts = countEmptyCuts(cuts)
    const events: ChatStreamEvent[] = []
    let failure: unknown = null
    try {
      await streamAssistantTurn({ message: 'a question' }, (event) => events.push(event), new AbortController().signal)
    } catch (error) {
      failure = error
    } finally {
      releaseCuts()
    }
    return { events, reads, cuts: cuts.count, failure }
  }

  it('goes back to the reader instead of spinning on the buffer the keepalive emptied', async () => {
    // The worker's keepalive is one line with no `data:` on it, and a quiet turn writes it between two
    // answers rather than in the middle of one — so it arrives as a chunk by itself, and cutting it leaves
    // the buffer empty. The index the next cut is taken from was measured against a longer buffer, and a
    // loop that keeps that index does not lose any words here: it never gets back to the reader, and the
    // page hangs with an answer still coming. That is the shape `d7fe6d01` closed, and it had no assertion
    // because nothing above it could see it: the frames that survive a stale index are the shared-chunk
    // case, which is what the older file was written to say.
    const { events, reads, cuts, failure } = await readBounded([
      ': keepalive\n\n',
      `data: ${JSON.stringify({ type: 'text', delta: 'the words after the keepalive' })}\n\n`,
    ])

    expect(cuts, 'the loop cut the emptied buffer over and over instead of asking the reader again').toBeLessThanOrEqual(EMPTY_CUT_CAP)
    expect(failure, 'the reading loop did not finish the stream it was handed').toBeNull()
    // The keepalive, the chunk after it, and the end of the stream: the loop returned to the reader once
    // per chunk, and stopped returning once there were no more.
    expect(reads, 'the reader was not asked for the chunk after the keepalive').toBe(3)
    expect(reads, 'a loop past the chunks it was given never went back to the reader').toBeLessThanOrEqual(MAX_CHUNKS)
    expect(events).toEqual([{ type: 'text', delta: 'the words after the keepalive' }])
  })
})

describe('a turn the worker refused before it started', () => {
  it('hands the reader the refusal this app already has for the code, and nothing about the mock', async () => {
    // The third way a turn ends with no answer: the worker read the request, said no, and answered with a
    // status and a body instead of a stream. `stream.ts` reads that failure itself — on the other half of
    // this file's wire it owns the response — and it builds the error with `routeApiError`, the same factory
    // every JSON route's failure goes through. A stand-in for `lib/api` that leaves that export out does not
    // make this case about refusals fail to be about refusals; it makes the turn answer with a mock warning
    // dressed as a refusal, which is the shape of every hole this file's transport has ever had.
    harness.realBody = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'bad_request',
        message: 'A model name is required.',
        details: { modelId: 'The model named for this turn is not an enabled chat model of this account.' },
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } })))
    reset({ activeId: 'c1' })

    const sending = useAssistant.getState().send('a long question')
    expect(await sending, 'a turn the worker refused was taken as one it started').toBe(false)

    const state = useAssistant.getState()
    expect(state.turn?.error, 'a refusal read by the stream helper lost the sentence the app writes for its code')
      .toContain(t('api.error.bad_request'))
    expect(state.turn?.error, 'the field the route named did not reach the line the reader is shown')
      .toContain('A model name is required.')
    // Not the two failures this file is otherwise about: nobody broke a connection, and nothing was cut off
    // mid-sentence, so neither of their lines may be what the reader is told.
    expect(state.turn?.error).not.toBe(t('assistant.chat.stream_disconnected'))
    expect(state.turn?.error).not.toBe(t('api.no_network_connection'))
    expect(visibleText(), 'the stand-in’s own complaint reached the reader instead of the refusal')
      .not.toContain('routeApiError')
  })
})

describe('a request that died before its headers', () => {
  /**
   * A turn whose `fetch` itself never answered.
   *
   * This is the other half of a broken connection, and a different piece of code: everything above this
   * block failed *under* a response the worker had already started, and only the reading loop can see it.
   * A request that dies on the way to the headers never gets that far, so nothing in the loop is involved
   * — and the error the browser raises is the same untranslatable sentence, arriving where no failure
   * handler had been put. It is not the same sentence to the reader either: there is no half answer to
   * keep on the screen and no turn for 「继续生成」 to pick up, because the worker was never told.
   */
  it('says the app’s own offline line, not the browser’s', async () => {
    harness.realBody = true
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    reset({ activeId: 'c1' })

    const sending = useAssistant.getState().send('a long question')
    expect(await sending, 'a request that never reached the worker was taken as an accepted turn').toBe(false)

    const state = useAssistant.getState()
    expect(state.turn?.error, 'a request that died on the way there is not the app’s own news').toBe(t('api.no_network_connection'))
    expect(visibleText(), 'the browser’s own text was handed to the reader').not.toContain('Failed to fetch')
    expect(visibleText()).not.toContain('TypeError')
  })

  it('leaves the reader’s own stop a stop, even before the headers', async () => {
    // The one failure this path is not allowed to relabel: the request the reader cancelled answers with an
    // abort, and turning that into "no network" would tell them their connection is gone when their finger
    // pressed the button.
    harness.realBody = true
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    reset({ activeId: 'c1' })

    const controller = new AbortController()
    const pending = streamAssistantTurn({ message: 'a long question' }, () => undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
