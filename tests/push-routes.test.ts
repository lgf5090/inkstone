// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { toBase64Url, toHex } from '../src/worker/lib/encoding'
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
/** The three shapes a push service really answers with, and the reason a redaction may not read the path. */
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const GOOGLE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e3HO4d0nTQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const APPLE_ENDPOINT = 'https://notify.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3De'
/** The Apple endpoint with its last characters moved: same origin, same path shape, different device. */
const APPLE_TWIN_ENDPOINT = 'https://notify.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3Df'
const SECOND_ENDPOINT = 'https://fcmregistrations.googleapis.com/v1/projects/inkstone-test/registrations/AAAAAABx02TokenForASecondDeviceThatIsNotTheFirstOnesRow'
const OTHER_ENDPOINT = 'https://web.push.apple.com/DAQs1c0hKm3nPo5qRs7tUv9wXy1Za3Bc5De7Fg9Hi1Jk3Lm5No7Pq9Rs1Tu3Vw5Xy7Za1Bc3De'

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

/**
 * An endpoint's full SHA-256 in both spellings.
 *
 * A truncated digest is a label; the whole digest of an endpoint is a check value against a guessed address,
 * and neither spelling belongs anywhere near a response body or a stored error line.
 */
async function fullDigestsOf(endpoint: string): Promise<string[]> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)))
  return [toHex(bytes), toBase64Url(bytes)]
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
    // The row's id is the handle the screen keeps for "this device", so the write has to name it.
    expect(made.payload.deviceId).toBe(list[0]!.id)
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

describe('GET /push/subscriptions', () => {
  /** Subscribes `endpoint`s under one account and hands back the rows the write echoed. */
  async function subscribe(userId: string, ...endpoints: string[]): Promise<SubscriptionView[]> {
    asUser(userId)
    let rows: SubscriptionView[] = []
    for (const endpoint of endpoints) {
      const made = await request('POST', '/api/assistant/push/subscriptions', { endpoint, keys: { p256dh: P256DH, auth: AUTH } })
      rows = made.payload.subscriptions as SubscriptionView[]
    }
    return rows
  }

  it('lists the account\'s devices without making it write one first', async () => {
    const written = await subscribe(USER, ENDPOINT, SECOND_ENDPOINT)
    asUser(USER)
    const read = await request('GET', '/api/assistant/push/subscriptions')
    expect(read.status).toBe(200)
    const listed = read.payload.subscriptions as SubscriptionView[]
    // The same rows the write echoed back, with the same handles: a read is not a thinner view of the list.
    expect(listed.map((row) => row.id).sort()).toEqual(written.map((row) => row.id).sort())
    expect(listed.map((row) => row.endpoint).sort()).toEqual(written.map((row) => row.endpoint).sort())
    // The columns the settings screen prints beside each device, present on every row of a cold read.
    for (const row of listed) {
      expect(typeof row.createdAt).toBe('number')
      expect(row.failures).toBe(0)
      expect(row.lastError).toBeNull()
    }
  })

  it('reads one account and never its neighbour\'s rows', async () => {
    const mine = await subscribe(USER, ENDPOINT, SECOND_ENDPOINT)
    await subscribe(OTHER, OTHER_ENDPOINT)
    asUser(USER)
    const listed = (await request('GET', '/api/assistant/push/subscriptions')).payload.subscriptions as SubscriptionView[]
    // Three rows exist in the table and exactly the caller's two are answered. Dropping the tenant filter —
    // even one that still reads as scoped to the statement guard, because the guard only matches the SQL text
    // — puts the neighbour's row id in this answer, which fails the equality below rather than passing on
    // a count.
    expect(listed).toHaveLength(2)
    expect(listed.map((row) => row.id).sort()).toEqual(mine.map((row) => row.id).sort())
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 3 })
    // Redaction is not the read's own rule: the same view a write returns, so no endpoint tail on the wire.
    const wire = JSON.stringify(listed)
    expect(wire).not.toContain(ENDPOINT)
    expect(wire).not.toContain(SECOND_ENDPOINT)
    expect(wire).not.toContain(OTHER_ENDPOINT)
    expect(wire).not.toContain(P256DH)
    expect(wire).not.toContain(AUTH)
  })

  it('answers an empty list for an account that holds no device', async () => {
    const read = await request('GET', '/api/assistant/push/subscriptions')
    expect(read.status).toBe(200)
    // Empty is a fact about the account, not a missing read: the screen has to be able to tell them apart.
    expect(read.payload.subscriptions).toEqual([])
  })

  it('carries the failure ledger each row has behind it', async () => {
    await subscribe(USER, ENDPOINT)
    sqlite.prepare('UPDATE chat_push_subscriptions SET failures = 2, last_error = ? WHERE user_id = ?')
      .run('the push service answered 500 for https://example.invalid/other-device', USER)
    const listed = (await request('GET', '/api/assistant/push/subscriptions')).payload.subscriptions as SubscriptionView[]
    expect(listed[0]).toMatchObject({ failures: 2, lastError: 'the push service answered 500 for https://example.invalid/other-device' })
  })

  it('requires a signed-in account', async () => {
    app = buildApp(null)
    expect((await request('GET', '/api/assistant/push/subscriptions')).status).toBe(401)
  })
})

