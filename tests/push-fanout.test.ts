// @vitest-environment node
/**
 * When a scheduled routine delivers something, the account's devices are nudged — and nothing about that
 * nudge may break the delivery.
 *
 * The three things these tests hold the fan-out to are the three it cannot be trusted to get right by
 * reading it:
 *
 *  1. the payload. `sendPush` declares the `aes128gcm` content coding without applying RFC 8291 payload
 *     encryption, so the body reaches the push service readable, and a push service is not this app's trust
 *     domain. A reader's reminder text, their routine's name, a notification id — none of it may be in it.
 *     The fixture spells the private words loudly for exactly that reason.
 *  2. the row. A device that refuses, a send that throws before it asks, a deployment whose operator never
 *     set the VAPID secrets: the sweep still resolves, the notification is still in `chat_notifications`,
 *     and the run is still a success.
 *  3. the count. Every refusal still goes through the sender's own `notePushFailure`, `last_error` and
 *     five-refusal drop, and comes back as a number in the tick's `push` tally. Counting it is what keeps
 *     rule 2 from being the same thing as ignoring it.
 *
 * Everything runs through `runDueAssistantAutomations` with `reminder` routines — the one kind that needs
 * no model — so what is proven is the path a cron actually takes.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { PUSH_PING_KIND, pushPingPayload } from '../src/worker/assistant/push-fanout'
import { runDueAssistantAutomations, type SweepResult } from '../src/worker/assistant/scheduler'
import type { Env } from '../src/worker/env'
import { fromUtf8, toBase64Url } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const AUTOMATION = '0123456789abcdefghjkmnavto'
const SECOND_AUTOMATION = '0123456789abcdefghjkmnxato'
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const PHONE = 'https://web.push.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3De'
const OTHER_LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx9999tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kZZZZ'
const P256DH = 'BKwRvYJ0mMVaDBHn8lPMZ3wqZ3xq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3nPo'
const AUTH = '7Q9rUxF7Vh1sQ7Q9rUxF'

/** The reader's own words, spelled loudly: none of these may reach a push service. */
const PRIVATE_MESSAGE = 'Stand up and stretch before the Miller call'
const PRIVATE_NAME = 'Morning log for Priya'
/** Every word the payload is allowed to contain, and the ones a leak would have to use. */
const PRIVATE_FRAGMENTS = [PRIVATE_MESSAGE, PRIVATE_NAME, 'Miller', 'stretch', 'Morning', 'log', 'Priya', 'reminder']

let sqlite: DatabaseSync
let env: Env
let baseD1: D1Database
let vapid: { publicKey: string, privateKey: string }
/** Every subscription *listing* the sweep ran, so "read once per account" is a fact and not a hope. */
let subscriptionReads: string[]
const SUBSCRIPTION_LISTING = /^\s*SELECT[\s\S]*\bchat_push_subscriptions\b/i

/**
 * The environment a sweep runs in, with its subscription listings counted.
 *
 * Every `D1Database` member is written out rather than spread: a spread of a class-shaped type drops the
 * methods, and a spy that quietly lost `batch` would break the boot rather than the thing under test.
 */
function envWith(overrides: Partial<Env> = {}): Env {
  const counted: D1Database = {
    prepare(query: string) {
      if (SUBSCRIPTION_LISTING.test(query)) subscriptionReads.push(query)
      return baseD1.prepare(query)
    },
    batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // A batch is assembled from statements this `prepare` already looked at, so nothing is counted twice.
      return baseD1.batch<T>(statements)
    },
    exec: (query: string) => baseD1.exec(query),
    withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) => baseD1.withSession(constraint),
    dump: () => baseD1.dump(),
  }
  return testBindings(counted, {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    PUBLIC_URL: 'http://localhost',
    ...overrides,
  })
}

function storeFor(userId: string): AssistantStore {
  return new AssistantStore(env.DB, userId, env)
}

/** Arms one routine of one account so the next sweep finds it due. */
function armReminder(userId: string, id: string, name: string, message: string): void {
  sqlite.prepare(
    `INSERT INTO chat_automations (user_id, id, name, kind, message, schedule, enabled, status, next_run, run_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'reminder', ?4, '{"type":"daily","time":"07:00"}', 1, 'scheduled', ?5, 0, 1, 1)`,
  ).run(userId, id, name, message, Date.now() - 1000)
}

