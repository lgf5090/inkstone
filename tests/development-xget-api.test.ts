// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { hashToken } from '../src/worker/lib/session-store'
import { requireClientHeader } from '../src/worker/middleware/auth'
import { DEVELOPMENT_XGET_SCHEMA_STATEMENTS } from '../src/worker/development/xget/schema'
import { developmentXgetRoutes } from '../src/worker/routes/development-xget'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const OWNER = 'owner-user'
const MEMBER = 'member-user'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    const user = c.req.header('x-test-user')
    if (user) {
      const role = user === OWNER ? 'owner' : 'member'
      c.set('userId', user)
      c.set('user', {
        id: user,
        username: user,
        login: user,
        name: user,
        avatarUrl: '',
        role,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/development/xget', developmentXgetRoutes)
  return instance
}

interface CallOptions {
  user?: string | null
  body?: unknown
  headers?: Record<string, string>
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.user !== null) headers['x-test-user'] = options.user ?? OWNER
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return await app.fetch(
    new Request(`https://inkstone.test${path.startsWith('/api/') ? path : `/api/development/xget${path}`}`, {
      method,
      headers,
      body,
    }),
    env,
  )
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_XGET_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db)
  app = buildApp()
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('Xget settings API', () => {
  it('returns defaults and lets the owner save a bounded config', async () => {
    const initial = await call('GET', '/settings')
    expect(initial.status).toBe(200)
    const initialBody = await readJson<{ data: { platform_count: number; config: { timeout_seconds: number }; can_manage: boolean } }>(initial)
    expect(initialBody.data.platform_count).toBe(84)
    expect(initialBody.data.config.timeout_seconds).toBe(30)
    expect(initialBody.data.can_manage).toBe(true)

    const saved = await call('PUT', '/settings', {
      body: {
        timeout_seconds: 5,
        max_retries: 2,
        retry_delay_ms: 250,
        cache_duration: 120,
        allowed_methods: ['get', 'post', 'get', 'TRACE'],
        allowed_origins: ['https://Example.com', 'javascript:alert(1)', '*'],
        max_path_length: 4096,
      },
    })
    expect(saved.status).toBe(200)
    const savedBody = await readJson<{ data: { config: Record<string, unknown> } }>(saved)
    expect(savedBody.data.config.timeout_seconds).toBe(5)
    expect(savedBody.data.config.allowed_methods).toEqual(['GET', 'POST'])
    expect(savedBody.data.config.allowed_origins).toEqual(['*'])
    expect(savedBody.data.config.max_path_length).toBe(4096)

    const reread = await readJson<{ data: { config: { timeout_seconds: number } } }>(await call('GET', '/settings'))
    expect(reread.data.config.timeout_seconds).toBe(5)
  })

  it('rejects a member write and malformed bodies', async () => {
    expect((await call('PUT', '/settings', { user: MEMBER, body: { timeout_seconds: 5 } })).status).toBe(403)
    expect((await call('PUT', '/settings', { body: { timeout_seconds: 'five' } })).status).toBe(400)
    expect((await call('PUT', '/settings', { body: { allowed_methods: 'GET' } })).status).toBe(400)
  })

  it('rejects an invalid origin instead of widening the allow list', async () => {
    const rejected = await call('PUT', '/settings', { body: { allowed_origins: ['not-a-url'] } })
    expect(rejected.status).toBe(400)
    const unchanged = await readJson<{ data: { config: { allowed_origins: string[] } } }>(
      await call('GET', '/settings'),
    )
    expect(unchanged.data.config.allowed_origins).toEqual(['*'])

    const cleared = await call('PUT', '/settings', { body: { allowed_origins: [] } })
    expect(cleared.status).toBe(200)
    const clearedBody = await readJson<{ data: { config: { allowed_origins: string[] } } }>(cleared)
    expect(clearedBody.data.config.allowed_origins).toEqual([])
  })

  it('stores only a token hash, reports ON/OFF and clears it with an empty value', async () => {
    const set = await call('PUT', '/settings/token', { body: { token: 'secret-token-123' } })
    expect(set.status).toBe(200)
    expect((await readJson<{ data: { has_proxy_token: boolean } }>(set)).data.has_proxy_token).toBe(true)

    const row = sqlite.prepare('SELECT proxy_token_hash FROM development_xget_settings WHERE id = 1').get() as {
      proxy_token_hash: string
    }
    expect(row.proxy_token_hash).toBe(await hashToken('secret-token-123'))
    expect(row.proxy_token_hash).not.toContain('secret-token-123')

    const read = await readJson<{ data: { has_proxy_token: boolean } }>(await call('GET', '/settings'))
    expect(read.data.has_proxy_token).toBe(true)

    const clear = await call('PUT', '/settings/token', { body: { token: '' } })
    expect((await readJson<{ data: { has_proxy_token: boolean } }>(clear)).data.has_proxy_token).toBe(false)
  })

  it('validates token length and character set', async () => {
    expect((await call('PUT', '/settings/token', { body: { token: 'short' } })).status).toBe(400)
    expect((await call('PUT', '/settings/token', { body: { token: 'has space 123' } })).status).toBe(400)
  })

  it('resolves a proxy path for the self-test and rejects a path without a slash', async () => {
    const ok = await call('POST', '/settings/test', { body: { path: '/gh/microsoft/vscode' } })
    expect(ok.status).toBe(200)
    const body = await readJson<{ data: { platform: string; target_url: string } }>(ok)
    expect(body.data.platform).toBe('gh')
    expect(body.data.target_url).toBe('https://github.com/microsoft/vscode')

    const bad = await call('POST', '/settings/test', { body: { path: 'gh/microsoft' } })
    expect(bad.status).toBe(400)
  })

  it('requires a session for management endpoints', async () => {
    expect((await call('GET', '/settings', { user: null })).status).toBe(401)
    expect((await call('GET', '/stats/summary', { user: null })).status).toBe(401)
  })
})

describe('Xget proxy API', () => {
  it('proxies an anonymous request, records one stat and keeps the engine headers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('hello', {
        status: 200,
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=60' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', {
      user: null,
      headers: { 'x-xget-token': '' },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const stat = sqlite
      .prepare('SELECT platform, ok, count FROM development_xget_stats')
      .get() as { platform: string; ok: number; count: number }
    expect(stat.platform).toBe('gh')
    expect(stat.ok).toBe(1)
    expect(stat.count).toBe(1)
  })

  it('enforces the stored token for anonymous clients but lets a signed-in session through', async () => {
    await call('PUT', '/settings/token', { body: { token: 'token-12345678' } })
    const missing = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', { user: null })
    expect(missing.status).toBe(401)

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const withQuery = await call(
      'GET',
      '/api/development/xget/gh/owner/repo/archive/main.zip?access_token=token-12345678',
      { user: null },
    )
    expect(withQuery.status).toBe(200)
    const withHeader = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', {
      user: null,
      headers: { 'x-xget-token': 'token-12345678' },
    })
    expect(withHeader.status).toBe(200)
    const withSession = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', {
      user: OWNER,
    })
    expect(withSession.status).toBe(200)
  })

  it('lets a valid CORS preflight through the token gate', async () => {
    await call('PUT', '/settings/token', { body: { token: 'token-12345678' } })
    const preflight = await call('OPTIONS', '/api/development/xget/ip/openai/v1/models', {
      user: null,
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-xget-token, content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-xget-token')

    const actual = await call('POST', '/api/development/xget/ip/openai/v1/models', {
      user: null,
      body: {},
    })
    expect(actual.status).toBe(401)
  })

  it('can close anonymous access without a token', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const open = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', { user: null })
    expect(open.status).toBe(200)

    const saved = await call('PUT', '/settings', { body: { allow_anonymous: false } })
    expect(saved.status).toBe(200)
    const savedBody = await readJson<{ data: { config: { allow_anonymous: boolean } } }>(saved)
    expect(savedBody.data.config.allow_anonymous).toBe(false)

    const closed = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', { user: null })
    expect(closed.status).toBe(401)

    const session = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', { user: OWNER })
    expect(session.status).toBe(200)
  })

  it('does not accept an Authorization bearer as the proxy token', async () => {
    await call('PUT', '/settings/token', { body: { token: 'token-12345678' } })
    const response = await call('GET', '/api/development/xget/gh/owner/repo/archive/main.zip', {
      user: null,
      headers: { authorization: 'Bearer token-12345678' },
    })
    expect(response.status).toBe(401)
  })

  it('never forwards the proxy token to the upstream', async () => {
    await call('PUT', '/settings/token', { body: { token: 'token-12345678' } })

    let outgoingUrl = ''
    let outgoingHeaders = new Headers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      outgoingUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      outgoingHeaders = new Headers(init?.headers as HeadersInit)
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const viaQuery = await call(
      'GET',
      '/api/development/xget/ip/openai/v1/models?access_token=token-12345678&keep=1',
      { user: null },
    )
    expect(viaQuery.status).toBe(200)
    expect(outgoingUrl).toContain('keep=1')
    expect(outgoingUrl).not.toContain('access_token')

    const viaHeader = await call('GET', '/api/development/xget/ip/openai/v1/models', {
      user: null,
      headers: { 'x-xget-token': 'token-12345678' },
    })
    expect(viaHeader.status).toBe(200)
    expect(outgoingHeaders.get('x-xget-token')).toBeNull()

    // A signed-in session bypasses the proxy token, so an upstream access_token stays a query argument.
    const sessionUpstream = await call(
      'GET',
      '/api/development/xget/ip/openai/v1/models?access_token=upstream-key&keep=1',
      { user: OWNER },
    )
    expect(sessionUpstream.status).toBe(200)
    expect(outgoingUrl).toContain('access_token=upstream-key')
  })

  it('does not require the Inkstone client header for proxy POSTs but still requires it for management', async () => {
    const instance = new Hono<AppBindings>()
    instance.onError((error, c) => errorResponse(c, error))
    instance.use('/api/*', requireClientHeader)
    instance.post('/api/development/xget/gh/x', (c) => c.text('proxy'))
    instance.put('/api/development/xget/settings', (c) => c.text('settings'))
    const proxy = await instance.fetch(new Request('https://inkstone.test/api/development/xget/gh/x', { method: 'POST' }))
    expect(proxy.status).toBe(200)
    const settings = await instance.fetch(
      new Request('https://inkstone.test/api/development/xget/settings', { method: 'PUT' }),
    )
    expect(settings.status).toBe(403)
  })
})

