// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_TTL_MS,
  MAX_PROXY_RESPONSE_BYTES,
  PROXY_RATE_LIMIT,
} from '../src/shared/development/api-tester/limits'
import { newApiTesterId } from '../src/shared/development/api-tester/ids'
import type { ProxyRequest, ProxyResponse } from '../src/shared/development/api-tester/types'
import type { AppBindings, Env } from '../src/worker/env'
import { DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS } from '../src/worker/development/api-tester/schema'
import { relayRoutes } from '../src/worker/development/api-tester/relay'
import { toBase64 } from '../src/worker/lib/encoding'
import { errorResponse } from '../src/worker/lib/errors'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-owner'
const OTHER = 'user-other'

const LOGIN_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`

type FetchArgs = [input: string | URL | Request, init?: RequestInit]

let sqlite: DatabaseSync
let db: D1Database
let bucket: TestR2Bucket
let env: Env
let currentUser = USER
let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>

const app = new Hono<AppBindings>()
app.use('*', async (c, next) => {
  c.set('userId', currentUser)
  await next()
})
app.route('/', relayRoutes)
app.onError((err, c) => errorResponse(c, err))

function textResponse(body: string, contentType = 'text/plain; charset=utf-8', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

function redirectResponse(status: number, location: string, body?: string): Response {
  return new Response(body ?? null, { status, headers: { location } })
}

function requestBody(patch: Partial<ProxyRequest> = {}): string {
  return JSON.stringify({
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: [],
    redirect: 'follow',
    timeoutMs: 5_000,
    ...patch,
  })
}

async function postProxy(patch: Partial<ProxyRequest> = {}): Promise<Response> {
  return app.request(
    '/proxy',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(patch),
    },
    env,
  )
}

async function proxyJson(response: Response): Promise<ProxyResponse> {
  return (await response.json()) as ProxyResponse
}

beforeEach(() => {
  currentUser = USER
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(LOGIN_ATTEMPTS_SCHEMA)
  db = makeD1(sqlite)
  bucket = testR2Bucket()
  env = testBindings(db, { FILES: bucket })
  fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sqlite.close()
})

describe('relay target validation', () => {
  it.each([
    '127.0.0.1',
    '127.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    'localhost',
    'metadata.google.internal',
    'printer.local',
    '[::1]',
    '[fc00::1]',
    '[::ffff:127.0.0.1]',
  ])('blocks the literal private target %s', async (host) => {
    const response = await postProxy({ url: `http://${host}/internal` })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('apitester_blocked_target')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'not-a-url',
    'ftp://example.com/file',
    'file:///etc/passwd',
    '//example.com/no-scheme',
    'http://user:pass@example.com/',
  ])('rejects the unusable url %s', async (url) => {
    const response = await postProxy({ url })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('bad_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects header values carrying control characters', async () => {
    const response = await postProxy({ headers: [{ key: 'X-Test', value: 'bad\u0001value' }] })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects CR/LF header values before reaching the network', async () => {
    const response = await postProxy({ headers: [{ key: 'X-Test', value: 'bad\r\nvalue' }] })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 429 once the per-user proxy budget is locked', async () => {
    const now = Date.now()
    db.prepare(
      'INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, ?, ?, ?)',
    )
      .bind(`apitester-proxy:${USER}`, PROXY_RATE_LIMIT.maxAttempts, now, now + 60_000)
      .run()

    const response = await postProxy()
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('too_many_attempts')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('relay request shaping', () => {
  it('drops hop-by-hop headers and keeps user headers, last duplicate winning', async () => {
    fetchMock.mockResolvedValue(textResponse('ok'))

    const response = await postProxy({
      method: 'POST',
      body: 'payload',
      headers: [
        { key: 'Host', value: 'evil.example' },
        { key: 'Content-Length', value: '999' },
        { key: 'Connection', value: 'keep-alive' },
        { key: 'Keep-Alive', value: 'timeout=5' },
        { key: 'Transfer-Encoding', value: 'chunked' },
        { key: 'Upgrade', value: 'h2c' },
        { key: 'TE', value: 'trailers' },
        { key: 'Trailer', value: 'x-checksum' },
        { key: 'Proxy-Authorization', value: 'Basic secret' },
        { key: 'Authorization', value: 'Bearer token' },
        { key: 'X-Dupe', value: 'one' },
        { key: 'x-dupe', value: 'two' },
      ],
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]![1]!
    const headers = new Headers(init.headers)
    for (const dropped of [
      'host',
      'content-length',
      'connection',
      'keep-alive',
      'transfer-encoding',
      'upgrade',
      'te',
      'trailer',
      'proxy-authorization',
    ]) {
      expect(headers.get(dropped), dropped).toBeNull()
    }
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.get('x-dupe')).toBe('two')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('payload')
  })

  it('forces GET and HEAD to carry no body', async () => {
    fetchMock.mockResolvedValue(textResponse('ok'))

    await postProxy({ method: 'GET', body: 'ignored' })
    await postProxy({ method: 'HEAD', body: 'ignored' })

    expect(fetchMock.mock.calls[0]![1]!.body).toBeUndefined()
    expect(fetchMock.mock.calls[1]![1]!.body).toBeUndefined()
  })

  it('reads a body file that belongs to the caller', async () => {
    const fileId = newApiTesterId()
    const key = `development/apitester/bin/${USER}/${fileId}.bin`
    await bucket.put(key, new Uint8Array([1, 2, 3]))
    const now = Date.now()
    db.prepare(
      `INSERT INTO development_apitester_files
         (id, user_id, kind, name, content_type, size, r2_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fileId, USER, 'bin', 'body.bin', 'application/octet-stream', 3, key, now, now + FILE_TTL_MS)
      .run()
    fetchMock.mockResolvedValue(textResponse('ok'))

    const response = await postProxy({ method: 'POST', bodyFileId: fileId })
    expect(response.status).toBe(200)
    const sent = fetchMock.mock.calls[0]![1]!.body as Uint8Array
    expect(Array.from(new Uint8Array(sent))).toEqual([1, 2, 3])
  })

  it('does not read a body file owned by another account', async () => {
    const fileId = newApiTesterId()
    const key = `development/apitester/bin/${USER}/${fileId}.bin`
    await bucket.put(key, new Uint8Array([9]))
    const now = Date.now()
    db.prepare(
      `INSERT INTO development_apitester_files
         (id, user_id, kind, name, content_type, size, r2_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fileId, USER, 'bin', 'body.bin', 'application/octet-stream', 1, key, now, now + FILE_TTL_MS)
      .run()
    currentUser = OTHER

    const response = await postProxy({ method: 'POST', bodyFileId: fileId })
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a request carrying both a text body and a body file', async () => {
    const response = await postProxy({ method: 'POST', body: 'text', bodyFileId: newApiTesterId() })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('relay redirects', () => {
  it('follows a 301 POST as GET without the body', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(301, '/next'))
      .mockResolvedValueOnce(textResponse('done'))

    const response = await postProxy({ method: 'POST', body: 'payload' })
    const body = await proxyJson(response)

    expect(body.status).toBe(200)
    expect(body.body).toBe('done')
    expect(body.redirected).toBe(true)
    expect(body.url).toBe('https://api.example.com/next')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST')
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('GET')
    expect(fetchMock.mock.calls[1]![1]!.body).toBeUndefined()
  })

  it('follows a 302 POST as GET and a 303 as GET', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(302, '/second'))
      .mockResolvedValueOnce(redirectResponse(303, '/third'))
      .mockResolvedValueOnce(textResponse('done'))

    const response = await postProxy({ method: 'POST', body: 'payload' })
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('GET')
    expect(fetchMock.mock.calls[1]![1]!.body).toBeUndefined()
    expect(fetchMock.mock.calls[2]![1]!.method).toBe('GET')
    expect(fetchMock.mock.calls[2]![1]!.body).toBeUndefined()
  })

  it.each([307, 308])('keeps the method and body across a %i redirect', async (status) => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(status, '/next'))
      .mockResolvedValueOnce(textResponse('done'))

    await postProxy({ method: 'POST', body: 'payload' })
    expect(fetchMock.mock.calls[1]![1]!.method).toBe('POST')
    expect(fetchMock.mock.calls[1]![1]!.body).toBe('payload')
  })

  it('drops authorization and cookie headers on a cross-origin redirect', async () => {
    // The relay reuses one Headers object while following, so the mock snapshots each hop when the
    // fetch is made; inspecting it later would show the mutations the next hop caused.
    const seen: Headers[] = []
    fetchMock.mockImplementation(async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return seen.length === 1
        ? redirectResponse(302, 'https://other.example/next')
        : textResponse('done')
    })

    await postProxy({
      headers: [
        { key: 'Authorization', value: 'Bearer token' },
        { key: 'Cookie', value: 'session=secret' },
      ],
    })

    expect(seen).toHaveLength(2)
    expect(seen[0]!.get('authorization')).toBe('Bearer token')
    expect(seen[0]!.get('cookie')).toBe('session=secret')
    expect(seen[1]!.get('authorization')).toBeNull()
    expect(seen[1]!.get('cookie')).toBeNull()
  })

  it('keeps credentials on a same-origin redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(302, '/next'))
      .mockResolvedValueOnce(textResponse('done'))

    await postProxy({ headers: [{ key: 'Authorization', value: 'Bearer token' }] })
    const second = new Headers(fetchMock.mock.calls[1]![1]!.headers)
    expect(second.get('authorization')).toBe('Bearer token')
  })

  it('rechecks SSRF on every redirect hop', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(302, 'http://127.0.0.1/secret'))

    const response = await postProxy()
    expect(response.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after five followed redirects', async () => {
    fetchMock.mockResolvedValue(redirectResponse(302, '/loop'))

    const response = await postProxy()
    const body = await proxyJson(response)

    expect(response.status).toBe(200)
    expect(body.error).toBe('too_many_redirects')
    expect(body.status).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('returns the first redirect when manual mode is requested', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(302, '/next', 'moved'))

    const response = await postProxy({ redirect: 'manual' })
    const body = await proxyJson(response)

    expect(body.status).toBe(302)
    expect(body.body).toBe('moved')
    expect(body.redirected).toBe(false)
    expect(body.url).toBe('https://api.example.com/items')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('relay response handling', () => {
  it('splits text and binary bodies by content type', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('hello'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 1, 2, 255]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      )

    const text = await proxyJson(await postProxy())
    expect(text.body).toBe('hello')
    expect(text.bodyB64).toBeNull()
    expect(text.sizeBytes).toBe(5)
    expect(text.contentType).toBe('text/plain; charset=utf-8')

    const binary = await proxyJson(await postProxy())
    expect(binary.body).toBeNull()
    expect(binary.bodyB64).toBe(toBase64(new Uint8Array([0, 1, 2, 255])))
    expect(binary.sizeBytes).toBe(4)
  })

  it('cancels a response that passes five mebibytes', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let canceled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        canceled = true
      },
    })
    fetchMock.mockResolvedValue(
      new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }),
    )

    const response = await postProxy()
    const body = await proxyJson(response)

    expect(response.status).toBe(200)
    expect(body.error).toBe('response_too_large')
    expect(body.status).toBe(0)
    expect(body.body).toBeNull()
    expect(body.bodyB64).toBeNull()
    expect(body.sizeBytes).toBeGreaterThan(MAX_PROXY_RESPONSE_BYTES)
    expect(canceled).toBe(true)
  })

  it('reads every Set-Cookie value into the cookie list', async () => {
    const headers = new Headers()
    headers.append('set-cookie', 'session=abc; Domain=api.example.com; Path=/app')
    headers.append('set-cookie', 'theme=dark; Path=/')
    fetchMock.mockResolvedValue(new Response('ok', { headers }))

    const body = await proxyJson(await postProxy())
    expect(body.cookies).toEqual([
      { name: 'session', value: 'abc', domain: 'api.example.com', path: '/app' },
      { name: 'theme', value: 'dark', path: '/' },
    ])
  })

  it('reports ttfb, download and total timings separately', async () => {
    let tick = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      tick += 100
      return tick
    })
    fetchMock.mockResolvedValue(textResponse('ok'))

    const body = await proxyJson(await postProxy())

    expect(body.timing).toEqual({ ttfbMs: 100, downloadMs: 100, totalMs: 200 })
    expect(body.durationMs).toBe(200)
    now.mockRestore()
  })

  it('maps a timeout to a 200 envelope with request_timeout', async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException('The operation timed out', 'TimeoutError')
    })

    const response = await postProxy()
    const body = await proxyJson(response)
    expect(response.status).toBe(200)
    expect(body.error).toBe('request_timeout')
    expect(body.status).toBe(0)
  })

  it('maps an unreachable upstream to a 200 envelope', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const body = await proxyJson(await postProxy())
    expect(body.error).toBe('upstream_unreachable')
    expect(body.status).toBe(0)
  })
})
