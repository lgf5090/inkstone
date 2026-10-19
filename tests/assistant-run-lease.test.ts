// @vitest-environment node
/**
 * One conversation, one turn.
 *
 * The lease in `chat_active_runs` is what makes that true, and it was failing in both directions at once.
 * A turn renewed blindly and then asked somebody else whether the conversation was live: a step that
 * outlived the lease watched its own expired row get deleted and filed a finished answer as stopped, while
 * a turn whose lease a second run had taken read that run's fresh row as permission and kept streaming into
 * the same thread, writing two answers and spending the reader's budget twice. Renewal and ownership are one
 * statement now, so a turn either still holds its claim or stops.
 *
 * The same token is what a stop has to name. A cancel that released whatever claim it found unlocked — and
 * so aborted — the turn the reader had just started a second after pressing Stop, which is why the route
 * takes the token and refuses to guess.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore, usageDay } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantMessage, AssistantModel, AssistantProvider, ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let provider: AssistantProvider
let model: AssistantModel
let app: Hono<AppBindings>

function buildApp(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await respond(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  const response = await respond(method, path, body)
  await response.text()
  return response.status
}

async function respond(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext)
}

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const STOP = frame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })
const USAGE = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })
/** A plain reply, said in pieces: the step has to run past the sixteenth event for the lease to matter. */
const LONG_ANSWER = Array.from({ length: 24 }, (_, index) =>
  frame({ choices: [{ index: 0, finish_reason: null, delta: { content: `part${index} ` } }] }))

/** Ages a lease the way a clock does, without the test waiting on one. */
function expireLease(): void {
  sqlite.prepare('UPDATE chat_active_runs SET lease_until = ?').run(1)
}

/** The claim a conversation is under right now, read straight off the row. */
function claimOf(conversationId: string): number | null {
  const row = sqlite.prepare('SELECT started_at FROM chat_active_runs WHERE conversation_id = ?')
    .get(conversationId) as { started_at: number } | undefined
  return row?.started_at ?? null
}

/**
 * A wire that answers with one long plain reply.
 *
 * The lease is aged inside the call, which is inside the step: that is the shape of the bug, a turn whose
 * own step was still running when the clock passed the number it was claimed under.
 */
function stubLongAnswer(options: { expireMidStep?: boolean } = {}): number[] {
  const calls: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    // The follow-up pass after the answer is filed is not a step of this turn, and must not age the lease.
    if (isNamingRequest(JSON.parse(String(init?.body ?? '{}')))) return namingAnswer()
    calls.push(calls.length)
    if (options.expireMidStep !== false) expireLease()
    return new Response(sse([...LONG_ANSWER, STOP, USAGE]), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return calls
}

function stubAnswer(content = 'Answered.'): number[] {
  const calls: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (isNamingRequest(JSON.parse(String(init?.body ?? '{}')))) return namingAnswer()
    calls.push(calls.length)
    return new Response(sse([frame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content } }] }), USAGE]),
      { headers: { 'content-type': 'text/event-stream' } })
  }))
  return calls
}

/** One turn on a conversation this caller has already claimed, driven to the event that ends it. */
async function drive(runToken: number, conversationId: string, message: string): Promise<ChatStreamEvent[]> {
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
    runToken,
  })
  const events: ChatStreamEvent[] = []
  for await (const event of runner.chat({ conversationId, message, signal: new AbortController().signal })) {
    events.push(event)
  }
  return events
}

