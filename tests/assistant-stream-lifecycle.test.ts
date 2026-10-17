// @vitest-environment node
/**
 * The life of one streamed turn: what it says while it waits, and how a turn that cannot start is answered.
 *
 * Two failures of the same transport, both about what the reader is told. A silent connection looks like
 * a dead one to anything sitting between the worker and the browser, so a long tool call used to lose its
 * answer halfway through generation; and a request that could never be served — the day's budget spent,
 * nothing to retry — used to arrive as a `200 OK` whose only complaint was a frame inside the body,
 * invisible to any client that is not this one SSE reader.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantSettings, ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
/** The interval the stream keeps itself alive on; the test waits one beat past it, not two. */
const KEEPALIVE_MS = 15_000

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Env
let store: AssistantStore
const turnTasks: Promise<unknown>[] = []
const ctx = { waitUntil: (task: Promise<unknown>) => { turnTasks.push(task) } } as ExecutionContext

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function settleTurns(): Promise<void> {
  await Promise.all(turnTasks.splice(0))
}

async function chatRequest(body: Record<string, unknown>): Promise<Response> {
  return await app.fetch(new Request('http://localhost/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env, ctx)
}

/** The reason a refused turn gives, read off the status body rather than off a stream. */
async function refusal(response: Response): Promise<string> {
  const body = await response.json() as { error?: { message?: string } }
  return body.error?.message ?? ''
}

/** A turn that was accepted: its whole stream, read back as the events it carried. */
async function sseEvents(response: Response): Promise<ChatStreamEvent[]> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5)) as ChatStreamEvent)
}

/**
 * The turn's own words, as they arrive.
 *
 * Read in the background rather than with `response.text()`: the point of these cases is what the stream
 * says while the turn is still running, so nothing may wait for it to end.
 */
function openStream(response: Response): { text: () => Promise<string>, closed: Promise<void> } {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  const closed = (async () => {
    const reader = response.body!.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
  })()
  return {
    text: async () => {
      // The writes this reader is waiting on travel through the job queue, not the timer queue.
      await vi.advanceTimersByTimeAsync(0)
      return chunks.join('')
    },
    closed,
  }
}

const chunk = (text: string, finishReason: string | null = null) => `data: ${JSON.stringify({
  choices: [{ index: 0, finish_reason: finishReason, delta: text ? { content: text } : {} }],
})}\n\n`

/**
 * A provider call that answers only when the test lets it.
 *
 * This is the one situation the heartbeat exists for: a turn that is running and has nothing to show for
 * it. Anything the turn asks for afterwards is answered at once, so the stream is quiet for the reason
 * under test rather than for a missing stub.
 */
function holdUpstream(): { say: (text: string, finishReason?: string | null) => Promise<void>, finish: () => Promise<void> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let calls = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++
    if (calls === 1) return new Response(readable, { headers: { 'content-type': 'text/event-stream' } })
    return new Response(encoder.encode(chunk('Not the call under test.', 'stop')), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return {
    say: async (text, finishReason = null) => { await writer.write(encoder.encode(chunk(text, finishReason))) },
    finish: async () => { await writer.close() },
  }
}

/** A call that would spend the provider's time if the turn were ever allowed to reach it. */
function refuseProvider(): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('a turn that cannot start must not reach the provider')
  }))
}

async function saveSettings(over: Partial<AssistantSettings>): Promise<void> {
  await store.saveSettings({ ...(await store.getSettings()), ...over })
}

beforeEach(async () => {
  // A quiet turn is left running on purpose in the cases below, so the tasks collected here are not all
  // ones that can still settle: each test starts with a list of its own.
  turnTasks.length = 0
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  app = buildApp()
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // A provider with no key at all: nothing has to be decrypted for a turn to reach the stubbed wire.
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', maxOutputTokens: 64 })
  await saveSettings({ activeModelId: model.id })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a stream that has nothing to say yet', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('says it is still alive instead of going silent', async () => {
    holdUpstream()
    const conversation = await store.createConversation('Planning')
    const stream = openStream(await chatRequest({ conversationId: conversation.id, message: 'Any answer?' }))

    // The turn did begin, and then the model went quiet on it.
    expect(await stream.text()).toContain('"type":"start"')
    expect(await stream.text()).not.toContain('keepalive')

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(await stream.text()).toContain(': keepalive\n\n')
  })

  it('keeps the beat only as long as the stream stays quiet', async () => {
    const upstream = holdUpstream()
    const conversation = await store.createConversation('Planning')
    const stream = openStream(await chatRequest({ conversationId: conversation.id, message: 'Any answer?' }))
    await stream.text()

    // A frame of its own is the answer's own keepalive: the clock starts again from it, so the fifteen
    // seconds the turn had already been silent do not add up to a comment nobody needed.
    await vi.advanceTimersByTimeAsync(10_000)
    await upstream.say('Still working')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await stream.text()).toContain('"type":"text"')
    expect(await stream.text()).not.toContain('keepalive')

    await vi.advanceTimersByTimeAsync(10_001)
    expect((await stream.text()).match(/keepalive/g)).toHaveLength(1)
  })

  it('leaves no timer behind once the turn is done', async () => {
    const upstream = holdUpstream()
    const conversation = await store.createConversation('Planning')
    const stream = openStream(await chatRequest({ conversationId: conversation.id, message: 'Any answer?' }))
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(await stream.text()).toContain('keepalive')

    await upstream.say('Whole answer.', 'stop')
    await upstream.finish()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await stream.text()).toContain('"type":"done"')

    // An interval that outlives the turn is a writer on a closed stream, forever.
    expect(vi.getTimerCount()).toBe(0)
    expect((await stream.text()).match(/keepalive/g)).toHaveLength(1)
    await settleTurns()
  })
})

