// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS } from '../src/worker/development/api-tester/schema'
import { oauthRoutes } from '../src/worker/development/api-tester/oauth'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import type { OAuthTokenResponse } from '../src/shared/development/api-tester/types'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-oauth'
const TOKEN_URL = 'https://auth.example.com/oauth/token'

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown }
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let app: Hono<AppBindings>
let warn: MockInstance<typeof console.warn>

function buildApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    const user = c.req.header('x-test-user')
    if (user) c.set('userId', user)
    await next()
  })
  instance.route('/api/development/api-tester', oauthRoutes)
  return instance
}

interface CallOptions {
  user?: string | null
  body?: unknown
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.user !== null) headers['x-test-user'] = options.user ?? USER
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return await app.fetch(
    new Request(`http://localhost/api/development/api-tester${path}`, { method, headers, body }),
    env,
  )
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec(`CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL,
    locked_until INTEGER
  )`)
  db = makeD1(sqlite)
  env = testBindings(db)
  app = buildApp()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  sqlite.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /oauth2/token', () => {
  it('exchanges an authorization code as form data and maps the token response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: {
        tokenUrl: TOKEN_URL,
        code: 'code-1',
        redirectUri: 'https://app.example.com/callback',
        clientId: 'client-1',
        clientSecret: 'secret-1',
      },
    })

    expect(response.status).toBe(200)
    expect(await bodyOf<OAuthTokenResponse>(response)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'read write',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TOKEN_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.redirect).toBe('manual')
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://app.example.com/callback',
      client_id: 'client-1',
      client_secret: 'secret-1',
    })
  })

  it('refreshes a token without leaking authorization-code fields into the form', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'access-2', token_type: 'Bearer', expires_in: '900' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: {
        tokenUrl: TOKEN_URL,
        grantType: 'refresh_token',
        refreshToken: 'refresh-2',
        code: 'must-not-be-sent',
        clientId: 'client-2',
      },
    })

    expect(response.status).toBe(200)
    expect(await bodyOf<OAuthTokenResponse>(response)).toEqual({
      accessToken: 'access-2',
      tokenType: 'Bearer',
      expiresIn: 900,
    })
    const form = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-2')
    expect(form.has('code')).toBe(false)
    expect(form.has('redirect_uri')).toBe(false)
    expect(form.get('client_id')).toBe('client-2')
  })

  it('returns a 200 envelope with an error when the endpoint does not answer with JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    )

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: TOKEN_URL, code: 'code-1' },
    })

    expect(response.status).toBe(200)
    const body = await bodyOf<OAuthTokenResponse>(response)
    expect(body.error).toContain('non-JSON')
    expect(body.error).toContain('502')
    expect(body.accessToken).toBeUndefined()
  })

  it('refuses to follow a redirect instead of letting the hop pick a new target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 303, headers: { location: 'http://127.0.0.1:8080/token' } }),
      ),
    )

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: TOKEN_URL, code: 'code-1' },
    })

    expect(response.status).toBe(502)
    const body = await bodyOf<ErrorEnvelope>(response)
    expect(body.error.code).toBe('apitester_token_redirect')
  })

  it('refuses a token response larger than the cap instead of buffering it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ access_token: 'x'.repeat(1_100_000), token_type: 'Bearer' }),
      ),
    )

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: TOKEN_URL, code: 'code-1' },
    })

    expect(response.status).toBe(200)
    const body = await bodyOf<OAuthTokenResponse>(response)
    expect(body.accessToken).toBeUndefined()
    expect(body.error).toContain('1048576')
  })

  it('passes an upstream OAuth error and description through unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: 'invalid_grant', error_description: 'The authorization code expired' },
          400,
        ),
      ),
    )

    const response = await call('POST', '/oauth2/token', {
      body: {
        tokenUrl: TOKEN_URL,
        code: 'expired',
        clientSecret: 'super-secret-value',
      },
    })

    expect(response.status).toBe(200)
    expect(await bodyOf<OAuthTokenResponse>(response)).toEqual({
      error: 'invalid_grant',
      errorDescription: 'The authorization code expired',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-value')
  })

  it('refuses private token endpoints before any request is made', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: 'http://127.0.0.1:8080/token', code: 'code-1' },
    })

    expect(response.status).toBe(403)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_blocked_target')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a token URL that is not http or https', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: 'ftp://example.com/token', code: 'code-1' },
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an aborted exchange to a 502 timeout', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: TOKEN_URL, code: 'code-1' },
    })

    expect(response.status).toBe(502)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('apitester_request_timeout')
  })

  it('enforces the per-user exchange budget', async () => {
    sqlite
      .prepare('INSERT INTO login_attempts (key, fails, last_fail_at, locked_until) VALUES (?, 20, ?, NULL)')
      .run(`apitester-oauth:${USER}`, Date.now())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await call('POST', '/oauth2/token', {
      body: { tokenUrl: TOKEN_URL, code: 'code-1' },
    })

    expect(response.status).toBe(429)
    expect((await bodyOf<ErrorEnvelope>(response)).error.code).toBe('too_many_attempts')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