function endedWith(events: ChatStreamEvent[]): AssistantMessage | undefined {
  const done = events.find((event) => event.type === 'done')
  return done?.finalMessage
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
  // A provider with no key: `signKey` answers with an empty string, so nothing has to be decrypted for a
  // turn to reach the stubbed wire.
  provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

describe('a turn that holds its conversation', () => {
  it('finishes an answer whose step outlived the lease it was claimed under', async () => {
    const conversation = await store.createConversation('Long answer')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const calls = stubLongAnswer()

    const events = await drive(token!, conversation.id, 'Tell me the whole story.')
    vi.unstubAllGlobals()

    // Nobody pressed stop, so the answer is the one the model wrote and the row says so.
    expect(calls).toHaveLength(1)
    // The claim's token travels with the `start` event even when the caller claimed the conversation before
    // handing it over: it is the only thing the reader's tab can name a stop with.
    expect(events.find((event) => event.type === 'start')?.runToken).toBe(token!)
    expect(endedWith(events)?.status).toBe('complete')
    expect(endedWith(events)?.content).toContain('part0')
    expect(endedWith(events)?.content).toContain('part23')
    // The touch that kept the turn alive also pushed the lease back out, so the answer is still guarded
    // while its turn is, and nobody else can start a second one over it.
    expect(await store.isRunning(conversation.id)).toBe(true)
    await store.releaseRun(conversation.id, token!)
    expect(await store.isRunning(conversation.id)).toBe(false)
  })

  it('stops instead of writing into a conversation another run has claimed', async () => {
    const conversation = await store.createConversation('Taken over')
    const mine = await store.claimRun(conversation.id)
    expect(mine).not.toBeNull()
    // The lease aged out and a second tab claimed the conversation legitimately: the row is its claim now,
    // under a token this turn has never seen. A claim is stamped with the clock, so the takeover is given
    // the next millisecond rather than the one that is already in the row.
    expireLease()
    const theirs = await store.claimRun(conversation.id, Date.now() + 1)
    expect(theirs).not.toBeNull()
    expect(theirs).not.toBe(mine!)
    const calls = stubLongAnswer({ expireMidStep: false })

    const events = await drive(mine!, conversation.id, 'Say something.')
    vi.unstubAllGlobals()

    // Nothing was spent and nothing was written over the other run's answer.
    expect(calls).toHaveLength(0)
    expect(endedWith(events)?.status).toBe('cancelled')
    expect(endedWith(events)?.content).toBe('')
    const rows = await store.messages(conversation.id)
    expect(rows.filter((row) => row.role === 'assistant' && row.status === 'complete')).toHaveLength(0)
    // A turn that lost the conversation does not take it with it: the other claim is still live.
    expect(claimOf(conversation.id)).toBe(theirs!)
    await store.releaseRun(conversation.id, theirs!)
  })

  it('keeps its lease across a turn of several steps', async () => {
    const conversation = await store.createConversation('Two steps')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      // The follow-up pass after the answer is filed is not one of this turn's steps, and the question here
      // is whether the steps between the first and the last renewed their way back into the lease.
      if (isNamingRequest(JSON.parse(String(init?.body ?? '{}')))) return namingAnswer()
      calls++
      // Every step runs the clock on past the lease: the next one has to renew its way back in.
      expireLease()
      const frames = calls === 1
        ? [frame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_tasks', arguments: '{}' } }] } }] }),
          frame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] })]
        : [frame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'Nothing is on the list.' } }] }), USAGE]
      return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const events = await drive(token!, conversation.id, 'What is on my list?')
    vi.unstubAllGlobals()

    expect(calls).toBe(2)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(endedWith(events)?.status).toBe('complete')
    expect(endedWith(events)?.content).toContain('Nothing is on the list.')
  })

  it('ends when the claim is released, which is what a stop does', async () => {
    const conversation = await store.createConversation('Stopped')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const calls = stubLongAnswer({ expireMidStep: false })
    // The reader pressed stop: the cancel route lets go of exactly this claim.
    await store.releaseRun(conversation.id, token!)

    const events = await drive(token!, conversation.id, 'Say something.')
    vi.unstubAllGlobals()

    expect(calls).toHaveLength(0)
    expect(endedWith(events)?.status).toBe('cancelled')
  })
})

describe('stopping a turn through the API', () => {
  it('releases only the claim the stop names', async () => {
    const conversation = await store.createConversation('Stopped late')
    const mine = await store.claimRun(conversation.id)
    expect(mine).not.toBeNull()
    expireLease()
    // Two claims one millisecond apart are two different tokens: the stop names the first, the row holds
    // the second, and releasing what the row holds is the bug this is here to keep out.
    const theirs = await store.claimRun(conversation.id, Date.now() + 1)
    expect(theirs).not.toBeNull()

    // Stop, then send again: the new turn claims, and the cancel that was already on its way names the old
    // claim. Releasing what it found is what aborted the answer a second later.
    expect(await status('POST', '/api/assistant/chat/cancel', { conversationId: conversation.id, runToken: mine! })).toBe(200)
    expect(claimOf(conversation.id)).toBe(theirs!)
    expect(await store.isRunning(conversation.id)).toBe(true)

    expect(await status('POST', '/api/assistant/chat/cancel', { conversationId: conversation.id, runToken: theirs! })).toBe(200)
    expect(claimOf(conversation.id)).toBeNull()
  })

  it('still unlocks a conversation when the caller names no claim', async () => {
    const conversation = await store.createConversation('Unlocked')
    expect(await store.claimRun(conversation.id)).not.toBeNull()
    // A remote turn's lease is not one this tab holds a token for, and freeing a conversation is a
    // legitimate ask: unguarded stays available, it is just no longer what a Stop does.
    expect(await status('POST', '/api/assistant/chat/cancel', { conversationId: conversation.id })).toBe(200)
    expect(await store.isRunning(conversation.id)).toBe(false)
  })

  it('refuses a run token that no claim could have been made under', async () => {
    const conversation = await store.createConversation('Bad token')
    const mine = await store.claimRun(conversation.id)
    expect(mine).not.toBeNull()
    expect(await status('POST', '/api/assistant/chat/cancel', { conversationId: conversation.id, runToken: 'yours' })).toBe(400)
    expect(await status('POST', '/api/assistant/chat/cancel', { conversationId: conversation.id, runToken: 0 })).toBe(400)
    // A value that is not a token is not "no token": the claim the reader is standing on stays put.
    expect(claimOf(conversation.id)).toBe(mine!)
    await store.releaseRun(conversation.id, mine!)
  })
})

