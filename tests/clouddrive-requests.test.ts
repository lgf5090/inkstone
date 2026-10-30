// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { clouddrivePublicRequestRoutes } from '../src/worker/clouddrive/routes-requests'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let db: D1Database
let r2: TestR2Bucket
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  r2 = testR2Bucket()
  env = testBindings(db, { FILES: r2 })
})

function appFor(userId: string | null): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    if (userId) {
      c.set('userId', userId)
      c.set('user', { id: userId, username: 'tester', login: 'tester', name: 'Tester', avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '{}' })
    }
    await next()
  })
  app.route('/api/clouddrive', clouddriveRoutes)
  app.route('/api/public/clouddrive', clouddrivePublicRequestRoutes)
  return app
}

async function call(
  userId: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await appFor(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function publicCall(method: string, path: string, init: RequestInit = {}) {
  const response = await appFor(null).fetch(new Request(`http://localhost${path}`, { method, ...init }), env)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function folder(path: string): Promise<void> {
  const created = await call(USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: path.replace(/^\//, '') })
  expect(created.status).toBe(201)
}

describe('CloudDrive file requests', () => {
  it('creates a password link, accepts an upload and counts it', async () => {
    await folder('inbox')
    const created = await call(USER, 'POST', '/api/clouddrive/requests', {
      name: 'Homework',
      targetPath: '/inbox',
      password: 'correct horse',
      maxFiles: 2,
      maxBytes: 1000,
      maxFileBytes: 500,
    })
    expect(created.status).toBe(201)
    const request = created.body.request as { slug: string; url: string; hasPassword: boolean }
    expect(request.hasPassword).toBe(true)
    expect(request.url).toBe(`/r/${request.slug}`)

    const wrong = await publicCall('POST', `/api/public/clouddrive/requests/${request.slug}/verify`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(wrong.status).toBe(401)
    const right = await publicCall('POST', `/api/public/clouddrive/requests/${request.slug}/verify`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct horse' }),
    })
    expect(right.status).toBe(200)

    const locked = await publicCall('POST', `/api/public/clouddrive/requests/${request.slug}/upload?name=notes.txt`, {
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(locked.status).toBe(401)

    const uploaded = await publicCall('POST', `/api/public/clouddrive/requests/${request.slug}/upload?name=notes.txt`, {
      headers: { 'content-type': 'text/plain', 'x-clouddrive-request-password': 'correct horse' },
      body: 'hello',
    })
    expect(uploaded.status).toBe(200)
    expect(uploaded.body).toMatchObject({ ok: true, name: 'notes.txt', size: 5 })

    const info = await publicCall('GET', `/api/public/clouddrive/requests/${request.slug}`)
    expect(info.body).toMatchObject({ receivedFiles: 1, receivedBytes: 5 })

    const listing = await call(USER, 'GET', '/api/clouddrive/files?path=%2Finbox')
    const entries = listing.body as { files: { name: string; size: number }[] }
    expect(entries.files.map((file) => ({ name: file.name, size: file.size }))).toEqual([{ name: 'notes.txt', size: 5 }])
    expect(r2.objects.size).toBe(1)
  })

  it('enforces size, type and remaining-file limits', async () => {
    await folder('drop')
    const created = await call(USER, 'POST', '/api/clouddrive/requests', {
      name: 'Small',
      targetPath: '/drop',
      maxFiles: 1,
      maxBytes: 20,
      maxFileBytes: 10,
    })
    const slug = (created.body.request as { slug: string }).slug

    expect((await publicCall('POST', `/api/public/clouddrive/requests/${slug}/upload?name=a.txt`, {
      headers: { 'content-type': 'text/plain' }, body: '12345678901',
    })).status).toBe(413)
    expect((await publicCall('POST', `/api/public/clouddrive/requests/${slug}/upload?name=a.html`, {
      headers: { 'content-type': 'text/html' }, body: '<b>x</b>',
    })).status).toBe(400)
    expect((await publicCall('POST', `/api/public/clouddrive/requests/${slug}/upload?name=a.txt`, {
      headers: { 'content-type': 'text/plain' }, body: '12345',
    })).status).toBe(200)
    expect((await publicCall('POST', `/api/public/clouddrive/requests/${slug}/upload?name=b.txt`, {
      headers: { 'content-type': 'text/plain' }, body: '12345',
    })).status).toBe(400)
  })

  it('revokes a link and keeps it invisible to other accounts', async () => {
    await folder('drop')
    const created = await call(USER, 'POST', '/api/clouddrive/requests', { name: 'Link', targetPath: '/drop' })
    const slug = (created.body.request as { slug: string }).slug
    expect((await call(OTHER, 'GET', '/api/clouddrive/requests')).body.requests).toEqual([])
    expect((await call(USER, 'DELETE', `/api/clouddrive/requests/${slug}`)).status).toBe(200)
    expect((await publicCall('GET', `/api/public/clouddrive/requests/${slug}`)).status).toBe(404)
  })

  it('rejects a target that is not an existing folder', async () => {
    const missing = await call(USER, 'POST', '/api/clouddrive/requests', { name: 'Bad', targetPath: '/missing' })
    expect(missing.status).toBe(404)
  })
})