describe('Xget stats API', () => {
  it('returns an empty summary, then the aggregated counts', async () => {
    const empty = await readJson<{ data: { total: number; platforms: unknown[] } }>(
      await call('GET', '/stats/summary?days=7'),
    )
    expect(empty.data.total).toBe(0)
    expect(empty.data.platforms).toEqual([])

    sqlite
      .prepare('INSERT INTO development_xget_stats (day, platform, ok, count) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString().slice(0, 10), 'gh', 1, 3)
    sqlite
      .prepare('INSERT INTO development_xget_stats (day, platform, ok, count) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString().slice(0, 10), 'gh', 0, 1)

    const summary = await readJson<{ data: { total: number; ok: number; platformCount: number; platforms: { platform: string; pct: number }[] } }>(
      await call('GET', '/stats/summary?days=all'),
    )
    expect(summary.data.total).toBe(4)
    expect(summary.data.ok).toBe(3)
    expect(summary.data.platformCount).toBe(1)
    expect(summary.data.platforms[0]).toMatchObject({ platform: 'gh', pct: 100 })
  })

  it('rejects an invalid range', async () => {
    expect((await call('GET', '/stats/summary?days=-1')).status).toBe(400)
    expect((await call('GET', '/stats/summary?days=abc')).status).toBe(400)
  })
})
