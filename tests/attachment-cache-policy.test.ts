// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { filesRoutes } from '../src/worker/routes/files'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

/**
 * How long an attachment response may be kept, split by who is allowed to invalidate it.
 *
 * The bytes behind an attachment id never change, so an owner's own browser may hold them
 * indefinitely — that is what the ETag work added, and it is the only party that can delete them.
 * A share grant is different: rotating the share password is documented to cut old asset sessions
 * off immediately, and a year-long cache in the visitor's browser would keep serving the file after
 * both the rotation and the share are gone. Revocable access cannot be cacheable.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OWNER_CACHE = 'private, max-age=31536000, immutable'
const SHARE_CACHE = 'private, no-store'
// Slugs are exactly twenty characters and attachment ids exactly twenty-six, both drawn from the
// same generated alphabet, which is also what the body reference scanner matches against.
const NOTE = '00000000000000000000000001'
const ATTACHMENT = '00000000000000000000000002'
const SLUG = '0123456789abcdefghjk'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('/api/files/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  instance.route('/api/files', filesRoutes)
  return instance
}

async function get(path: string, headers?: HeadersInit): Promise<Response> {
  return app().request(`http://localhost${path}`, { headers }, env)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })

  sqlite
    .prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count, is_pinned, is_starred, is_archived, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, 'Shared note', 'shared note', ?, '', 1, 0, 0, 0, 0, 0, 0, 1, 1, NULL)`,
    )
    .run(NOTE, USER, `![](/api/files/${ATTACHMENT})`)
  sqlite
    .prepare(
      `INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at)
       VALUES (?, ?, ?, NULL, NULL, 0, 1)`,
    )
    .run(SLUG, NOTE, USER)
  sqlite
    .prepare(
      `INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256, object_key, width, height, storage, created_at)
       VALUES (?, ?, 'notes', ?, 'kept.txt', 'text/plain', 4, ?, ?, NULL, NULL, 'r2', 1000)`,
    )
    .run(ATTACHMENT, USER, NOTE, `${ATTACHMENT}hash`, `notes/${USER}/${ATTACHMENT}.txt`)
  bucket.objects.set(`notes/${USER}/${ATTACHMENT}.txt`, new Uint8Array([1, 2, 3, 4]))
  mocks.userId = USER
})

describe('an owner reading their own attachment', () => {
  it('may keep the bytes privately for a year', async () => {
    const response = await get(`/api/files/${ATTACHMENT}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(OWNER_CACHE)
  })

  it('revalidates with the tag instead of pulling the bytes again', async () => {
    const first = await get(`/api/files/${ATTACHMENT}`)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const again = await get(`/api/files/${ATTACHMENT}`, { 'If-None-Match': etag! })
    expect(again.status).toBe(304)
    expect(again.headers.get('cache-control')).toBe(OWNER_CACHE)
  })
})

describe('a share reader without a session', () => {
  it('is never handed a cacheable copy', async () => {
    mocks.userId = ''
    const response = await get(`/api/files/${ATTACHMENT}?share=${SLUG}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(SHARE_CACHE)
  })

  it('gets the bytes rather than a 304 even when it offers a matching tag', async () => {
    mocks.userId = ''
    const response = await get(`/api/files/${ATTACHMENT}?share=${SLUG}`, {
      'If-None-Match': `"${ATTACHMENT}hash"`,
    })
    expect(response.status).toBe(200)
    expect(await response.bytes()).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(response.headers.get('cache-control')).toBe(SHARE_CACHE)
  })

  it('still cannot read the file without naming the share', async () => {
    mocks.userId = ''
    expect((await get(`/api/files/${ATTACHMENT}`)).status).toBe(401)
  })
})
