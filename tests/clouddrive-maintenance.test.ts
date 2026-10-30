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

async function call<T = Record<string, unknown>>(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await appFor(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T }
}

interface InsertOptions {
  userId?: string
  path: string
  kind?: 'file' | 'folder'
  storageKey?: string | null
  parentId?: string
}

async function insertEntry(options: InsertOptions): Promise<string> {
  const id = newId()
  const now = Date.now()
  const name = options.path.split('/').filter(Boolean).pop() ?? 'entry'
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, 'txt', 'text/plain', 4, NULL, NULL, 'r2', ?, '{}', '',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    id,
    options.userId ?? USER,
    options.parentId ?? '',
    options.kind ?? 'file',
    name,
    foldedName(name),
    initialsOf(name),
    options.path,
    options.storageKey ?? null,
    now, now, now, now,
  ).run()
  return id
}

describe('CloudDrive maintenance', () => {
  it('lists only objects no row references and deletes only those', async () => {
    const key = `CloudDrive/txt/${newId()}`
    await insertEntry({ path: '/kept.txt', storageKey: key })
    await r2.put(key, 'kept')
    await r2.put(`CloudDrive/txt/${newId()}`, 'orphan')

    const scan = await call<{ orphans: { key: string }[]; scanned: number; done: boolean }>(
      USER, 'GET', '/api/clouddrive/admin/maintenance/orphans?limit=10',
    )
    expect(scan.status).toBe(200)
    expect(scan.body.scanned).toBe(2)
    expect(scan.body.done).toBe(true)
    expect(scan.body.orphans).toHaveLength(1)
    expect(scan.body.orphans[0]!.key).not.toBe(key)

    const deleted = await call<{ deleted: number; skipped: number }>(USER, 'POST', '/api/clouddrive/admin/maintenance/orphans/delete', {
      keys: [key, scan.body.orphans[0]!.key],
    })
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ deleted: 1, skipped: 1 })
    expect(await r2.head(key)).not.toBeNull()
    expect(await r2.head(scan.body.orphans[0]!.key)).toBeNull()
  })

  it('refuses object keys outside the CloudDrive prefix', async () => {
    const response = await call(USER, 'POST', '/api/clouddrive/admin/maintenance/orphans/delete', {
      keys: ['notes/someone-else'],
    })
    expect(response.status).toBe(400)
  })

  it('exports metadata and reimports it under new rows', async () => {
    const folderId = await insertEntry({ path: '/docs', kind: 'folder' })
    const key = `CloudDrive/txt/${newId()}`
    const fileId = await insertEntry({ path: '/docs/readme.txt', parentId: folderId, storageKey: key })
    await r2.put(key, 'hello')
    await db.prepare(
      `INSERT INTO CloudDrive_file_tags (user_id, file_id, tag, tag_folded, color, created_at)
       VALUES (?, ?, 'work', 'work', '#3B82F6', ?)`,
    ).bind(USER, fileId, Date.now()).run()

    const exported = await call<{ format: string; entries: { path: string; tags: { tag: string }[]; storageKey: string | null }[] }>(
      USER, 'GET', '/api/clouddrive/admin/maintenance/export',
    )
    expect(exported.status).toBe(200)
    expect(exported.body.format).toBe('inkstone-clouddrive')
    expect(exported.body.entries.map((entry) => entry.path)).toEqual(['/docs', '/docs/readme.txt'])
    expect(exported.body.entries[1]!.tags).toEqual([{ tag: 'work', color: '#3B82F6' }])

    await db.prepare(`DELETE FROM CloudDrive_files WHERE user_id = ?`).bind(USER).run()
    await db.prepare(`DELETE FROM CloudDrive_file_tags WHERE user_id = ?`).bind(USER).run()

    const imported = await call<{ imported: number; skipped: number; errors: unknown[] }>(
      USER, 'POST', '/api/clouddrive/admin/maintenance/import', exported.body,
    )
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ imported: 2, skipped: 0 })

    const rows = await db.prepare(
      `SELECT path, storage_key FROM CloudDrive_files WHERE user_id = ? ORDER BY path`,
    ).bind(USER).all<{ path: string; storage_key: string | null }>()
    expect(rows.results).toEqual([
      { path: '/docs', storage_key: null },
      { path: '/docs/readme.txt', storage_key: key },
    ])
    const tags = await db.prepare(
      `SELECT t.tag FROM CloudDrive_file_tags t
         JOIN CloudDrive_files f ON f.user_id = t.user_id AND f.id = t.file_id
        WHERE t.user_id = ? AND f.path = '/docs/readme.txt'`,
    ).bind(USER).all<{ tag: string }>()
    expect(tags.results).toEqual([{ tag: 'work' }])
  })

  it('lists and cancels a queued server task', async () => {
    const id = newId()
    const now = Date.now()
    await db.prepare(
      `INSERT INTO CloudDrive_tasks (id, user_id, type, status, payload, progress, error, locked_until,
        created_at, started_at, finished_at, updated_at)
       VALUES (?, ?, 'reindex', 'queued', '{}', '{}', NULL, NULL, ?, NULL, NULL, ?)`,
    ).bind(id, USER, now, now).run()
    const listed = await call<{ tasks: { id: string; status: string }[] }>(USER, 'GET', '/api/clouddrive/tasks')
    expect(listed.status).toBe(200)
    expect(listed.body.tasks).toMatchObject([{ id, status: 'queued' }])
    expect((await call<{ tasks: unknown[] }>(OTHER, 'GET', '/api/clouddrive/tasks')).body.tasks).toHaveLength(0)

    const cancelled = await call(USER, 'POST', `/api/clouddrive/tasks/${id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    expect((await call<{ tasks: { id: string; status: string }[] }>(USER, 'GET', '/api/clouddrive/tasks')).body.tasks)
      .toMatchObject([{ id, status: 'cancelled' }])
  })

  it('skips a child whose parent is absent and a key another row owns', async () => {
    const taken = `CloudDrive/txt/${newId()}`
    await insertEntry({ userId: OTHER, path: '/owned.txt', storageKey: taken })
    const manifest = {
      format: 'inkstone-clouddrive',
      version: 1,
      exportedAt: Date.now(),
      truncated: false,
      entries: [
        { path: '/missing/child.txt', name: 'child.txt', kind: 'file' },
        { path: '/claimed.txt', name: 'claimed.txt', kind: 'file', storageKey: taken },
      ],
    }
    const result = await call<{ imported: number; skipped: number; errors: { reason: string }[] }>(
      USER, 'POST', '/api/clouddrive/admin/maintenance/import', manifest,
    )
    expect(result.status).toBe(200)
    expect(result.body.imported).toBe(0)
    expect(result.body.skipped).toBe(2)
    expect(result.body.errors.map((error) => error.reason).sort()).toEqual(['missing_parent', 'storage_key_taken'])
  })
})