describe('a turn this account cannot start', () => {
  it('keeps a turn with no model in the transcript rather than in a status code', async () => {
    refuseProvider()
    await saveSettings({ activeModelId: null })
    const conversation = await store.createConversation('Planning')
    const response = await chatRequest({ conversationId: conversation.id, message: 'Hello there' })

    // This one is a deliberate exception to the cases below: the reader's question belongs to the thread
    // and the reason belongs under it, so the failure stays where they are already looking.
    expect(response.status).toBe(200)
    const events = await sseEvents(response)
    expect(events.some((event) => event.type === 'error' && JSON.stringify(event).includes('No model is configured yet'))).toBe(true)
    expect((await store.messages(conversation.id)).some((row) => row.role === 'user')).toBe(true)
    await settleTurns()
  })

  it('answers a spent day as a 409 rather than as a stream', async () => {
    refuseProvider()
    await saveSettings({ limits: { ...(await store.getSettings()).limits, maxRequestsPerDay: 1 } })
    await store.incrementUsage({ requests: 1 }, await store.currentUsageDay())
    const response = await chatRequest({ message: 'Hello there' })
    expect(response.status).toBe(409)
    expect(await refusal(response)).toContain('daily limit of 1 assistant requests is reached')
  })

  it('refuses a retry of a thread that has no answer to replace', async () => {
    refuseProvider()
    const conversation = await store.createConversation('Planning')
    const response = await chatRequest({ conversationId: conversation.id, message: 'Ask it again', retry: true })
    expect(response.status).toBe(409)
    expect(await refusal(response)).toBe('Nothing to retry.')
  })

  it('refuses a retry aimed at another account’s message', async () => {
    refuseProvider()
    const conversation = await store.createConversation('Planning')
    await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'A question.' })
    const other = await store.createConversation('Elsewhere')
    await store.addMessage({ conversationId: other.id, role: 'assistant', content: 'Not yours to retry.', status: 'complete' })
    const response = await chatRequest({ conversationId: conversation.id, message: '', retry: true, messageId: (await store.lastMessage(other.id))!.id })
    expect(response.status).toBe(404)
    expect(await refusal(response)).toBe('Message not found')
  })

  it('refuses to continue an answer that has no words in it', async () => {
    refuseProvider()
    const conversation = await store.createConversation('Planning')
    await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'A question.' })
    await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: '', status: 'error', error: 'The call failed.' })
    const response = await chatRequest({ conversationId: conversation.id, message: '', continue: true })
    expect(response.status).toBe(409)
    expect(await refusal(response)).toContain('nothing to continue from')
  })

  it('refuses a retry and a continuation that have no conversation', async () => {
    refuseProvider()
    expect(await refusal(await chatRequest({ message: 'Ask it again', retry: true })))
      .toBe('There is nothing to retry without a conversation.')
    expect(await refusal(await chatRequest({ message: 'Finish it', continue: true })))
      .toBe('There is nothing to continue without a conversation.')
  })

  it('still streams a turn that is allowed to run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(chunk('Retried.', 'stop')), {
      headers: { 'content-type': 'text/event-stream' },
    })))
    const conversation = await store.createConversation('Planning')
    await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'A question.' })
    await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'The answer it replaces.', status: 'complete' })

    const response = await chatRequest({ conversationId: conversation.id, message: '', retry: true })
    expect(response.status).toBe(200)
    const events = await sseEvents(response)
    expect(events.some((event) => event.type === 'text')).toBe(true)
    await settleTurns()
  })
})