describe('DELETE /push/subscriptions/:id', () => {
  /** The caller's two rows, and the neighbour account's one row, as each account's own list names them. */
  let mine: SubscriptionView[]
  let neighbour: SubscriptionView

  async function readList(): Promise<SubscriptionView[]> {
    return (await request('GET', '/api/assistant/push/subscriptions')).payload.subscriptions as SubscriptionView[]
  }

  function revoke(id: string): Promise<{ status: number, payload: Record<string, unknown> }> {
    return request('DELETE', `/api/assistant/push/subscriptions/${id}`)
  }

  function rowsOwnedBy(userId: string): number {
    const counted = sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions WHERE user_id = ?').get(userId) as { n: number }
    return counted.n
  }

  beforeEach(async () => {
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: SECOND_ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    mine = await readList()
    asUser(OTHER)
    await request('POST', '/api/assistant/push/subscriptions', { endpoint: OTHER_ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    neighbour = (await readList())[0]!
    asUser(USER)
    expect(mine).toHaveLength(2)
    expect(neighbour.id).toBeTruthy()
  })

  it('removes the row the caller names and answers with the list that is left', async () => {
    const gone = await revoke(mine[0]!.id)
    expect(gone.status).toBe(200)
    expect(gone.payload.removed).toBe(true)
    expect((gone.payload.subscriptions as SubscriptionView[]).map((row) => row.id)).toEqual([mine[1]!.id])
    // The redaction rule survives the delete: the list that comes back is the same view the read gives, and
    // it carries no endpoint tail and no key.
    const wire = JSON.stringify(gone.payload)
    expect(wire).not.toContain(ENDPOINT)
    expect(wire).not.toContain(SECOND_ENDPOINT)
    expect(wire).not.toContain(P256DH)
    expect(wire).not.toContain(AUTH)
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 2 })
  })

  it('will not remove another account\'s row, and says so instead of pretending', async () => {
    // A row id is handed to any signed-in reader of their own screen, so it is a handle and not a
    // capability: naming a neighbour's row has to be refused, and refused without telling anybody whose row
    // it was.
    const denied = await revoke(neighbour.id)
    expect(denied.status, 'a foreign row id was accepted as a delete').toBe(404)
    expect(denied.payload.removed).toBeUndefined()
    expect(denied.payload.subscriptions).toBeUndefined()
    expect(JSON.stringify(denied.payload), 'the refusal named the account that owns the row').not.toContain(OTHER)
    expect(rowsOwnedBy(OTHER), 'another account\'s subscription was removed by a stranger').toBe(1)
    expect(await readList()).toHaveLength(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 3 })
  })

  it('answers 404 for an id that is not one, and for one that is simply not there', async () => {
    const notAnId = ['', 'not-a-row-id', '../..', '0'.repeat(25), '0'.repeat(27), '0123456789abcdefghjkmnpqrsu']
    for (const id of notAnId) {
      expect((await revoke(id)).status, `${id} is not a row id, and must not be probed against the table`).toBe(404)
    }
    // Right shape, no row: answered the same way, because the difference would be a lookup into the table.
    expect((await revoke('0123456789abcdefghjkmnpqrt')).status).toBe(404)
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 3 })
  })

  it('requires a signed-in account', async () => {
    app = buildApp(null)
    expect((await revoke(mine[0]!.id)).status).toBe(401)
    expect(rowsOwnedBy(USER)).toBe(2)
  })
})

