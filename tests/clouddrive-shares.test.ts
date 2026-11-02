// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { createUsersTable } from './doubles/users-table'
import {
  clouddrivePublicRoutes,
  clouddriveRoutes,
} from '../src/worker/clouddrive/routes'
import { clouddriveRawRoutes } from '../src/worker/clouddrive/routes-shares'
import { foldedName } from '../src/shared/clouddrive/model'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { createLoginAttemptsTable } from './doubles/login-attempts'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
let sqlite: DatabaseSync
let db: D1Database
let r2: TestR2Bucket
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  createLoginAttemptsTable(sqlite)
  db = makeD1(sqlite)
  r2 = testR2Bucket()
  env = testBindings(db, { FILES: r2 })
})

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', {
      id: USER, username: 'tester', login: 'tester', name: 'Tester', avatarUrl: '',
      role: 'owner', createdAt: 1, settingsRaw: '{}',
    })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  instance.route('/api/public/clouddrive', clouddrivePublicRoutes)
  instance.route('/d', clouddriveRawRoutes)
  return instance
}

async function file(): Promise<string> {
  const id = newId()
  const path = '/notes.txt'
  const key = `CloudDrive/txt/${id}`
  await r2.put(key, new TextEncoder().encode('hello cloud drive'), { httpMetadata: { contentType: 'text/plain' } })
  const now = Date.now()
  await db.prepare(
    `INSERT INTO CloudDrive_files
       (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path,
        category, mime, size, etag, checksum, storage_kind, storage_key, metadata, color,
        starred_at, last_viewed_at, deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
     VALUES (?1,?2,'primary','','file','notes.txt',?3,'',?4,'txt','text/plain',17,NULL,NULL,'r2',?5,'{}','',NULL,NULL,NULL,NULL,?6,?6,?6,?6)`,
  ).bind(id, USER, foldedName('notes.txt'), path, key, now).run()
  return id
}

