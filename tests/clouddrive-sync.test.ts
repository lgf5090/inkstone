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
import { planMirror, type MirrorLocalFile, type MirrorRemoteEntry } from '../src/client/features/clouddrive/sync/plan'

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
    c.set('user', { id: userId, username: 'tester', login: 'tester', name: 'Tester', avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '{}' })
    await next()
  })
  app.route('/api/clouddrive', clouddriveRoutes)
  return app
}

async function call<T = Record<string, unknown>>(userId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await appFor(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T }
}

async function insertEntry(path: string, kind: 'file' | 'folder' = 'file', size = 4): Promise<void> {
  const id = newId()
  const now = Date.now()
  const name = path.split('/').filter(Boolean).pop() ?? 'entry'
  const parentPath = path.slice(0, path.lastIndexOf('/')) || '/'
  const parent = parentPath === '/' ? { id: '' } : await db.prepare(
    `SELECT id FROM CloudDrive_files WHERE user_id = ? AND path = ? AND deleted_at IS NULL`,
  ).bind(USER, parentPath).first<{ id: string }>()
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, 'other', 'application/octet-stream', ?, NULL, NULL, 'r2', NULL, '{}', '',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(id, USER, parent?.id ?? '', kind, name, foldedName(name), initialsOf(name), path, kind === 'folder' ? 0 : size, now, now, now, now).run()
}

function local(path: string, size: number, lastModified = 1000): MirrorLocalFile {
  return { path, size, lastModified }
}

function remote(path: string, kind: 'file' | 'folder', size = 0, modifiedAt = 0): MirrorRemoteEntry {
  return { path, kind, size, modifiedAt }
}

describe('mirror planner', () => {
  it('uploads new and changed files, skips unchanged ones case-insensitively, and creates folders', () => {
    const plan = planMirror(
      ['photos', 'photos/2026'],
      [local('photos/new.jpg', 10), local('photos/B.TXT', 5), local('photos/old.txt', 8)],
      [remote('photos', 'folder'), remote('photos/b.txt', 'file', 5, 5000), remote('photos/old.txt', 'file', 7, 0)],
    )
    expect(plan.uploads.map((file) => file.path)).toEqual(['photos/new.jpg', 'photos/old.txt'])
    expect(plan.unchanged).toBe(1)
    expect(plan.folders).toEqual(['photos/2026'])
    expect(plan.bytes).toBe(18)
  })

  it('skips hidden files, oversized files and a path that is a remote folder', () => {
    const plan = planMirror(
      [],
      [local('.secret', 1), local('huge.bin', 100), local('photos', 4)],
      [remote('photos', 'folder')],
      { includeHidden: false, maxFiles: 10, maxBytes: 1000, maxFileBytes: 50 },
    )
    expect(plan.uploads).toHaveLength(0)
    expect(plan.skipped).toEqual([
      { path: '.secret', reason: 'hidden' },
      { path: 'huge.bin', reason: 'too_large' },
      { path: 'photos', reason: 'conflict' },
    ])
  })

  it('enforces the file-count and byte budgets', () => {
    const plan = planMirror(
      [],
      [local('a', 10), local('b', 10), local('c', 10)],
      [],
      { includeHidden: true, maxFiles: 2, maxBytes: 25, maxFileBytes: 100 },
    )
    expect(plan.uploads.map((file) => file.path)).toEqual(['a', 'b'])
    expect(plan.skipped).toEqual([{ path: 'c', reason: 'over_limit' }])
  })
})

describe('sync target routes', () => {
  it('creates, lists, updates and reports a target for one account only', async () => {
    const created = await call<{ target: { id: string; remotePath: string } }>(USER, 'POST', '/api/clouddrive/sync/targets', {
      name: 'Photos',
      localLabel: 'Pictures on the laptop',
      remotePath: '/photos',
    })
    expect(created.status).toBe(201)
    expect(created.body.target.remotePath).toBe('/photos')
    const id = created.body.target.id

    expect((await call<{ targets: unknown[] }>(OTHER, 'GET', '/api/clouddrive/sync/targets')).body.targets).toHaveLength(0)
    expect((await call<{ targets: unknown[] }>(USER, 'GET', '/api/clouddrive/sync/targets')).body.targets).toHaveLength(1)

    const patched = await call<{ target: { enabled: boolean } }>(USER, 'PATCH', `/api/clouddrive/sync/targets/${id}`, { enabled: false })
    expect(patched.body.target.enabled).toBe(false)

    const reported = await call<{ target: { lastStatus: string; lastFileCount: number; lastBytes: number } }>(
      USER, 'POST', `/api/clouddrive/sync/targets/${id}/report`, { status: 'success', files: 3, bytes: 30 },
    )
    expect(reported.body.target).toMatchObject({ lastStatus: 'success', lastFileCount: 3, lastBytes: 30 })

    expect((await call(USER, 'DELETE', `/api/clouddrive/sync/targets/${id}`)).status).toBe(200)
    expect((await call<{ targets: unknown[] }>(USER, 'GET', '/api/clouddrive/sync/targets')).body.targets).toHaveLength(0)
  })

  it('returns the remote index relative to the target folder', async () => {
    await insertEntry('/photos', 'folder')
    await insertEntry('/photos/a.jpg', 'file', 10)
    await insertEntry('/photos/2026', 'folder')
    await insertEntry('/photos/2026/b.jpg', 'file', 20)
    await insertEntry('/elsewhere.txt', 'file', 5)

    const result = await call<{ entries: { path: string; kind: string; size: number }[]; base: string }>(
      USER, 'GET', '/api/clouddrive/sync/remote?mount=primary&path=%2Fphotos',
    )
    expect(result.status).toBe(200)
    expect(result.body.base).toBe('/photos')
    expect(result.body.entries).toEqual([
      { path: '2026', kind: 'folder', size: 0, modifiedAt: expect.any(Number) },
      { path: '2026/b.jpg', kind: 'file', size: 20, modifiedAt: expect.any(Number) },
      { path: 'a.jpg', kind: 'file', size: 10, modifiedAt: expect.any(Number) },
    ])
  })

  it('rejects an invalid target name and a range report', async () => {
    expect((await call(USER, 'POST', '/api/clouddrive/sync/targets', { name: '', remotePath: '/' })).status).toBe(400)
    const created = await call<{ target: { id: string } }>(USER, 'POST', '/api/clouddrive/sync/targets', { name: 'T', remotePath: '/' })
    const id = created.body.target.id
    expect((await call(USER, 'POST', `/api/clouddrive/sync/targets/${id}/report`, { status: 'success', files: -1, bytes: 0 })).status).toBe(400)
  })
})
