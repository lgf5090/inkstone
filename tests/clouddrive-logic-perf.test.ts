// @vitest-environment node
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { ensurePrimaryMount, readCloudDriveUsageCounts } from '../src/worker/clouddrive/store'
import { hashToken } from '../src/worker/lib/session-store'
import { newId } from '../src/worker/lib/id'
import { foldedName } from '../src/shared/clouddrive/model'
import type { Env } from '../src/worker/env'
import { initialsOf } from '../src/worker/clouddrive/lib'
import { makeD1 } from './doubles/d1-sqlite'
import { createUsersTable } from './doubles/users-table'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const OWNER_TOKEN = 'a'.repeat(64)
const MEMBER_TOKEN = 'b'.repeat(64)
const VISITOR_IP = '203.0.113.20'

interface Harness {
  sqlite: DatabaseSync
  env: Env
  bucket: TestR2Bucket
  app: ReturnType<typeof createApp>
}

let h: Harness

beforeEach(async () => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  const bucket = testR2Bucket()
  const env = testBindings(makeD1(sqlite), { FILES: bucket })
  const app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const user of [
    { id: OWNER, username: 'owner', role: 'owner', token: OWNER_TOKEN },
    { id: MEMBER, username: 'member', role: 'member', token: MEMBER_TOKEN },
  ]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', ?, '{}', ?, ?)`,
    ).run(user.id, user.username, user.username, user.username, user.role, now, now)
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(await hashToken(user.token), user.id, now + 600_000, now)
    await ensurePrimaryMount(env.DB, user.id)
  }
  h = { sqlite, env, bucket, app }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  h.sqlite.close()
})

async function request(
  method: string,
  path: string,
  options: { user?: typeof OWNER | typeof MEMBER | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.user === OWNER) headers.set('Cookie', `inkstone_session=${OWNER_TOKEN}`)
  if (options.user === MEMBER) headers.set('Cookie', `inkstone_session=${MEMBER_TOKEN}`)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD'].includes(method)) headers.set('X-Inkstone-Client', '1')
  return await h.app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), h.env)
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return await response.json() as T
}

interface EntryOptions {
  user?: string
  parentId?: string
  path: string
  name?: string
  kind?: 'folder' | 'file'
  size?: number
  category?: string
  mime?: string
  storageKey?: string | null
  storageKind?: string
  metadata?: string
  uploadedAt?: number
  viewedAt?: number | null
  starredAt?: number | null
  deletedAt?: number | null
  content?: string
}

