// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { createUsersTable } from './doubles/users-table'
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
  createUsersTable(sqlite)
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
  metadata?: string
  mime?: string
}): Promise<string> {
  const id = newId()
  const now = options.uploadedAt ?? Date.now()
  const name = options.name
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'r2', ?, ?, '',
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
    options.mime ?? 'application/octet-stream',
    options.size ?? 0,
    options.storageKey ?? null,
    options.metadata ?? '{}',
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

  it('creates an empty file the drive owns, with a category and a stored object', async () => {
    const created = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/files', {
      parentPath: '/', name: 'notes.md',
    })
    expect(created.status).toBe(201)
    expect(created.body.entry.kind).toBe('file')
    expect(created.body.entry.path).toBe('/notes.md')
    expect(created.body.entry.size).toBe(0)
    expect(created.body.entry.mime).toBe('text/plain')
    expect(created.body.entry.category).toBe('txt')
    const key = `CloudDrive/${created.body.entry.category}/${created.body.entry.id}`
    expect([...r2.objects.keys()]).toContain(key)
    expect(r2.objects.get(key)?.byteLength).toBe(0)

    const listing = await call<{ files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?path=/')
    expect(listing.body.files.map((entry) => entry.name)).toContain('notes.md')
  })

  it('refuses to create a file whose name the drive would not store', async () => {
    const badName = await call(USER, 'POST', '/api/clouddrive/files', { parentPath: '/', name: 'bad/name' })
    expect(badName.status).toBe(400)
    expect((badName.body as { error?: { code?: string } }).error?.code).toBe('clouddrive_path_invalid')
    expect([...r2.objects.keys()]).toEqual([])
  })

  it('reports a name clash on a new file with the name it would accept', async () => {
    const first = await call(USER, 'POST', '/api/clouddrive/files', { parentPath: '/', name: 'a.txt' })
    expect(first.status).toBe(201)
    const second = await call<{ error: { code: string; details?: { suggestedName?: string } } }>(
      USER, 'POST', '/api/clouddrive/files', { parentPath: '/', name: 'A.TXT' },
    )
    expect(second.status).toBe(409)
    expect(second.body.error.details?.suggestedName).toBe('A (1).TXT')
    // The placeholder written before the row was refused must not stay behind as an orphan.
    expect(r2.objects.size).toBe(1)
  })

  it('creates an html name as plain text, never as a type the browser would run', async () => {
    const created = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/files', {
      parentPath: '/', name: 'page.html',
    })
    expect(created.status).toBe(201)
    expect(created.body.entry.mime).not.toBe('text/html')
    expect(created.body.entry.mime).toBe('text/plain')
  })

  it('groups the album by the capture time an image carries, not by the import date', async () => {
    const taken = Date.UTC(2020, 4, 1, 9, 0, 0)
    const imported = Date.UTC(2026, 10, 2, 9, 0, 0)
    await insertEntry({ path: '/shot.jpg', name: 'shot.jpg', category: 'images', uploadedAt: imported, metadata: JSON.stringify({ takenAt: taken }) })
    await insertEntry({ path: '/plain.jpg', name: 'plain.jpg', category: 'images', uploadedAt: imported })

    const album = await call<{ groups: { month: string; files: { name: string; takenAt: number | null }[] }[]; cursor: string | null }>(
      USER, 'GET', '/api/clouddrive/album',
    )
    expect(album.status).toBe(200)
    expect(album.body.groups.map((group) => group.month)).toEqual(['2026-11', '2020-05'])
    const stamped = album.body.groups[1]!.files[0]!
    expect(stamped.name).toBe('shot.jpg')
    expect(stamped.takenAt).toBe(taken)
    expect(album.body.groups[0]!.files[0]!.takenAt).toBeNull()
  })

  it('filters the album to videos and to both kinds without breaking on a corrupt stamp', async () => {
    await insertEntry({ path: '/clip.mp4', name: 'clip.mp4', category: 'videos', mime: 'video/mp4' })
    await insertEntry({ path: '/pic.png', name: 'pic.png', category: 'images' })
    await insertEntry({ path: '/broken.jpg', name: 'broken.jpg', category: 'images', metadata: 'not json' })

    const videos = await call<{ groups: { files: { name: string }[] }[] }>(USER, 'GET', '/api/clouddrive/album?kind=videos')
    expect(videos.body.groups.flatMap((group) => group.files).map((file) => file.name)).toEqual(['clip.mp4'])
    const all = await call<{ groups: { files: { name: string }[] }[] }>(USER, 'GET', '/api/clouddrive/album?kind=all')
    expect(all.body.groups.flatMap((group) => group.files).map((file) => file.name).sort()).toEqual(['broken.jpg', 'clip.mp4', 'pic.png'])
    // A row whose metadata is not JSON still lists, grouped by its upload time.
    const images = await call<{ groups: { files: { name: string }[] }[] }>(USER, 'GET', '/api/clouddrive/album')
    expect(images.body.groups.flatMap((group) => group.files).map((file) => file.name).sort()).toEqual(['broken.jpg', 'pic.png'])
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

  it('refuses tags, versions and the tag panel inside a locked folder', async () => {
    const vault = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Vault',
    })
    const inner = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/Vault', name: 'notes',
    })
    const fileId = await insertEntry({ path: '/Vault/todo.txt', name: 'todo.txt', parentId: vault.body.entry.id })
    expect((await call(USER, 'POST', `/api/clouddrive/files/${inner.body.entry.id}/tags`, { tag: 'internal' })).status).toBe(200)

    const locked = await call(USER, 'PUT', '/api/clouddrive/meta', { mountId: 'primary', path: '/Vault', password: 'hunter2' })
    expect(locked.status).toBe(200)

    expect((await call(USER, 'POST', `/api/clouddrive/files/${fileId}/tags`, { tag: 'leak' })).status).toBe(403)
    expect((await call(USER, 'DELETE', `/api/clouddrive/files/${fileId}/tags/leak`)).status).toBe(403)
    expect((await call(USER, 'GET', `/api/clouddrive/files/${fileId}/versions`)).status).toBe(403)
    const panel = await call<{ tags: { name: string }[] }>(USER, 'GET', '/api/clouddrive/tags')
    expect(panel.body.tags.map((tag) => tag.name)).not.toContain('internal')

    // The locked folder is still listed in its parent, so its own tag stays in the panel.
    expect((await call(USER, 'POST', `/api/clouddrive/files/${vault.body.entry.id}/tags`, { tag: 'on-vault' })).status).toBe(200)
    const after = await call<{ tags: { name: string }[] }>(USER, 'GET', '/api/clouddrive/tags')
    expect(after.body.tags.map((tag) => tag.name)).toContain('on-vault')
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
    // Trash lists the deleted root, not every row under it: the child rides with its folder and the
    // flag says so, so one restore click brings the whole subtree back.
    expect(trashed.body.folders.map((entry) => entry.name)).toEqual(['Keep'])
    expect(trashed.body.folders[0]!.descendantsTrashed).toBe(true)
    expect(trashed.body.folders[0]!.deletedAt).toBeTypeOf('number')
    expect(trashed.body.files).toEqual([])

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

  it('restores a trashed folder together with the subtree inside it', async () => {
    const folder = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Deep',
    })
    const inner = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/Deep', name: 'inner',
    })
    await insertEntry({ path: '/Deep/inner/note.txt', name: 'note.txt', parentId: inner.body.entry.id })

    const deleted = await call<{ deleted: number }>(USER, 'DELETE', '/api/clouddrive/files', { ids: [folder.body.entry.id] })
    expect(deleted.body.deleted).toBe(3)
    const trashed = await call<{ folders: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/trash')
    expect(trashed.body.folders.map((entry) => entry.path)).toEqual(['/Deep'])

    const restored = await call<{ results: { ok: boolean }[] }>(
      USER, 'POST', '/api/clouddrive/files/restore', { ids: [folder.body.entry.id] },
    )
    expect(restored.body.results[0]!.ok).toBe(true)
    const back = await call<{ folders: CloudDriveEntry[]; files: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/files?path=/Deep/inner')
    expect(back.body.files.map((entry) => entry.name)).toEqual(['note.txt'])
    const stillGone = await call<{ folders: CloudDriveEntry[] }>(USER, 'GET', '/api/clouddrive/trash')
    expect(stillGone.body.folders).toEqual([])
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

  it('applies each folder’s own hiding rules to a search that spans them', async () => {
    const a = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'A' })
    const b = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'B' })
    await insertEntry({ path: '/A/keep.txt', name: 'keep.txt', parentId: a.body.entry.id })
    await insertEntry({ path: '/A/skip.tmp', name: 'skip.tmp', parentId: a.body.entry.id })
    await insertEntry({ path: '/B/keep.txt', name: 'keep.txt', parentId: b.body.entry.id })
    expect((await call(USER, 'PATCH', `/api/clouddrive/files/${a.body.entry.id}`, { hidePatterns: ['*.tmp'] })).status).toBe(200)
    expect((await call(USER, 'PATCH', `/api/clouddrive/files/${b.body.entry.id}`, { hidePatterns: ['keep.txt'] })).status).toBe(200)

    // Batched metadata has to stay per path: one answer reused across the two folders would either
    // hide both files or show both.
    const found = await call<{ files: { path: string }[] }>(USER, 'GET', '/api/clouddrive/search?q=keep')
    expect(found.body.files.map((file) => file.path)).toEqual(['/A/keep.txt'])
    const inA = await call<{ files: { name: string }[] }>(USER, 'GET', '/api/clouddrive/files?path=%2FA')
    expect(inA.body.files.map((file) => file.name)).toEqual(['keep.txt'])
    const inB = await call<{ files: { name: string }[] }>(USER, 'GET', '/api/clouddrive/files?path=%2FB')
    expect(inB.body.files).toEqual([])
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

  it('packs a folder into a zip the reader can unzip', async () => {
    const folder = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Docs',
    })
    const deep = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/Docs', name: 'deep',
    })
    await r2.put('CloudDrive/txt/zip-a', new TextEncoder().encode('first file'))
    await r2.put('CloudDrive/txt/zip-b', new TextEncoder().encode('nested file'))
    await insertEntry({
      path: '/Docs/a.txt', name: 'a.txt', parentId: folder.body.entry.id,
      storageKey: 'CloudDrive/txt/zip-a', size: 10,
    })
    await insertEntry({
      path: '/Docs/deep/b.txt', name: 'b.txt', parentId: deep.body.entry.id,
      storageKey: 'CloudDrive/txt/zip-b', size: 11,
    })

    const response = await buildApp(USER).fetch(
      new Request('http://localhost/api/clouddrive/download/zip?mount=primary&path=/Docs'),
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('Docs.zip')
    expect(response.headers.get('x-clouddrive-zip-items')).toBe('2')

    const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()))
    // The archive carries the folder itself and each nested folder; `unzipSync` reports a directory
    // member by its name without the trailing slash.
    expect(Object.keys(unzipped).sort()).toEqual(['Docs', 'Docs/a.txt', 'Docs/deep', 'Docs/deep/b.txt'])
    expect(new TextDecoder().decode(unzipped['Docs/a.txt'])).toBe('first file')
    expect(new TextDecoder().decode(unzipped['Docs/deep/b.txt'])).toBe('nested file')
  })

  it('refuses to archive a single file, and hides what the folder hides', async () => {
    await insertEntry({ path: '/solo.txt', name: 'solo.txt', size: 1 })
    const solo = await call(USER, 'GET', '/api/clouddrive/download/zip?mount=primary&path=/solo.txt')
    expect(solo.status).toBe(400)

    const folder = await call<{ entry: CloudDriveEntry }>(USER, 'POST', '/api/clouddrive/folders', {
      parentPath: '/', name: 'Mixed',
    })
    await r2.put('CloudDrive/txt/zip-keep', new TextEncoder().encode('kept'))
    await r2.put('CloudDrive/txt/zip-hide', new TextEncoder().encode('hidden'))
    await insertEntry({
      path: '/Mixed/keep.txt', name: 'keep.txt', parentId: folder.body.entry.id,
      storageKey: 'CloudDrive/txt/zip-keep', size: 4,
    })
    await insertEntry({
      path: '/Mixed/secret.txt', name: 'secret.txt', parentId: folder.body.entry.id,
      storageKey: 'CloudDrive/txt/zip-hide', size: 6,
    })
    await call(USER, 'PATCH', `/api/clouddrive/files/${folder.body.entry.id}`, { hidePatterns: ['secret*'] })

    const response = await buildApp(USER).fetch(
      new Request('http://localhost/api/clouddrive/download/zip?mount=primary&path=/Mixed'),
      env,
    )
    expect(response.status).toBe(200)
    const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(unzipped)).toEqual(['Mixed', 'Mixed/keep.txt'])
  })
})
