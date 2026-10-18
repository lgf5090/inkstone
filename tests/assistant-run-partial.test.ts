// @vitest-environment node
/**
 * The half answer a killed turn leaves on its own lease, and who is allowed to read it.
 *
 * A Worker isolate run out of CPU does not get to run a `finally`: the request dies where it stands, the
 * assistant row is written at `finish` so there is no row, and `chat_active_runs` goes on claiming the
 * conversation for the rest of `RUN_LEASE_MS`. The reader who reopened the thread was told a turn was
 * running, was polled for three minutes, and then was told nothing more — the words the model had already
 * written existed on no surface at all.
 *
 * The renewal the turn already performs is now the thing that carries them, so the first question below is
 * answered while a stream is still in flight: the row has to hold the words that had reached the reader and
 * nothing further, which is what proves the text travels inside the touch that was already happening rather
 * than in a write of its own. The rest is about reading it back honestly — bounded, attributable to nobody
 * but the account that wrote it, and reported as cut short when the ceiling did the cutting.
 *
 * The last section is where those words stop being a draft. A conversation read may not settle the claim it
 * is reporting — the half answer is on the screen because that read handed it over — so the fragment is
 * filed as the unfinished turn it was by the next claim, which is the statement that would otherwise wipe
 * the column, and the continuation control is offered only once it is a row.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore, RUN_LEASE_MS, type RunLease } from '../src/worker/assistant/store'
import { RUN_PARTIAL_MAX_CHARS } from '../src/shared/assistant'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantModel, AssistantProvider } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

interface ConversationRead {
  streaming: boolean
  partialText: string | null
  partialTruncated: boolean
}

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let other: AssistantStore
let provider: AssistantProvider
let model: AssistantModel

const NO_LEASE: RunLease = { claimed: false, running: false, token: null, text: null, truncated: false }

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

async function call<T>(app: Hono<AppBindings>, method: string, path: string): Promise<T> {
  const response = await app.fetch(new Request(`http://localhost${path}`, { method }), env, {} as ExecutionContext)
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  // Every frame is already there, and the stream is left unclosed: a turn pulled apart one event at a
  // time is a turn that was abandoned mid-step, which is the state a CPU limit leaves and that no
  // `finally` of ours ever ran. The pull count below is bounded, so a build that writes no fragment
  // fails its assertion instead of hanging on a stream that will never end.
  return new ReadableStream({
    start(controller) {
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk))
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
/** Twenty-four text deltas, so the sixteenth-event renewal lands in the middle of them. */
const PARTS = Array.from({ length: 24 }, (_, index) => `part${index} `)
const STREAM_FRAMES = PARTS.map((part) => frame({ choices: [{ index: 0, finish_reason: null, delta: { content: part } }] }))

function stubStream(): void {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(sse(STREAM_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
}

async function newRunner(runToken: number): Promise<AssistantRunner> {
  return new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
    runToken,
  })
}

/** Pull a turn apart one event at a time, reading the lease after each, until it says anything. */
async function followUntilDraft(iterator: AsyncIterator<unknown>, conversationId: string): Promise<RunLease> {
  let lease = NO_LEASE
  for (let pulls = 0; pulls < STREAM_FRAMES.length - 2; pulls++) {
    const next = await iterator.next()
    if (next.done) return lease
    lease = await store.readRunLease(conversationId)
    if (lease.text) return lease
  }
  return lease
}

/** Age a claim past its window the way a clock does, without the test waiting on one. */
function expireLease(): void {
  sqlite.prepare('UPDATE chat_active_runs SET lease_until = ?').run(1)
}

