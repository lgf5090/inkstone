// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppBindings, Env } from '../src/worker/env'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveActivityRoutes } from '../src/worker/clouddrive/routes-activity'
import { clouddriveBackupRoutes } from '../src/worker/clouddrive/routes-backups'
import { clouddriveJobRoutes } from '../src/worker/clouddrive/routes-jobs'
import { clouddriveSnapshotRoutes } from '../src/worker/clouddrive/routes-snapshots'
import { clouddriveVaultRoutes } from '../src/worker/clouddrive/routes-vault'
import { clouddriveSyncRoutes } from '../src/worker/clouddrive/routes-sync'
import { listActivities, recordActivity } from '../src/worker/clouddrive/activity'
import { createSnapshot } from '../src/worker/clouddrive/snapshots'
import { ensurePrimaryMount } from '../src/worker/clouddrive/store'
import { errorResponse } from '../src/worker/lib/errors'
import { hashPassword } from '../src/worker/lib/password'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { createUsersTable } from './doubles/users-table'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const PASSWORD = 'owner-password'

interface Harness { sqlite: DatabaseSync; env: Env; app: Hono<AppBindings> }
let h: Harness

beforeEach(async () => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  const env = testBindings(makeD1(sqlite, { maxBatchStatements: 90, maxBoundParameters: 100 }), { FILES: testR2Bucket() })
  const passwordHash = await hashPassword(PASSWORD)
  const now = Date.now()
  for (const [id, role] of [[USER, 'owner'], [OTHER, 'member']] as const) {
    sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, '', '', ?, '{}', ?, ?)`).run(id, id, passwordHash, id, role, now, now)
    await ensurePrimaryMount(env.DB, id)
  }
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    const userId = c.req.header('X-Test-User') ?? USER
    c.set('userId', userId)
    c.set('user', {
      id: userId, username: userId, login: userId, name: '', avatarUrl: '',
      role: userId === USER ? 'owner' : 'member', createdAt: now, settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/clouddrive', clouddriveActivityRoutes)
  app.route('/api/clouddrive', clouddriveBackupRoutes)
  app.route('/api/clouddrive', clouddriveJobRoutes)
  app.route('/api/clouddrive', clouddriveSnapshotRoutes)
  app.route('/api/clouddrive', clouddriveVaultRoutes)
  app.route('/api/clouddrive', clouddriveSyncRoutes)
  h = { sqlite, env, app }
})

afterEach(() => h.sqlite.close())

async function request(method: string, path: string, body?: unknown, as = USER): Promise<Response> {
  const headers = new Headers({ 'X-Test-User': as })
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), h.env)
}

function insertFile(id: string): void {
  const now = Date.now()
  h.sqlite.prepare(`INSERT INTO CloudDrive_files
    (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,
     etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,
     trash_batch,created_at,updated_at,uploaded_at,modified_at)
    VALUES (?, ?, 'primary', '', 'file', ?, ?, '', ?, 'txt', 'text/plain', 1,
     NULL, NULL, 'r2', ?, '{}', '', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`)
    .run(id, USER, id, id, `/${id}`, `CloudDrive/txt/${id}`, now, now, now, now)
}

describe('CloudDrive audit and backup boundaries', () => {
  it('seeds the backup job when the backups page is opened before the jobs page', async () => {
    const response = await request('GET', '/api/clouddrive/backups/status')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ backup: { enabled: true, intervalSec: 86_400 } })
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS count FROM CloudDrive_scheduled_jobs
      WHERE user_id = ? AND builtin = 1`).get(USER)).toMatchObject({ count: 5 })
  })

  it('isolates alerts and uses the id as the cursor tie-breaker', async () => {
    const now = Date.now()
    for (let index = 0; index < 19; index++) await recordActivity(h.env.DB, USER, { action: 'delete', targetPath: '/old', destructive: true })
    await recordActivity(h.env.DB, USER, { action: 'purge', targetPath: '/trash', destructive: true })
    await recordActivity(h.env.DB, OTHER, { action: 'delete', targetPath: '/private', destructive: true })
    h.sqlite.prepare(`UPDATE CloudDrive_activities SET created_at = ? WHERE user_id = ?`).run(now, USER)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_activities').get()).toMatchObject({ count: 21 })
    expect(h.sqlite.prepare('SELECT user_id, COUNT(*) AS count FROM CloudDrive_activities GROUP BY user_id').all()).toEqual([
      { user_id: USER, count: 20 }, { user_id: OTHER, count: 1 },
    ])

    const first = await listActivities(h.env.DB, USER, { limit: 2 })
    expect(first.activities).toHaveLength(2)
    expect(first.activities.map((row) => row.id)).toEqual([...first.activities.map((row) => row.id)].sort().reverse())
    expect(first.cursor).not.toBeNull()
    const second = await listActivities(h.env.DB, USER, { limit: 2, cursor: first.cursor! })
    expect(second.activities.every((row) => !first.activities.some((item) => item.id === row.id))).toBe(true)
    const alerts = await listActivities(h.env.DB, USER, { alerts: true })
    expect(alerts.alerts).toBe(1)
    expect(alerts.activities).toHaveLength(1)
    expect(alerts.activities[0]?.severity).toBe('warning')
    expect((await listActivities(h.env.DB, OTHER, { alerts: true })).alerts).toBe(0)
    await expect(listActivities(h.env.DB, USER, { cursor: 'invalid' })).rejects.toMatchObject({ status: 400 })
  })

  it('rejects members from backup, snapshot, job and vault management', async () => {
    await createSnapshot(h.env, USER, 'Owner snapshot')
    await createSnapshot(h.env, OTHER, 'Other snapshot')
    expect((await request('GET', '/api/clouddrive/jobs')).status).toBe(200)
    const own = await (await request('GET', '/api/clouddrive/snapshots')).json() as { snapshots: { name: string }[] }
    expect(own.snapshots.map((row) => row.name)).toEqual(['Owner snapshot'])
    const ownerSnapshot = own.snapshots[0]!
    const snapshotId = h.sqlite.prepare('SELECT id FROM CloudDrive_snapshots WHERE user_id = ?').get(USER) as { id: string }
    const otherSnapshotId = h.sqlite.prepare('SELECT id FROM CloudDrive_snapshots WHERE user_id = ?').get(OTHER) as { id: string }

    const denied: Array<[string, string, unknown?]> = [
      ['GET', '/api/clouddrive/jobs'], ['GET', '/api/clouddrive/backups/status'],
      ['PATCH', '/api/clouddrive/backups/schedule', { enabled: false }],
      ['POST', '/api/clouddrive/backups/run', {}], ['GET', '/api/clouddrive/snapshots'],
      ['POST', '/api/clouddrive/snapshots', { name: 'Member snapshot' }],
      ['POST', `/api/clouddrive/snapshots/${snapshotId.id}/restore`, {}],
      ['DELETE', `/api/clouddrive/snapshots/${snapshotId.id}`],
      ['PUT', '/api/clouddrive/vault', { path: '/Vault', password: 'vault-password', currentPassword: PASSWORD }],
      ['POST', '/api/clouddrive/vault/unlock', { path: '/Vault', password: 'vault-password', currentPassword: PASSWORD }],
      ['POST', '/api/clouddrive/vault/lock', { path: '/Vault' }],
      ['DELETE', '/api/clouddrive/vault', { path: '/Vault', currentPassword: PASSWORD }],
    ]
    for (const [method, path, body] of denied) expect((await request(method, path, body, OTHER)).status).toBe(403)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_snapshots').get()).toMatchObject({ count: 2 })
    expect((await request('POST', `/api/clouddrive/snapshots/${otherSnapshotId.id}/restore`, {})).status).toBe(404)
    const crossOwnerDelete = await request('DELETE', `/api/clouddrive/snapshots/${otherSnapshotId.id}`)
    expect(crossOwnerDelete.status).toBe(200)
    expect(await crossOwnerDelete.json()).toEqual({ ok: false })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_snapshots WHERE user_id = ?').get(OTHER)).toMatchObject({ count: 1 })
    expect(ownerSnapshot.name).toBe('Owner snapshot')
  })

  it('validates backup schedules and audits an automatic backup run', async () => {
    const jobs = await (await request('GET', '/api/clouddrive/jobs')).json() as { jobs: { id: string; handler: string }[] }
    const backup = jobs.jobs.find((job) => job.handler === 'backup_snapshot')!
    const status = await request('GET', '/api/clouddrive/backups/status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ backup: { enabled: true, intervalSec: 86_400 } })
    expect((await request('PATCH', '/api/clouddrive/backups/schedule', { intervalSec: 60 })).status).toBe(400)
    expect((await request('PATCH', '/api/clouddrive/backups/schedule', { enabled: false })).status).toBe(200)
    expect(await (await request('GET', '/api/clouddrive/backups/status')).json()).toMatchObject({ backup: { enabled: false, nextRunAfter: null } })
    expect((await request('POST', '/api/clouddrive/backups/run', {})).status).toBe(201)
    const runResponse = await request('POST', `/api/clouddrive/jobs/${backup.id}/run`, {})
    expect(runResponse.status).toBe(200)
    expect(await runResponse.json()).toMatchObject({ run: { status: 'success' } })

    const snapshots = await (await request('GET', '/api/clouddrive/snapshots')).json() as { snapshots: unknown[] }
    expect(snapshots.snapshots).toHaveLength(2)
    const audit = await (await request('GET', '/api/clouddrive/activity')).json() as { activities: { action: string; target_path: string }[] }
    expect(audit.activities).toContainEqual(expect.objectContaining({ action: 'backup', target_path: '/' }))
  })

  it('does not leave a partial snapshot when item insertion fails', async () => {
    for (let index = 0; index < 92; index++) insertFile(`file-${String(index).padStart(2, '0')}.txt`)
    h.sqlite.exec(`CREATE TRIGGER fail_snapshot_item BEFORE INSERT ON CloudDrive_snapshot_items
      WHEN json_extract(NEW.payload, '$.file.name') = 'file-91.txt'
      BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END`)
    expect((await request('POST', '/api/clouddrive/snapshots', { name: 'Must roll back' })).status).toBe(500)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_snapshots').get()).toMatchObject({ count: 0 })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS count FROM CloudDrive_snapshot_items').get()).toMatchObject({ count: 0 })
  })
})
