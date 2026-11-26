// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
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

afterEach(() => sqlite.close())

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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; response: Response }> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: {} })
  const response = await app(userId).fetch(request, env)
  const text = await response.clone().text()
  let parsed = {} as T
  try { parsed = (text ? JSON.parse(text) : {}) as T } catch { parsed = { text } as T }
  return { status: response.status, body: parsed, response }
}

async function mount(id: string, options: { storageId?: string; readOnly?: boolean; enabled?: boolean } = {}): Promise<void> {
  const now = Date.now()
  const storageId = options.storageId ?? 'primary'
  if (storageId !== 'primary') {
    await db.prepare(
      `INSERT INTO CloudDrive_storages
         (user_id,id,name,type,config,credentials,status,is_default,api_key_visible,read_quota,default_path,created_at,updated_at)
       VALUES (?1,?2,?2,'s3','{}','','enabled',0,0,0,'/',?3,?3)
       ON CONFLICT(user_id,id) DO NOTHING`,
    ).bind(OWNER, storageId, now).run()
  }
  await db.prepare(
    `INSERT INTO CloudDrive_mounts
       (user_id,id,storage_id,name,mount_path,read_only,cache_ttl,web_proxy,webdav_policy,
        weight,sort_order,enabled,remark,folder_summary,created_at,updated_at)
     VALUES (?1,?2,?3,?2,?4,?5,300,0,'native_proxy',1,0,?6,'',0,?7,?7)`,
  ).bind(OWNER, id, storageId, `/${id}`, options.readOnly ? 1 : 0, options.enabled === false ? 0 : 1, now).run()
}