function leaseRows(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM chat_active_runs').get() as unknown as { n: number }).n
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  other = new AssistantStore(env.DB as D1Database, OTHER, env)
  provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

describe('the renewal carries the words the turn has written', () => {
  it('puts them on the lease while the turn is still streaming', async () => {
    const conversation = await store.createConversation('Killed mid-stream')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    stubStream()
    const touches = vi.spyOn(store, 'touchRun')
    const iterator = (await newRunner(token!)).chat({
      conversationId: conversation.id, message: 'Tell me the whole story.', signal: new AbortController().signal,
    })[Symbol.asyncIterator]()
    const lease = await followUntilDraft(iterator, conversation.id)
    vi.unstubAllGlobals()

    // Found while the generator is still suspended inside its step. A loop that had run to the end would
    // have filed the answer and released the claim, and this feature is only about the turn that did not.
    expect(lease.text, 'the fragment has to be on the row before the turn ends').not.toBeNull()
    expect(lease.running).toBe(true)
    // A prefix of what the model has said so far, never more than it has said.
    expect(PARTS.join('').startsWith(lease.text!)).toBe(true)
    expect(lease.text!.length).toBeLessThan(PARTS.join('').length)
    // The words rode a renewal rather than a write of their own: every call that carried a draft was a call
    // that renewed the lease at the same time, and the draft is its fourth argument.
    const renewals = touches.mock.calls as unknown as [string, number, number, string | undefined][]
    expect(renewals.length).toBeGreaterThan(0)
    const carrying = renewals.filter((args) => typeof args[3] === 'string' && (args[3] as string).length > 0)
    expect(carrying.length).toBeGreaterThan(0)
    expect(carrying.every((args) => (args[3] as string).startsWith(PARTS[0]!))).toBe(true)
  })

  it('stores nothing for a renewal with no words behind it', async () => {
    const conversation = await store.createConversation('Nothing written yet')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), '')).toBe(true)
    // Empty and absent are one fact, and it is the fact a claim predating the column also carries.
    expect((await store.readRunLease(conversation.id)).text).toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), null)).toBe(true)
    expect((await store.readRunLease(conversation.id)).text).toBeNull()
  })

  it('carries the draft through the unguarded renewal too, which is what a caller holding its own claim uses', async () => {
    const conversation = await store.createConversation('Route-held claim')
    expect(await store.claimRun(conversation.id)).not.toBeNull()
    await store.renewRun(conversation.id, undefined, Date.now(), 'written under a claim this turn keeps')
    expect((await store.readRunLease(conversation.id)).text).toBe('written under a claim this turn keeps')
    // A renewal that brings no draft leaves the earlier one alone rather than wiping the reader's words.
    await store.renewRun(conversation.id)
    expect((await store.readRunLease(conversation.id)).text).toBe('written under a claim this turn keeps')
  })

  it('drops the previous turn fragment when a claim takes the conversation over', async () => {
    const conversation = await store.createConversation('Taken over')
    const mine = await store.claimRun(conversation.id)
    expect(mine).not.toBeNull()
    expect(await store.touchRun(conversation.id, mine!, Date.now(), 'the dead turn half answer')).toBe(true)
    // The lease ages out and a second turn claims it. Inheriting the dead turn's words would put them at
    // the head of a brand new answer, and the next renewal would keep them there.
    expireLease()
    const theirs = await store.claimRun(conversation.id, Date.now() + 1)
    expect(theirs).not.toBeNull()
    expect((await store.readRunLease(conversation.id)).text).toBeNull()
    await store.releaseRun(conversation.id, theirs!)
  })

  it('refuses to write a fragment through a claim the turn no longer holds', async () => {
    const conversation = await store.createConversation('Lost the lease')
    const mine = await store.claimRun(conversation.id)
    expect(mine).not.toBeNull()
    expireLease()
    const theirs = await store.claimRun(conversation.id, Date.now() + 1)
    expect(theirs).not.toBeNull()
    // A touch under a token that is no longer the row's changes nothing, the way it already did — and that
    // has to still be true now that the same statement writes text as well as a timestamp.
    expect(await store.touchRun(conversation.id, mine!, Date.now(), 'written after the takeover')).toBe(false)
    expect((await store.readRunLease(conversation.id)).text).toBeNull()
    await store.releaseRun(conversation.id, theirs!)
  })
})

describe('the fragment is bounded, and says so', () => {
  it('cuts what it is given to the ceiling the column may carry', async () => {
    const conversation = await store.createConversation('Too long to keep')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const oversize = 'x'.repeat(RUN_PARTIAL_MAX_CHARS + 5_000)
    expect(await store.touchRun(conversation.id, token!, Date.now(), oversize)).toBe(true)

    const lease = await store.readRunLease(conversation.id)
    expect(lease.text).toHaveLength(RUN_PARTIAL_MAX_CHARS)
    expect(lease.text).not.toContain('x'.repeat(RUN_PARTIAL_MAX_CHARS + 1))
    // Cut short is a fact the screen has to be able to state, not something a fragment may imply.
    expect(lease.truncated).toBe(true)
  })

  it('reports a fragment that lands exactly on the ceiling as cut short', async () => {
    const conversation = await store.createConversation('Exactly the ceiling')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'y'.repeat(RUN_PARTIAL_MAX_CHARS))).toBe(true)
    // The direction of the doubt is fixed here: a fragment that filled the column might have more behind it,
    // and a screen that called it complete would be selling an unfinished answer as a finished one.
    expect((await store.readRunLease(conversation.id)).truncated).toBe(true)
  })

  it('keeps a fragment under the ceiling whole, and not marked as cut', async () => {
    const conversation = await store.createConversation('Under the ceiling')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const almost = 'z'.repeat(RUN_PARTIAL_MAX_CHARS - 1)
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'a')).toBe(true)
    expect(await store.touchRun(conversation.id, token!, Date.now(), almost)).toBe(true)
    const lease = await store.readRunLease(conversation.id)
    expect(lease.truncated).toBe(false)
    expect(lease.text).toBe(almost)
  })
})

