import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/**
 * The app itself, with a real D1 schema and the in-memory R2 double. CloudDrive is mounted above the
 * `/api/clouddrive` prefix, so the session cookie and the client header are the same ones a browser
 * sends.
 */
async function harness(): Promise<Harness> {
  const sqlite = new DatabaseSync(':memory:')
  const bucket = testR2Bucket()
  const env = testBindings(makeD1(sqlite), { FILES: bucket })
  const app = createApp()
  // The first request builds every table on the real schema, the way the worker boots.
  await app.fetch(new Request('http://localhost/api/health'), env)

  const now = Date.now()
  const users = [
    { id: USER_A, username: 'owner', role: 'owner', token: TOKEN_A },
    { id: USER_B, username: 'member', role: 'member', token: TOKEN_B },
  ]
  for (const user of users) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', ?, '{}', ?, ?)`,
    ).run(user.id, user.username, user.username, user.username, user.role, now, now)
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(await hashToken(user.token), user.id, now + 600_000, now)
  }
  return { sqlite, env, bucket, app }
}

async function request(
  h: Harness,
  method: string,
  path: string,
  init: RequestInit = {},
  as = USER_A,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Cookie', `inkstone_session=${as === USER_B ? TOKEN_B : TOKEN_A}`)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    headers.set('X-Inkstone-Client', '1')
  }
  return await h.app.fetch(new Request(`http://localhost${path}`, { ...init, method, headers }), h.env)
}

interface UploadSessionResponse {
  session: { id: string; strategy: 'direct' | 'multipart'; partSize: number; totalParts: number }
  entryPath: string
  skipped?: boolean
  existing?: { id: string; path: string }
}

async function initUpload(
  h: Harness,
  payload: Record<string, unknown>,
  as = USER_A,
): Promise<Response> {
  return await request(h, 'POST', '/api/clouddrive/uploads', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, as)
}

interface CompleteResponse {
  entry: {
    id: string
    path: string
    name: string
    size: number
    mime: string
  }
  skipped?: boolean
  entryPath?: string
}

async function uploadSmall(
  h: Harness,
  name: string,
  content: string,
): Promise<{ session: UploadSessionResponse; entry: CompleteResponse['entry']; key: string }> {
  const init = await initUpload(h, {
    parentPath: '/', name, size: content.length, mime: 'text/plain',
  })
  expect(init.status).toBe(200)
  const session = await init.json() as UploadSessionResponse
  const put = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/content`, {
    body: content,
  })
  expect(put.status).toBe(200)
  const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, {
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(complete.status).toBe(200)
  const body = await complete.json() as CompleteResponse
  const row = h.sqlite.prepare(
    'SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND id = ?',
  ).get(USER_A, body.entry.id) as { storage_key: string } | undefined
  expect(row?.storage_key).toMatch(/^CloudDrive\/[a-z]+\/[0-9a-z]{26}$/)
  return { session: session as UploadSessionResponse, entry: body.entry, key: row!.storage_key }
}

let h: Harness

beforeEach(async () => {
  h = await harness()
})

afterEach(() => {
  h.sqlite.close()
})

describe('clouddrive direct upload', () => {
  it('streams one body and completes a file row with the primary R2 key shape', async () => {
    const upload = await uploadSmall(h, 'notes.txt', 'hello world')

    expect(upload.session.session.strategy).toBe('direct')
    expect(upload.session.entryPath).toBe('/notes.txt')
    expect(upload.key).toMatch(/^CloudDrive\/txt\//)
    expect(upload.entry.size).toBe(11)

    const row = h.sqlite.prepare(
      `SELECT id, mount_id, parent_id, kind, name, name_folded, path, category, mime, size,
              storage_kind, storage_key, deleted_at
         FROM CloudDrive_files WHERE user_id = ? AND id = ?`,
    ).get(USER_A, upload.entry.id) as Record<string, unknown>
    expect(row).toMatchObject({
      mount_id: 'primary',
      parent_id: '',
      kind: 'file',
      name: 'notes.txt',
      name_folded: 'notes.txt',
      path: '/notes.txt',
      category: 'txt',
      mime: 'text/plain',
      size: 11,
      storage_kind: 'r2',
      storage_key: upload.key,
      deleted_at: null,
    })
    expect(h.bucket.objects.get(upload.key)?.byteLength).toBe(11)
    expect(h.bucket.types.get(upload.key)).toBe('text/plain')

    const session = h.sqlite.prepare(
      'SELECT id FROM CloudDrive_upload_sessions WHERE user_id = ? AND id = ?',
    ).get(USER_A, upload.session.session.id)
    expect(session).toBeUndefined()
  })

  it('renames on a sibling collision and skips when the conflict says so', async () => {
    await uploadSmall(h, 'same.txt', 'one')

    const renamed = await initUpload(h, {
      parentPath: '/', name: 'same.txt', size: 3, mime: 'text/plain', conflict: 'rename',
    })
    expect(renamed.status).toBe(200)
    expect((await renamed.json() as UploadSessionResponse).entryPath).toBe('/same (1).txt')

    const skipped = await initUpload(h, {
      parentPath: '/', name: 'same.txt', size: 3, mime: 'text/plain', conflict: 'skip',
    })
    expect(skipped.status).toBe(200)
    const skippedBody = await skipped.json() as UploadSessionResponse
    expect(skippedBody.skipped).toBe(true)
    expect(skippedBody.existing?.path).toBe('/same.txt')
    expect(skippedBody.session).toBeUndefined()
  })

  it('moves the previous row to trash when overwriting', async () => {
    const first = await uploadSmall(h, 'over.txt', 'one')

    const init = await initUpload(h, {
      parentPath: '/', name: 'over.txt', size: 3, mime: 'text/plain', conflict: 'overwrite',
    })
    expect(init.status).toBe(200)
    const session = await init.json() as UploadSessionResponse
    expect(session.session.strategy).toBe('direct')

    const put = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/content`, {
      body: 'two',
    })
    expect(put.status).toBe(200)
    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(complete.status).toBe(200)
    const body = await complete.json() as CompleteResponse

    const oldRow = h.sqlite.prepare(
      'SELECT deleted_at, trash_batch FROM CloudDrive_files WHERE user_id = ? AND id = ?',
    ).get(USER_A, first.entry.id) as { deleted_at: number | null; trash_batch: string | null }
    expect(oldRow.deleted_at).not.toBeNull()
    expect(oldRow.trash_batch).not.toBeNull()

    const live = h.sqlite.prepare(
      `SELECT id, size FROM CloudDrive_files
        WHERE user_id = ? AND path = ? AND deleted_at IS NULL`,
    ).all(USER_A, '/over.txt') as { id: string; size: number }[]
    expect(live).toHaveLength(1)
    expect(live[0]!.id).toBe(body.entry.id)
    expect(live[0]!.size).toBe(3)
  })
})

