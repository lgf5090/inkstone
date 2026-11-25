// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { createUsersTable } from './doubles/users-table'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { clouddriveDavRoutes, WEBDAV_AUTH_CACHE_TTL_MS } from '../src/worker/clouddrive/routes-dav'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { createLoginAttemptsTable } from './doubles/login-attempts'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { lockCovers, presentedLockTokens, type DavLock } from '../src/worker/clouddrive/dav-locks'
import * as password from '../src/worker/lib/password'

const USER = '0123456789abcdefghjkmnpqrs'
const CLOCK = Date.UTC(2026, 10, 3, 12, 0, 0)
let sqlite: DatabaseSync
let db: D1Database
let env: Env

function setClock(at: number) {
  vi.spyOn(Date, 'now').mockReturnValue(at)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  createLoginAttemptsTable(sqlite)
  db = makeD1(sqlite)
  env = testBindings(db, { FILES: testR2Bucket() })
  setClock(CLOCK)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', { id: USER, username: 'owner', login: 'owner', name: 'Owner', avatarUrl: '', role: 'owner', createdAt: 1, settingsRaw: '{}' })
    await next()
  })
  instance.route('/api/clouddrive', clouddriveRoutes)
  instance.route('/clouddrive/dav', clouddriveDavRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Inkstone-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  return { status: response.status, body: await response.json().catch(() => ({})) as any }
}

interface DavReply {
  status: number
  text: string
  token: string | null
  dav: string | null
}

async function dav(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<DavReply> {
  const response = await app().fetch(new Request(`http://localhost/clouddrive/dav${path}`, {
    method,
    headers: { Authorization: `Basic ${btoa('owner:davpass')}`, ...headers },
    body,
  }), env)
  return {
    status: response.status,
    text: await response.text(),
    token: response.headers.get('lock-token'),
    dav: response.headers.get('dav'),
  }
}

function lockInfo(scope: 'exclusive' | 'shared'): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:lockinfo xmlns:D="DAV:">'
    + `<D:lockscope><D:${scope}/></D:lockscope>`
    + '<D:locktype><D:write/></D:locktype>'
    + '<D:owner><D:href>client-a</D:href></D:owner>'
    + '</D:lockinfo>'
}

async function setupWebdav() {
  await call('GET', '/api/clouddrive/bootstrap')
  expect((await call('PATCH', '/api/clouddrive/settings', {
    webdavEnabled: true, webdavUsername: 'owner', webdavPassword: 'davpass',
  })).status).toBe(200)
}

async function put(path: string, body = 'bytes') {
  return dav('PUT', path, { 'content-type': 'text/plain' }, body)
}

describe('cloud drive WebDAV credential cache', () => {
  it('reuses a successful password check without the per-PROPFIND throttle write', async () => {
    await setupWebdav()
    const verify = vi.spyOn(password, 'verifyPassword')
    expect((await put('/Docs/cached.txt')).status).toBe(201)
    const prepare = vi.spyOn(db, 'prepare')

    expect((await dav('PROPFIND', '/Docs')).status).toBe(207)
    expect((await dav('PROPFIND', '/Docs/cached.txt', { Depth: '0' })).status).toBe(207)

    expect(verify).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls.some(([sql]) => sql.includes('DELETE FROM login_attempts'))).toBe(false)
  })

  it('rejects the previous password immediately after rotation and accepts the new one', async () => {
    await setupWebdav()
    expect((await put('/Docs/rotated.txt')).status).toBe(201)
    expect((await call('PATCH', '/api/clouddrive/settings', { webdavPassword: 'newdavpass' })).status).toBe(200)

    expect((await dav('PROPFIND', '/Docs/rotated.txt', { Depth: '0' })).status).toBe(401)
    const current = await dav('PROPFIND', '/Docs/rotated.txt', {
      Depth: '0',
      Authorization: `Basic ${btoa('owner:newdavpass')}`,
    })
    expect(current.status).toBe(207)
  })

  it('expires an idle cached session and verifies the password again', async () => {
    await setupWebdav()
    const verify = vi.spyOn(password, 'verifyPassword')
    expect((await put('/Docs/expiring.txt')).status).toBe(201)
    expect((await dav('PROPFIND', '/Docs/expiring.txt', { Depth: '0' })).status).toBe(207)
    expect(verify).toHaveBeenCalledTimes(1)

    setClock(CLOCK + WEBDAV_AUTH_CACHE_TTL_MS + 1)
    expect((await dav('PROPFIND', '/Docs/expiring.txt', { Depth: '0' })).status).toBe(207)
    expect(verify).toHaveBeenCalledTimes(2)
  })
})