describe('only the account that wrote the fragment can read it', () => {
  it('gives another account nothing, on the store and over the wire', async () => {
    const conversation = await store.createConversation('Someone else thread')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const secret = 'the words only this account was shown'
    expect(await store.touchRun(conversation.id, token!, Date.now(), secret)).toBe(true)

    // The lease row is keyed by account, so naming the conversation id is not naming the row.
    const stolen = await other.readRunLease(conversation.id)
    expect(stolen.claimed).toBe(false)
    expect(stolen.text).toBeNull()
    expect((await store.readRunLease(conversation.id)).text).toBe(secret)

    const ownBody = await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    expect(ownBody.partialText).toBe(secret)
    expect(ownBody.streaming).toBe(true)

    const stranger = await buildApp(OTHER).fetch(new Request(`http://localhost/api/assistant/conversations/${conversation.id}`),
      env, {} as ExecutionContext)
    expect(stranger.status).toBe(404)
    // Refused without a word of the content in it: a 404 that repeats the fragment back is the leak.
    expect(await stranger.text()).not.toContain(secret)
  })

  it('answers no fragment for a conversation nobody has run', async () => {
    const conversation = await store.createConversation('Never run')
    expect(await store.readRunLease(conversation.id)).toEqual(NO_LEASE)
  })

  it('never prints the fragment on the way through a turn', async () => {
    const conversation = await store.createConversation('Unlogged')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    const secret = 'content nobody may print'
    const noise = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    stubStream()
    const iterator = (await newRunner(token!)).chat({
      conversationId: conversation.id, message: 'Say something long.', signal: new AbortController().signal,
    })[Symbol.asyncIterator]()
    await followUntilDraft(iterator, conversation.id)
    await store.touchRun(conversation.id, token!, Date.now(), secret)
    await store.readRunLease(conversation.id)
    await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    vi.unstubAllGlobals()
    const printed = noise.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n')
    noise.forEach((spy) => spy.mockRestore())
    expect(printed).not.toContain(secret)
    expect(printed).not.toContain(PARTS[0]!)
  })
})

describe('the conversation read reports the lease it read', () => {
  it('says a turn is live and carries its half answer at once', async () => {
    const conversation = await store.createConversation('Live with a draft')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'only the beginning so far')).toBe(true)
    const body = await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    expect(body.streaming).toBe(true)
    expect(body.partialText).toBe('only the beginning so far')
    expect(body.partialTruncated).toBe(false)
  })

  it('names the ceiling when the fragment it hands back was cut to it', async () => {
    const conversation = await store.createConversation('Cut at the ceiling')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'q'.repeat(RUN_PARTIAL_MAX_CHARS + 100))).toBe(true)
    const body = await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    expect(body.partialText).toHaveLength(RUN_PARTIAL_MAX_CHARS)
    expect(body.partialTruncated).toBe(true)
  })

  it('clears a stale claim that holds nothing, the way this read always did', async () => {
    const conversation = await store.createConversation('Stale and empty')
    expect(await store.claimRun(conversation.id)).not.toBeNull()
    expireLease()
    expect(leaseRows()).toBe(1)
    const body = await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    expect(body.streaming).toBe(false)
    expect(body.partialText).toBeNull()
    expect(leaseRows(), 'an empty stale claim is still a marker nobody holds').toBe(0)
  })

  it('leaves a stale claim standing when it is the only copy of an answer', async () => {
    const conversation = await store.createConversation('Stale with a draft')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'half of it, then the worker died')).toBe(true)
    expireLease()
    const body = await call<ConversationRead>(buildApp(USER), 'GET', '/api/assistant/conversations/' + conversation.id)
    expect(body.streaming).toBe(false)
    expect(body.partialText).toBe('half of it, then the worker died')
    expect((await store.readRunLease(conversation.id)).text).toBe('half of it, then the worker died')
  })

  it('describes the lease window it is reading', async () => {
    const conversation = await store.createConversation('Windowed')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect((await store.readRunLease(conversation.id, token! + RUN_LEASE_MS - 1)).running).toBe(true)
    expect((await store.readRunLease(conversation.id, token! + RUN_LEASE_MS)).running).toBe(false)
  })
})

