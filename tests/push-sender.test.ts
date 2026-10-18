// @vitest-environment node
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AssistantPushSubscription } from '../src/worker/assistant/store'
import {
  createVapidAuthorization,
  derToFixedWidth,
  describeEndpoint,
  pushServiceOrigin,
  sendPush,
  vapidProblem,
} from '../src/worker/assistant/push'
import { fromUtf8, toBase64Url, utf8 } from '../src/worker/lib/encoding'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The VAPID pair, generated the way an operator generates one: an ES256 key, the private half kept as the
 * JWK that goes into the secret, the public half as the raw uncompressed point a browser puts into
 * `applicationServerKey`.
 */
const USER = '0123456789abcdefghjkmnpqrs'
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABx0197tPQY0kq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3n'
const P256DH = 'BKwRvYJ0mMVaDBHn8lPMZ3wqZ3xq0Y1sQ7Q9rUxF7Vh1sQYb1W1pZ9YQ3s6zXw1oQ2m7cPv8rJn0kLm3nPo'
const AUTH = '7Q9rUxF7Vh1sQ7Q9rUxF'

let sqlite: DatabaseSync
let keys: { publicKey: string, privateKey: string }

function envWith(overrides: Partial<Env> = {}): Env {
  return testBindings(makeD1(sqlite), {
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    ...overrides,
  })
}

function base64urlJson(segment: string): Record<string, unknown> {
  const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4)
  return JSON.parse(fromUtf8(Uint8Array.from(atob(padded.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)))) as Record<string, unknown>
}

async function storedSubscription(endpoint = ENDPOINT): Promise<AssistantPushSubscription> {
  const store = new AssistantStore(envWith().DB, USER, envWith())
  return await store.upsertPushSubscription({ endpoint, p256dh: P256DH, auth: AUTH })
}

/** One fetch the sender made, as the sender made it. */
interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array
  redirect?: string
}

function stubFetch(responses: (() => Response)[]): { calls: Sent[] } {
  const calls: Sent[] = []
  const handler = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value
    const body = typeof init?.body === 'string' ? utf8(init.body) : init?.body instanceof Uint8Array ? init.body : new Uint8Array()
    calls.push({ url, method: init?.method ?? 'GET', headers, body, redirect: init?.redirect })
    const next = responses.shift()
    if (!next) throw new Error(`the sender retried a push service it was told to answer ${calls.length} times`)
    return next()
  })
  vi.stubGlobal('fetch', handler)
  return { calls }
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
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the VAPID configuration', () => {
  it('names the variable that is missing rather than answering "not configured"', () => {
    expect(vapidProblem(envWith({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined })),
      'a missing pair has to tell the operator which two names to set').toMatch(/VAPID_PUBLIC_KEY[\s\S]*VAPID_PRIVATE_KEY/)
    expect(vapidProblem(envWith({ VAPID_PRIVATE_KEY: undefined }))).toMatch(/VAPID_PRIVATE_KEY/)
    expect(vapidProblem(envWith({ VAPID_PUBLIC_KEY: undefined }))).toMatch(/VAPID_PUBLIC_KEY/)
    // The message has to be something an operator can act on, not just a name.
    expect(vapidProblem(envWith({ VAPID_PRIVATE_KEY: undefined }))).toMatch(/wrangler secret put VAPID_PRIVATE_KEY/)
    expect(vapidProblem(envWith())).toBeNull()
  })

  it('rejects a public key that is not an uncompressed P-256 point', () => {
    expect(vapidProblem(envWith({ VAPID_PUBLIC_KEY: 'not-a-point' }))).toMatch(/VAPID_PUBLIC_KEY/)
    // 64 bytes is a compressed point: the length alone says it, and the browser would refuse it later.
    expect(vapidProblem(envWith({ VAPID_PUBLIC_KEY: toBase64Url(new Uint8Array(64)) }))).toMatch(/VAPID_PUBLIC_KEY/)
    expect(vapidProblem(envWith({ VAPID_PRIVATE_KEY: '{"kty":"EC","crv":"P-256"}' }))).toMatch(/VAPID_PRIVATE_KEY/)
  })

  it('refuses to sign rather than pretending a send happened', async () => {
    const subscription = await storedSubscription()
    const env = envWith({ VAPID_PRIVATE_KEY: undefined })
    await expect(sendPush(subscription, '{}', env)).rejects.toThrow(/VAPID_PRIVATE_KEY/)
    // Fast-failed before any request: nothing was sent, and the subscription is untouched.
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 1 })
  })
})

