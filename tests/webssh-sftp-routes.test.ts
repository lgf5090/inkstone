// @vitest-environment node
// W5 SFTP REST surface: owner isolation, path validation, chunk staging and the Durable Object
// hand-off. The real SSH path is exercised by the live acceptance, not here.

import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'
import type { AppBindings, Env, Variables } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { websshRoutes } from '../src/worker/webssh/routes'
import { WEBSSH_SFTP_MAX_BLOCK_BYTES, WEBSSH_SFTP_MAX_FILE_BYTES } from '../src/worker/webssh/sftp/limits'

const ORIGIN = 'https://notes.example.com'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let userId: string
let app: Hono<AppBindings>
let doRequests: Array<{ url: URL; body: Record<string, unknown> }>
let doResponse: ((body: Record<string, unknown>) => Response) | null

function makeApp(ownerId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.use('*', async (c, next) => {
    c.set('userId', ownerId)
    c.set('user', {
      id: ownerId,
      username: 'owner',
      login: 'owner',
      name: 'Owner',
      avatarUrl: '',
      role: 'owner',
      createdAt: 0,
      settingsRaw: '{}',
    } as Variables['user'])
    await next()
  })
  instance.route('/api/webssh', websshRoutes)
  instance.onError((error, c) => errorResponse(c, error))
  return instance
}

