// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { clouddrivePublicRoutes, clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { foldedName } from '../src/shared/clouddrive/model'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { createLoginAttemptsTable } from './doubles/login-attempts'
import { createUsersTable } from './doubles/users-table'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const OTHER = '0123456789abcdefghjkmnpqru'

let sqlite: DatabaseSync
let db: D1Database
let r2: TestR2Bucket
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  createLoginAttemptsTable(sqlite)
  const now = Date.now()
  for (const [id, username] of [[OWNER, 'owner'], [MEMBER, 'member'], [OTHER, 'other']] as const) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
    ).run(id, username, username, username, now, now)
  }
  db = makeD1(sqlite)
  r2 = testR2Bucket()
  env = testBindings(db, { FILES: r2 })
})

function app(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, context) => errorResponse(context, error))
  instance.use('*', async (context, next) => {
    context.set('userId', userId)
    context.set('user', {
      id: userId,
      username: userId === OWNER ? 'owner' : userId === MEMBER ? 'member' : 'other',
      login: 'tester',
      name: 'Tester',
      avatarUrl: '',
      role: 'owner',
      createdAt: 1,
      settingsRaw: '{}',
    })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  instance.route('/api/public/clouddrive', clouddrivePublicRoutes)
  return instance
}

async function call<T = Record<string, unknown>>(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; response: Response }> {
  const response = await app(userId).fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.clone().text()
  let parsed: T = {} as T
  try { parsed = (text ? JSON.parse(text) : {}) as T } catch { parsed = { text } as T }
  return { status: response.status, body: parsed, response }
}

async function mount(id: string, storageId = 'primary'): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO CloudDrive_mounts
       (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy,
        weight, sort_order, enabled, remark, folder_summary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 300, 0, 'native_proxy', 1, 0, 1, '', 0, ?6, ?6)`,
  ).bind(OWNER, id, storageId, id, `/${id}`, now).run()
}

async function entry(options: {
  userId?: string
  mountId?: string
  parentId?: string
  path: string
  name: string
  kind?: 'folder' | 'file'
  content?: string
  storageKind?: 'r2' | 'distributed' | 'external'
}): Promise<string> {
  const id = newId()
  const kind = options.kind ?? 'file'
  const content = options.content ?? options.name
  const key = kind === 'file' && options.storageKind !== 'distributed' ? `CloudDrive/txt/${id}` : null
  if (key) await r2.put(key, new TextEncoder().encode(content))
  const now = Date.now()
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, 'txt', 'text/plain', ?9, NULL, NULL, ?10, ?11,
             '{}', '', NULL, NULL, NULL, NULL, ?12, ?12, ?12, ?12)`,
  ).bind(
    id, options.userId ?? OWNER, options.mountId ?? 'primary', options.parentId ?? '', kind,
    options.name, foldedName(options.name), options.path, content.length, options.storageKind ?? 'r2', key, now,
  ).run()
  return id
}

async function primaryRow(userId: string, id: string) {
  const row = await db.prepare(
    `SELECT mount_id, path, deleted_at, storage_key FROM CloudDrive_files WHERE user_id = ? AND id = ?`,
  ).bind(userId, id).first<{ mount_id: string; path: string; deleted_at: number | null; storage_key: string | null }>()
  if (!row) throw new Error('row missing')
  return row
}

