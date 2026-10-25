// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALENDAR_SCHEMA_STATEMENTS } from '../src/worker/calendar/schema'
import { createCalendarConnection } from '../src/worker/calendar/connections'
import {
  PROXY_REQUEST_MAX_BYTES,
  PROXY_RESPONSE_MAX_BYTES,
  basicAuthorization,
  proxyHeaders,
  proxyMethod,
  resolveProxyUrl,
} from '../src/worker/calendar/proxy'
import { decryptCalendarCredential, encryptCalendarCredential } from '../src/worker/lib/crypto'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { calendarSyncRoutes } from '../src/worker/routes/calendar-sync'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'c'.repeat(26)
const OTHER = 'd'.repeat(26)

const mocks = vi.hoisted(() => ({ userId: 'c'.repeat(26) }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    if (!mocks.userId) {
      const { ApiError } = await import('../src/worker/lib/errors')
      throw new ApiError(401, 'unauthenticated', 'Authentication required')
    }
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database
let env: Env

function makeVault(): DurableObjectNamespace {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
}

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/calendar', calendarSyncRoutes)

beforeEach(() => {
  vi.unstubAllGlobals()
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALENDAR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, {
    CREDENTIAL_VAULT: makeVault(),
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
  })
  mocks.userId = USER
})

async function request(path: string, init?: RequestInit, bindings: Env = env): Promise<Response> {
  return app.request(`/api/calendar${path}`, init, bindings)
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function seedBasic(userId = USER): Promise<string> {
  const id = newId()
  const ciphertext = await encryptCalendarCredential(env, id, {
    kind: 'basic',
    username: 'alice',
    password: 'synthetic-password',
  })
  await createCalendarConnection(db, userId, {
    id,
    kind: 'caldav',
    label: 'Home server',
    baseUrl: 'https://dav.example.com/',
    calendarHomeUrl: 'https://dav.example.com/calendars/alice/',
    username: 'alice',
    scope: 'write',
    writable: true,
    credential: { kind: 'basic', ciphertext },
  })
  return id
}

async function seedGoogle(userId = USER): Promise<string> {
  const id = newId()
  const ciphertext = await encryptCalendarCredential(env, id, {
    kind: 'oauth',
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/calendar',
    tokenType: 'Bearer',
  })
  await createCalendarConnection(db, userId, {
    id,
    kind: 'google',
    label: 'Google Calendar',
    baseUrl: 'https://www.googleapis.com/calendar/v3/',
    calendarHomeUrl: 'https://www.googleapis.com/calendar/v3/',
    username: null,
    scope: 'write',
    writable: true,
    credential: { kind: 'oauth', ciphertext },
  })
  return id
}

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return responder(url, init)
  })
  return calls
}

describe('proxy address resolution', () => {
  const base = 'https://dav.example.com/calendars/alice/'

  it('accepts a home-relative path and a root path that starts with the home', () => {
    expect(resolveProxyUrl(base, 'work/event.ics').toString()).toBe('https://dav.example.com/calendars/alice/work/event.ics')
    expect(resolveProxyUrl(base, '/calendars/alice/work/event.ics').toString())
      .toBe('https://dav.example.com/calendars/alice/work/event.ics')
    expect(resolveProxyUrl('https://www.googleapis.com/calendar/v3/', '/calendar/v3/users/me/calendarList?pageToken=a%2Fb').toString())
      .toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList?pageToken=a%2Fb')
  })

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a parent segment', '../bob/calendar'],
    ['an encoded parent segment', '%2e%2e/bob/calendar'],
    ['a double-encoded parent segment', '%252e%252e/bob/calendar'],
    ['a triple-encoded parent segment', '%25252e%25252e/bob/calendar'],
    ['an encoded slash', 'work%2F..%2F..%2Fbob/'],
    ['a backslash', 'work\\..\\bob'],
    ['a control character', 'work/\u0007calendar'],
    ['a fragment', 'work/#fragment'],
    ['another collection', '/calendars/bob/calendar'],
    ['a sibling collection', '/calendars/alice-other/calendar'],
  ])('refuses %s', (_label, path) => {
    expect(() => resolveProxyUrl(base, path)).toThrow()
  })

  it('keeps an encoded question mark inside the pathname', () => {
    const target = resolveProxyUrl(base, 'work/a%3Fb.ics?depth=1')
    expect(target.pathname).toBe('/calendars/alice/work/a%3Fb.ics')
    expect(target.search).toBe('?depth=1')
  })
})

