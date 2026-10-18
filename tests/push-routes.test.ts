// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { toBase64Url } from '../src/worker/lib/encoding'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The push surface as a reader's client sees it.
 *
 * Two things are being proved here and they are easy to confuse: a subscription the browser hands over is
 * validated at the trust boundary rather than trusted, and nothing that comes back may carry the credential
 * it just stored. Both are checked against the real route rather than against a helper, because the route is
 * where the account scoping and the redaction actually live.
 */
const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'

interface SubscriptionView {
  id: string
  endpoint: string
  createdAt: number
  failures: number
  lastError: string | null
}

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Env
let keys: { publicKey: string, privateKey: string }
/** A real subscription key pair: an uncompressed P-256 point and a 16-byte auth secret, base64url. */
let P256DH: string
let AUTH: string

/** The message an `ApiError` put on the wire, which is where a field-named rejection has to be read. */
function errorMessage(payload: Record<string, unknown>): string {
  const error = payload.error as { message?: string } | undefined
  return String(error?.message ?? JSON.stringify(payload))
}

function buildApp(userId: string | null): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    if (userId) c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number, payload: Record<string, unknown> }> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext)
  return { status: response.status, payload: await response.json().catch(() => ({})) as Record<string, unknown> }
}

function asUser(userId: string): void {
  app = buildApp(userId)
}

async function freshPoint(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  keys = {
    publicKey: toBase64Url(new Uint8Array(raw)),
    privateKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }),
  }
  // The two keys a browser really produces: a second P-256 point for the device, and 16 random bytes of auth.
  P256DH = await freshPoint()
  AUTH = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  env = testBindings(makeD1(sqlite), { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey })
  app = buildApp(USER)
})

describe('GET /push/config', () => {
  it('says the server has no push keys, and names the ones missing', async () => {
    env = testBindings(makeD1(sqlite))
    const config = await request('GET', '/api/assistant/push/config')
    expect(config.status).toBe(200)
    expect(config.payload.enabled).toBe(false)
    expect(config.payload.publicKey).toBeNull()
    // The interface reads this string to explain itself; a bare "false" would leave it lying.
    expect(String(config.payload.reason)).toMatch(/VAPID_PUBLIC_KEY/)
    expect(String(config.payload.reason)).toMatch(/VAPID_PRIVATE_KEY/)
  })

  it('hands out the public key when the pair is configured', async () => {
    const config = await request('GET', '/api/assistant/push/config')
    expect(config.payload).toMatchObject({ enabled: true, publicKey: keys.publicKey })
    expect(JSON.stringify(config.payload), 'the private half must never leave the worker').not.toContain(keys.privateKey)
  })

  it('reports a half-configured deployment as off, naming the gap', async () => {
    env = testBindings(makeD1(sqlite), { VAPID_PUBLIC_KEY: keys.publicKey })
    const config = await request('GET', '/api/assistant/push/config')
    expect(config.payload.enabled).toBe(false)
    expect(String(config.payload.reason)).toMatch(/VAPID_PRIVATE_KEY/)
  })
})