async function entry(options: {
  userId?: string
  mountId?: string
  parentId?: string
  path: string
  name: string
  kind?: 'folder' | 'file'
  content?: string
  metadata?: string
}): Promise<string> {
  const id = newId()
  const kind = options.kind ?? 'file'
  const content = options.content ?? options.name
  const key = kind === 'file' ? `CloudDrive/txt/${id}` : null
  if (key) await r2.put(key, new TextEncoder().encode(content))
  const now = Date.now()
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,
        etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,
        trash_batch,created_at,updated_at,uploaded_at,modified_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'',?8,'txt','text/plain',?9,NULL,NULL,'r2',?10,?11,'',
             NULL,NULL,NULL,NULL,?12,?12,?12,?12)`,
  ).bind(
    id, options.userId ?? OWNER, options.mountId ?? 'primary', options.parentId ?? '', kind,
    options.name, foldedName(options.name), options.path, content.length, key, options.metadata ?? '{}', now,
  ).run()
  return id
}

async function row(userId: string, id: string) {
  const found = await db.prepare(
    `SELECT mount_id,parent_id,path,deleted_at,storage_key,metadata FROM CloudDrive_files WHERE user_id = ? AND id = ?`,
  ).bind(userId, id).first<{ mount_id: string; parent_id: string; path: string; deleted_at: number | null; storage_key: string | null; metadata: string }>()
  if (!found) throw new Error(`missing row ${id}`)
  return found
}

async function share(targetKind: 'file' | 'folder', fileId: string, options: Record<string, unknown> = {}) {
  const created = await call<{ share: { slug: string } }>(OWNER, 'POST', '/api/clouddrive/shares', {
    targetKind, fileId, ...options,
  })
  expect(created.status).toBe(200)
  return created.body.share.slug
}

describe('CloudDrive cross-mount transfers', () => {
  it('copies folder contents and hidden metadata across mounts, then applies rename/skip/overwrite conflicts', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    const folder = await entry({ path: '/docs', name: 'docs', kind: 'folder' })
    const visible = await entry({ parentId: folder, path: '/docs/readme.txt', name: 'readme.txt', content: 'visible' })
    await entry({ parentId: folder, path: '/docs/draft.tmp', name: 'draft.tmp', content: 'hidden' })
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/docs', hidePatterns: ['*.tmp'],
    })).status).toBe(200)

    const copied = await call<{ results: { id: string; ok: boolean; toPath: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'archive', ids: [folder, visible], toPath: '/' },
    )
    expect(copied.status).toBe(200)
    expect(copied.body.results).toHaveLength(1)
    expect(copied.body.results[0]).toMatchObject({ id: folder, ok: true, toPath: '/docs' })
    expect((await row(OWNER, folder)).deleted_at).toBeNull()
    const destination = await db.prepare(
      `SELECT id FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/docs'`,
    ).bind(OWNER).first<{ id: string }>()
    expect(destination).not.toBeNull()
    const copiedChild = await db.prepare(
      `SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/docs/readme.txt'`,
    ).bind(OWNER).first<{ storage_key: string }>()
    expect(copiedChild?.storage_key).toBe((await row(OWNER, visible)).storage_key)
    const listing = await call<{ files: { name: string }[] }>(OWNER, 'GET', '/api/clouddrive/files?mount=archive&path=/docs')
    expect(listing.body.files.map((file) => file.name)).toEqual(['readme.txt'])

    const renamed = await call<{ results: { toPath: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/' },
    )
    expect(renamed.body.results[0]?.toPath).toBe('/docs (1)')
    const skipped = await call<{ results: { ok: boolean; error: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/', conflict: 'skip' },
    )
    expect(skipped.status).toBe(207)
    expect(skipped.body.results[0]).toMatchObject({ ok: false, error: 'conflict' })
    const overwritten = await call<{ results: { toPath: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/copy',
      { mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/', conflict: 'overwrite' },
    )
    expect(overwritten.status).toBe(200)
    expect(overwritten.body.results[0]?.toPath).toBe('/docs')
    expect(await db.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/docs' AND deleted_at IS NULL`,
    ).bind(OWNER).first()).toMatchObject({ count: 1 })
  })

  it('moves a tree across mounts only after the destination copy succeeds', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    const folder = await entry({ path: '/move', name: 'move', kind: 'folder' })
    const child = await entry({ parentId: folder, path: '/move/a.txt', name: 'a.txt', content: 'move me' })
    const moved = await call<{ results: { ok: boolean; toPath: string }[] }>(
      OWNER, 'POST', '/api/clouddrive/files/move',
      { mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/' },
    )
    expect(moved.status).toBe(200)
    expect(moved.body.results[0]).toMatchObject({ ok: true, toPath: '/move' })
    expect((await row(OWNER, folder)).deleted_at).not.toBeNull()
    expect((await row(OWNER, child)).deleted_at).not.toBeNull()
    const destination = await db.prepare(
      `SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND mount_id = 'archive' AND path = '/move/a.txt'`,
    ).bind(OWNER).first<{ storage_key: string }>()
    expect(destination?.storage_key).toBe((await row(OWNER, child)).storage_key)
  })

  it('allows copying from a read-only mount but refuses moves and read-only destinations', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive', { readOnly: true })
    const source = await entry({ mountId: 'archive', path: '/readonly.txt', name: 'readonly.txt' })
    const copied = await call(OWNER, 'POST', '/api/clouddrive/files/copy', {
      mountId: 'archive', toMountId: 'primary', ids: [source], toPath: '/',
    })
    expect(copied.status).toBe(200)
    expect((await row(OWNER, source)).deleted_at).toBeNull()
    expect((await call(OWNER, 'POST', '/api/clouddrive/files/move', {
      mountId: 'archive', toMountId: 'primary', ids: [source], toPath: '/',
    })).status).toBe(403)

    await mount('destination', { readOnly: true })
    const writable = await entry({ path: '/writable.txt', name: 'writable.txt' })
    expect((await call(OWNER, 'POST', '/api/clouddrive/files/copy', {
      mountId: 'primary', toMountId: 'destination', ids: [writable], toPath: '/',
    })).status).toBe(403)
  })

  it('requires access to a selected folder itself before copying or moving it', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    const folder = await entry({ path: '/locked', name: 'locked', kind: 'folder' })
    await entry({ parentId: folder, path: '/locked/secret.txt', name: 'secret.txt' })
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/locked', password: 'folder password',
    })).status).toBe(200)
    for (const operation of ['copy', 'move']) {
      const refused = await call(OWNER, 'POST', `/api/clouddrive/files/${operation}`, {
        mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/',
      })
      expect(refused.status).toBe(403)
      expect((refused.body as { error: { code: string } }).error.code).toBe('clouddrive_meta_locked')
    }
    expect((await row(OWNER, folder)).deleted_at).toBeNull()

    const unlocked = await call(OWNER, 'POST', '/api/clouddrive/meta/unlock', {
      mountId: 'primary', path: '/locked', password: 'folder password',
    })
    expect(unlocked.status).toBe(200)
    const cookie = (unlocked.response.headers.get('set-cookie') ?? '').split(';')[0]!
    const copied = await call(OWNER, 'POST', '/api/clouddrive/files/copy', {
      mountId: 'primary', toMountId: 'archive', ids: [folder], toPath: '/',
    }, { Cookie: cookie })
    expect(copied.status).toBe(200)
    expect((await call(OWNER, 'GET', '/api/clouddrive/files?mount=archive&path=/locked')).status).toBe(403)
  })
})