function insertSession(id: string, ownerId: string, status: string): void {
  sqlite.prepare(
    `INSERT INTO webssh_sessions
       (id, user_id, host_id, status, client_ip_hash, user_agent_hash, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, '', '', 1, 1)`,
  ).run(id, ownerId, newId(), status)
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(app.request(`${ORIGIN}${path}`, init, env))
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

beforeEach(() => {
  doRequests = []
  doResponse = null
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL,
      client_ip_hash TEXT NOT NULL DEFAULT '',
      user_agent_hash TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      connected_at INTEGER,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      close_reason TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      recording_id TEXT NOT NULL DEFAULT ''
    );
  `)
  db = makeD1(sqlite)
  userId = newId()
  app = makeApp(userId)
  env = testBindings(db, {
    FILES: testR2Bucket(),
    WEBSSH_SESSION: testDurableObjectNamespace(async (incoming) => {
      const body = await incoming.json() as Record<string, unknown>
      doRequests.push({ url: new URL(incoming.url), body })
      if (doResponse) return doResponse(body)
      return new Response(JSON.stringify({ path: '/home/test', entries: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  })
})

describe('SFTP session ownership', () => {
  it('answers 404 for an unknown session', async () => {
    const response = await request(`/api/webssh/sessions/${newId()}/sftp/list?path=/home/test`)
    expect(response.status).toBe(404)
  })

  it('answers 404 for another account session', async () => {
    const foreign = newId()
    insertSession(foreign, newId(), 'active')
    const response = await request(`/api/webssh/sessions/${foreign}/sftp/list?path=/home/test`)
    expect(response.status).toBe(404)
  })

  it('answers 409 before the session is active', async () => {
    const id = newId()
    insertSession(id, userId, 'pending')
    const response = await request(`/api/webssh/sessions/${id}/sftp/list?path=/home/test`)
    expect(response.status).toBe(409)
    expect((await json(response)).error).toMatchObject({ code: 'session_not_ready' })
  })

  it('answers 400 for a traversal path before touching the Durable Object', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const response = await request(`/api/webssh/sessions/${id}/sftp/list?path=${encodeURIComponent('/home/../etc')}`)
    expect(response.status).toBe(400)
    expect((await json(response)).error).toMatchObject({ code: 'invalid_path' })
    expect(doRequests).toHaveLength(0)
  })
})

describe('SFTP proxying', () => {
  it('lists through the session object', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const response = await request(`/api/webssh/sessions/${id}/sftp/list?path=/home/test`)
    expect(response.status).toBe(200)
    expect(doRequests[0]?.body).toMatchObject({ op: 'list', path: '/home/test' })
    expect(await json(response)).toMatchObject({ path: '/home/test', entries: [] })
  })

  it('forwards a stat read for the editor mtime check', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => new Response(JSON.stringify({
      entry: {
        name: 'app.conf',
        path: '/home/test/app.conf',
        kind: 'file',
        size: 12,
        mtime: 1700000000,
        permissions: '-rw-r--r--',
        uid: 1000,
        gid: 1000,
        owner: 'deploy',
        group: 'deploy',
        longname: '',
      },
    }), { headers: { 'content-type': 'application/json' } })
    const response = await request(`/api/webssh/sessions/${id}/sftp/stat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/app.conf' }),
    })
    expect(response.status).toBe(200)
    expect(doRequests[0]?.body).toMatchObject({ op: 'stat', path: '/home/test/app.conf' })
    expect((await json(response)).entry).toMatchObject({ mtime: 1700000000 })
  })

  it('forwards mkdir, remove and rename operation bodies', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })

    await request(`/api/webssh/sessions/${id}/sftp/mkdir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/new' }),
    })
    await request(`/api/webssh/sessions/${id}/sftp/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/file.txt', kind: 'directory' }),
    })
    await request(`/api/webssh/sessions/${id}/sftp/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '/home/test/a', to: '/home/test/b', overwrite: true }),
    })

    expect(doRequests.map((entry) => entry.body.op)).toEqual(['mkdir', 'remove', 'rename'])
    expect(doRequests[1]?.body).toMatchObject({ path: '/home/test/file.txt', kind: 'directory' })
    expect(doRequests[2]?.body).toMatchObject({ from: '/home/test/a', to: '/home/test/b', overwrite: true })
  })

  it('forwards a download block with its headers', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream', 'x-webssh-file-size': '3' },
    })
    const response = await request(`/api/webssh/sessions/${id}/sftp/download?path=/home/test/a&offset=2&length=3`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(doRequests[0]?.body).toMatchObject({ op: 'download', path: '/home/test/a', offset: 2, length: 3 })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('maps a Durable Object error body onto the REST error', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
    const response = await request(`/api/webssh/sessions/${id}/sftp/list?path=/missing`)
    expect(response.status).toBe(404)
    expect((await json(response)).error).toMatchObject({ code: 'not_found', message: 'gone' })
  })
})

describe('SFTP upload staging', () => {
  it('rejects a file over 2 GiB', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const response = await request(`/api/webssh/sessions/${id}/sftp/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/huge.bin', size: WEBSSH_SFTP_MAX_FILE_BYTES + 1 }),
    })
    expect(response.status).toBe(413)
    expect((await json(response)).error).toMatchObject({ code: 'file_too_large' })
  })

  it('stages chunks and refuses one over 64 MiB', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const created = await json(await request(`/api/webssh/sessions/${id}/sftp/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/notes.txt', size: 8 }),
    }))
    const transferId = String(created.transferId)
    expect(created).toMatchObject({ size: 8, chunkSize: WEBSSH_SFTP_MAX_BLOCK_BYTES })

    const tooBig = await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': '0', 'content-length': String(WEBSSH_SFTP_MAX_BLOCK_BYTES + 1) },
      body: new Uint8Array(1),
    })
    expect(tooBig.status).toBe(413)

    const stored = await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': '0' },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    })
    expect(stored.status).toBe(200)
    expect(await json(stored)).toMatchObject({ transferId, received: 8, size: 8 })
  })

  it('refuses a chunk past the declared size', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const created = await json(await request(`/api/webssh/sessions/${id}/sftp/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/notes.txt', size: 4 }),
    }))
    const response = await request(`/api/webssh/sessions/${id}/sftp/uploads/${created.transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': '4' },
      body: new Uint8Array([1, 2]),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).error).toMatchObject({ code: 'size_mismatch' })
  })

  it('completes only after every byte is staged, then clears R2', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    doResponse = () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    const created = await json(await request(`/api/webssh/sessions/${id}/sftp/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/notes.txt', size: 8 }),
    }))
    const transferId = String(created.transferId)

    const incomplete = await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}/complete`, { method: 'POST' })
    expect(incomplete.status).toBe(409)
    expect((await json(incomplete)).error).toMatchObject({ code: 'upload_incomplete' })

    await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': '0' },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    })
    const completed = await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}/complete`, { method: 'POST' })
    expect(completed.status).toBe(200)
    expect(doRequests.at(-1)?.body).toMatchObject({
      op: 'upload',
      path: '/home/test/notes.txt',
      size: 8,
      transferId,
    })
    const bucket = env.FILES
    if (bucket) {
      const listed = await bucket.list({ prefix: `webssh/documents/uploads/${userId}/${transferId}/` })
      expect(listed.objects).toHaveLength(0)
    }
  })

  it('cancels a staged upload and removes its objects', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const created = await json(await request(`/api/webssh/sessions/${id}/sftp/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/home/test/notes.txt', size: 8 }),
    }))
    const transferId = String(created.transferId)
    await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}`, {
      method: 'PUT',
      headers: { 'x-webssh-offset': '0' },
      body: new Uint8Array([1, 2, 3, 4]),
    })
    const cancelled = await request(`/api/webssh/sessions/${id}/sftp/uploads/${transferId}`, { method: 'DELETE' })
    expect(cancelled.status).toBe(200)
    const bucket = env.FILES
    if (bucket) {
      const listed = await bucket.list({ prefix: `webssh/documents/uploads/${userId}/${transferId}/` })
      expect(listed.objects).toHaveLength(0)
    }
  })

  it('answers 404 when another account names a transfer id', async () => {
    const id = newId()
    insertSession(id, userId, 'active')
    const foreignTransfer = newId()
    const response = await request(`/api/webssh/sessions/${id}/sftp/uploads/${foreignTransfer}`, { method: 'DELETE' })
    expect(response.status).toBe(404)
    expect((await json(response)).error).toMatchObject({ code: 'upload_not_found' })
  })
})
