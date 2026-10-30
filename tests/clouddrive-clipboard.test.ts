// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { initialsOf } from '../src/worker/clouddrive/lib'
import { foldedName } from '../src/shared/clouddrive/model'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let db: D1Database
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket() })
})

function appFor(userId: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('user', {
      id: userId,
      username: 'tester',
      login: 'tester',
      name: 'Tester',
      avatarUrl: '',
      role: 'owner',
      createdAt: 1,
      settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/clouddrive', clouddriveRoutes)
  return app
}

async function call(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await appFor(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function insertFile(userId: string, name: string): Promise<string> {
  const id = newId()
  const now = Date.now()
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, 'primary', '', 'file', ?, ?, ?, ?, 'other', 'text/plain', 4, NULL, NULL, 'r2', NULL, '{}', '',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(id, userId, name, foldedName(name), initialsOf(name), `/${name}`, now, now, now, now).run()
  return id
}

describe('CloudDrive clipboard', () => {
  it('round-trips a copy and keeps accounts apart', async () => {
    const fileId = await insertFile(USER, 'note.txt')
    const saved = await call(USER, 'PUT', '/api/clouddrive/clipboard', {
      mode: 'copy',
      mountId: 'primary',
      sourcePath: '/',
      ids: [fileId],
    })
    expect(saved.status).toBe(200)
    expect(saved.body.clipboard).toMatchObject({ mode: 'copy', mountId: 'primary', ids: [fileId] })

    const mine = await call(USER, 'GET', '/api/clouddrive/clipboard')
    expect(mine.status).toBe(200)
    expect((mine.body.clipboard as { ids: string[] }).ids).toEqual([fileId])

    const theirs = await call(OTHER, 'GET', '/api/clouddrive/clipboard')
    expect(theirs.body.clipboard).toBeNull()
  })

  it('rejects an entry that belongs to another account', async () => {
    const foreign = await insertFile(OTHER, 'secret.txt')
    const response = await call(USER, 'PUT', '/api/clouddrive/clipboard', {
      mode: 'cut',
      mountId: 'primary',
      sourcePath: '/',
      ids: [foreign],
    })
    expect(response.status).toBe(404)
    expect((await call(USER, 'GET', '/api/clouddrive/clipboard')).body.clipboard).toBeNull()
  })

  it('rejects an invalid mode and a missing id list', async () => {
    const fileId = await insertFile(USER, 'note.txt')
    const mode = await call(USER, 'PUT', '/api/clouddrive/clipboard', { mode: 'move', mountId: 'primary', ids: [fileId] })
    expect(mode.status).toBe(400)
    const ids = await call(USER, 'PUT', '/api/clouddrive/clipboard', { mode: 'copy', mountId: 'primary', ids: [] })
    expect(ids.status).toBe(400)
  })

  it('clears the clipboard', async () => {
    const fileId = await insertFile(USER, 'note.txt')
    await call(USER, 'PUT', '/api/clouddrive/clipboard', {
      mode: 'copy', mountId: 'primary', sourcePath: '/', ids: [fileId],
    })
    const cleared = await call(USER, 'DELETE', '/api/clouddrive/clipboard')
    expect(cleared.status).toBe(200)
    expect((await call(USER, 'GET', '/api/clouddrive/clipboard')).body.clipboard).toBeNull()
  })
})