describe('proxy method and header allowlists', () => {
  it('allows only the provider methods', () => {
    expect(proxyMethod('caldav', 'propfind')).toBe('PROPFIND')
    expect(proxyMethod('caldav', 'REPORT')).toBe('REPORT')
    expect(proxyMethod('caldav', 'PUT')).toBe('PUT')
    expect(proxyMethod('caldav', 'DELETE')).toBe('DELETE')
    expect(() => proxyMethod('caldav', 'GET')).toThrow()
    expect(() => proxyMethod('caldav', 'POST')).toThrow()
    expect(proxyMethod('google', 'GET')).toBe('GET')
    expect(proxyMethod('google', 'PATCH')).toBe('PATCH')
    expect(proxyMethod('outlook', 'POST')).toBe('POST')
    expect(() => proxyMethod('google', 'PROPFIND')).toThrow()
  })

  it('drops Authorization, Cookie and Host and canonicalizes the allowed headers', () => {
    const headers = proxyHeaders({
      authorization: 'Bearer injected',
      cookie: 'session=injected',
      host: 'evil.example',
      Depth: '1',
      'content-type': 'application/xml',
      'if-match': '"etag"',
      'if-none-match': '"other"',
      prefer: 'return=minimal',
      range: 'bytes=0-10',
      'x-custom': 'dropped',
    })
    expect(headers).toEqual({
      Depth: '1',
      'Content-Type': 'application/xml',
      'If-Match': '"etag"',
      'If-None-Match': '"other"',
      Prefer: 'return=minimal',
      Range: 'bytes=0-10',
    })
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Cookie).toBeUndefined()
    expect(headers.Host).toBeUndefined()
  })

  it('rejects a header value that could smuggle a second header', () => {
    expect(() => proxyHeaders({ 'If-Match': '"ok"\r\nAuthorization: Bearer x' })).toThrow()
  })
})

