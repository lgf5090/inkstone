// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_SCHEMA_STATEMENTS } from '../src/worker/nav/schema'
import { navCheckRoutes } from '../src/worker/nav/check'
import { navIconRoutes } from '../src/worker/nav/icons'
import { errorResponse } from '../src/worker/lib/errors'
import { NAV_LIMITS, isNavId } from '../src/shared/nav/model'
import type { AppBindings, Env } from '../src/worker/env'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import type { NavCheckResponse, NavIconsResponse } from '../src/shared/nav/api'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

interface CallOptions {
  user?: string | null
  body?: unknown
  form?: FormData
  headers?: Record<string, string>
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  app.route('/api/nav', navIconRoutes)
  app.route('/api/nav/check', navCheckRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env
let r2: TestR2Bucket
let fetchCalls: Array<{ url: string; init: RequestInit }>

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = { ...options.headers }
  if (userId) headers['x-test-user'] = userId
  let body: BodyInit | undefined
  if (options.form) {
    body = options.form
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorCode(response: Response): Promise<string> {
  const body = await json<{ error: { code: string } }>(response)
  return body.error.code
}

function pngBytes(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function icoBytes(width = 32, height = 16): Uint8Array {
  const bytes = new Uint8Array(22)
  bytes.set([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, width, height, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00], 0)
  return bytes
}

function uploadForm(bytes: Uint8Array, name = 'icon.png', type = 'image/png'): FormData {
  const form = new FormData()
  form.set('file', new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], name, { type }))
  return form
}

async function upload(user: string, bytes: Uint8Array, name?: string, type?: string): Promise<Response> {
  return call('POST', '/api/nav/icons', { user, form: uploadForm(bytes, name, type) })
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const requestInit = init ?? {}
    fetchCalls.push({ url, init: requestInit })
    return await handler(url, requestInit)
  })
}

function iconRow(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM nav_icons WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of NAV_SCHEMA_STATEMENTS) sqlite.exec(statement)
  r2 = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: r2 })
  fetchCalls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sqlite.close()
})

describe('icon upload', () => {
  it('sniffs a PNG upload, stores it under nav/icons and records the row', async () => {
    const bytes = pngBytes(24, 12)
    const response = await upload(USER_A, bytes)
    expect(response.status).toBe(200)
    const body = await json<NavIconsResponse>(response)
    expect(isNavId(body.icon.id)).toBe(true)
    expect(body.icon).toMatchObject({ url: `/api/nav/icons/${body.icon.id}`, width: 24, height: 12 })

    const key = `nav/icons/${body.icon.id}.png`
    expect(r2.objects.has(key)).toBe(true)
    expect(r2.objects.get(key)!.byteLength).toBe(bytes.byteLength)
    expect(r2.types.get(key)).toBe('image/png')

    const row = iconRow(body.icon.id)!
    expect(row).toMatchObject({
      user_id: USER_A,
      object_key: key,
      content_type: 'image/png',
      byte_size: bytes.byteLength,
      width: 24,
      height: 12,
      source: 'upload',
      source_url: null,
    })
  })

  it('accepts an ICO header and records its declared dimensions', async () => {
    const response = await upload(USER_A, icoBytes(32, 16), 'favicon.ico', 'image/x-icon')
    expect(response.status).toBe(200)
    const body = await json<NavIconsResponse>(response)
    expect(body.icon).toMatchObject({ width: 32, height: 16 })
    expect(r2.types.get(`nav/icons/${body.icon.id}.ico`)).toBe('image/x-icon')
    expect(iconRow(body.icon.id)!.content_type).toBe('image/x-icon')
  })

  it('rejects bytes that are not a supported image without writing a row or object', async () => {
    const response = await upload(USER_A, new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'icon.svg', 'image/svg+xml')
    expect(response.status).toBe(415)
    expect(await errorCode(response)).toBe('nav_icon_invalid')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM nav_icons').get()).toEqual({ n: 0 })
    expect(r2.objects.size).toBe(0)
  })

  it('rejects an empty file, a missing field and files above one megabyte', async () => {
    const empty = await upload(USER_A, new Uint8Array(0))
    expect(empty.status).toBe(413)
    expect(await errorCode(empty)).toBe('payload_too_large')

    const missing = await call('POST', '/api/nav/icons', {
      form: (() => { const form = new FormData(); form.set('other', 'x'); return form })(),
    })
    expect(missing.status).toBe(400)

    const oversized = new Uint8Array(NAV_LIMITS.iconBytes + 1)
    oversized.set(pngBytes())
    const tooLarge = await upload(USER_A, oversized)
    expect(tooLarge.status).toBe(413)
    expect(await errorCode(tooLarge)).toBe('payload_too_large')
    expect(r2.objects.size).toBe(0)
  })
})

