// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLIENT_HEADER } from '../src/shared/constants'
import { errorResponse } from '../src/worker/lib/errors'
import { requireClientHeader } from '../src/worker/middleware/auth'
import { toolsShortlinksRoutes } from '../src/worker/routes/tools-shortlinks'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import type { AppBindings, Env } from '../src/worker/env'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-owner'
const SESSION_HEADER = 'x-test-session'
const CLIENT_HEADER_MESSAGE = `Missing client identification header. Web clients must send ${CLIENT_HEADER}: 1`

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('/api/*', requireClientHeader)
app.use('/api/*', async (c, next) => {
  const userId = c.req.header(SESSION_HEADER)
  if (userId) c.set('userId', userId)
  await next()
})
app.route('/api/tools/shortlinks', toolsShortlinksRoutes)
app.post('/api/notes', (c) => c.json({ ok: true }))

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

interface CallOptions {
  session?: boolean
  headers?: Record<string, string>
  body?: unknown
}

function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.session !== false) headers[SESSION_HEADER] = USER
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env))
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function apiKey(scope: 'read' | 'write' = 'write'): Promise<string> {
  const store = new ShortlinksStore(env.DB, USER)
  return (await store.createApiKey('external client', scope)).apiKey
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

describe('Shortlinks API keys from external clients', () => {
  it('writes with only a bearer key: no session, no client header', async () => {
    const key = await apiKey('write')

    const create = await call('POST', '/api/tools/shortlinks/links', {
      session: false,
      headers: bearer(key),
      body: { url: 'https://example.com/via-key', custom_slug: 'via-key', label: 'External' },
    })
    expect(create.status).toBe(200)
    const created = (await json<{ data: { id: number; slugs: Array<{ slug: string }> } }>(create)).data
    expect(created.slugs[0]?.slug).toBe('via-key')

    const update = await call('PATCH', `/api/tools/shortlinks/links/${created.id}`, {
      session: false,
      headers: bearer(key),
      body: { label: 'Renamed from a script' },
    })
    expect(update.status).toBe(200)

    const remove = await call('DELETE', `/api/tools/shortlinks/links/${created.id}`, {
      session: false,
      headers: bearer(key),
    })
    expect(remove.status).toBe(200)
  })

  it('keeps read keys read-only and rejects unknown keys', async () => {
    const readKey = await apiKey('read')

    const list = await call('GET', '/api/tools/shortlinks/links', {
      session: false,
      headers: bearer(readKey),
    })
    expect(list.status).toBe(200)

    const write = await call('POST', '/api/tools/shortlinks/links', {
      session: false,
      headers: bearer(readKey),
      body: { url: 'https://example.com/read-key-write' },
    })
    expect(write.status).toBe(403)
    const denied = await json<{ error: { code: string } }>(write)
    expect(denied.error.code).toBe('forbidden')

    const unknown = await call('POST', '/api/tools/shortlinks/links', {
      session: false,
      headers: { authorization: 'Bearer sl_deadbeef' },
      body: { url: 'https://example.com/unknown-key' },
    })
    expect(unknown.status).toBe(401)
    expect((await json<{ error: { code: string } }>(unknown)).error.code).toBe('unauthenticated')
  })

  it('still requires the client header for session writes', async () => {
    const create = await call('POST', '/api/tools/shortlinks/links', {
      body: { url: 'https://example.com/session-no-header' },
    })
    expect(create.status).toBe(403)
    expect(await create.json()).toEqual({
      error: { code: 'forbidden', message: CLIENT_HEADER_MESSAGE },
    })
  })

  it('does not exempt the key shape outside the shortlinks prefix', async () => {
    const key = await apiKey('write')

    const bare = await call('POST', '/api/notes', { session: false, headers: bearer(key) })
    expect(bare.status).toBe(403)
    expect(await json<{ error: { message: string } }>(bare)).toMatchObject({
      error: { message: CLIENT_HEADER_MESSAGE },
    })

    const withHeader = await call('POST', '/api/notes', {
      session: false,
      headers: { ...bearer(key), [CLIENT_HEADER]: '1' },
    })
    expect(withHeader.status).toBe(200)
  })

  it('does not exempt a bearer that is not a shortlink key', async () => {
    const noHeader = await call('POST', '/api/tools/shortlinks/links', {
      session: false,
      headers: { authorization: 'Bearer memo_pat_other-module' },
      body: { url: 'https://example.com/foreign-bearer' },
    })
    expect(noHeader.status).toBe(403)
    expect(await json<{ error: { message: string } }>(noHeader)).toMatchObject({
      error: { message: CLIENT_HEADER_MESSAGE },
    })
  })
})