describe('POST /push/subscriptions', () => {
  it('stores a valid subscription and returns it without its credential', async () => {
    const made = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    expect(made.status).toBe(201)
    const list = made.payload.subscriptions as SubscriptionView[]
    expect(list).toHaveLength(1)
    expect(list[0]!.endpoint).not.toBe(ENDPOINT)
    expect(list[0]!.endpoint.length).toBeLessThan(ENDPOINT.length)
    const wire = JSON.stringify(made.payload)
    expect(wire).not.toContain(ENDPOINT)
    expect(wire).not.toContain(P256DH)
    expect(wire).not.toContain(AUTH)
    // The row itself is the whole credential, stored under the signed-in account.
    const row = sqlite.prepare('SELECT user_id, endpoint, p256dh, auth, failures FROM chat_push_subscriptions').get() as Record<string, unknown>
    expect(row).toMatchObject({ user_id: USER, endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, failures: 0 })
  })

  it('keeps one row per endpoint and replaces the keys of a renewed subscription', async () => {
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    const renewedPoint = await freshPoint()
    const renewed = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: renewedPoint, auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) } })
    expect((renewed.payload.subscriptions as SubscriptionView[])).toHaveLength(1)
    expect(sqlite.prepare('SELECT p256dh FROM chat_push_subscriptions').get()).toEqual({ p256dh: renewedPoint })
  })

  it('refuses an endpoint that is not an https URL, naming the field', async () => {
    for (const endpoint of ['http://updates.push.services.mozilla.com/x', 'not-a-url', 'https://', ENDPOINT.replace('https', 'javascript')]) {
      const refused = await request('POST', '/api/assistant/push/subscriptions', { endpoint, keys: { p256dh: P256DH, auth: AUTH } })
      expect(refused.status, `${endpoint} is not an https push endpoint`).toBe(400)
      expect(errorMessage(refused.payload), `${endpoint} has to be named as the offending field`).toMatch(/endpoint/)
    }
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('refuses an endpoint longer than the bound instead of trusting a client', async () => {
    const huge = `https://updates.push.services.mozilla.com/wpush/v2/${'a'.repeat(4000)}`
    const refused = await request('POST', '/api/assistant/push/subscriptions', { endpoint: huge, keys: { p256dh: P256DH, auth: AUTH } })
    expect(refused.status).toBe(400)
    expect(errorMessage(refused.payload)).toMatch(/endpoint/)
  })

  it('refuses a missing endpoint, missing keys, and keys that are not usable', async () => {
    expect((await request('POST', '/api/assistant/push/subscriptions', { keys: { p256dh: P256DH, auth: AUTH } })).status).toBe(400)
    expect((await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT })).status).toBe(400)
    expect((await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH } })).status).toBe(400)
    expect((await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: 'p256dh' })).status).toBe(400)
    const badShape = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: 'BKw Rv+Y=/0mMVa', auth: AUTH } })
    expect(badShape.status).toBe(400)
    expect(errorMessage(badShape.payload)).toMatch(/p256dh/)
    // A string of the right shape that is not a P-256 point cannot take part in a delivery either.
    const wrongPoint = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: toBase64Url(new Uint8Array(64)), auth: AUTH } })
    expect(wrongPoint.status).toBe(400)
    expect(errorMessage(wrongPoint.payload)).toMatch(/p256dh/)
    const oversized = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: 'a'.repeat(5000) } })
    expect(oversized.status).toBe(400)
    expect(errorMessage(oversized.payload)).toMatch(/auth/)
  })

  it('refuses to store a subscription the deployment could never send to', async () => {
    env = testBindings(makeD1(sqlite))
    const refused = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    expect(refused.status).toBe(500)
    expect(errorMessage(refused.payload)).toMatch(/VAPID_PUBLIC_KEY/)
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('requires a signed-in account', async () => {
    app = buildApp(null)
    const anonymous = await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    expect(anonymous.status).toBe(401)
    expect((await request('GET', '/api/assistant/push/config')).status).toBe(401)
  })
})

describe('DELETE /push/subscriptions', () => {
  beforeEach(async () => {
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    asUser(OTHER)
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    asUser(USER)
  })

  it('removes the caller\'s own endpoint and answers with what is left', async () => {
    const removed = await request('DELETE', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT })
    expect(removed.status).toBe(200)
    expect(removed.payload.removed).toBe(true)
    expect(removed.payload.subscriptions).toEqual([])
    expect(JSON.stringify(removed.payload)).not.toContain(ENDPOINT)
    // The same endpoint string under another account is another device and stays where it is.
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions WHERE user_id = ?').all(OTHER)).toEqual([{ n: 1 }])
  })

  it('answers 404 for an endpoint the caller does not hold', async () => {
    const stranger = await request('DELETE', '/api/assistant/push/subscriptions', { endpoint: 'https://web.push.apple.com/DAQs1c0hKm3nPo5q' })
    expect(stranger.status).toBe(404)
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 2 })
  })

  it('refuses an endpoint that is not an https URL rather than probing with it', async () => {
    const refused = await request('DELETE', '/api/assistant/push/subscriptions', { endpoint: 'http://updates.push.services.mozilla.com/x' })
    expect(refused.status).toBe(400)
    expect(errorMessage(refused.payload)).toMatch(/endpoint/)
    expect((await request('DELETE', '/api/assistant/push/subscriptions', {})).status).toBe(400)
  })
})
