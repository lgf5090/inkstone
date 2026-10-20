// @vitest-environment node
/**
 * Delivery into the reader's own notification inbox.
 *
 * The in-app channel is the one channel that is not an HTTP request, and that difference is where the
 * risk sits: it writes to the same table the assistant's routines write to, and it is the only place in
 * the subscription worker that reaches into another feature's data. So these hold the three things that
 * must stay true whatever the push service does.
 *
 *  1. the row. It is the delivery. A device that refuses, a deployment with no VAPID secrets, a reader
 *     with no registered browser: the reminder is still in `chat_notifications` and the result is still
 *     a success, because the inbox is where the message actually lives.
 *  2. the nudge. `push-fanout.ts` states the rule — a push service is outside this app's trust domain,
 *     so what a device is handed is a signal and a count. This is the second caller of that path, and a
 *     second caller is how a rule gets broken without anyone editing the file that holds it, so the same
 *     loud fixtures are asserted absent here.
 *  3. the account. One reader's reminder must not appear in another's inbox.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { PUSH_PING_KIND } from '../src/worker/assistant/push-fanout'
import type { Env } from '../src/worker/env'
import { dispatch } from '../src/worker/subscriptions/channels'
import type { DeliveryAccount } from '../src/worker/subscriptions/channels/inapp'
import { fromUtf8, toBase64Url } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const SUB_ID = '01subscribptionid0000000000'
const OTHER = '0123456789abcdefghjkmnpqrt'
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const P256DH = 'BKwRvYJ0mMVaDBHn8lPMZ3wqZ3xq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3nPo'
const AUTH = '7Q9rUxF7Vh1sQ7Q9rUxF'

/** What the reader is being told about, spelled loudly so that a leak cannot pass as an accident. */
const TITLE = 'Netflix renews tomorrow'
const BODY = '68.00 CNY charges in 1 day for the Streaming plan'
const PRIVATE_FRAGMENTS = ['Netflix', '68.00', 'Streaming', 'renews', 'charges', 'tomorrow']

const CONTEXT = { timezone: 'Asia/Shanghai', locale: 'zh-CN' as const }
const TARGETS = [{ kind: 'inapp' as const, config: {} }]

const vapid = { publicKey: '', privateKey: '' }

let sqlite: DatabaseSync
let env: Env
let account: DeliveryAccount
let bodies: string[]

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(makeD1(sqlite), {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    PUBLIC_URL: 'http://localhost',
    ...overrides,
  })
}

/** One fake push service that remembers every body it was handed. */
function stubFetch(respond: () => Response): void {
  bodies = []
  vi.stubGlobal('fetch', vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
    const body = init?.body
    bodies.push(typeof body === 'string' ? body : body instanceof Uint8Array ? fromUtf8(body) : '')
    return respond()
  }))
}

function rows(userId: string): { id: string, title: string, body: string, pushedAt: number | null, subscriptionId: string | null }[] {
  return sqlite.prepare(
    `SELECT id, title, body, pushed_at AS pushedAt, subscription_id AS subscriptionId FROM chat_notifications WHERE user_id = ?1 ORDER BY created_at`,
  ).all(userId ) as { id: string, title: string, body: string, pushedAt: number | null, subscriptionId: string | null }[]
}

async function subscribe(userId: string, endpoint: string): Promise<void> {
  await new AssistantStore(env.DB, userId, env).upsertPushSubscription({ endpoint, p256dh: P256DH, auth: AUTH })
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  vapid.publicKey = toBase64Url(new Uint8Array(raw))
  vapid.privateKey = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y })
  env = envWith()
  account = { env, userId: USER }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the in-app channel', () => {
  it('writes the reminder into the account it was dispatched for', async () => {
    stubFetch(() => new Response(null, { status: 201 }))
    const result = await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    const landed = rows(USER)
    expect(landed).toHaveLength(1)
    expect(landed[0]!.title).toBe(TITLE)
    expect(landed[0]!.body).toBe(BODY)
    expect(result.successCount).toBe(1)
    expect(result.failedCount).toBe(0)
    expect(rows(OTHER), 'a delivery for one reader left a row on another account').toEqual([])
  })

  it('nudges with a signal and a count, and none of the reader’s words', async () => {
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response(null, { status: 201 }))
    await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    expect(bodies).toHaveLength(1)
    const payload = bodies[0]!
    const landed = rows(USER)[0]!
    for (const leaked of [...PRIVATE_FRAGMENTS, landed.title, landed.body, landed.id]) {
      expect(payload, `the push payload carried ${leaked} out to the push service`).not.toContain(leaked)
    }
    expect(JSON.parse(payload)).toEqual({ kind: PUSH_PING_KIND, count: 1 })
  })

  it('stamps the row it announced, so the catch-up fire does not announce it again', async () => {
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response(null, { status: 201 }))
    await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    expect(rows(USER)[0]!.pushedAt, 'an unannounced row would be nudged again on the next fire').not.toBeNull()
  })

  it('reports a device that refused instead of failing the delivery', async () => {
    await subscribe(USER, LAPTOP)
    stubFetch(() => new Response('gone', { status: 500 }))
    const result = await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    expect(result.successCount).toBe(1)
    expect(result.results[0]!.error).toBeUndefined()
    // The refusal is still a number the reader can act on, which is what keeps it from being a silence.
    expect(result.results[0]!.detail).toMatch(/refused/)
    expect(rows(USER)).toHaveLength(1)
  })

  it('names a deployment with no push secrets rather than asking a service anything', async () => {
    account = { env: envWith({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }), userId: USER }
    stubFetch(() => new Response(null, { status: 201 }))
    const result = await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    expect(result.successCount).toBe(1)
    expect(bodies, 'an unconfigured deployment must not reach out to a push service').toHaveLength(0)
    expect(result.results[0]!.detail).toMatch(/VAPID_PUBLIC_KEY/)
    expect(rows(USER)).toHaveLength(1)
  })

  it('tells a reader with no registered device that the inbox is all they got', async () => {
    stubFetch(() => new Response(null, { status: 201 }))
    const result = await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)

    expect(result.successCount).toBe(1)
    expect(bodies).toHaveLength(0)
    expect(result.results[0]!.detail).toMatch(/No device is registered/)
  })
})

  /**
   * The pointer that makes a delivery openable.
   *
   * A row that says "Netflix renews in 3 days" and cannot be tapped is a message the reader has to go look
   * up. The id rides on the payload from the sweep, and a delivery that names no plan — a channel test, a
   * routine — must keep arriving with nothing attached rather than a pointer to whatever was last on hand.
   */
  it('keeps the plan it was about, so the reader can open it', async () => {
    stubFetch(() => new Response(null, { status: 201 }))
    await dispatch({ title: TITLE, content: BODY, subscriptionId: SUB_ID }, TARGETS, CONTEXT, account)
    const landed = rows(USER)
    expect(landed[0]!.subscriptionId).toBe(SUB_ID)
  })

  it('attaches nothing when the message names no plan', async () => {
    stubFetch(() => new Response(null, { status: 201 }))
    await dispatch({ title: TITLE, content: BODY }, TARGETS, CONTEXT, account)
    expect(rows(USER)[0]!.subscriptionId).toBeNull()
  })
