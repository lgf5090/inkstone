// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { initialsOf } from '../src/worker/clouddrive/lib'
import { foldedName, type CloudDriveEntry, type CloudDriveListing } from '../src/shared/clouddrive/model'
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

function buildApp(userId: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
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

interface Answer<T> {
  status: number
  body: T
}

async function call<T = Record<string, unknown>>(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer<T>> {
  const response = await buildApp(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T }
}

async function insertEntry(options: {
  userId?: string
  mountId?: string
  parentId?: string
  path: string
  name: string
  kind?: 'folder' | 'file'
  size?: number
  category?: string
  storageKey?: string | null
  uploadedAt?: number
}): Promise<string> {
  const id = newId()
  const now = options.uploadedAt ?? Date.now()
  const name = options.name
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'application/octet-stream', ?, NULL, NULL, 'r2', ?, '{}', '',
             NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    id,
    options.userId ?? USER,
    options.mountId ?? 'primary',
    options.parentId ?? '',
    options.kind ?? 'file',
    name,
    foldedName(name),
    initialsOf(name),
    options.path,
    options.category ?? 'other',
    options.size ?? 0,
    options.storageKey ?? null,
    now,
    now,
    now,
    now,
  ).run()
  return id
}

async function rowByPath(userId: string, path: string): Promise<{ id: string; path: string; storage_key: string | null }> {
  const row = await db.prepare(
    `SELECT id, path, storage_key FROM CloudDrive_files WHERE user_id = ? AND path = ? AND deleted_at IS NULL`,
  ).bind(userId, path).first<{ id: string; path: string; storage_key: string | null }>()
  if (!row) throw new Error(`row ${path} is missing`)
  return row
}

describe('clouddrive file API', () => {
  it('rejects traversal and invalid names with clouddrive_path_invalid', async () => {
    const traversal = await call(USER, 'GET', '/api/clouddrive/files?path=/docs/../secret')
    expect(traversal.status).toBe(400)
    expect((traversal.body as { error?: { code?: string } }).error?.code).toBe('clouddrive_path_invalid')

    const badName = await call(USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'bad/name' })
    expect(badName.status).toBe(400)
    expect((badName.body as { error?: { code?: string } }).error?.code).toBe('clouddrive_path_invalid')
  })

  it('hides another user\'s file behind 404', async () => {
    const created = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Private',
    })
    expect(created.status).toBe(201)
    const id = created.body.entry.id

    const read = await call(OTHER, 'GET', `/api/clouddrive/files/${id}`)
    expect(read.status).toBe(404)
    const listing = await call(OTHER, 'GET', '/api/clouddrive/files?path=/Private')
    expect(listing.status).toBe(404)
  })

  it('lists files by the requested sort and follows the cursor', async () => {
    await insertEntry({ path: '/alpha.txt', name: 'alpha.txt', size: 10, uploadedAt: 3 })
    await insertEntry({ path: '/beta.txt', name: 'beta.txt', size: 30, uploadedAt: 2 })
    await insertEntry({ path: '/gamma.txt', name: 'gamma.txt', size: 20, uploadedAt: 1 })

    const first = await call<{ files: CloudDriveEntry[]; cursor: string | null; total: number | null }>(
      USER, 'GET', '/api/clouddrive/files?sort=size&dir=desc&limit=2',
    )
    expect(first.status).toBe(200)
    expect(first.body.files.map((entry) => entry.name)).toEqual(['beta.txt', 'gamma.txt'])
    expect(first.body.total).toBe(3)
    expect(first.body.cursor).toBeTruthy()

    const second = await call<{ files: CloudDriveEntry[]; cursor: string | null }>(
      USER, 'GET', `/api/clouddrive/files?sort=size&dir=desc&limit=2&cursor=${encodeURIComponent(first.body.cursor!)}`,
    )
    expect(second.body.files.map((entry) => entry.name)).toEqual(['alpha.txt'])
    expect(second.body.cursor).toBeNull()

    const byName = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?sort=name&dir=asc')
    expect(byName.body.files.map((entry) => entry.name)).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt'])
  })

  it('returns 409 with a suggested name when a folder already exists', async () => {
    const first = await call(USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'Docs' })
    expect(first.status).toBe(201)
    const second = await call<{ error: { code: string; details?: { suggestedName?: string } } }>(
      USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'docs' },
    )
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('conflict')
    expect(second.body.error.details?.suggestedName).toBe('docs (1)')
  })

  it('renames a folder and its whole subtree', async () => {
    const docs = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Docs',
    })
    await insertEntry({ path: '/Docs/a.txt', name: 'a.txt', parentId: docs.body.entry.id })

    const renamed = await call<{ entry: CloudDriveEntry }>(
      USER, 'PATCH', `/api/clouddrive/files/${docs.body.entry.id}`, { name: 'Notes' },
    )
    expect(renamed.status).toBe(200)
    expect(renamed.body.entry.path).toBe('/Notes')

    const child = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?path=/Notes')
    expect(child.status).toBe(200)
    expect(child.body.files.map((entry) => entry.path)).toEqual(['/Notes/a.txt'])
  })

  it('trashes, restores and purges while keeping a shared object alive', async () => {
    const key = 'CloudDrive/txt/shared-object'
    await env.FILES!.put(key, 'bytes')
    const keep = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Keep',
    })
    const originalId = await insertEntry({
      path: '/Keep/a.txt', name: 'a.txt', parentId: keep.body.entry.id, storageKey: key,
    })

    const copied = await call<{ results: { id: string; ok: boolean; toPath?: string }[] }>(
      USER, 'POST', '/api/clouddrive/files/copy', { ids: [originalId], toPath: '/' },
    )
    expect(copied.status).toBe(200)
    const copyRow = await rowByPath(USER, '/a.txt')
    expect(copyRow.path).toBe('/a.txt')
    expect(copyRow.storage_key).toBe(key)

    // Deleting the folder trashes its child, not just the folder row.
    const deleted = await call<{ deleted: number }>(USER, 'DELETE', '/api/clouddrive/files', {
      ids: [keep.body.entry.id],
    })
    expect(deleted.status).toBe(200)
    expect(deleted.body.deleted).toBe(2)
    const trashed = await call<{ folders: CloudDriveEntry[]; files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/trash')
    expect(trashed.body.folders.map((entry) => entry.name)).toContain('Keep')
    expect(trashed.body.files.map((entry) => entry.name)).toContain('a.txt')

    // Restoring the child alone must first bring its trashed folder ancestor back.
    const restored = await call<{ results: { ok: boolean; entry?: CloudDriveEntry }[] }>(
      USER, 'POST', '/api/clouddrive/files/restore', { ids: [originalId] },
    )
    expect(restored.body.results[0]!.ok).toBe(true)
    const back = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?path=/Keep')
    expect(back.body.files.map((entry) => entry.name)).toEqual(['a.txt'])

    // Trash the original, purge it: the copy still holds the same storage key.
    await call(USER, 'DELETE', '/api/clouddrive/files', { ids: [originalId] })
    const purgedOriginal = await call<{ deleted: number; failed: number }>(
      USER, 'DELETE', '/api/clouddrive/files/purge', { ids: [originalId] },
    )
    expect(purgedOriginal.body).toMatchObject({ deleted: 1, failed: 0 })
    expect(r2.objects.has(key)).toBe(true)

    await call(USER, 'DELETE', '/api/clouddrive/files', { ids: [copyRow.id] })
    const purgedCopy = await call<{ deleted: number; failed: number }>(
      USER, 'DELETE', '/api/clouddrive/files/purge', { ids: [copyRow.id] },
    )
    expect(purgedCopy.body.deleted).toBe(1)
    expect(r2.objects.has(key)).toBe(false)
  })

  it('restores under a free name when the original path was taken', async () => {
    const original = await insertEntry({ path: '/x.txt', name: 'x.txt' })
    await call(USER, 'DELETE', '/api/clouddrive/files', { ids: [original] })
    await insertEntry({ path: '/x.txt', name: 'x.txt' })

    const restored = await call<{ results: { ok: boolean; entry?: CloudDriveEntry }[] }>(
      USER, 'POST', '/api/clouddrive/files/restore', { ids: [original] },
    )
    expect(restored.body.results[0]!.ok).toBe(true)
    expect(restored.body.results[0]!.entry?.name).toBe('x (restored).txt')
    expect(restored.body.results[0]!.entry?.path).toBe('/x (restored).txt')
  })

  it('upserts, filters and removes tags case-insensitively', async () => {
    const folder = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Tagged',
    })
    const id = folder.body.entry.id

    const added = await call<{ entry: CloudDriveEntry }>(USER, 'POST', `/api/clouddrive/files/${id}/tags`, {
      tag: 'Work', color: '#dc2626',
    })
    expect(added.body.entry.tags).toEqual([{ name: 'Work', color: '#dc2626' }])

    const updated = await call<{ entry: CloudDriveEntry }>(USER, 'POST', `/api/clouddrive/files/${id}/tags`, {
      tag: 'work', color: '#2563eb',
    })
    expect(updated.body.entry.tags).toEqual([{ name: 'work', color: '#2563eb' }])

    const tags = await call<{ tags: { name: string; color: string; count: number }[] }>(USER, 'GET', '/api/clouddrive/tags')
    expect(tags.body.tags).toEqual([{ name: 'work', color: '#2563eb', count: 1 }])

    const filtered = await call<{ folders: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?tag=WORK')
    expect(filtered.body.folders.map((entry) => entry.name)).toEqual(['Tagged'])

    const removed = await call<{ entry: CloudDriveEntry }>(
      USER, 'DELETE', `/api/clouddrive/files/${id}/tags/${encodeURIComponent('WORK')}`,
    )
    expect(removed.body.entry.tags).toEqual([])
    const empty = await call<{ tags: unknown[] }>(USER, 'GET', '/api/clouddrive/tags')
    expect(empty.body.tags).toEqual([])
  })

  it('searches by filename and by pinyin initials, hiding .keep', async () => {
    await insertEntry({ path: '/报告.pdf', name: '报告.pdf', category: 'documents' })
    await insertEntry({ path: '/.keep', name: '.keep' })

    const byName = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', `/api/clouddrive/search?q=${encodeURIComponent('报告')}`)
    expect(byName.body.files.map((entry) => entry.name)).toEqual(['报告.pdf'])

    const byInitials = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/search?q=bg')
    expect(byInitials.body.files.map((entry) => entry.name)).toEqual(['报告.pdf'])

    const hidden = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/search?q=keep')
    expect(hidden.body.files).toEqual([])
    const listing = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?path=/')
    expect(listing.body.files.map((entry) => entry.name)).not.toContain('.keep')
  })

  it('hashes the WebDAV password and never returns it', async () => {
    const patched = await call<{ settings: Record<string, unknown> }>(USER, 'PATCH', '/api/clouddrive/settings', {
      webdavEnabled: true,
      webdavUsername: 'alice',
      webdavPassword: 'correct horse battery',
    })
    expect(patched.status).toBe(200)
    expect(patched.body.settings.webdavHasPassword).toBe(true)
    expect(patched.body.settings).not.toHaveProperty('webdavPasswordHash')
    expect(patched.body.settings).not.toHaveProperty('webdavPassword')

    const stored = await db.prepare(
      `SELECT value FROM CloudDrive_settings WHERE user_id = ? AND key = 'webdav.passwordHash'`,
    ).bind(USER).first<{ value: string }>()
    expect(stored?.value).toMatch(/^scrypt\$/)

    const bootstrap = await call<{ primaryMount: { id: string } | null }>(USER, 'GET', '/api/clouddrive/bootstrap')
    expect(bootstrap.body.primaryMount?.id).toBe('primary')

    const capacity = await call<{ used: number; trashBytes: number; mounts: unknown[] }>(USER, 'GET', '/api/clouddrive/capacity')
    expect(capacity.status).toBe(200)
    expect(capacity.body.mounts.length).toBeGreaterThan(0)
    expect(capacity.body.used).toBe(0)
  })

  it('stores a folder note and hides matching names from the listing only', async () => {
    const folderId = await insertEntry({ path: '/folder', name: 'folder', kind: 'folder' })
    const secretId = await insertEntry({ path: '/folder/secret.txt', name: 'secret.txt', parentId: folderId })
    await insertEntry({ path: '/folder/keep.txt', name: 'keep.txt', parentId: folderId })
    await insertEntry({ path: '/folder/secret-dir', name: 'secret-dir', kind: 'folder', parentId: folderId })

    const patched = await call<{ entry: CloudDriveEntry }>(USER, 'PATCH', `/api/clouddrive/files/${folderId}`, {
      note: 'Read me first',
      hidePatterns: ['secret*'],
    })
    expect(patched.status).toBe(200)
    expect(patched.body.entry.note).toBe('Read me first')
    expect(patched.body.entry.hiddenPatterns).toEqual(['secret*'])

    const listing = await call<CloudDriveListing>(USER, 'GET', '/api/clouddrive/files?path=/folder')
    expect(listing.body.note).toBe('Read me first')
    expect(listing.body.files.map((entry) => entry.name)).toEqual(['keep.txt'])
    expect(listing.body.folders).toEqual([])

    const direct = await call<{ entry: CloudDriveEntry }>(USER, 'GET', `/api/clouddrive/files/${secretId}`)
    expect(direct.status).toBe(200)
    expect(direct.body.entry.name).toBe('secret.txt')

    expect((await call(USER, 'PATCH', `/api/clouddrive/files/${secretId}`, { note: 'x' })).status).toBe(400)
    expect((await call(USER, 'PATCH', `/api/clouddrive/files/${folderId}`, { hidePatterns: ['x'.repeat(101)] })).status).toBe(400)
  })
})