describe('proxy route', () => {
  it('injects Basic auth, forwards only allowlisted headers, and returns only safe response headers', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => new Response('<multistatus/>', {
      status: 207,
      headers: {
        etag: '"v1"',
        'content-type': 'application/xml',
        location: 'https://dav.example.com/calendars/alice/work/event.ics',
        'set-cookie': 'stolen=1',
        'www-authenticate': 'Basic realm="secret"',
      },
    }))
    const response = await request(`/connections/${id}/proxy`, json({
      method: 'PROPFIND',
      path: 'work/',
      headers: {
        authorization: 'Bearer injected',
        cookie: 'stolen=1',
        host: 'evil.example',
        Depth: '1',
        'If-Match': '"v1"',
      },
      body: '<propfind/>',
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { status: number; headers: Record<string, string>; body: string }
    expect(body.status).toBe(207)
    expect(body.body).toBe('<multistatus/>')
    expect(body.headers).toEqual({
      etag: '"v1"',
      'content-type': 'application/xml',
      location: 'https://dav.example.com/calendars/alice/work/event.ics',
    })
    expect(body.headers['set-cookie']).toBeUndefined()
    expect(body.headers['www-authenticate']).toBeUndefined()
    expect(calls).toHaveLength(1)
    const forwarded = calls[0]!.init?.headers as Record<string, string>
    expect(forwarded.Authorization).toBe(basicAuthorization('alice', 'synthetic-password'))
    expect(forwarded.Authorization).not.toContain('injected')
    expect(forwarded.Depth).toBe('1')
    expect(forwarded['If-Match']).toBe('"v1"')
    expect(forwarded.Cookie).toBeUndefined()
    expect(forwarded.Host).toBeUndefined()
    expect(forwarded['Content-Type']).toBe('application/xml; charset=utf-8')
    expect(calls[0]!.url).toBe('https://dav.example.com/calendars/alice/work/')
    expect(calls[0]!.init?.redirect).toBe('manual')
  })

  it('injects the stored OAuth token for Google and allows the API methods', async () => {
    const id = await seedGoogle()
    const calls = stubFetch(() => Response.json({ items: [] }))
    const response = await request(`/connections/${id}/proxy`, json({
      method: 'GET',
      path: '/calendar/v3/users/me/calendarList',
    }))
    expect(response.status).toBe(200)
    expect(calls[0]!.url).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList')
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer access-token-value')
  })

  it('refuses an absolute URL, a traversal, and a path outside the connection', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => Response.json({}))
    for (const path of ['https://evil.example/x', '../bob/', '/calendars/bob/', 'work\\..\\bob']) {
      const response = await request(`/connections/${id}/proxy`, json({ method: 'PROPFIND', path }))
      expect(response.status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses methods outside the provider list', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => Response.json({}))
    const response = await request(`/connections/${id}/proxy`, json({ method: 'GET', path: 'work/' }))
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('caps the request body at two mebibytes', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => Response.json({}))
    const response = await request(`/connections/${id}/proxy`, json({
      method: 'PUT',
      path: 'work/event.ics',
      body: 'x'.repeat(PROXY_REQUEST_MAX_BYTES + 1),
    }))
    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('caps the response body at eight mebibytes', async () => {
    const id = await seedBasic()
    stubFetch(() => new Response('x'.repeat(PROXY_RESPONSE_MAX_BYTES + 1), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))
    const response = await request(`/connections/${id}/proxy`, json({
      method: 'PROPFIND',
      path: 'work/',
      body: '<propfind/>',
    }))
    expect(response.status).toBe(502)
  })

  it('refuses a redirect instead of following it', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => new Response('', {
      status: 302,
      headers: { location: 'https://evil.example/' },
    }))
    const response = await request(`/connections/${id}/proxy`, json({
      method: 'PROPFIND',
      path: 'work/',
      body: '<propfind/>',
    }))
    expect(response.status).toBe(502)
    expect(calls).toHaveLength(1)
  })

  it('answers 404 for another account and for a connection with no credential', async () => {
    const other = await seedBasic(OTHER)
    expect((await request(`/connections/${other}/proxy`, json({ method: 'PROPFIND', path: 'work/' }))).status).toBe(404)

    const id = await seedBasic()
    sqlite.prepare('DELETE FROM calendar_credentials WHERE user_id = ? AND connection_id = ?').run(USER, id)
    const response = await request(`/connections/${id}/proxy`, json({ method: 'PROPFIND', path: 'work/' }))
    expect(response.status).toBe(409)
  })

  it('opens a breaker after five consecutive upstream failures', async () => {
    const id = await seedBasic()
    const calls = stubFetch(() => { throw new Error('synthetic upstream outage') })
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(`/connections/${id}/proxy`, json({ method: 'PROPFIND', path: 'work/' }))
      expect(response.status).toBe(502)
    }
    const open = await request(`/connections/${id}/proxy`, json({ method: 'PROPFIND', path: 'work/' }))
    expect(open.status).toBe(503)
    expect(open.headers.get('retry-after')).toBe('60')
    expect(calls).toHaveLength(5)
  })

  it('does not let a client move the base to another host for a Google connection', async () => {
    const id = await seedGoogle()
    sqlite.prepare('UPDATE calendar_connections SET calendar_home_url = ? WHERE user_id = ? AND id = ?')
      .run('https://evil.example/calendar/v3/', USER, id)
    const calls = stubFetch(() => Response.json({}))
    const response = await request(`/connections/${id}/proxy`, json({ method: 'GET', path: '/calendar/v3/users/me/calendarList' }))
    expect(response.status).toBe(500)
    expect(calls).toHaveLength(0)
  })
})

describe('stored credentials stay sealed', () => {
  it('never stores a readable password in D1', async () => {
    const id = await seedBasic()
    const row = sqlite.prepare('SELECT ciphertext FROM calendar_credentials WHERE user_id = ? AND connection_id = ?')
      .get(USER, id) as { ciphertext: string }
    expect(row.ciphertext).not.toContain('synthetic-password')
    await expect(decryptCalendarCredential(env, id, row.ciphertext)).resolves.toMatchObject({
      kind: 'basic',
      password: 'synthetic-password',
    })
  })
})