async function subscribe(userId: string, endpoint: string): Promise<void> {
  await storeFor(userId).upsertPushSubscription({ endpoint, p256dh: P256DH, auth: AUTH })
}

/** A row written the way a hostile or half-migrated database could leave it: no route validates an endpoint already in the table. */
function insertUnusableSubscription(userId: string, endpoint: string): void {
  sqlite.prepare(
    `INSERT INTO chat_push_subscriptions (user_id, id, endpoint, p256dh, auth, created_at, failures)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 0)`,
  ).run(userId, `0123456789abcdefghjkmnr0w1`, endpoint, P256DH, AUTH)
}

function notificationRows(userId: string): { id: string, title: string, body: string }[] {
  return sqlite.prepare(`SELECT id, title, body FROM chat_notifications WHERE user_id = ?1 ORDER BY created_at`).all(userId) as { id: string, title: string, body: string }[]
}

/** One fake push service that keeps every body it was handed. */
function stubFetch(respond: (url: string, index: number) => Response | Promise<Response>): { bodies: string[], urls: string[] } {
  const bodies: string[] = []
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    const body = init?.body
    bodies.push(typeof body === 'string' ? body : body instanceof Uint8Array ? fromUtf8(body) : '')
    return await respond(url, urls.length - 1)
  }))
  return { bodies, urls }
}

const ok = () => new Response(null, { status: 201 })

/** An `ExecutionContext` that only has to remember what the tick refused to wait for. */
function collectingContext(): { waitUntil: (task: Promise<unknown>) => void, tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = []
  return { tasks, waitUntil: (task) => { tasks.push(task) } }
}

function sweep(ctx?: { waitUntil: (task: Promise<unknown>) => void }): Promise<SweepResult> {
  // What counts is the tick's own reads: the fixture subscribes through the store, and that SELECT belongs
  // to the setup, not to the sweep the assertion is about.
  subscriptionReads.length = 0
  return runDueAssistantAutomations(env, Date.now(), ctx?.waitUntil)
}

beforeEach(async () => {
  subscriptionReads = []
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  baseD1 = makeD1(sqlite)
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  vapid = {
    publicKey: toBase64Url(new Uint8Array(raw)),
    privateKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }),
  }
  env = envWith()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the nudge a device is handed', () => {
  it('holds one signal and a count, and none of the reader\'s words', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    const { bodies } = stubFetch(ok)
    const result = await sweep()
    await result.push

    expect(bodies).toHaveLength(1)
    const payload = bodies[0]!
    // The red line, asserted before anything else so a leak is reported as a leak rather than as a payload
    // that no longer parses: a body the push service can read holds no text of the reader's.
    const stored = notificationRows(USER)[0]!
    expect(stored.title, 'the fixture stopped carrying the reader\'s text, so this asserts nothing').toBe(PRIVATE_MESSAGE)
    for (const leaked of [...PRIVATE_FRAGMENTS, stored.title, stored.body, stored.id]) {
      if (!leaked) continue
      expect(payload, `the push payload carried ${leaked} out to the push service`).not.toContain(leaked)
    }
    expect(JSON.parse(payload)).toEqual({ kind: PUSH_PING_KIND, count: 1 })
    expect(Object.keys(JSON.parse(payload) as Record<string, unknown>)).toEqual(['kind', 'count'])
  })

  it('counts what one tick delivered to one account in one request', async () => {
    // Two routines of the same reader: the case where a tick has more than one thing to say.
    armReminder(USER, AUTOMATION, 'First routine', 'First thing')
    armReminder(USER, SECOND_AUTOMATION, 'Second routine', 'Second thing')
    await subscribe(USER, LAPTOP)
    const { bodies } = stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]!).count).toBe(2)
    expect(notificationRows(USER)).toHaveLength(2)
    expect(tally.notifications).toBe(2)
    expect(tally.accounts).toBe(1)
    expect(tally.devices).toBe(1)
    expect(tally.sent).toBe(1)
    // The credential table is read once for the account, never once per notification.
    expect(subscriptionReads, `the subscription table was read ${subscriptionReads.length} times`).toHaveLength(1)
  })

  it('addresses every device of the account once, from one listing', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    await subscribe(USER, PHONE)
    const { bodies, urls } = stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    expect(urls).toEqual([LAPTOP, PHONE])
    expect(new Set(bodies).size, 'two devices of one reader were told two different counts').toBe(1)
    expect(tally.devices).toBe(2)
    expect(tally.sent).toBe(2)
    expect(subscriptionReads).toHaveLength(1)
  })

  it('nudges each account its own devices and never a neighbour\'s', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    armReminder(OTHER, SECOND_AUTOMATION, 'Their routine', 'their own private text')
    await subscribe(USER, LAPTOP)
    await subscribe(OTHER, OTHER_LAPTOP)
    const { urls } = stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    expect(urls.sort()).toEqual([LAPTOP, OTHER_LAPTOP].sort())
    expect(tally.accounts).toBe(2)
    expect(subscriptionReads).toHaveLength(2)
  })

  it('does not read the subscription table at all when the tick delivered nothing', async () => {
    await subscribe(USER, LAPTOP)
    const { urls } = stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    expect(urls).toEqual([])
    expect(subscriptionReads).toEqual([])
    expect(tally.accounts).toBe(0)
    expect(tally.notifications).toBe(0)
  })

  it('keeps the count inside what a browser can be shown with', () => {
    expect(JSON.parse(pushPingPayload(0))).toEqual({ kind: PUSH_PING_KIND, count: 0 })
    expect(JSON.parse(pushPingPayload(-7))).toEqual({ kind: PUSH_PING_KIND, count: 0 })
    expect(JSON.parse(pushPingPayload(2.9))).toEqual({ kind: PUSH_PING_KIND, count: 2 })
    expect(pushPingPayload(100_000)).not.toContain('100000')
  })
})