describe('icon capture', () => {
  it('refuses a blocked target without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('POST', '/api/nav/icons/capture', { body: { url: 'http://127.0.0.1/favicon.ico' } })
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('nav_blocked_target')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r2.objects.size).toBe(0)
  })

  it('rejects an oversized body before storing it', async () => {
    stubFetch(() => new Response(new Uint8Array(NAV_LIMITS.capturedIconBytes + 1), { status: 200 }))
    const response = await call('POST', '/api/nav/icons/capture', {
      body: { url: 'https://icons.example.com/huge.png' },
    })
    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('payload_too_large')
    expect(fetchCalls).toHaveLength(1)
    expect(r2.objects.size).toBe(0)
  })

  it('rejects a successful response whose bytes are not an image', async () => {
    stubFetch(() => new Response(new TextEncoder().encode('not an image'), { status: 200 }))
    const response = await call('POST', '/api/nav/icons/capture', {
      body: { url: 'https://icons.example.com/not-image' },
    })
    expect(response.status).toBe(415)
    expect(await errorCode(response)).toBe('nav_icon_invalid')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM nav_icons').get()).toEqual({ n: 0 })
    expect(r2.objects.size).toBe(0)
  })

  it('stores a fetched PNG and records its source URL', async () => {
    const bytes = pngBytes(48, 48)
    stubFetch((url, init) => {
      expect(url).toBe('https://icons.example.com/favicon.png')
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('manual')
      return new Response(bytes as unknown as BodyInit, { status: 200 })
    })
    const response = await call('POST', '/api/nav/icons/capture', {
      body: { url: 'https://icons.example.com/favicon.png' },
    })
    expect(response.status).toBe(200)
    const body = await json<NavIconsResponse>(response)
    expect(body.icon).toMatchObject({ width: 48, height: 48 })
    const row = iconRow(body.icon.id)!
    expect(row).toMatchObject({
      user_id: USER_A,
      source: 'captured',
      source_url: 'https://icons.example.com/favicon.png',
      content_type: 'image/png',
    })
    expect(r2.objects.has(`nav/icons/${body.icon.id}.png`)).toBe(true)
  })

  it('reports an upstream non-2xx response as a gateway failure', async () => {
    stubFetch(() => new Response(null, { status: 404 }))
    const response = await call('POST', '/api/nav/icons/capture', {
      body: { url: 'https://icons.example.com/missing.ico' },
    })
    expect(response.status).toBe(502)
    expect(await errorCode(response)).toBe('internal')
  })
})