async function call(method: string, path: string, body?: unknown, cookie = ''): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers()
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-Inkstone-Client', '1')
  if (cookie) headers.set('cookie', cookie)
  const response = await app().fetch(new Request(`http://localhost${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  const text = await response.text()
  let parsed: any = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { text } }
  return { status: response.status, body: parsed, headers: response.headers }
}

describe('cloud drive shares', () => {
  it('counts one view and one visit row per visitor per hour', async () => {
    const id = await file()
    const created = await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: id, path: '/notes.txt', maxViews: 3,
    })
    expect(created.status).toBe(200)
    const slug = created.body.share.slug as string

    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await call('GET', `/api/public/clouddrive/shares/${slug}`)).status).toBe(200)
    }
    const share = await db.prepare(`SELECT views FROM CloudDrive_shares WHERE slug = ?1`).bind(slug)
      .first<{ views: number }>()
    expect(share?.views).toBe(1)
    const visits = await db.prepare(`SELECT COUNT(*) AS count FROM CloudDrive_share_visits WHERE slug = ?1`).bind(slug)
      .first<{ count: number }>()
    expect(visits?.count).toBe(1)
    // The visitor is stored as a salted digest, never as the address itself.
    const visit = await db.prepare(`SELECT ip_hash FROM CloudDrive_share_visits WHERE slug = ?1`).bind(slug)
      .first<{ ip_hash: string }>()
    expect(visit?.ip_hash).toMatch(/^[0-9a-f]{32}$/)

    // A link that has run out still refuses the same visitor after the dedupe window.
    await db.prepare(`UPDATE CloudDrive_shares SET views = 3 WHERE slug = ?1`).bind(slug).run()
    const refused = await call('GET', `/api/public/clouddrive/shares/${slug}`)
    expect(refused.status).toBe(403)
  })

  it('creates a password share, verifies it, serves the file and revokes it', async () => {
    const id = await file()
    const created = await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: id, path: '/notes.txt', password: 'password1', allowDownload: true,
    })
    expect(created.status).toBe(200)
    const slug = created.body.share.slug as string
    expect(slug).toHaveLength(20)
    expect(created.body.share.url).toBe(`/d/${slug}`)

    // A locked link answers with the fact that it is locked and nothing else: the name, the owner's own
    // path, the size and the type are all the recipient's business only after the password.
    const meta = await call('GET', `/api/public/clouddrive/shares/${slug}`)
    expect(meta.status).toBe(200)
    expect(meta.body.locked).toBe(true)
    expect(meta.body.name).toBe('')
    expect(meta.body.path).toBe('')
    expect(meta.body.size).toBeNull()
    const lockedViews = await db.prepare(`SELECT views FROM CloudDrive_shares WHERE slug = ?1`).bind(slug)
      .first<{ views: number }>()
    expect(lockedViews?.views).toBe(0)

    const wrong = await call('POST', `/api/public/clouddrive/shares/${slug}/verify`, { password: 'nope' })
    expect(wrong.status).toBe(401)
    const verified = await call('POST', `/api/public/clouddrive/shares/${slug}/verify`, { password: 'password1' })
    expect(verified.status).toBe(200)
    const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0]!
    expect(cookie).toContain('clouddrive_share=')

    const unlocked = await call('GET', `/api/public/clouddrive/shares/${slug}`, undefined, cookie)
    expect(unlocked.body.name).toBe('notes.txt')
    expect(unlocked.body.locked).toBe(false)

    const content = await call('GET', `/api/public/clouddrive/shares/${slug}/content`, undefined, cookie)
    expect(content.status).toBe(200)
    expect(content.body.text).toBe('hello cloud drive')

    const raw = await call('GET', `/d/${slug}/raw`, undefined, cookie)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-disposition')).toContain('attachment')

    const revoked = await call('DELETE', `/api/clouddrive/shares/${slug}`)
    expect(revoked.status).toBe(200)
    const gone = await call('GET', `/api/public/clouddrive/shares/${slug}`)
    expect(gone.status).toBe(404)
  })

  it('addresses a folder link relative to the share and refuses to leave it', async () => {
    const folder = newId()
    const child = await file()
    const now = Date.now()
    await db.prepare(
      `INSERT INTO CloudDrive_files (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,trash_batch,created_at,updated_at,uploaded_at,modified_at)
       VALUES (?1,?2,'primary','','folder','docs',?3,'','/docs','other','application/octet-stream',0,NULL,NULL,'r2',NULL,'{}','',NULL,NULL,NULL,NULL,?4,?4,?4,?4)`,
    ).bind(folder, USER, foldedName('docs'), now).run()
    await db.prepare(`UPDATE CloudDrive_files SET parent_id = ?1, path = '/docs/notes.txt' WHERE id = ?2`)
      .bind(folder, child).run()
    const created = await call('POST', '/api/clouddrive/shares', { targetKind: 'folder', fileId: folder, path: '/docs' })
    expect(created.status).toBe(200)
    const slug = created.body.share.slug as string

    const listed = await call('GET', `/api/public/clouddrive/shares/${slug}/list`)
    expect(listed.status).toBe(200)
    // The recipient is handed the share's own address space, never `/docs/notes.txt` from the owner's tree.
    expect(listed.body.path).toBe('/')
    expect(listed.body.entries[0]?.path).toBe('/notes.txt')

    const inside = await call('GET', `/api/public/clouddrive/shares/${slug}/content?path=%2Fnotes.txt`)
    expect(inside.status).toBe(200)
    expect(inside.body.text).toBe('hello cloud drive')

    const escaping = await call('GET', `/api/public/clouddrive/shares/${slug}/content?path=${encodeURIComponent('/../secrets.txt')}`)
    expect(escaping.status).toBe(400)
  })

  it('enforces the download count', async () => {
    const id = await file()
    const created = await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: id, path: '/notes.txt', maxDownloads: 1, allowDownload: true,
    })
    const slug = created.body.share.slug as string
    const first = await call('GET', `/api/public/clouddrive/shares/${slug}/download`)
    expect(first.status).toBe(200)
    const second = await call('GET', `/api/public/clouddrive/shares/${slug}/download`)
    expect(second.status).toBe(403)
  })

  /** A row and its object, with the media type the share has to reason about. */
  async function mediaFile(name: string, mime: string, content: string): Promise<string> {
    const id = newId()
    const key = `CloudDrive/other/${id}`
    await r2.put(key, new TextEncoder().encode(content), { httpMetadata: { contentType: mime } })
    const now = Date.now()
    await db.prepare(
      `INSERT INTO CloudDrive_files (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,trash_batch,created_at,updated_at,uploaded_at,modified_at)
       VALUES (?1,?2,'primary','','file',?3,?4,'',?5,'other',?6,?7,NULL,NULL,'r2',?8,'{}','',NULL,NULL,NULL,NULL,?9,?9,?9,?9)`,
    ).bind(id, USER, name, foldedName(name), `/${name}`, mime, content.length, key, now).run()
    return id
  }

  it('keeps a preview-only link previewable and refuses the bytes of anything else', async () => {
    const text = await mediaFile('report.txt', 'text/plain', 'private bytes')
    const textSlug = (await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: text, path: '/report.txt', allowDownload: false,
    })).body.share.slug as string
    // "No download" cannot stop a viewer saving a picture, but it has to stop the plain file route
    // handing over a document the browser would only have offered to save.
    expect((await call('GET', `/api/public/clouddrive/shares/${textSlug}/content`)).status).toBe(403)
    expect((await call('GET', `/d/${textSlug}/raw`)).status).toBe(403)

    const image = await mediaFile('photo.png', 'image/png', 'png-bytes')
    const imageSlug = (await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: image, path: '/photo.png', allowDownload: false,
    })).body.share.slug as string
    const preview = await call('GET', `/api/public/clouddrive/shares/${imageSlug}/content`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toContain('image/png')
  })

  it('throttles repeated wrong share passwords', async () => {
    const id = await file()
    const slug = (await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: id, path: '/notes.txt', password: 'password1',
    })).body.share.slug as string
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await call('POST', `/api/public/clouddrive/shares/${slug}/verify`, { password: 'nope' })).status).toBe(401)
    }
    // The right password arrives at a locked budget: the lock is what stops the guessing, not the answer.
    const locked = await call('POST', `/api/public/clouddrive/shares/${slug}/verify`, { password: 'password1' })
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe('too_many_attempts')
  })
})