describe('the delivery is not the push', () => {
  it('writes the row and reports the run as delivered while every device refuses', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response('nope', { status: 500 }))
    const result = await sweep()
    const tally = await result.push

    expect(result.started).toBe(1)
    expect(result.failed).toBe(0)
    expect(notificationRows(USER)).toHaveLength(1)
    expect(tally.refused).toBe(1)
    expect(tally.sent).toBe(0)
    // Not swallowed: the sender still counted it against the device, in its own redacted words.
    const [subscription] = await storeFor(USER).listPushSubscriptions()
    expect(subscription?.failures).toBe(1)
    expect(subscription?.lastError).toContain('500')
    expect(subscription?.lastError).not.toContain(LAPTOP)
  })

  it('survives a request that never got an answer, and counts it', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('socket hang up') }))
    const result = await sweep()
    const tally = await result.push

    expect(notificationRows(USER)).toHaveLength(1)
    expect(result.started).toBe(1)
    expect(tally.refused).toBe(1)
    expect(sqlite.prepare(`SELECT failures FROM chat_push_subscriptions`).get()).toEqual({ failures: 1 })
  })

  it('turns a send that throws before it asks into a number, not into a failed tick', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    // A row whose endpoint is not a URL: `sendPush` takes the audience out of it before any request, so this
    // is the case where the sender throws instead of answering with a status.
    insertUnusableSubscription(USER, 'updates.push.services.mozilla.com/wpush/v2/noScheme')
    stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    // The delivery first, always: this is the case where a push blows up, and what has to be true is that
    // the reader still got their row and the run still counts as delivered.
    expect(notificationRows(USER)).toHaveLength(1)
    expect(result.started).toBe(1)
    expect(result.failed).toBe(0)
    expect(tally.errors).toBe(1)
    expect(tally.devices).toBe(1)
    expect(tally.sent).toBe(0)
    expect(sqlite.prepare(`SELECT failures FROM chat_push_subscriptions`).get()).toEqual({ failures: 0 })
  })

  it('names the missing secret and blames no device when the deployment has no VAPID keys', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    env = envWith({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined })
    const { urls } = stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    expect(urls, 'an unconfigured deployment must not ask a push service for anything').toEqual([])
    expect(subscriptionReads, 'a fan-out that cannot send still read the credential table').toEqual([])
    expect(notificationRows(USER)).toHaveLength(1)
    expect(result.started).toBe(1)
    expect(tally.configuration).toMatch(/VAPID_PUBLIC_KEY[\s\S]*VAPID_PRIVATE_KEY/)
    expect(tally.accounts).toBe(1)
    expect(tally.notifications).toBe(1)
    expect(tally.sent + tally.refused + tally.errors).toBe(0)
    // The device did nothing wrong: five ticks of an operator forgetting a secret must not delete it.
    expect((await storeFor(USER).listPushSubscriptions())[0]?.failures).toBe(0)
  })

  it('stamps the rows a device accepted, which is what the cron fire reads', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    stubFetch(ok)
    const result = await sweep()
    const tally = await result.push

    // The handover between the two paths: an accepted nudge leaves a mark, so the catch-up fire does not
    // announce the same row again. Dropping that stamping turns `tests/push-catchup.test.ts` red.
    expect(tally.marked).toBe(1)
    const stamped = sqlite.prepare(`SELECT pushed_at FROM chat_notifications WHERE user_id = ?1`).get(USER) as { pushed_at: number | null }
    expect(stamped.pushed_at, 'a row nothing was told about is still marked as if it had been').not.toBeNull()
  })

  it('leaves a row nothing accepted unmarked, so the next fire may try again', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response('nope', { status: 500 }))
    const result = await sweep()
    const tally = await result.push

    expect(tally.marked).toBe(0)
    expect(sqlite.prepare(`SELECT pushed_at FROM chat_notifications WHERE user_id = ?1`).get(USER)).toEqual({ pushed_at: null })
  })

  it('lets the sender delete the endpoint a service declares gone', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response('Gone', { status: 410 }))
    const result = await sweep()
    const tally = await result.push

    expect(tally.expired).toBe(1)
    expect(tally.sent).toBe(0)
    expect(await storeFor(USER).listPushSubscriptions()).toEqual([])
    expect(notificationRows(USER)).toHaveLength(1)
  })

  it('keeps nudging the surviving device of an account whose other one dies', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    await subscribe(USER, PHONE)
    stubFetch((url) => url === LAPTOP ? new Response('Gone', { status: 410 }) : ok())
    const result = await sweep()
    const tally = await result.push

    expect(tally.expired).toBe(1)
    expect(tally.sent).toBe(1)
    expect((await storeFor(USER).listPushSubscriptions()).map((row) => row.endpoint)).toEqual([PHONE])
  })
})