async function insertEntry(options: EntryOptions): Promise<string> {
  const id = newId()
  const name = options.name ?? options.path.split('/').pop()!
  const now = options.uploadedAt ?? Date.now()
  const storageKey = options.storageKey === undefined
    ? options.kind === 'folder' ? null : `CloudDrive/txt/${id}`
    : options.storageKey
  if (options.content !== undefined && storageKey) {
    await h.bucket.put(storageKey, new TextEncoder().encode(options.content), {
      httpMetadata: { contentType: options.mime ?? 'text/plain' },
    })
  }
  h.sqlite.prepare(
    `INSERT INTO CloudDrive_files
       (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,
        etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,
        trash_batch,created_at,updated_at,uploaded_at,modified_at)
     VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, '',
             ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    id, options.user ?? OWNER, options.parentId ?? '', options.kind ?? 'file', name, foldedName(name),
    initialsOf(name), options.path, options.category ?? 'txt', options.mime ?? 'text/plain', options.size ?? 0,
    options.storageKind ?? 'r2', storageKey, options.metadata ?? '{}', options.starredAt ?? null,
    options.viewedAt ?? null, options.deletedAt ?? null, now, now, now, now,
  )
  return id
}

async function insertShare(fileId: string, slug = newId(), targetKind: 'file' | 'folder' = 'file'): Promise<void> {
  const now = Date.now()
  h.sqlite.prepare(
    `INSERT INTO CloudDrive_shares
       (slug,user_id,target_kind,file_id,mount_id,path,name,size,mime,password_hash,expires_at,
        max_views,views,max_downloads,downloads,allow_download,allow_list,is_enabled,created_at)
     VALUES (?, ?, ?, ?, 'primary', '/shared', 'shared', 4, 'text/plain', NULL, NULL,
             NULL,0,NULL,0,1,1,1,?)`,
  ).run(slug, OWNER, targetKind, fileId, now)
}

function rangedServer(bytes: Uint8Array): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get('Range')) {
      return new Response(bytes.slice(0, 1), {
        status: 206,
        headers: { 'Content-Length': '1', 'Content-Range': `bytes 0-0/${bytes.byteLength}`, 'Content-Type': 'text/plain' },
      })
    }
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Length': String(bytes.byteLength), 'Content-Type': 'text/plain' },
    })
  }) as typeof fetch
}

describe('CloudDrive logic and performance remediation', () => {
  it('LOG-04 charges simultaneous downloads from one visitor/file/window once', async () => {
    const fileId = await insertEntry({ path: '/shared', content: 'data', size: 4 })
    const slug = newId()
    await insertShare(fileId, slug)

    const responses = await Promise.all(Array.from({ length: 8 }, () => request(
      'GET', `/api/public/clouddrive/shares/${slug}/download`,
      { headers: { 'CF-Connecting-IP': VISITOR_IP } },
    )))
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(h.sqlite.prepare('SELECT downloads FROM CloudDrive_shares WHERE slug = ?').get(slug))
      .toMatchObject({ downloads: 1 })
    expect(h.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_share_visits WHERE slug = ? AND kind = 'download'`,
    ).get(slug)).toMatchObject({ count: 1 })
  })

  it('LOG-05 resumes a public folder by keyset when a file is inserted between pages', async () => {
    const folder = await insertEntry({ path: '/docs', kind: 'folder' })
    for (let index = 0; index < 250; index++) {
      const name = `f-${String(index).padStart(3, '0')}.txt`
      await insertEntry({ parentId: folder, path: `/docs/${name}`, name })
    }
    const slug = newId()
    await insertShare(folder, slug, 'folder')

    const first = await json<{ entries: { name: string }[]; cursor: string; total: number }>(
      await request('GET', `/api/public/clouddrive/shares/${slug}/list`),
    )
    expect(first.entries).toHaveLength(200)
    expect(first.total).toBe(250)
    const inserted = await insertEntry({ parentId: folder, path: '/docs/f-100a.txt' })
    const second = await json<{ entries: { name: string }[]; cursor: null; total: number }>(
      await request('GET', `/api/public/clouddrive/shares/${slug}/list?cursor=${encodeURIComponent(first.cursor)}`),
    )
    const names = [...first.entries, ...second.entries].map((entry) => entry.name)
    expect(new Set(names).size).toBe(250)
    expect(names).not.toContain('f-100a.txt')
    expect(second.entries[0]?.name).toBe('f-200.txt')
    expect(second.total).toBe(251)
    expect(second.cursor).toBeNull()
    expect(h.sqlite.prepare('SELECT id FROM CloudDrive_files WHERE id = ?').get(inserted)).toBeTruthy()
    expect((await request('GET', `/api/public/clouddrive/shares/${slug}/list?cursor=garbage`)).status).toBe(400)
  })

  it('LOG-05 fills ACL pages after hidden rows are removed and keeps grants keyset paged', async () => {
    const folder = await insertEntry({
      path: '/docs', kind: 'folder', metadata: JSON.stringify({ hidePatterns: ['hidden-*'] }),
    })
    for (let index = 0; index < 101; index++) {
      const name = `visible-${String(index).padStart(3, '0')}.txt`
      await insertEntry({ parentId: folder, path: `/docs/${name}`, name })
    }
    for (let index = 0; index < 30; index++) {
      const name = `hidden-${String(index).padStart(3, '0')}.txt`
      await insertEntry({ parentId: folder, path: `/docs/${name}`, name })
    }
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_acl (owner_id,file_id,grantee_id,role,expires_at,created_at,revoked_at)
       VALUES (?, ?, ?, 'viewer', NULL, ?, NULL)`,
    ).run(OWNER, folder, MEMBER, Date.now())

    const first = await json<{ entries: { name: string }[]; cursor: string }>(await request(
      'GET', `/api/clouddrive/acl/shared/${OWNER}/${folder}/list?path=%2Fdocs&limit=100`, { user: MEMBER },
    ))
    expect(first.entries).toHaveLength(100)
    expect(first.entries.every((entry) => !entry.name.startsWith('hidden-'))).toBe(true)
    const second = await json<{ entries: { name: string }[]; cursor: null }>(await request(
      'GET', `/api/clouddrive/acl/shared/${OWNER}/${folder}/list?path=%2Fdocs&limit=100&cursor=${encodeURIComponent(first.cursor)}`,
      { user: MEMBER },
    ))
    expect(second.entries).toHaveLength(1)
    expect(second.cursor).toBeNull()
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size).toBe(101)
  })

  it('LOG-05 pages recent rows with tied timestamps and rejects a cursor from another kind', async () => {
    const now = Date.now()
    for (let index = 0; index < 101; index++) {
      await insertEntry({ path: `/recent-${index}.txt`, uploadedAt: now, viewedAt: now })
    }
    const first = await json<{ files: { id: string }[]; cursor: string }>(await request(
      'GET', '/api/clouddrive/recent?kind=viewed&limit=100', { user: OWNER },
    ))
    await insertEntry({ path: '/newer.txt', uploadedAt: now + 1, viewedAt: now + 1 })
    const second = await json<{ files: { id: string }[]; cursor: null }>(await request(
      'GET', `/api/clouddrive/recent?kind=viewed&limit=100&cursor=${encodeURIComponent(first.cursor)}`, { user: OWNER },
    ))
    expect(second.files).toHaveLength(1)
    expect(second.cursor).toBeNull()
    expect(new Set([...first.files, ...second.files].map((file) => file.id)).size).toBe(101)
    expect((await request(
      'GET', `/api/clouddrive/recent?kind=uploaded&cursor=${encodeURIComponent(first.cursor)}`, { user: OWNER },
    )).status).toBe(400)
  })

  it('LOG-09 moves a selected parent once and preserves its selected descendants', async () => {
    const parent = await insertEntry({ path: '/parent', kind: 'folder' })
    const child = await insertEntry({ path: '/parent/child', parentId: parent, kind: 'folder' })
    const file = await insertEntry({ path: '/parent/child/note.txt', parentId: child })
    await insertEntry({ path: '/target', kind: 'folder' })

    const response = await request('POST', '/api/clouddrive/files/move', {
      user: OWNER, body: { ids: [child, parent], toPath: '/target' },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ results: [{ id: parent, ok: true, toPath: '/target/parent' }] })
    expect(h.sqlite.prepare('SELECT parent_id, path FROM CloudDrive_files WHERE id = ?').get(child))
      .toMatchObject({ parent_id: parent, path: '/target/parent/child' })
    expect(h.sqlite.prepare('SELECT parent_id, path FROM CloudDrive_files WHERE id = ?').get(file))
      .toMatchObject({ parent_id: child, path: '/target/parent/child/note.txt' })
    expect(h.sqlite.prepare(`SELECT id FROM CloudDrive_files WHERE path = '/target/child'`).get()).toBeUndefined()
  })

  it('LOG-10 keeps total equal to visible files across hidden-row cursor pages', async () => {
    const folder = await insertEntry({
      path: '/docs', kind: 'folder', metadata: JSON.stringify({ hidePatterns: ['secret-*'] }),
    })
    for (let index = 0; index < 105; index++) {
      const name = `visible-${String(index).padStart(3, '0')}.txt`
      await insertEntry({ parentId: folder, path: `/docs/${name}`, name })
    }
    for (let index = 0; index < 25; index++) {
      const name = `secret-${String(index).padStart(3, '0')}.txt`
      await insertEntry({ parentId: folder, path: `/docs/${name}`, name })
    }
    const first = await json<{ files: { name: string }[]; total: number; cursor: string }>(await request(
      'GET', '/api/clouddrive/files?path=%2Fdocs&limit=100', { user: OWNER },
    ))
    const second = await json<{ files: { name: string }[]; total: number; cursor: null }>(await request(
      'GET', `/api/clouddrive/files?path=%2Fdocs&limit=100&cursor=${encodeURIComponent(first.cursor)}`, { user: OWNER },
    ))
    expect(first.total).toBe(105)
    expect(second.total).toBe(105)
    const files = [...first.files, ...second.files]
    expect(files).toHaveLength(105)
    expect(files.every((file) => !file.name.startsWith('secret-'))).toBe(true)
  })

  it('PERF-07 caches deduplicated object bytes and force-calibrates through the jobs API', async () => {
    await insertEntry({ path: '/a.txt', size: 5, storageKey: 'shared-key' })
    await insertEntry({ path: '/b.txt', size: 9, storageKey: 'shared-key' })
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_file_versions (user_id,file_id,version,storage_key,size,mime,etag,checksum,created_at)
       VALUES (?, (SELECT id FROM CloudDrive_files WHERE path = '/a.txt'), 1, 'shared-key', 11, 'text/plain', NULL, NULL, ?)`,
    ).run(OWNER, Date.now())
    await insertEntry({ path: '/trashed.txt', size: 7, storageKey: 'trash-key', deletedAt: Date.now() })
    const distributed = await insertEntry({ path: '/parts.bin', size: 13, storageKey: null, storageKind: 'distributed' })
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_file_parts (user_id,file_id,part_number,mount_id,storage_key,size,etag,created_at)
       VALUES (?, ?, 1, 'primary', 'part-key', 3, NULL, ?)`,
    ).run(OWNER, distributed, Date.now())

    expect(await readCloudDriveUsageCounts(h.env.DB, OWNER, { force: true }))
      .toEqual({ liveBytes: 14, trashBytes: 7, usedBytes: 21 })
    expect(h.sqlite.prepare('SELECT used_bytes, calibrated_at FROM CloudDrive_usage WHERE user_id = ?').get(OWNER))
      .toMatchObject({ used_bytes: 21 })
    h.sqlite.prepare('UPDATE CloudDrive_usage SET used_bytes = 999, live_bytes = 999 WHERE user_id = ?').run(OWNER)
    expect((await request('GET', '/api/clouddrive/jobs', { user: OWNER })).status).toBe(200)
    const run = await request('POST', '/api/clouddrive/jobs/builtin_refresh_storage_usage/run', { user: OWNER })
    expect(run.status).toBe(200)
    expect(await json<{ run: { status: string; result: { usedBytes: number } } }>(run))
      .toMatchObject({ run: { status: 'success', result: { usedBytes: 21 } } })
    expect(h.sqlite.prepare('SELECT used_bytes, live_bytes FROM CloudDrive_usage WHERE user_id = ?').get(OWNER))
      .toMatchObject({ used_bytes: 21, live_bytes: 14 })
  })

  it('PERF-07 applies the same trash-inclusive quota to ACL saves', async () => {
    const shared = await insertEntry({ path: '/shared.txt', size: 1, storageKey: 'owner-shared' })
    await insertEntry({ user: MEMBER, path: '/trashed.txt', size: 10, storageKey: 'member-trash', deletedAt: Date.now() })
    h.sqlite.prepare(
      `INSERT INTO CloudDrive_acl (owner_id,file_id,grantee_id,role,expires_at,created_at,revoked_at)
       VALUES (?, ?, ?, 'viewer', NULL, ?, NULL)`,
    ).run(OWNER, shared, MEMBER, Date.now())
    expect((await request('PATCH', '/api/clouddrive/settings', {
      user: OWNER, body: { quotaDefaultBytes: 10 },
    })).status).toBe(200)

    const response = await request('POST', '/api/clouddrive/acl/save', {
      user: MEMBER, body: { ownerId: OWNER, fileId: shared, toPath: '/' },
    })
    expect(response.status).toBe(403)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({ error: { code: 'clouddrive_quota_exceeded' } })
  })

  it('PERF-08 rate-limits URL upload starts before another outbound probe', async () => {
    const fetchMock = vi.fn(rangedServer(new TextEncoder().encode('data')))
    vi.stubGlobal('fetch', fetchMock)
    for (let index = 0; index < 5; index++) {
      const response = await request('POST', '/api/clouddrive/uploads/url', {
        user: OWNER,
        body: { url: `https://example.com/${index}.txt`, name: `${index}.txt` },
      })
      expect(response.status).toBe(202)
    }
    const callsBefore = fetchMock.mock.calls.length
    const limited = await request('POST', '/api/clouddrive/uploads/url', {
      user: OWNER, body: { url: 'https://example.com/limited.txt' },
    })
    expect(limited.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS count FROM CloudDrive_tasks WHERE type = 'url_upload'`).get())
      .toMatchObject({ count: 5 })
  })

  it('PERF-08 fails a transfer that ends before its inspected length without creating a file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        status: 206,
        headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/4', 'Content-Type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { 'Content-Length': '4', 'Content-Type': 'text/plain' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await request('POST', '/api/clouddrive/uploads/url', {
      user: OWNER, body: { url: 'https://example.com/short.txt' },
    })).status).toBe(202)
    expect(h.sqlite.prepare(`SELECT status, error FROM CloudDrive_tasks WHERE type = 'url_upload'`).get())
      .toMatchObject({ status: 'failed', error: expect.stringMatching(/changed length|match/i) })
    expect(h.sqlite.prepare('SELECT id FROM CloudDrive_files WHERE user_id = ?').get(OWNER)).toBeUndefined()
  })

  it('UX-07 keeps the public store entry while listing and tags have separate modules', () => {
    const facade = readFileSync(new URL('../src/worker/clouddrive/store-files.ts', import.meta.url), 'utf8')
    const listing = readFileSync(new URL('../src/worker/clouddrive/store-files-list.ts', import.meta.url), 'utf8')
    const tags = readFileSync(new URL('../src/worker/clouddrive/store-files-tags.ts', import.meta.url), 'utf8')
    expect(facade).toContain("from './store-files-list'")
    expect(facade).toContain("from './store-files-tags'")
    expect(facade).not.toContain('export async function listFolder')
    expect(facade).not.toContain('export async function recentEntries')
    expect(listing).toContain('export async function listFolder')
    expect(listing).toContain('export async function recentEntries')
    expect(tags).toContain('export async function upsertTag')
  })
})
