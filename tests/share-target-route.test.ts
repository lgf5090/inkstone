// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { shareTargetRoutes } from '../src/worker/routes/share-target'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: { DB: D1Database }

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'user-a', 'hash', 'user-a', '', '', 'owner', '{}', 1, 1)`,
  ).run(USER)
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/share-target', shareTargetRoutes)
})

function request(fields: Record<string, string>, origin = 'http://localhost', contentLength?: number, target?: 'todo'): Promise<Response> {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const headers = new Headers({ origin })
  if (contentLength !== undefined) headers.set('content-length', String(contentLength))
  return Promise.resolve(app.fetch(new Request(`http://localhost/share-target${target ? `?target=${target}` : ''}`, {
    method: 'POST',
    headers,
    body: form,
  }), env as never, ctx))
}

describe('PWA share target', () => {
  it('creates a note from shared text and URL, then redirects to it', async () => {
    const response = await request({ title: 'Shared page', text: 'Worth reading', url: 'https://example.com/article' })
    expect(response.status).toBe(303)
    const location = response.headers.get('location')!
    expect(location).toMatch(/^\/n\/[a-z0-9]{26}$/)
    const id = location.slice(3)
    expect(sqlite.prepare('SELECT title, content, user_id FROM notes WHERE id = ?').get(id))
      .toMatchObject({ title: 'Shared page', content: 'Worth reading\n\nhttps://example.com/article', user_id: USER })
  })

  it('creates an editable task from shared text and URL when the todo target is named', async () => {
    const response = await request({ title: 'Read later', text: 'Worth reading', url: 'https://example.com/article' }, 'http://localhost', undefined, 'todo')
    expect(response.status).toBe(303)
    const location = response.headers.get('location')!
    expect(location).toMatch(/^\/todo\/[a-z0-9]{26}$/)
    const id = location.slice(6)
    expect(sqlite.prepare('SELECT title, description, user_id FROM todos_tasks WHERE id = ?').get(id))
      .toMatchObject({ title: 'Read later', description: 'Worth reading\n\nhttps://example.com/article', user_id: USER })
  })

  it('uses a shared URL as the title when no title or text is supplied', async () => {
    const response = await request({ url: 'https://example.com/url-only' })
    expect(response.status).toBe(303)
    const id = response.headers.get('location')!.slice(3)
    expect(sqlite.prepare('SELECT title FROM notes WHERE id = ?').get(id))
      .toMatchObject({ title: 'https://example.com/url-only' })
  })

  it('refuses empty shared content', async () => {
    expect((await request({ title: 'Empty' })).status).toBe(400)
  })

  it('refuses a cross-origin share target submission', async () => {
    expect((await request({ text: 'untrusted' }, 'https://evil.example')).status).toBe(403)
  })

  it('refuses an oversized shared body', async () => {
    expect((await request({ text: 'x'.repeat(70 * 1024) }, 'http://localhost', 80 * 1024)).status).toBe(413)
  })

  it('requires an authenticated session', async () => {
    const anonymous = new Hono<AppBindings>()
    anonymous.onError((err, c) => errorResponse(c, err))
    anonymous.use('*', async (c, next) => {
      c.set('database', { ftsEnabled: false })
      await next()
    })
    anonymous.route('/share-target', shareTargetRoutes)
    const form = new FormData()
    form.set('text', 'private')
    const response = await anonymous.fetch(new Request('http://localhost/share-target', { method: 'POST', body: form }), env as never, ctx)
    expect(response.status).toBe(401)
  })
})