describe('CloudDrive FEAT-01 through FEAT-05', () => {
  it('upgrades existing ACL columns and backfills the FTS index', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
      CREATE TABLE CloudDrive_files (name TEXT NOT NULL, name_initials TEXT NOT NULL DEFAULT '', deleted_at INTEGER);
      CREATE TABLE CloudDrive_acl (owner_id TEXT NOT NULL, file_id TEXT NOT NULL, grantee_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      INSERT INTO CloudDrive_files (name, name_initials) VALUES ('Migration report', 'migration');
      INSERT INTO CloudDrive_acl (owner_id, file_id, grantee_id, created_at) VALUES ('owner', 'file', 'member', 1);
    `)
    for (const migration of SCHEMA_MIGRATIONS.filter((item) => item.version >= 428 && item.version <= 431)) {
      for (const statement of migration.statements) legacy.exec(statement)
    }
    const acl = legacy.prepare('SELECT role, expires_at FROM CloudDrive_acl').get() as { role: string; expires_at: number | null }
    expect(acl).toEqual({ role: 'commenter', expires_at: null })
    expect(legacy.prepare("SELECT count(*) AS count FROM CloudDrive_files_fts WHERE CloudDrive_files_fts MATCH 'migration'").get())
      .toMatchObject({ count: 1 })
    legacy.close()
  })

  it('copies and moves primary R2 rows across mounts and refuses external destinations', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    const copied = await entry({ path: '/copy.txt', name: 'copy.txt', content: 'copy' })
    const moved = await entry({ path: '/move.txt', name: 'move.txt', content: 'move' })
    const sourceKey = (await primaryRow(OWNER, copied)).storage_key

    const copy = await call<{ results: { id: string; ok: boolean; toPath: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'archive', ids: [copied], toPath: '/' },
    )
    expect(copy.status).toBe(200)
    expect(copy.body.results[0]).toMatchObject({ id: copied, ok: true, toPath: '/copy.txt' })
    const destination = await db.prepare(
      `SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/copy.txt'`,
    ).bind(OWNER).first<{ storage_key: string }>()
    expect(destination?.storage_key).toBe(sourceKey)
    expect((await primaryRow(OWNER, copied)).deleted_at).toBeNull()

    const move = await call(OWNER, 'POST', '/api/clouddrive/files/move',
      { mountId: 'primary', toMountId: 'archive', ids: [moved], toPath: '/' })
    expect(move.status).toBe(200)
    expect((await primaryRow(OWNER, moved)).deleted_at).not.toBeNull()
    expect(await db.prepare(`SELECT 1 AS hit FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/move.txt'`)
      .bind(OWNER).first()).not.toBeNull()

    await db.prepare(
      `INSERT INTO CloudDrive_storages (user_id,id,name,type,config,credentials,status,is_default,api_key_visible,read_quota,default_path,created_at,updated_at)
       VALUES (?1,'external','External','s3','{}','','enabled',0,0,0,'/',?2,?2)`,
    ).bind(OWNER, Date.now()).run()
    await mount('remote', 'external')
    const refused = await call(OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'remote', ids: [copied], toPath: '/' })
    expect(refused.status).toBe(403)
    expect((refused.body as { error: { code: string } }).error.code).toBe('clouddrive_read_only')
  })

  it('uses FTS5 for cross-mount search and keeps rename/trash/account isolation', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    const first = await entry({ path: '/quarterly-report.txt', name: 'quarterly-report.txt' })
    const second = await entry({ mountId: 'archive', path: '/quarterly-report-2.txt', name: 'quarterly-report-2.txt' })
    await entry({ userId: OTHER, path: '/quarterly-report-private.txt', name: 'quarterly-report-private.txt' })

    const found = await call<{ files: { id: string; mountId: string }[] }>(
      OWNER, 'GET', '/api/clouddrive/search?scope=all&q=quarterly',
    )
    expect(found.status).toBe(200)
    expect(found.body.files.map((file) => file.id).sort()).toEqual([first, second].sort())
    expect(new Set(found.body.files.map((file) => file.mountId))).toEqual(new Set(['primary', 'archive']))

    expect((await call(OWNER, 'PATCH', `/api/clouddrive/files/${first}`, { name: 'renamed.txt' })).status).toBe(200)
    expect((await call<{ files: { id: string }[] }>(OWNER, 'GET', '/api/clouddrive/search?scope=all&q=quarterly')).body.files.map((file) => file.id)).toEqual([second])
    expect((await call<{ files: { id: string }[] }>(OWNER, 'GET', '/api/clouddrive/search?scope=all&q=renamed')).body.files.map((file) => file.id)).toEqual([first])
    await call(OWNER, 'DELETE', '/api/clouddrive/files', { mountId: 'archive', ids: [second] })
    expect((await call<{ files: unknown[] }>(OWNER, 'GET', '/api/clouddrive/search?scope=all&q=quarterly')).body.files).toEqual([])
  })

  it('saves a public share into the recipient drive and streams a folder share as ZIP', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/team', name: 'team', kind: 'folder', content: '' })
    const child = await entry({ parentId: folder, path: '/team/readme.txt', name: 'readme.txt', content: 'shared bytes' })
    const created = await call<{ share: { slug: string } }>(OWNER, 'POST', '/api/clouddrive/shares', {
      targetKind: 'folder', fileId: folder, path: '/team', allowDownload: true,
    })
    const slug = created.body.share.slug

    const saved = await call<{ saved: number; entry: { path: string } }>(MEMBER, 'POST', `/api/clouddrive/shares/${slug}/save`, { toPath: '/' })
    expect(saved.status).toBe(201)
    expect(saved.body.saved).toBe(2)
    expect(saved.body.entry.path).toBe('/team')
    const memberChild = await db.prepare(
      `SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND path = '/team/readme.txt' AND deleted_at IS NULL`,
    ).bind(MEMBER).first<{ storage_key: string }>()
    expect(memberChild?.storage_key).toBe((await primaryRow(OWNER, child)).storage_key)

    const zipped = await call(OWNER, 'GET', `/api/public/clouddrive/shares/${slug}/zip`)
    expect(zipped.status).toBe(200)
    expect(zipped.response.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await zipped.response.arrayBuffer()))
    expect(new TextDecoder().decode(files['team/readme.txt'])).toBe('shared bytes')
  })

  it('enforces viewer/commenter/editor roles and grant expiry', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/shared', name: 'shared', kind: 'folder', content: '' })
    expect((await call(OWNER, 'POST', '/api/clouddrive/acl/grants', {
      fileId: folder, username: 'member', role: 'viewer',
    })).status).toBe(200)

    const deniedComment = await call(MEMBER, 'POST', `/api/clouddrive/files/${folder}/comments?ownerId=${OWNER}`, { body: 'not allowed' })
    expect(deniedComment.status).toBe(403)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'nope' })).status).toBe(403)

    expect((await call(OWNER, 'PATCH', '/api/clouddrive/acl/grants', {
      fileId: folder, granteeId: MEMBER, role: 'commenter',
    })).status).toBe(200)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${folder}/comments?ownerId=${OWNER}`, { body: 'allowed' })).status).toBe(201)

    expect((await call(OWNER, 'PATCH', '/api/clouddrive/acl/grants', {
      fileId: folder, granteeId: MEMBER, role: 'editor', expiresAt: Date.now() + 60_000,
    })).status).toBe(200)
    const created = await call<{ entry: { path: string; user_id?: string } }>(
      MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'by-editor' },
    )
    expect(created.status).toBe(201)
    expect(created.body.entry.path).toBe('/shared/by-editor')
    expect(await db.prepare(`SELECT 1 AS hit FROM CloudDrive_files WHERE user_id = ? AND path = '/shared/by-editor'`).bind(OWNER).first()).not.toBeNull()

    await db.prepare(`UPDATE CloudDrive_acl SET expires_at = ? WHERE owner_id = ? AND grantee_id = ?`).bind(Date.now() - 1, OWNER, MEMBER).run()
    expect((await call(MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${folder}/list`)).status).toBe(404)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'expired' })).status).toBe(404)
  })
})