describe('icon delivery', () => {
  it('serves an uploaded icon to its owner with cache and ETag headers', async () => {
    const bytes = pngBytes(2, 3)
    const uploaded = await json<NavIconsResponse>(await upload(USER_A, bytes))
    const response = await call('GET', `/api/nav/icons/${uploaded.icon.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
    const etag = response.headers.get('etag')
    expect(etag).not.toBeNull()
    expect(etag!.startsWith('"')).toBe(true)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)

    const notModified = await call('GET', `/api/nav/icons/${uploaded.icon.id}`, {
      headers: { 'if-none-match': etag! },
    })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBeNull()
  })

  it('answers 404 for another user, an unknown id and a malformed id', async () => {
    const uploaded = await json<NavIconsResponse>(await upload(USER_A, pngBytes()))
    expect((await call('GET', `/api/nav/icons/${uploaded.icon.id}`, { user: USER_B })).status).toBe(404)
    expect((await call('GET', `/api/nav/icons/${'b'.repeat(26)}`)).status).toBe(404)
    expect((await call('GET', `/api/nav/icons/${'b'.repeat(24)}i`)).status).toBe(404)
  })
})

describe('link check classification', () => {
  it('classifies 2xx, 4xx and 5xx HEAD answers', async () => {
    stubFetch((url) => {
      if (url === 'https://ok.example.com/') return new Response(null, { status: 200 })
      if (url === 'https://missing.example.com/') return new Response(null, { status: 404 })
      return new Response(null, { status: 500 })
    })
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://ok.example.com/', 'https://missing.example.com/', 'https://down.example.com/'] },
    })
    expect(response.status).toBe(200)
    const body = await json<NavCheckResponse>(response)
    expect(body.results).toHaveLength(3)
    expect(body.results[0]).toMatchObject({ url: 'https://ok.example.com/', status: 200, ok: true, level: 'ok' })
    expect(body.results[1]).toMatchObject({ url: 'https://missing.example.com/', status: 404, ok: false, level: 'warning' })
    expect(body.results[2]).toMatchObject({ url: 'https://down.example.com/', status: 500, ok: false, level: 'broken', errorCode: 'http_error' })
    expect(fetchCalls.map((entry) => entry.init.method)).toEqual(['HEAD', 'HEAD', 'HEAD'])
    expect(fetchCalls[0]!.init.redirect).toBe('manual')
  })

  it('retries a 405 or 403 HEAD with GET and reports the GET answer', async () => {
    stubFetch((url, init) => {
      if (init.method === 'HEAD') return new Response(null, { status: url.includes('forbidden') ? 403 : 405 })
      return url.includes('forbidden')
        ? new Response(null, { status: 403 })
        : new Response(null, { status: 200 })
    })
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://no-head.example.com/', 'https://forbidden.example.com/'] },
    })
    expect(response.status).toBe(200)
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({ status: 200, ok: true, level: 'ok' })
    expect(body.results[1]).toMatchObject({ status: 403, ok: false, level: 'warning' })
    const calls = fetchCalls.map((entry) => `${entry.init.method} ${entry.url}`)
    expect(calls).toHaveLength(4)
    expect(calls.filter((call) => call.endsWith('https://no-head.example.com/'))).toEqual([
      'HEAD https://no-head.example.com/',
      'GET https://no-head.example.com/',
    ])
    expect(calls.filter((call) => call.endsWith('https://forbidden.example.com/'))).toEqual([
      'HEAD https://forbidden.example.com/',
      'GET https://forbidden.example.com/',
    ])
  })

  it('retries a network failure with GET before declaring the link broken', async () => {
    stubFetch((_url, init) => {
      if (init.method === 'HEAD') throw new TypeError('connection reset')
      return new Response(null, { status: 201 })
    })
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://flaky.example.com/'] },
    })
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({ status: 201, ok: true, level: 'ok' })
    expect(fetchCalls.map((entry) => entry.init.method)).toEqual(['HEAD', 'GET'])
  })

  it('reports a double timeout as broken rather than throwing', async () => {
    stubFetch(() => {
      const error = new Error('aborted')
      error.name = 'TimeoutError'
      throw error
    })
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://slow.example.com/'] },
    })
    expect(response.status).toBe(200)
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({
      url: 'https://slow.example.com/',
      status: null,
      ok: false,
      level: 'broken',
      errorCode: 'timeout',
    })
    expect(fetchCalls).toHaveLength(2)
  })

  it('follows a public redirect and reports the final URL', async () => {
    stubFetch((url) => {
      if (url === 'https://start.example.com/') {
        return new Response(null, { status: 301, headers: { location: 'https://final.example.com/home' } })
      }
      return new Response(null, { status: 200 })
    })
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://start.example.com/'] },
    })
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({
      url: 'https://start.example.com/',
      status: 200,
      ok: true,
      level: 'ok',
      finalUrl: 'https://final.example.com/home',
    })
    expect(fetchCalls.map((entry) => entry.url)).toEqual([
      'https://start.example.com/',
      'https://final.example.com/home',
    ])
  })

  it('skips a redirect into a private address without issuing the private request', async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret' } }))
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['https://public.example.com/'] },
    })
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({
      url: 'https://public.example.com/',
      status: null,
      ok: false,
      level: 'skipped',
      errorCode: 'blocked_target',
      finalUrl: 'http://10.0.0.5/secret',
    })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('https://public.example.com/')
  })

  it('skips an invalid scheme and a direct private target before fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('POST', '/api/nav/check', {
      body: { urls: ['ftp://example.com/file', 'http://127.0.0.1/'] },
    })
    expect(response.status).toBe(200)
    const body = await json<NavCheckResponse>(response)
    expect(body.results[0]).toMatchObject({ level: 'skipped', errorCode: 'invalid_url', status: null })
    expect(body.results[1]).toMatchObject({ level: 'skipped', errorCode: 'blocked_target', status: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects anonymous checks and accepts an empty batch', async () => {
    expect((await call('POST', '/api/nav/check', { user: null, body: { urls: [] } })).status).toBe(401)
    const empty = await call('POST', '/api/nav/check', { body: { urls: [] } })
    expect(empty.status).toBe(200)
    expect(await json(empty)).toEqual({ results: [] })
  })
})