describe('the VAPID claim', () => {
  it('audiences itself at the push service origin, not at the endpoint', async () => {
    const authorization = await createVapidAuthorization(ENDPOINT, envWith())
    expect(authorization.startsWith('WebPush ')).toBe(true)
    const [, token] = authorization.split(' ')
    const [header, claims, signature, publicKey] = token.split('.')
    expect(base64urlJson(header!)).toEqual({ typ: 'JWT', alg: 'ES256' })
    const payload = base64urlJson(claims!)
    expect(payload.aud, 'aud has to be the origin the claim is presented to').toBe('https://updates.push.services.mozilla.com')
    expect(String(payload.aud)).not.toContain('gAAAAABx')
    expect(typeof payload.exp).toBe('number')
    expect(payload.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000) + 11 * 60 * 60)
    expect(payload.exp as number).toBeLessThan(Math.floor(Date.now() / 1000) + 13 * 60 * 60)
    expect(publicKey).toBe(keys.publicKey)
    expect(signature).toBeTruthy()
    // The endpoint as a whole is a capability and must never reach the claim, the header or a log line.
    expect(authorization).not.toContain(ENDPOINT)
  })

  it('carries a subject only when the operator configured one, and in a form a service accepts', async () => {
    const plain = await createVapidAuthorization(ENDPOINT, envWith())
    expect(base64urlJson(plain.split(' ')[1]!.split('.')[1]!).sub).toBeUndefined()
    const claimed = await createVapidAuthorization(ENDPOINT, envWith({ VAPID_SUBJECT: 'mailto:me@example.com' }))
    expect(base64urlJson(claimed.split(' ')[1]!.split('.')[1]!).sub).toBe('mailto:me@example.com')
    expect(vapidProblem(envWith({ VAPID_SUBJECT: 'me@example.com' }))).toMatch(/VAPID_SUBJECT/)
  })

  it('signs a signature the public key verifies, which is what a push service actually checks', async () => {
    const authorization = await createVapidAuthorization(ENDPOINT, envWith())
    const [header, claims, signature] = authorization.split(' ')[1]!.split('.')
    const point = fromBase64UrlBytes(keys.publicKey)
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    // A JWS ES256 signature is the fixed-width r||s pair. WebCrypto signs DER on some runtimes, and shipping
    // those bytes is the mistake that reads as "every push service returns 401" rather than as a bug.
    const signatureBytes = fromBase64UrlBytes(signature!)
    expect(signatureBytes.byteLength, 'the claim does not carry a 64-byte ES256 signature').toBe(64)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes as BufferSource,
      utf8(`${header}.${claims}`) as BufferSource), 'the signature does not verify under the configured public key').toBe(true)
  })

  it('turns the DER form workerd signs into the pair a JWS requires, verified rather than measured', () => {
    // Node's WebCrypto happens to hand back the fixed-width pair, so the conversion branch production runs
    // on has to be exercised against a real DER signature from elsewhere — and `ieee-p1363` is the same form
    // the claim ships. Verifying the converted bytes is what proves the leading-zero slice, not a length check.
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const message = new TextEncoder().encode(`${Date.now()}-claim`)
    let sawPaddedInteger = false
    for (let attempt = 0; attempt < 24; attempt++) {
      const der = new Uint8Array(sign('sha256', Buffer.from([attempt]), { key: privateKey, dsaEncoding: 'der' }))
      const raw = derToFixedWidth(der)
      expect(raw.byteLength).toBe(64)
      expect(verify('sha256', Buffer.from([attempt]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(raw)),
        'the converted signature no longer says what was signed').toBe(true)
      // DER writes a component whose top bit is set with a leading zero byte; the slice has to drop it.
      if (der[der.indexOf(0x02, 2) + 2] === 0x00) sawPaddedInteger = true
    }
    expect(sawPaddedInteger, 'nothing in the sample carried DER\'s sign bit, so the slice went untested').toBe(true)
  })

  it('takes the audience from the endpoint, so two services get two claims', () => {
    expect(pushServiceOrigin('https://web.push.apple.com/DAQs1c0hKm3n')).toBe('https://web.push.apple.com')
    expect(pushServiceOrigin('https://fcm.googleapis.com/fcm/send/abc')).toBe('https://fcm.googleapis.com')
    expect(() => pushServiceOrigin('http://updates.push.services.mozilla.com/x'),
      'a plain-http endpoint is not a push service').toThrow(/https/)
    expect(() => pushServiceOrigin('not a url')).toThrow()
  })
})