describe('cloud drive WebDAV write locks', () => {
  it('holds a lock over a second client and lets the holder through', async () => {
    await setupWebdav()
    expect((await put('/Docs/a.txt', 'first')).status).toBe(201)

    const locked = await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('exclusive'))
    expect(locked.status).toBe(200)
    expect(locked.token).toMatch(/^<opaquelocktoken:[0-9a-f-]+>$/)
    expect(locked.text).toContain('<D:activelock>')
    expect(locked.text).toContain('<D:owner>client-a</D:owner>')
    expect(locked.text).toContain('<D:lockroot>')

    const stranger = await put('/Docs/a.txt', 'second')
    expect(stranger.status).toBe(423)
    expect(stranger.text).toContain('<D:locked/>')
    expect((await dav('GET', '/Docs/a.txt')).text).toBe('first')

    expect((await dav('PUT', '/Docs/a.txt', {
      'content-type': 'text/plain',
      If: `(${locked.token})`,
    }, 'second')).status).toBe(204)
    expect((await dav('GET', '/Docs/a.txt')).text).toBe('second')
  })

  it('lists the lock in PROPFIND so a client is not told the path is free', async () => {
    await setupWebdav()
    await put('/Docs/a.txt')
    const before = await dav('PROPFIND', '/Docs/a.txt', { Depth: '0' })
    expect(before.status).toBe(207)
    expect(before.text).toContain('<D:lockdiscovery/>')

    const locked = await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('exclusive'))
    const after = await dav('PROPFIND', '/Docs/a.txt', { Depth: '0' })
    expect(after.text).toContain('<D:activelock>')
    expect(after.text).toContain(locked.token!.slice(1, -1))
    expect(after.text).toContain('<D:timeout>Second-3600</D:timeout>')
  })

  it('locks a subtree only when the client asks for more than the resource itself', async () => {
    await setupWebdav()
    expect((await put('/Docs/sub/c.txt', 'child')).status).toBe(201)

    const shallow = await dav('LOCK', '/Docs', {
      'content-type': 'application/xml',
      Depth: '0',
    }, lockInfo('exclusive'))
    expect(shallow.status).toBe(200)
    expect((await put('/Docs/sub/c.txt', 'child')).status).toBe(204)
    expect((await put('/Docs/sibling.txt')).status).toBe(201)
    expect((await dav('UNLOCK', '/Docs', { 'Lock-Token': shallow.token! })).status).toBe(204)

    const deep = await dav('LOCK', '/Docs', { 'content-type': 'application/xml' }, lockInfo('exclusive'))
    expect(deep.status).toBe(200)
    expect((await put('/Docs/sub/c.txt', 'blocked')).status).toBe(423)
  })

  it('lets the lock go when the timeout the client chose runs out', async () => {
    await setupWebdav()
    await put('/Docs/a.txt')
    expect((await dav('LOCK', '/Docs/a.txt', {
      'content-type': 'application/xml',
      Timeout: 'Second-30',
    }, lockInfo('exclusive'))).status).toBe(200)
    expect((await put('/Docs/a.txt')).status).toBe(423)

    setClock(CLOCK + 31_000)
    expect((await put('/Docs/a.txt')).status).toBe(204)
  })

  it('refreshes the lock a client names and refuses one it does not', async () => {
    await setupWebdav()
    await put('/Docs/a.txt')
    const locked = await dav('LOCK', '/Docs/a.txt', {
      'content-type': 'application/xml',
      Timeout: 'Second-60',
    }, lockInfo('exclusive'))

    const refreshed = await dav('LOCK', '/Docs/a.txt', { 'Lock-Token': locked.token! })
    expect(refreshed.status).toBe(200)
    expect(refreshed.token).toBeNull()
    expect(refreshed.text).toContain(locked.token!.slice(1, -1))

    expect((await dav('LOCK', '/Docs/a.txt')).status).toBe(423)
    setClock(CLOCK + 59_000)
    expect((await put('/Docs/a.txt')).status).toBe(423)
    // A refresh that names no Timeout restarts the clock at the server default, not at the
    // 60 seconds the original lock asked for.
    setClock(CLOCK + 3_600_000 - 1_000)
    expect((await put('/Docs/a.txt')).status).toBe(423)
    setClock(CLOCK + 3_600_000 + 1_000)
    expect((await put('/Docs/a.txt')).status).toBe(204)
  })

  it('lets readers share a path but keeps an exclusive writer out', async () => {
    await setupWebdav()
    await put('/Docs/a.txt')
    const first = await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('shared'))
    const second = await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('shared'))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('exclusive'))).status).toBe(423)
    expect((await put('/Docs/a.txt')).status).toBe(423)
  })

  it('blocks a move or a copy that lands on a locked path', async () => {
    await setupWebdav()
    await put('/Docs/x.txt', 'x')
    await put('/Docs/y.txt', 'y')
    const held = await dav('LOCK', '/Docs/z.txt', { 'content-type': 'application/xml' }, lockInfo('exclusive'))
    expect(held.status).toBe(200)

    const moved = await dav('MOVE', '/Docs/x.txt', { Destination: 'http://localhost/clouddrive/dav/Docs/z.txt' })
    expect(moved.status).toBe(423)
    const copied = await dav('COPY', '/Docs/y.txt', { Destination: 'http://localhost/clouddrive/dav/Docs/z.txt' })
    expect(copied.status).toBe(423)

    expect((await dav('UNLOCK', '/Docs/z.txt', { 'Lock-Token': held.token! })).status).toBe(204)
    expect((await dav('MOVE', '/Docs/x.txt', { Destination: 'http://localhost/clouddrive/dav/Docs/z.txt' })).status).toBe(201)
  })

  it('advertises class 2 and refuses a token that names no lock here', async () => {
    await setupWebdav()
    await put('/Docs/a.txt')
    const options = await dav('OPTIONS', '/Docs/a.txt')
    expect(options.dav).toBe('1, 2')

    const stranger = `<opaquelocktoken:${'0'.repeat(32)}>`
    expect((await dav('UNLOCK', '/Docs/a.txt', { 'Lock-Token': stranger })).status).toBe(409)
    const locked = await dav('LOCK', '/Docs/a.txt', { 'content-type': 'application/xml' }, lockInfo('exclusive'))
    expect((await dav('UNLOCK', '/Docs/a.txt', { 'Lock-Token': stranger })).status).toBe(409)
    expect((await dav('UNLOCK', '/Docs', { 'Lock-Token': locked.token! })).status).toBe(409)
    expect((await dav('UNLOCK', '/Docs/a.txt', { 'Lock-Token': locked.token! })).status).toBe(204)
  })

  it('keeps file identity, tags, stars, ACL and shares when PUT overwrites content', async () => {
    await setupWebdav()
    expect((await put('/Docs/stable.txt', 'old')).status).toBe(201)
    const before = sqlite.prepare(
      "SELECT id, storage_key FROM CloudDrive_files WHERE user_id = ? AND path = '/Docs/stable.txt' AND deleted_at IS NULL",
    ).get(USER) as { id: string; storage_key: string }
    expect((await call('PATCH', `/api/clouddrive/files/${before.id}`, { starred: true })).status).toBe(200)
    expect((await call('POST', `/api/clouddrive/files/${before.id}/tags`, { tag: 'important', color: '#ff0000' })).status).toBe(200)
    const share = await call('POST', '/api/clouddrive/shares', {
      targetKind: 'file', fileId: before.id, mountId: 'primary', path: '/Docs/stable.txt', allowDownload: true,
    })
    expect(share.status).toBe(200)
    sqlite.prepare(
      'INSERT INTO CloudDrive_acl (owner_id, file_id, grantee_id, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
    ).run(USER, before.id, 'grantee-user', Date.now())

    expect((await put('/Docs/stable.txt', 'replacement')).status).toBe(204)
    const after = sqlite.prepare(
      "SELECT id, storage_key, size, deleted_at, starred_at FROM CloudDrive_files WHERE user_id = ? AND path = '/Docs/stable.txt' AND deleted_at IS NULL",
    ).get(USER) as { id: string; storage_key: string; size: number; deleted_at: null; starred_at: number }
    expect(after).toMatchObject({ id: before.id, size: 11, deleted_at: null })
    expect(after.starred_at).not.toBeNull()
    expect(after.storage_key).not.toBe(before.storage_key)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ?').get(USER, before.id)).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_acl WHERE owner_id = ? AND file_id = ? AND revoked_at IS NULL').get(USER, before.id)).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT size, revoked_at FROM CloudDrive_shares WHERE user_id = ? AND file_id = ?').get(USER, before.id)).toEqual({ size: 11, revoked_at: null })
    expect(sqlite.prepare('SELECT version, storage_key FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ?').get(USER, before.id)).toEqual({ version: 1, storage_key: before.storage_key })
    expect(await (await dav('GET', '/Docs/stable.txt')).text).toBe('replacement')
    const historical = await app().fetch(new Request(`http://localhost/api/clouddrive/files/${before.id}/versions/1/content`), env)
    expect(historical.status).toBe(200)
    expect(await historical.text()).toBe('old')
  })

  it('explicitly refuses COPY of a distributed file instead of creating an unreadable row', async () => {
    await setupWebdav()
    expect((await put('/Docs/dist.bin', 'parts')).status).toBe(201)
    sqlite.prepare(
      "UPDATE CloudDrive_files SET storage_kind = 'distributed', storage_key = NULL WHERE user_id = ? AND path = '/Docs/dist.bin'",
    ).run(USER)
    const copied = await dav('COPY', '/Docs/dist.bin', {
      Destination: 'http://localhost/clouddrive/dav/Docs/copy.bin',
    })
    expect(copied.status).toBe(501)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND path = '/Docs/copy.bin'").get(USER)).toEqual({ count: 0 })

    expect((await put('/Docs/tree/leaf.bin', 'parts')).status).toBe(201)
    sqlite.prepare(
      "UPDATE CloudDrive_files SET storage_kind = 'distributed', storage_key = NULL WHERE user_id = ? AND path = '/Docs/tree/leaf.bin'",
    ).run(USER)
    const folderCopy = await dav('COPY', '/Docs/tree', {
      Destination: 'http://localhost/clouddrive/dav/Docs/tree-copy',
    })
    expect(folderCopy.status).toBe(501)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND path = '/Docs/tree-copy'").get(USER)).toEqual({ count: 0 })
  })

  it('covers paths the way a lock claims them', () => {
    const base: DavLock = {
      token: 'opaquelocktoken:x', root: '/Docs', scope: 'exclusive', depth: 'infinity', owner: '', expiresAt: 0,
    }
    expect(lockCovers(base, '/Docs')).toBe(true)
    expect(lockCovers(base, '/Docs/a.txt')).toBe(true)
    expect(lockCovers(base, '/Docs-2/a.txt')).toBe(false)
    expect(lockCovers(base, '/Other/a.txt')).toBe(false)
    expect(lockCovers({ ...base, depth: '0' }, '/Docs/a.txt')).toBe(false)
    expect(lockCovers({ ...base, root: '/' }, '/anything/at/all')).toBe(true)
  })

  it('counts only the tokens a client actually presented', () => {
    expect(presentedLockTokens(undefined, '<opaquelocktoken:a>')).toEqual(['opaquelocktoken:a'])
    expect(presentedLockTokens('(<opaquelocktoken:a>)', undefined)).toEqual(['opaquelocktoken:a'])
    expect(presentedLockTokens('(Not <opaquelocktoken:a>)', undefined)).toEqual([])
    expect(presentedLockTokens('(<http://host/lock>)', undefined)).toEqual([])
    expect(presentedLockTokens('(<opaquelocktoken:a>)', '<opaquelocktoken:a>')).toEqual(['opaquelocktoken:a'])
  })
})