describe('CloudDrive global search scope and pagination', () => {
  it('searches enabled primary mounts only and pages without duplicates across mounts', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await mount('archive')
    await mount('disabled', { enabled: false })
    await mount('remote', { storageId: 'external' })
    const primary = await entry({ path: '/needle-a.txt', name: 'needle-a.txt' })
    const archive = await entry({ mountId: 'archive', path: '/needle-b.txt', name: 'needle-b.txt' })
    await entry({ mountId: 'disabled', path: '/needle-c.txt', name: 'needle-c.txt' })
    await entry({ mountId: 'remote', path: '/needle-d.txt', name: 'needle-d.txt' })
    await entry({ userId: OTHER, path: '/needle-private.txt', name: 'needle-private.txt' })

    const scoped = await call<{ files: { id: string }[] }>(OWNER, 'GET', '/api/clouddrive/search?q=needle&mount=primary')
    expect(scoped.body.files.map((file) => file.id)).toEqual([primary])
    const first = await call<{ files: { id: string; mountId: string }[]; cursor: string; indexedMountIds: string[]; skippedMounts: string[] }>(
      OWNER, 'GET', '/api/clouddrive/search?scope=all&q=needle&limit=1',
    )
    expect(first.body.files.map((file) => file.id)).toEqual([primary])
    expect(first.body.indexedMountIds.sort()).toEqual(['archive', 'primary'])
    expect(first.body.skippedMounts).toContain('remote')
    const second = await call<{ files: { id: string }[]; cursor: string | null }>(
      OWNER, 'GET', `/api/clouddrive/search?scope=all&q=needle&limit=1&cursor=${encodeURIComponent(first.body.cursor)}`,
    )
    expect(second.body.files.map((file) => file.id)).toEqual([archive])
    const final = await call<{ files: { id: string }[]; cursor: null }>(
      OWNER, 'GET', `/api/clouddrive/search?scope=all&q=needle&limit=1&cursor=${encodeURIComponent(second.body.cursor!)}`,
    )
    expect(final.body.files).toEqual([])
    expect(final.body.cursor).toBeNull()
  })

  it('keeps hidden and password-protected matches out of both search scopes', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    const visible = await entry({ path: '/needle-visible.txt', name: 'needle-visible.txt' })
    await entry({ path: '/needle-hidden.txt', name: 'needle-hidden.txt' })
    const locked = await entry({ path: '/locked', name: 'locked', kind: 'folder' })
    await entry({ parentId: locked, path: '/locked/needle-secret.txt', name: 'needle-secret.txt' })
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/', hidePatterns: ['needle-hidden.txt'],
    })).status).toBe(200)
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/locked', password: 'folder password',
    })).status).toBe(200)
    for (const scope of ['primary', 'all']) {
      const found = await call<{ files: { id: string }[] }>(OWNER, 'GET', `/api/clouddrive/search?scope=${scope}&q=needle`)
      expect(found.body.files.map((file) => file.id)).toEqual([visible])
    }
  })
})