describe('sending to a push service', () => {
  it('posts the payload with the headers the protocol asks for and keeps the subscription', async () => {
    const subscription = await storedSubscription()
    const { calls } = stubFetch([() => new Response(null, { status: 201 })])
    const result = await sendPush(subscription, JSON.stringify({ title: 'Inkstone' }), envWith())
    expect(result.outcome).toBe('sent')
    expect(result.statusCode).toBe(201)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(ENDPOINT)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['authorization']).toMatch(/^WebPush /)
    expect(calls[0]!.headers['content-encoding']).toBe('aes128gcm')
    expect(Number(calls[0]!.headers['ttl'])).toBeGreaterThan(0)
    expect(Number(calls[0]!.headers['content-length'])).toBe(calls[0]!.body.byteLength)
    expect(fromUtf8(calls[0]!.body)).toBe(JSON.stringify({ title: 'Inkstone' }))
    const store = new AssistantStore(envWith().DB, USER, envWith())
    expect((await store.listPushSubscriptions())[0]?.failures).toBe(0)
  })

  it('drops the subscription on 410 and does not retry it', async () => {
    const subscription = await storedSubscription()
    const { calls } = stubFetch([() => new Response('Not Found', { status: 410 })])
    const store = new AssistantStore(envWith().DB, USER, envWith())
    const result = await sendPush(subscription, '{}', envWith())
    expect(result.outcome).toBe('expired')
    expect(result.statusCode).toBe(410)
    expect(result.dropped).toBe(true)
    expect(calls, 'an expired endpoint must not be sent to again').toHaveLength(1)
    expect(await store.listPushSubscriptions()).toEqual([])
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('drops the subscription on 404 too', async () => {
    const subscription = await storedSubscription()
    stubFetch([() => new Response('Not Found', { status: 404 })])
    const result = await sendPush(subscription, '{}', envWith())
    expect(result.outcome).toBe('expired')
    expect(sqlite.prepare('SELECT count(*) AS n FROM chat_push_subscriptions').get()).toEqual({ n: 0 })
  })

  it('counts a refusal, keeps the row, and names the status and the answer without leaking the endpoint', async () => {
    const subscription = await storedSubscription()
    // A push service that echoes the request URL back in its error page is the case that matters here.
    stubFetch([() => new Response(`Internal Server Error while handling ${ENDPOINT}`, { status: 500 })])
    const store = new AssistantStore(envWith().DB, USER, envWith())
    const result = await sendPush(subscription, '{}', envWith())
    expect(result.outcome).toBe('failed')
    expect(result.statusCode).toBe(500)
    expect(result.dropped).toBe(false)
    expect(result.detail).toContain('500')
    expect(result.detail, 'the error text is stored and may be logged: no credential in it').not.toContain(ENDPOINT)
    expect(result.detail).toContain(await describeEndpoint(ENDPOINT))
    const [row] = await store.listPushSubscriptions()
    expect(row?.failures).toBe(1)
    expect(row?.lastError).toBe(result.detail)
    expect(row?.lastError).not.toContain(ENDPOINT)
  })

  it('reports a request that never got an answer instead of swallowing it', async () => {
    const subscription = await storedSubscription()
    const handler = vi.fn(async () => { throw new TypeError('socket hang up') })
    vi.stubGlobal('fetch', handler)
    const result = await sendPush(subscription, '{}', envWith())
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('socket hang up')
    expect(result.detail).not.toContain(ENDPOINT)
    expect(sqlite.prepare('SELECT failures FROM chat_push_subscriptions').get()).toEqual({ failures: 1 })
  })

  it('refuses a redirect instead of carrying the claim to another origin', async () => {
    const subscription = await storedSubscription()
    const { calls } = stubFetch([() => new Response(null, { status: 302, headers: { location: 'https://somewhere-else.example/x' } })])
    const result = await sendPush(subscription, '{}', envWith())
    expect(calls[0]!.redirect, 'a manual redirect is the only way workerd can decline one').toBe('manual')
    expect(result.outcome).toBe('failed')
    expect(result.statusCode).toBe(302)
    expect(result.detail).not.toContain(ENDPOINT)
    expect(sqlite.prepare('SELECT failures FROM chat_push_subscriptions').get()).toEqual({ failures: 1 })
  })

  it('treats an answer that is not 201 as a refusal, because a 200 says nothing was queued', async () => {
    const subscription = await storedSubscription()
    stubFetch([() => new Response('ok', { status: 200 })])
    const result = await sendPush(subscription, '{}', envWith())
    expect(result.outcome).toBe('failed')
    expect(result.statusCode).toBe(200)
    expect(sqlite.prepare('SELECT failures FROM chat_push_subscriptions').get()).toEqual({ failures: 1 })
  })

  it('drops the row once the refusals reach the limit, so the sender says so', async () => {
    const subscription = await storedSubscription()
    const env = envWith()
    const store = new AssistantStore(env.DB, USER, env)
    for (let attempt = 1; attempt <= 4; attempt++) {
      stubFetch([() => new Response('try later', { status: 429 })])
      expect((await sendPush(subscription, '{}', env)).dropped).toBe(false)
    }
    stubFetch([() => new Response('try later', { status: 429 })])
    const last = await sendPush(subscription, '{}', env)
    expect(last.outcome).toBe('failed')
    expect(last.dropped).toBe(true)
    expect(await store.listPushSubscriptions()).toEqual([])
    expect(await store.listPushSubscriptions()).toEqual([])
  })
})

function fromBase64UrlBytes(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function b64u(bytes: Uint8Array): string {
  return toBase64Url(bytes)
}