describe('clouddrive multipart upload', () => {
  it('accepts parts out of order, completes, and keeps the declared part size', async () => {
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at)
       VALUES (?, 'upload.partSizeBytes', '5242880', ?)`,
    ).run(USER_A, Date.now())

    const size = 6 * MIB
    const init = await initUpload(h, {
      parentPath: '/', name: 'big.bin', size, mime: 'application/octet-stream',
    })
    expect(init.status).toBe(200)
    const session = await init.json() as UploadSessionResponse
    expect(session.session.strategy).toBe('multipart')
    expect(session.session.partSize).toBe(5 * MIB)
    expect(session.session.totalParts).toBe(2)

    const firstPart = new Uint8Array(5 * MIB).fill(1)
    const lastPart = new Uint8Array(MIB).fill(2)
    const last = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/2`, {
      body: lastPart,
    })
    expect(last.status).toBe(200)
    const first = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/1`, {
      body: firstPart,
    })
    expect(first.status).toBe(200)

    const partRows = h.sqlite.prepare(
      'SELECT part_number, size FROM CloudDrive_upload_parts WHERE session_id = ? ORDER BY part_number',
    ).all(session.session.id) as { part_number: number; size: number }[]
    expect(partRows).toEqual([
      { part_number: 1, size: 5 * MIB },
      { part_number: 2, size: MIB },
    ])

    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(complete.status).toBe(200)
    const body = await complete.json() as CompleteResponse
    expect(body.entry.size).toBe(size)

    const stored = h.bucket.objects.get(`CloudDrive/other/${body.entry.id}`)
    expect(stored?.byteLength).toBe(size)
    expect(stored?.[5 * MIB - 1]).toBe(1)
    expect(stored?.[5 * MIB]).toBe(2)
  })

  it('aborts the multipart upload and removes it from the active list', async () => {
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at)
       VALUES (?, 'upload.partSizeBytes', '5242880', ?)`,
    ).run(USER_A, Date.now())

    const init = await initUpload(h, {
      parentPath: '/', name: 'abort.bin', size: 6 * MIB, mime: 'application/octet-stream',
    })
    const session = await init.json() as UploadSessionResponse
    const part = await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/parts/1`, {
      body: new Uint8Array(5 * MIB),
    })
    expect(part.status).toBe(200)

    const listed = await request(h, 'GET', '/api/clouddrive/uploads?status=active')
    const listedBody = await listed.json() as {
      sessions: { id: string; partsUploaded: number; entryPath: string }[]
    }
    expect(listedBody.sessions).toHaveLength(1)
    expect(listedBody.sessions[0]!.id).toBe(session.session.id)
    expect(listedBody.sessions[0]!.partsUploaded).toBe(1)
    expect(listedBody.sessions[0]!.entryPath).toBe('/abort.bin')

    const abort = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/abort`)
    expect(abort.status).toBe(200)
    expect(await abort.json()).toEqual({ ok: true })

    const row = h.sqlite.prepare(
      'SELECT status FROM CloudDrive_upload_sessions WHERE user_id = ? AND id = ?',
    ).get(USER_A, session.session.id) as { status: string }
    expect(row.status).toBe('aborted')
    expect(h.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM CloudDrive_upload_parts WHERE session_id = ?',
    ).get(session.session.id)).toEqual({ count: 0 })

    const active = await request(h, 'GET', '/api/clouddrive/uploads?status=active')
    expect((await active.json() as { sessions: unknown[] }).sessions).toEqual([])

    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`)
    expect(complete.status).toBe(404)
  })
})

describe('clouddrive content', () => {
  it('serves 200, 206, 304 and 416 with the right headers', async () => {
    const uploaded = await uploadSmall(h, 'range.txt', '0123456789')
    const path = `/api/clouddrive/files/${uploaded.entry.id}/content`

    const full = await request(h, 'GET', path)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('10')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(await full.text()).toBe('0123456789')
    const etag = full.headers.get('etag')
    expect(etag).toBeTruthy()

    const partial = await request(h, 'GET', path, { headers: { Range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(partial.headers.get('content-length')).toBe('4')
    expect(await partial.text()).toBe('2345')

    const notModified = await request(h, 'GET', path, { headers: { 'If-None-Match': etag! } })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('etag')).toBe(etag)
    expect(await notModified.text()).toBe('')

    const unsatisfiable = await request(h, 'GET', path, { headers: { Range: 'bytes=100-' } })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */10')

    const head = await request(h, 'HEAD', path)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')

    const download = await request(h, 'GET', `${path}?download=1`)
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  it('keeps another user from reading the file', async () => {
    const uploaded = await uploadSmall(h, 'private.txt', 'secret')
    const response = await request(
      h, 'GET', `/api/clouddrive/files/${uploaded.entry.id}/content`, {}, USER_B,
    )
    expect(response.status).toBe(404)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('not_found')
  })

  it('falls back to the original image when Image Resizing is not bound', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const init = await initUpload(h, {
      parentPath: '/', name: 'pixel.png', size: png.byteLength, mime: 'image/png',
    })
    const session = await init.json() as UploadSessionResponse
    await request(h, 'PUT', `/api/clouddrive/uploads/${session.session.id}/content`, { body: png })
    const complete = await request(h, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await complete.json() as CompleteResponse

    const thumbnail = await request(h, 'GET', `/api/clouddrive/files/${body.entry.id}/thumbnail?w=320`)
    expect(thumbnail.status).toBe(200)
    expect(thumbnail.headers.get('x-clouddrive-thumbnail')).toBe('fallback')
    expect(thumbnail.headers.get('content-type')).toBe('image/png')
  })

  it('rejects invalid thumbnail widths', async () => {
    const uploaded = await uploadSmall(h, 'w.txt', 'x')
    const response = await request(h, 'GET', `/api/clouddrive/files/${uploaded.entry.id}/thumbnail?w=99`)
    expect(response.status).toBe(400)
  })

  it('answers the zip endpoint with an explicit 501', async () => {
    const response = await request(h, 'GET', '/api/clouddrive/download/zip?mountId=primary&path=/')
    expect(response.status).toBe(501)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('not_implemented')
  })
})

describe('clouddrive upload validation', () => {
  it('rejects traversal in the parent path and the file name', async () => {
    const parent = await initUpload(h, {
      parentPath: '/../secret', name: 'a.txt', size: 1, mime: 'text/plain',
    })
    expect(parent.status).toBe(400)
    expect((await parent.json() as { error: { code: string } }).error.code).toBe('clouddrive_path_invalid')

    const name = await initUpload(h, {
      parentPath: '/', name: '../a.txt', size: 1, mime: 'text/plain',
    })
    expect(name.status).toBe(400)
    expect((await name.json() as { error: { code: string } }).error.code).toBe('clouddrive_path_invalid')
  })

  it('requires an existing live parent folder', async () => {
    const response = await initUpload(h, {
      parentPath: '/missing', name: 'a.txt', size: 1, mime: 'text/plain',
    })
    expect(response.status).toBe(404)
  })

  it('refuses a mount other than the primary one', async () => {
    const response = await initUpload(h, {
      mountId: 'photos', parentPath: '/', name: 'a.txt', size: 1, mime: 'text/plain',
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('clouddrive_mount_unavailable')
  })

  it('enforces the configured file-size limit', async () => {
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at)
       VALUES (?, 'upload.maxFileBytes', '1048576', ?)`,
    ).run(USER_A, Date.now())
    const response = await initUpload(h, {
      parentPath: '/', name: 'too.bin', size: 2 * MIB, mime: 'application/octet-stream',
    })
    expect(response.status).toBe(413)
  })

  it('enforces the per-user quota from the deduplicated storage keys', async () => {
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_settings (user_id, key, value, updated_at)
       VALUES (?, 'quota.defaultUserBytes', '10', ?)`,
    ).run(USER_A, Date.now())
    const response = await initUpload(h, {
      parentPath: '/', name: 'quota.txt', size: 11, mime: 'text/plain',
    })
    expect(response.status).toBe(403)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('clouddrive_quota_exceeded')
  })
})