describe('the tick does not wait for the push service', () => {
  it('hands the sends to waitUntil and reports the same promise in its result', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    let release = () => {}
    const gate = new Promise<void>((done) => { release = done })
    stubFetch(async () => { await gate; return ok() })
    const ctx = collectingContext()

    // The row is landed and the sweep has returned while the push service is still being held open: that is
    // the whole of "does not lengthen the tick", and it fails the moment the sends move back onto the path.
    const result = await sweep(ctx)
    expect(notificationRows(USER)).toHaveLength(1)
    expect(ctx.tasks).toHaveLength(1)
    expect(ctx.tasks[0], 'the task handed to waitUntil is not the tally the result reports').toBe(result.push)

    release()
    const tally = await result.push
    expect(tally.sent).toBe(1)
  })

  it('stops addressing a device that refused five ticks running, and the reader keeps the rows', async () => {
    armReminder(USER, AUTOMATION, PRIVATE_NAME, PRIVATE_MESSAGE)
    await subscribe(USER, LAPTOP)
    for (let tick = 0; tick < 5; tick++) {
      // Re-armed by hand: the routine's own daily next_run would not be due again inside one test.
      sqlite.prepare(`UPDATE chat_automations SET next_run = ?1, claimed_at = NULL, status = 'scheduled'`).run(Date.now() - 1000)
      stubFetch(() => new Response('try later', { status: 429 }))
      const result = await sweep()
      await result.push
      expect(result.started).toBe(1)
    }
    expect(notificationRows(USER)).toHaveLength(5)
    expect(await storeFor(USER).listPushSubscriptions(), 'a device refusing forever is still being addressed').toEqual([])
  })
})