describe('CloudDrive public share save and ZIP', () => {
  it('saves a public folder under the recipient path without exposing the owner path', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await call(MEMBER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/private/team', name: 'team', kind: 'folder' })
    const child = await entry({ parentId: folder, path: '/private/team/readme.txt', name: 'readme.txt', content: 'shared bytes' })
    const slug = await share('folder', folder)
    const metadata = await call<{ path: string }>(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}`)
    expect(metadata.body.path).toBe('/')
    const listed = await call<{ entries: { path: string }[] }>(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/list`)
    expect(listed.body.entries.map((item) => item.path)).toEqual(['/readme.txt'])
    expect((await call(MEMBER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'inbox' })).status).toBe(201)

    const saved = await call<{ saved: number; entry: { path: string } }>(MEMBER, 'POST', `/api/clouddrive/shares/${slug}/save`, { toPath: '/inbox' })
    expect(saved.status).toBe(201)
    expect(saved.body.saved).toBe(2)
    expect(saved.body.entry.path).toBe('/inbox/team')
    expect(JSON.stringify(saved.body)).not.toContain('/private/team')
    const recipientChild = await db.prepare(
      `SELECT storage_key FROM CloudDrive_files WHERE user_id = ? AND path = '/inbox/team/readme.txt' AND deleted_at IS NULL`,
    ).bind(MEMBER).first<{ storage_key: string }>()
    expect(recipientChild?.storage_key).toBe((await row(OWNER, child)).storage_key)
    const second = await call<{ entry: { path: string } }>(MEMBER, 'POST', `/api/clouddrive/shares/${slug}/save`, { toPath: '/inbox' })
    expect(second.body.entry.path).toBe('/inbox/team (1)')

    const noDownload = await share('folder', folder, { allowDownload: false })
    expect((await call(MEMBER, 'POST', `/api/clouddrive/shares/${noDownload}/save`, { toPath: '/' })).status).toBe(403)
    const lockedShare = await share('folder', folder, { password: 'share password' })
    expect((await call(MEMBER, 'POST', `/api/clouddrive/shares/${lockedShare}/save`, { toPath: '/' })).status).toBe(401)
  })

  it('does not list, serve or archive hidden descendants and refuses locked descendants', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/team', name: 'team', kind: 'folder' })
    await entry({ parentId: folder, path: '/team/visible.txt', name: 'visible.txt', content: 'visible' })
    await entry({ parentId: folder, path: '/team/hidden.txt', name: 'hidden.txt', content: 'hidden' })
    const hiddenFolder = await entry({ parentId: folder, path: '/team/hidden-folder', name: 'hidden-folder', kind: 'folder' })
    await entry({ parentId: hiddenFolder, path: '/team/hidden-folder/inside.txt', name: 'inside.txt', content: 'hidden child' })
    const lockedFolder = await entry({ parentId: folder, path: '/team/locked', name: 'locked', kind: 'folder' })
    await entry({ parentId: lockedFolder, path: '/team/locked/secret.txt', name: 'secret.txt', content: 'locked child' })
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/team', hidePatterns: ['hidden*'],
    })).status).toBe(200)
    expect((await call(OWNER, 'PUT', '/api/clouddrive/meta', {
      mountId: 'primary', path: '/team/locked', password: 'folder password',
    })).status).toBe(200)
    const slug = await share('folder', folder)

    const listed = await call<{ entries: { name: string }[]; total: number }>(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/list`)
    expect(listed.body.entries.map((item) => item.name)).toEqual(['locked', 'visible.txt'])
    expect(listed.body.total).toBe(2)
    expect((await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/content?path=%2Fhidden.txt`)).status).toBe(404)
    expect((await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/content?path=%2Fhidden-folder%2Finside.txt`)).status).toBe(404)
    expect((await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/content?path=%2Flocked%2Fsecret.txt`)).status).toBe(403)

    const zipped = await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/zip`)
    expect(zipped.status).toBe(200)
    const files = unzipSync(new Uint8Array(await zipped.response.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['team', 'team/locked', 'team/visible.txt'])
    expect(new TextDecoder().decode(files['team/visible.txt'])).toBe('visible')
  })

  it('streams folder ZIP downloads through HEAD and the share download budget', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/zip', name: 'zip', kind: 'folder' })
    await entry({ parentId: folder, path: '/zip/a.txt', name: 'a.txt', content: 'zip bytes' })
    const slug = await share('folder', folder, { maxDownloads: 1 })
    const head = await call(MEMBER, 'HEAD', `/api/public/clouddrive/shares/${slug}/zip`)
    expect(head.status).toBe(200)
    expect((await head.response.arrayBuffer()).byteLength).toBe(0)
    expect(await db.prepare(`SELECT downloads FROM CloudDrive_shares WHERE slug = ?`).bind(slug).first()).toMatchObject({ downloads: 0 })
    expect((await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/zip`)).status).toBe(200)
    expect((await call(MEMBER, 'GET', `/api/public/clouddrive/shares/${slug}/zip`, undefined, { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(403)
  })
})