/**
 * The redaction may not know what an endpoint's path means.
 *
 * Taking "the head" of an endpoint was a shape assumption, and the shape that breaks it is the common one:
 * Apple's services put the whole replayable token in the first path segment (`https://notify.apple.com/DAQs…`),
 * so a path head there *is* the credential — and endpoint + `p256dh` + `auth` together let anybody place a
 * notification on that device. These cases hold every service to one form, an origin and a short digest, and
 * they are written against the wire a reader's browser actually receives rather than against the helper.
 */
describe('push endpoint redaction is independent of the path shape', () => {
  /** The only shape a masked endpoint may take: an origin, a `#`, then eight base64url characters. */
  const MASKED_FORM = /^https:\/\/[A-Za-z0-9.-]+#[A-Za-z0-9_-]{8}$/

  /** Subscribes one endpoint under the signed-in account and reads the row back as the wire that carries it. */
  async function labelled(endpoint: string): Promise<{ row: SubscriptionView, wire: string }> {
    const made = await request('POST', '/api/assistant/push/subscriptions', { endpoint, keys: { p256dh: P256DH, auth: AUTH } })
    expect(made.status).toBe(201)
    const read = await request('GET', '/api/assistant/push/subscriptions')
    const rows = read.payload.subscriptions as SubscriptionView[]
    expect(rows).toHaveLength(1)
    return { row: rows[0]!, wire: JSON.stringify([read.payload, made.payload]) }
  }

  const shapes = [
    { name: 'a Mozilla long path', endpoint: ENDPOINT },
    { name: 'a Google FCM path', endpoint: GOOGLE_ENDPOINT },
    { name: 'an Apple short path', endpoint: APPLE_ENDPOINT },
  ]

  for (const shape of shapes) {
    it(`echoes no token segment of ${shape.name}`, async () => {
      const { row, wire } = await labelled(shape.endpoint)
      const url = new URL(shape.endpoint)
      const label = new URL(row.endpoint)
      expect(row.endpoint, `${shape.name} was answered in a form other than origin plus digest`).toMatch(MASKED_FORM)
      // No path at all survives, however many segments the service used to spell it.
      expect(label.pathname, `${shape.name} kept part of the endpoint's path`).toBe('/')
      expect(label.hash.slice(1), `${shape.name}'s digest is not a fixed width`).toHaveLength(8)
      // The replayable piece named directly: no segment long enough to be a token has even its head echoed.
      for (const segment of url.pathname.split('/').filter(Boolean)) {
        if (segment.length < 8) continue
        expect(wire, `${shape.name} echoed the head of its token segment`).not.toContain(segment.slice(0, 8))
      }
      expect(wire).not.toContain(shape.endpoint)
      expect(wire, `${shape.name} leaked the path the token travels in`).not.toContain(url.pathname)
      for (const digest of await fullDigestsOf(shape.endpoint)) {
        expect(wire, 'the whole digest of an endpoint is a check value, not a label').not.toContain(digest)
      }
      // The keys are never on the wire either, whatever the endpoint looks like.
      expect(wire).not.toContain(P256DH)
      expect(wire).not.toContain(AUTH)
    })
  }

  it('labels two Apple endpoints that share every visible character differently', async () => {
    // The positive control against a redaction that quietly went back to reading the path: a prefix rule
    // gives these two rows the same label, because they share their origin, their shape and 110 of their
    // characters. Only a digest of the whole endpoint tells them apart.
    const first = await labelled(APPLE_ENDPOINT)
    sqlite.exec('DELETE FROM chat_push_subscriptions')
    const twin = await labelled(APPLE_TWIN_ENDPOINT)
    expect(first.row.endpoint).toMatch(MASKED_FORM)
    expect(twin.row.endpoint).toMatch(MASKED_FORM)
    expect(twin.row.endpoint, 'two different devices were given the same endpoint label').not.toBe(first.row.endpoint)
  })

  it('labels one endpoint the same way on every read, so a row stays recognisable', async () => {
    const made = await request('POST', '/api/assistant/push/subscriptions', { endpoint: APPLE_ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } })
    const written = (made.payload.subscriptions as SubscriptionView[])[0]!
    const read = await request('GET', '/api/assistant/push/subscriptions')
    expect((read.payload.subscriptions as SubscriptionView[])[0]!.endpoint).toBe(written.endpoint)
  })
})
