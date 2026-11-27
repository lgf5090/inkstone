// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import * as nodeStreamWeb from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashPassword } from '../src/worker/lib/password'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'
import { usedPrimaryBytes } from '../src/worker/clouddrive/upload-finalize'

const NodeFixedLengthStream = (nodeStreamWeb as unknown as {
  FixedLengthStream: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
}).FixedLengthStream
Object.defineProperty(globalThis, 'FixedLengthStream', { configurable: true, writable: true, value: NodeFixedLengthStream })

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const TOKEN = 'a'.repeat(64)
const PASSWORD = 'owner-password'
const SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

interface Harness { sqlite: DatabaseSync; env: Env; bucket: TestR2Bucket; app: ReturnType<typeof createApp> }
let h: Harness

beforeEach(async () => {
  const sqlite = new DatabaseSync(':memory:')
  const bucket = testR2Bucket()
  const env = testBindings(makeD1(sqlite), { FILES: bucket })
  const app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const [id, role] of [[USER, 'owner'], [OTHER, 'member']] as const) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, '', '', ?, '{}', ?, ?)`,
    ).run(id, id, await hashPassword(PASSWORD), id, role, now, now)
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(await hashToken(id === USER ? TOKEN : 'b'.repeat(64)), id, now + 600_000, now)
  }
  h = { sqlite, env, bucket, app }
})

afterEach(() => {
  vi.restoreAllMocks()
  h.sqlite.close()
})

async function request(method: string, path: string, body?: unknown, headers: HeadersInit = {}, as = USER): Promise<Response> {
  const merged = new Headers(headers)
  if (!merged.has('Cookie')) merged.set('Cookie', `inkstone_session=${as === USER ? TOKEN : 'b'.repeat(64)}`)
  if (body !== undefined && !merged.has('Content-Type')) merged.set('Content-Type', 'application/json')
  if (as === USER && method !== 'GET') merged.set('X-Inkstone-Client', '1')
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method, headers: merged, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), h.env, {
    waitUntil: () => {}, passThroughOnException: () => {}, props: {},
  } as unknown as ExecutionContext)
}

async function initUpload(name: string, content: string, sha256?: string) {
  const response = await request('POST', '/api/clouddrive/uploads', {
    parentPath: '/', name, size: new TextEncoder().encode(content).length, mime: 'text/plain', sha256,
  })
  expect(response.status).toBe(200)
  return await response.json() as { session?: { id: string; strategy: string }; entryPath: string; skipped?: boolean }
}

async function completeUpload(sessionId: string, content?: string) {
  if (content !== undefined) expect((await request('PUT', `/api/clouddrive/uploads/${sessionId}/content`, content)).status).toBe(200)
  const response = await request('POST', `/api/clouddrive/uploads/${sessionId}/complete`, {})
  expect(response.status).toBe(200)
  return await response.json() as { entry: { id: string; path: string } }
}

async function createFolder(path: string) {
  const name = path.split('/').pop()!
  const response = await request('POST', '/api/clouddrive/folders', { parentPath: '/', name })
  expect(response.status).toBe(201)
}

describe('CloudDrive SHA-256 dedupe', () => {
  it('reuses the existing object key for identical content under another name', async () => {
    h.sqlite.prepare(`INSERT INTO CloudDrive_settings (user_id, key, value, updated_at) VALUES (?, 'quota.defaultUserBytes', '5', ?)`)
      .run(USER, Date.now())
    const first = await initUpload('hello.txt', 'hello', SHA)
    const uploaded = await completeUpload(first.session!.id, 'hello')
    const original = h.sqlite.prepare('SELECT storage_key FROM CloudDrive_files WHERE id = ?').get(uploaded.entry.id) as { storage_key: string }

    const second = await initUpload('copy.txt', 'hello', SHA)
    expect(second.session?.strategy).toBe('dedupe')
    const completed = await completeUpload(second.session!.id)
    const duplicate = h.sqlite.prepare('SELECT storage_key, checksum FROM CloudDrive_files WHERE id = ?').get(completed.entry.id) as { storage_key: string; checksum: string }
    expect(duplicate.storage_key).toBe(original.storage_key)
    expect(duplicate.checksum).toBe(SHA)
    expect(h.bucket.objects.size).toBe(1)
    expect(completed.entry.path).toBe('/copy.txt')
    expect(await usedPrimaryBytes(h.env.DB, USER)).toBe(5)
    const activity = await (await request('GET', '/api/clouddrive/activity')).json() as { activities: { action: string; target_path: string }[] }
    expect(activity.activities).toContainEqual(expect.objectContaining({ action: 'upload_dedupe', target_path: '/copy.txt' }))
  })

  it('verifies direct bytes against the declared digest before completing', async () => {
    const init = await initUpload('bad.txt', 'hello', SHA)
    const response = await request('PUT', `/api/clouddrive/uploads/${init.session!.id}/content`, 'hell0')
    expect(response.status).toBe(400)
    expect(h.bucket.objects.size).toBe(0)
  })
})

describe('CloudDrive activity and recovery', () => {
  it('audits successful writes, isolates accounts and flags destructive bursts', async () => {
    await createFolder('/docs')
    const listed = await request('GET', '/api/clouddrive/activity')
    expect(listed.status).toBe(200)
    const body = await listed.json() as { activities: { action: string }[]; alerts: number }
    expect(body.activities.some((item) => item.action === 'folder')).toBe(true)
    const otherResponse = await request('GET', '/api/clouddrive/activity', undefined, {}, OTHER)
    expect(otherResponse.status).toBe(200)
    expect((await otherResponse.json() as { activities: unknown[] }).activities).toHaveLength(0)

    const now = Date.now()
    for (let index = 0; index < 19; index++) {
      h.sqlite.prepare(`INSERT INTO CloudDrive_activities (id, user_id, action, target_path, severity, detail, created_at)
        VALUES (?, ?, 'delete', '/old', 'info', '', ?)`).run(`old-${index}`, USER, now)
    }
    const created = await request('POST', '/api/clouddrive/folders', { parentPath: '/', name: 'remove-me' })
    expect(created.status).toBe(201)
    const folder = (await created.json() as { entry: { id: string } }).entry
    expect((await request('DELETE', '/api/clouddrive/files', { ids: [folder.id] })).status).toBe(200)
    const alerts = await (await request('GET', '/api/clouddrive/activity?alerts=1')).json() as { activities: { severity: string }[]; alerts: number }
    expect(alerts.alerts).toBeGreaterThan(0)
    expect(alerts.activities.every((item) => item.severity === 'warning')).toBe(true)
  })

  it('paginates audit rows by timestamp and id without crossing owners', async () => {
    const now = Date.now()
    for (let index = 0; index < 6; index++) {
      h.sqlite.prepare(`INSERT INTO CloudDrive_activities (id, user_id, action, target_path, severity, detail, created_at)
        VALUES (?, ?, 'folder', ?, 'info', '', ?)`).run(`audit-${index}`, USER, `/folder-${index}`, now)
    }
    h.sqlite.prepare(`INSERT INTO CloudDrive_activities (id, user_id, action, target_path, severity, detail, created_at)
      VALUES ('other-audit', ?, 'folder', '/private', 'info', '', ?)`).run(OTHER, now + 1)

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ limit: '2' })
      if (cursor) query.set('cursor', cursor)
      const response = await request('GET', `/api/clouddrive/activity?${query}`)
      expect(response.status).toBe(200)
      const body = await response.json() as { activities: { id: string }[]; cursor: string | null }
      seen.push(...body.activities.map((item) => item.id))
      cursor = body.cursor
      if (!cursor) break
    }
    expect(seen).toEqual(['audit-5', 'audit-4', 'audit-3', 'audit-2', 'audit-1', 'audit-0'])
    expect((await request('GET', '/api/clouddrive/activity?cursor=not-base64')).status).toBe(400)
    const otherResponse = await request('GET', '/api/clouddrive/activity', undefined, {}, OTHER)
    expect(otherResponse.status).toBe(200)
    const other = await otherResponse.json() as { activities: { id: string }[] }
    expect(other.activities.map((item) => item.id)).toEqual(['other-audit'])
  })

  it('keeps snapshot object references through purge and recreates a missing file on restore', async () => {
    const init = await initUpload('recover.txt', 'hello', SHA)
    const uploaded = await completeUpload(init.session!.id, 'hello')
    expect((await request('POST', `/api/clouddrive/files/${uploaded.entry.id}/tags`, { tag: 'important' })).status).toBe(200)
    const created = await request('POST', '/api/clouddrive/snapshots', { name: 'Before delete' })
    expect(created.status).toBe(201)
    const snapshot = (await created.json() as { snapshot: { id: string } }).snapshot
    expect((await request('DELETE', '/api/clouddrive/files', { ids: [uploaded.entry.id] })).status).toBe(200)
    expect((await request('DELETE', '/api/clouddrive/files/purge', { ids: [uploaded.entry.id] })).status).toBe(200)
    expect(h.bucket.objects.size).toBe(1)
    expect(await usedPrimaryBytes(h.env.DB, USER)).toBe(5)

    const restored = await request('POST', `/api/clouddrive/snapshots/${snapshot.id}/restore`, {})
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ restored: 1, skipped: 0 })
    const row = h.sqlite.prepare(`SELECT id, path FROM CloudDrive_files WHERE user_id = ? AND id = ?`).get(USER, uploaded.entry.id)
    expect(row).toMatchObject({ id: uploaded.entry.id, path: '/recover.txt' })
    expect(h.sqlite.prepare('SELECT tag FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ?').get(USER, uploaded.entry.id))
      .toMatchObject({ tag: 'important' })
    expect((await request('DELETE', `/api/clouddrive/snapshots/${snapshot.id}`)).status).toBe(200)
  })

  it('rolls back the whole restore when a later snapshot item fails', async () => {
    const first = await initUpload('a.txt', 'hello', SHA)
    const firstUpload = await completeUpload(first.session!.id, 'hello')
    const second = await initUpload('b.txt', 'hello', SHA)
    const secondUpload = await completeUpload(second.session!.id)
    const created = await request('POST', '/api/clouddrive/snapshots', { name: 'Atomic restore' })
    const snapshot = (await created.json() as { snapshot: { id: string } }).snapshot
    expect((await request('DELETE', '/api/clouddrive/files', { ids: [firstUpload.entry.id, secondUpload.entry.id] })).status).toBe(200)
    expect((await request('DELETE', '/api/clouddrive/files/purge', { ids: [firstUpload.entry.id, secondUpload.entry.id] })).status).toBe(200)
    h.sqlite.exec(`CREATE TRIGGER fail_restore BEFORE INSERT ON CloudDrive_files
      WHEN NEW.name = 'b.txt' BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END`)

    expect((await request('POST', `/api/clouddrive/snapshots/${snapshot.id}/restore`, {})).status).toBe(500)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NULL`).get(USER))
      .toMatchObject({ count: 0 })
  })

  it('does not restore a child under a parent that is still deleted', async () => {
    const created = await request('POST', '/api/clouddrive/folders', { parentPath: '/', name: 'docs' })
    const folder = (await created.json() as { entry: { id: string } }).entry
    const init = await request('POST', '/api/clouddrive/uploads', {
      parentPath: '/docs', name: 'child.txt', size: 5, mime: 'text/plain', sha256: SHA,
    })
    const session = (await init.json() as { session: { id: string } }).session
    const uploaded = await completeUpload(session.id, 'hello')
    const snapshot = (await (await request('POST', '/api/clouddrive/snapshots', { name: 'Deleted parent' })).json() as { snapshot: { id: string } }).snapshot
    expect((await request('DELETE', '/api/clouddrive/files', { ids: [folder.id] })).status).toBe(200)
    expect((await request('DELETE', '/api/clouddrive/files/purge', { ids: [uploaded.entry.id] })).status).toBe(200)

    const restored = await request('POST', `/api/clouddrive/snapshots/${snapshot.id}/restore`, {})
    expect(restored.status).toBe(207)
    expect(await restored.json()).toMatchObject({ restored: 0, skipped: 2 })
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS count FROM CloudDrive_files
      WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL`).get(USER, folder.id)).toMatchObject({ count: 0 })
  })

  it('keeps restored children under a renamed snapshot folder', async () => {
    const created = await request('POST', '/api/clouddrive/folders', { parentPath: '/', name: 'docs' })
    const folder = (await created.json() as { entry: { id: string } }).entry
    const init = await request('POST', '/api/clouddrive/uploads', {
      parentPath: '/docs', name: 'child.txt', size: 5, mime: 'text/plain', sha256: SHA,
    })
    const session = (await init.json() as { session: { id: string } }).session
    const uploaded = await completeUpload(session.id, 'hello')
    const snapshot = (await (await request('POST', '/api/clouddrive/snapshots', { name: 'Rename restore' })).json() as { snapshot: { id: string } }).snapshot
    expect((await request('DELETE', '/api/clouddrive/files', { ids: [folder.id] })).status).toBe(200)
    expect((await request('DELETE', '/api/clouddrive/files/purge', { ids: [folder.id] })).status).toBe(200)
    expect((await request('POST', '/api/clouddrive/folders', { parentPath: '/', name: 'docs' })).status).toBe(201)

    const restored = await request('POST', `/api/clouddrive/snapshots/${snapshot.id}/restore`, {})
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ restored: 2, skipped: 0 })
    const restoredFolder = h.sqlite.prepare('SELECT path FROM CloudDrive_files WHERE user_id = ? AND id = ?').get(USER, folder.id) as { path: string }
    const restoredChild = h.sqlite.prepare('SELECT parent_id, path FROM CloudDrive_files WHERE user_id = ? AND id = ?').get(USER, uploaded.entry.id) as { parent_id: string; path: string }
    expect(restoredFolder.path).not.toBe('/docs')
    expect(restoredChild.parent_id).toBe(folder.id)
    expect(restoredChild.path).toBe(`${restoredFolder.path}/child.txt`)
  })

  it('creates a pre-sync checkpoint and runs the scheduled backup handler', async () => {
    const target = await request('POST', '/api/clouddrive/sync/targets', { name: 'Docs', remotePath: '/' })
    const targetId = (await target.json() as { target: { id: string } }).target.id
    expect((await request('POST', `/api/clouddrive/sync/targets/${targetId}/prepare`, {})).status).toBe(201)
    const jobs = await (await request('GET', '/api/clouddrive/jobs')).json() as { jobs: { id: string }[] }
    const backup = jobs.jobs.find((job) => job.id === 'builtin_backup_snapshot')!
    expect((await request('POST', `/api/clouddrive/jobs/${backup.id}/run`, {})).status).toBe(200)
    const snapshots = await (await request('GET', '/api/clouddrive/snapshots')).json() as { snapshots: unknown[] }
    expect(snapshots.snapshots).toHaveLength(2)
  })
})

describe('CloudDrive private vault', () => {
  it('requires both passwords, hides content without the memory token and revokes it on lock', async () => {
    await createFolder('/Vault')
    expect((await request('PUT', '/api/clouddrive/vault', {
      mountId: 'primary', path: '/Vault', password: 'vault-password', currentPassword: 'wrong',
    })).status).toBe(401)
    expect((await request('PUT', '/api/clouddrive/vault', {
      mountId: 'primary', path: '/Vault', password: 'vault-password', currentPassword: PASSWORD,
    })).status).toBe(200)
    expect((await request('GET', '/api/clouddrive/files?path=%2FVault')).status).toBe(403)
    expect((await request('POST', '/api/clouddrive/vault/unlock', {
      mountId: 'primary', path: '/Vault', password: 'vault-password', currentPassword: 'wrong',
    })).status).toBe(401)
    expect((await request('POST', '/api/clouddrive/vault/unlock', {
      mountId: 'primary', path: '/Vault', password: 'wrong', currentPassword: PASSWORD,
    })).status).toBe(403)

    const unlocked = await request('POST', '/api/clouddrive/vault/unlock', {
      mountId: 'primary', path: '/Vault', password: 'vault-password', currentPassword: PASSWORD,
    })
    expect(unlocked.status).toBe(200)
    const result = await unlocked.json() as { token: string }
    const cookie = unlocked.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
    const headers = { Cookie: `inkstone_session=${TOKEN}; ${cookie}`, 'X-CloudDrive-Vault-Unlock': result.token }
    expect((await request('GET', '/api/clouddrive/files?path=%2FVault', undefined, headers)).status).toBe(200)
    expect((await request('GET', '/api/clouddrive/files?path=%2FVault', undefined, { Cookie: `inkstone_session=${TOKEN}; ${cookie}` })).status).toBe(403)
    expect((await request('POST', '/api/clouddrive/vault/lock', { mountId: 'primary', path: '/Vault' })).status).toBe(200)
    expect((await request('GET', '/api/clouddrive/files?path=%2FVault', undefined, headers)).status).toBe(403)
  })

  it('expires the vault memory session after exactly ten minutes', async () => {
    await createFolder('/TimedVault')
    expect((await request('PUT', '/api/clouddrive/vault', {
      mountId: 'primary', path: '/TimedVault', password: 'vault-password', currentPassword: PASSWORD,
    })).status).toBe(200)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    h.sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(now + 3_600_000, USER)
    const unlocked = await request('POST', '/api/clouddrive/vault/unlock', {
      mountId: 'primary', path: '/TimedVault', password: 'vault-password', currentPassword: PASSWORD,
    })
    expect(unlocked.status).toBe(200)
    const result = await unlocked.json() as { token: string; expiresAt: number }
    expect(result.expiresAt).toBe(now + 10 * 60 * 1000)
    const cookie = unlocked.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
    const headers = { Cookie: `inkstone_session=${TOKEN}; ${cookie}`, 'X-CloudDrive-Vault-Unlock': result.token }
    expect((await request('GET', '/api/clouddrive/files?path=%2FTimedVault', undefined, headers)).status).toBe(200)
    clock.mockReturnValue(now + 10 * 60 * 1000)
    expect((await request('GET', '/api/clouddrive/files?path=%2FTimedVault', undefined, headers)).status).toBe(403)
  })
})