describe('CloudDrive ACL role and expiry API matrix', () => {
  it('separates viewer, commenter and editor operations and rejects every expired grant', async () => {
    await call(OWNER, 'GET', '/api/clouddrive/bootstrap')
    await call(MEMBER, 'GET', '/api/clouddrive/bootstrap')
    const folder = await entry({ path: '/shared', name: 'shared', kind: 'folder' })
    const child = await entry({ parentId: folder, path: '/shared/note.txt', name: 'note.txt', content: 'shared' })
    expect((await call(OWNER, 'POST', '/api/clouddrive/acl/grants', {
      fileId: folder, username: 'member', role: 'viewer',
    })).status).toBe(200)

    expect((await call(MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${folder}/list`)).status).toBe(200)
    expect((await call(MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${child}/content`)).status).toBe(200)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${child}/comments?ownerId=${OWNER}`, { body: 'viewer' })).status).toBe(403)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'viewer-folder' })).status).toBe(403)

    expect((await call(OWNER, 'PATCH', '/api/clouddrive/acl/grants', {
      fileId: folder, granteeId: MEMBER, role: 'commenter',
    })).status).toBe(200)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${child}/comments?ownerId=${OWNER}`, { body: 'commenter' })).status).toBe(201)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'commenter-folder' })).status).toBe(403)

    expect((await call(OWNER, 'PATCH', '/api/clouddrive/acl/grants', {
      fileId: folder, granteeId: MEMBER, role: 'editor', expiresAt: Date.now() + 60_000,
    })).status).toBe(200)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'editor-folder' })).status).toBe(201)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/files`, { name: 'editor.txt' })).status).toBe(201)
    expect((await call(MEMBER, 'PATCH', `/api/clouddrive/acl/shared/${OWNER}/${child}`, { name: 'renamed.txt' })).status).toBe(200)

    await db.prepare(`UPDATE CloudDrive_acl SET expires_at = ? WHERE owner_id = ? AND grantee_id = ?`)
      .bind(Date.now() - 1, OWNER, MEMBER).run()
    const shared = await call<{ shared: unknown[] }>(MEMBER, 'GET', '/api/clouddrive/acl/shared')
    expect(shared.body.shared).toEqual([])
    expect((await call(MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${folder}/list`)).status).toBe(404)
    expect((await call(MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${child}/content`)).status).toBe(404)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/files/${child}/comments?ownerId=${OWNER}`, { body: 'expired' })).status).toBe(404)
    expect((await call(MEMBER, 'POST', `/api/clouddrive/acl/shared/${OWNER}/${folder}/folders`, { name: 'expired' })).status).toBe(404)
  })
})