describe('the numbers a model field accepts', () => {
  it('refuses a sampling value that is not a number instead of storing it', async () => {
    const before = await store.getModel(model.id)
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { temperature: 'abc' })).toBe(400)
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { topP: 'abc' })).toBe(400)
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { temperature: '1e999' })).toBe(400)

    // Refused is not stored: `Number('abc')` is NaN, and NaN survives both `Math.min` and `Math.max`, so
    // the clamp used to keep a NaN the provider would be sent — which reads back off the API as nothing.
    const stored = await store.getModel(model.id)
    expect(stored?.temperature).toBe(before?.temperature)
    expect(stored?.topP).toBe(before?.topP)

    // A value the field can mean still answers, in either shape the editor sends.
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { temperature: '0.7' })).toBe(200)
    expect((await store.getModel(model.id))?.temperature).toBe(0.7)
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { topP: 1.4 })).toBe(200)
    expect((await store.getModel(model.id))?.topP).toBe(1)
    expect(await status('PATCH', `/api/assistant/models/${model.id}`, { temperature: null })).toBe(200)
    expect((await store.getModel(model.id))?.temperature).toBeNull()
  })

  it('refuses an unparseable temperature on a new model, and still takes one that is absent', async () => {
    expect(await status('POST', '/api/assistant/models', { providerId: provider.id, model: 'second-model', temperature: 'abc' })).toBe(400)
    expect(await store.listModels()).toHaveLength(1)
    // Absent is not unreadable: the account's own setting answers for a model nobody pinned down.
    const created = await call<{ model: AssistantModel }>('POST', '/api/assistant/models', { providerId: provider.id, model: 'second-model' })
    expect(created.model.temperature).toBe(0.4)
  })
})

describe('the day a quota is measured on', () => {
  it('counts the reader’s own day, not the deployment’s', async () => {
    await store.saveSettings({ ...(await store.getSettings()), timezone: 'Asia/Shanghai' })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-12T20:00:00.000Z'))
      // Eight in the evening UTC is the next morning in Shanghai. A ceiling that rolled over at UTC
      // midnight emptied before the number the settings screen showed as "today".
      expect(usageDay()).toBe('2026-10-12')
      expect(await store.currentUsageDay()).toBe('2026-10-13')

      expect(await store.reserveRequests(1, 2, 'Example one', { providerId: provider.id, providerLabel: provider.label })).toBe(true)
      const { day, today } = await call<{ day: string, today: { requests: number } }>('GET', '/api/assistant/usage')
      expect(day).toBe('2026-10-13')
      expect(today.requests).toBe(1)
      // Charge and ceiling read the same row: split across two keys and the screen quotes a number the
      // quota never saw.
      expect(sqlite.prepare('SELECT day, requests FROM chat_usage_daily').all())
        .toEqual([{ day: '2026-10-13', requests: 1 }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the daily ceiling under concurrency', () => {
  it('lets one of two turns that start together through', async () => {
    const settings = await store.getSettings()
    await store.saveSettings({ ...settings, limits: { ...settings.limits, maxRequestsPerDay: 1 } })
    const first = await store.createConversation('First thread')
    const second = await store.createConversation('Second thread')
    const firstToken = await store.claimRun(first.id)
    const secondToken = await store.claimRun(second.id)
    expect(firstToken).not.toBeNull()
    expect(secondToken).not.toBeNull()
    const calls = stubAnswer()

    // Two conversations, two turns, started in the same instant. Each used to read the day's counters,
    // see one request left, and charge it, so the ceiling the reader set was spendable twice over.
    const [left, right] = await Promise.all([
      drive(firstToken!, first.id, 'Ask one.'),
      drive(secondToken!, second.id, 'Ask two.'),
    ])
    vi.unstubAllGlobals()

    expect([left, right].filter((events) => events.some((event) => event.type === 'error'))).toHaveLength(1)
    expect((await store.todayUsage()).requests).toBe(1)
    expect(sqlite.prepare("SELECT status FROM chat_messages WHERE role = 'assistant' AND status = 'complete'").all())
      .toHaveLength(1)
    // The turn that was refused never reached the wire, so the reader spent nothing on it.
    expect(calls).toHaveLength(1)
  })

  it('refuses the second of two charges that land together', async () => {
    // The same question one layer down, where the answer is one statement's worth of race: both charges
    // are judged against the row as the database finds it, so the second has nowhere to spend.
    const [left, right] = await Promise.all([store.reserveRequests(1, 1), store.reserveRequests(1, 1)])
    expect([left, right].filter(Boolean)).toHaveLength(1)
    expect((await store.todayUsage()).requests).toBe(1)
  })
})