describe('the turn that takes a dead claim over files what it holds', () => {
  /** The answers this thread was filed, oldest first. */
  const answers = async (conversationId: string) =>
    (await store.messages(conversationId)).filter((row) => row.role === 'assistant')

  it('files a dead turn’s words as an unfinished answer instead of clearing them', async () => {
    const conversation = await store.createConversation('Taken over after the death')
    const dead = await store.claimRun(conversation.id)
    expect(dead).not.toBeNull()
    expect(await store.touchRun(conversation.id, dead!, Date.now(), 'half of it, then the isolate died')).toBe(true)
    expireLease()
    // The reader was shown the fragment, and now asks something new. That send claims the thread, and the
    // claim is the statement that wipes the column — the last moment these words exist anywhere else.
    const mine = await store.claimRun(conversation.id, Date.now() + 1)
    expect(mine).not.toBeNull()

    const filed = await answers(conversation.id)
    expect(filed).toHaveLength(1)
    expect(filed[0]?.content).toBe('half of it, then the isolate died')
    // An answer that did not finish, said as the thing that happened to it rather than as a stop the
    // reader asked for, and with the reason on the row so the transcript carries it after this read.
    expect(filed[0]?.status).toBe('error')
    expect(filed[0]?.error).toContain('ran out of time')

    // The new turn starts from nothing: inheriting a dead turn's first half is the other bug this table had.
    expect((await store.readRunLease(conversation.id)).text).toBeNull()
    await store.releaseRun(conversation.id, mine!)
  })

  it('files nothing for a claim somebody is still holding', async () => {
    const conversation = await store.createConversation('Still writing')
    const token = await store.claimRun(conversation.id)
    expect(token).not.toBeNull()
    expect(await store.touchRun(conversation.id, token!, Date.now(), 'still arriving')).toBe(true)
    // A second tab's send is refused by the lease, and a refusal may not reach the transcript: this turn
    // has written words the reader is still being sent, and lifting them out would file them twice.
    expect(await store.claimRun(conversation.id, Date.now() + 1)).toBeNull()
    expect(await answers(conversation.id)).toHaveLength(0)
    expect((await store.readRunLease(conversation.id)).text).toBe('still arriving')
    await store.releaseRun(conversation.id, token!)
  })

  it('files one answer for one dead claim, whichever turn reaches it', async () => {
    const conversation = await store.createConversation('Two turns, one corpse')
    const dead = await store.claimRun(conversation.id)
    expect(dead).not.toBeNull()
    expect(await store.touchRun(conversation.id, dead!, Date.now(), 'written by a turn that never came back')).toBe(true)
    expireLease()
    const first = await store.claimRun(conversation.id, Date.now() + 1)
    expect(first).not.toBeNull()
    const second = await store.claimRun(conversation.id, Date.now() + 2)
    // The takeover above is a live claim now, so the second send is refused — and a refused send that
    // also filed an answer would put the same fragment in the thread twice.
    expect(second).toBeNull()
    expect(await answers(conversation.id)).toHaveLength(1)
    await store.releaseRun(conversation.id, first!)
  })

  it('files no fragment for an account that did not write it', async () => {
    const conversation = await store.createConversation('Someone else thread, taken over')
    const dead = await store.claimRun(conversation.id)
    expect(dead).not.toBeNull()
    const secret = 'the words only this account was shown'
    expect(await store.touchRun(conversation.id, dead!, Date.now(), secret)).toBe(true)
    expireLease()

    // Another account can name the same conversation id and get a claim of its own; the row it reads is
    // keyed by that account, so there is nothing of ours to take and nothing to file under theirs.
    expect(await other.claimRun(conversation.id)).not.toBeNull()
    const theirs = (await other.messages(conversation.id)).filter((row) => row.role === 'assistant')
    expect(theirs).toHaveLength(0)
    expect((await store.readRunLease(conversation.id)).text).toBe(secret)
  })

  it('refuses to continue an answer the lease is the only copy of', async () => {
    const conversation = await store.createConversation('Nothing to continue yet')
    const dead = await store.claimRun(conversation.id)
    expect(dead).not.toBeNull()
    await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'Tell me the whole story.' })
    expect(await store.touchRun(conversation.id, dead!, Date.now(), 'half of it, then the isolate died')).toBe(true)
    expireLease()

    const response = await buildApp(USER).fetch(new Request('http://localhost/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: '', continue: true }),
    }), env, {} as ExecutionContext)
    // The newest row is the reader's own question, so the continuation is refused before anything claims
    // the thread — which is why the screen shows this fragment as an interrupted turn's words rather than
    // offering the control that finishes an answer. Filing it is the takeover's job, and the row it files
    // is the shape the control does read.
    expect(response.status).toBe(409)
    await response.text()
    expect(await answers(conversation.id)).toHaveLength(0)
    expect((await store.readRunLease(conversation.id)).text).toBe('half of it, then the isolate died')
  })
})
