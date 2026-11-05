import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER_A = 'user-a'
const USER_B = 'user-b'
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const MIB = 1024 * 1024

interface Harness {
  sqlite: DatabaseSync
  env: Env
  bucket: TestR2Bucket
  app: ReturnType<typeof createApp>
}

async function harness(): Promise<Harness> {
  const sqlite = new DatabaseSync(':memory:')
  const bucket = testR2Bucket()
  const env = testBindings(makeD1(sqlite), { FILES: bucket })
  const app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const user of [
    { id: USER_A, username: 'owner', role: 'owner', token: TOKEN_A },
    { id: USER_B, username: 'member', role: 'member', token: TOKEN_B },
  ]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', ?, '{}', ?, ?)`,
    ).run(user.id, user.username, user.username, user.username, user.role, now, now)
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(await hashToken(user.token), user.id, now + 600_000, now)
  }
  return { sqlite, env, bucket, app }
}

async function request(h: Harness, method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Cookie', `inkstone_session=${TOKEN_A}`)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) headers.set('X-Inkstone-Client', '1')
  return await h.app.fetch(new Request(`http://localhost${path}`, { ...init, method, headers }), h.env)
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** A remote server that honours byte ranges, with the whole body held in memory. */
function rangedServer(bytes: Uint8Array, contentType = 'application/octet-stream', supportsRange = true): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const range = headers.get('Range')
    if (range) {
      if (!supportsRange) {
        return new Response(bytes.slice(), {
          status: 200,
          headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
        })
      }
      const match = /bytes=(\d+)-(\d+)/.exec(range)
      const start = match ? Number(match[1]) : 0
      const end = match ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
        },
      })
    }
    return new Response(bytes.slice(), {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
    })
  }) as typeof fetch
}

let h: Harness

beforeEach(async () => {
  h = await harness()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  h.sqlite.close()
})

describe('clouddrive URL upload', () => {
  it('pulls a small remote file and writes a real file row with task progress', async () => {
    const body = new TextEncoder().encode('hello world')
    vi.stubGlobal('fetch', rangedServer(body, 'text/plain'))

    const response = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/notes.txt',
      parentPath: '/',
    }))
    expect(response.status).toBe(202)
    const payload = await response.json() as { taskId: string; sessionId: string; entryPath: string; strategy: string }
    expect(payload.entryPath).toBe('/notes.txt')
    expect(payload.strategy).toBe('direct')

    const row = h.sqlite.prepare(
      `SELECT name, path, category, mime, size, storage_key, storage_kind FROM CloudDrive_files
        WHERE user_id = ? AND name = 'notes.txt'`,
    ).get(USER_A) as Record<string, unknown>
    expect(row).toMatchObject({
      path: '/notes.txt', category: 'txt', mime: 'text/plain', size: 11, storage_kind: 'r2',
    })
    expect(h.bucket.objects.get(String(row.storage_key))?.byteLength).toBe(11)

    const task = h.sqlite.prepare(
      'SELECT status, progress, error FROM CloudDrive_tasks WHERE user_id = ? AND id = ?',
    ).get(USER_A, payload.taskId) as { status: string; progress: string; error: string | null }
    expect(task.status).toBe('completed')
    expect(JSON.parse(task.progress)).toMatchObject({ done: 1, bytes: 11 })
    expect(task.error).toBeNull()
    expect(h.sqlite.prepare('SELECT id FROM CloudDrive_upload_sessions WHERE user_id = ?').get(USER_A)).toBeUndefined()
  })

  it('downloads a file larger than the direct ceiling in ranged parts', async () => {
    const bytes = new Uint8Array(5 * MIB + 1)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
    vi.stubGlobal('fetch', rangedServer(bytes))

    const response = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/big.bin',
      parentPath: '/',
    }))
    expect(response.status).toBe(202)
    const payload = await response.json() as { taskId: string; entryPath: string; strategy: string }
    expect(payload.strategy).toBe('multipart')

    const row = h.sqlite.prepare(
      `SELECT size, storage_key FROM CloudDrive_files WHERE user_id = ? AND path = '/big.bin'`,
    ).get(USER_A) as { size: number; storage_key: string }
    expect(row.size).toBe(bytes.byteLength)
    expect(h.bucket.objects.get(row.storage_key)?.byteLength).toBe(bytes.byteLength)
    expect(h.bucket.objects.get(row.storage_key)?.at(-1)).toBe(bytes.at(-1))
    expect(h.sqlite.prepare(
      'SELECT status FROM CloudDrive_tasks WHERE user_id = ? AND id = ?',
    ).get(USER_A, payload.taskId)).toMatchObject({ status: 'completed' })
  })

  it('refuses a large remote file whose server ignores range requests', async () => {
    const bytes = new Uint8Array(5 * MIB + 1)
    vi.stubGlobal('fetch', rangedServer(bytes, 'application/octet-stream', false))

    const response = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/big.bin',
    }))
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/range/)
    expect(h.sqlite.prepare('SELECT id FROM CloudDrive_upload_sessions WHERE user_id = ?').get(USER_A)).toBeUndefined()
  })

  it('refuses a private address before any request leaves the worker', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'http://127.0.0.1/secret.txt',
    }))
    expect(response.status).toBe(502)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a remote file whose size the server never declares', async () => {
    // A range answer without a total is the honest shape of "the server will not say how big it is".
    vi.stubGlobal('fetch', (async () => new Response(new Uint8Array([115]), {
      status: 206,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': '1',
        'Content-Range': 'bytes 0-0/*',
      },
    })) as unknown as typeof fetch)

    const response = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/stream.txt',
    }))
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/size/)
  })

  it('honours a rename conflict when the destination already holds the name', async () => {
    const bytes = new TextEncoder().encode('one')
    vi.stubGlobal('fetch', rangedServer(bytes, 'text/plain'))
    const first = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/same.txt',
    }))
    expect(first.status).toBe(202)

    const second = await request(h, 'POST', '/api/clouddrive/uploads/url', jsonBody({
      url: 'https://example.com/same.txt',
      conflict: 'rename',
    }))
    expect(second.status).toBe(202)
    expect((await second.json() as { entryPath: string }).entryPath).toBe('/same (1).txt')
  })
})
