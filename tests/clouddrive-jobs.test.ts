// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { CLOUDDRIVE_SCHEMA_STATEMENTS } from '../src/worker/clouddrive/schema'
import { clouddriveRoutes } from '../src/worker/clouddrive/routes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { createUsersTable } from './doubles/users-table'
import { usedPrimaryBytes } from '../src/worker/clouddrive/upload-finalize'
import { runDueCloudDriveJobs } from '../src/worker/clouddrive/routes-jobs'

const USER = '0123456789abcdefghjkmnpqrs'
let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CLOUDDRIVE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  createUsersTable(sqlite)
  env = testBindings(makeD1(sqlite))
})

function appFor(role: 'owner' | 'member'): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((error, c) => errorResponse(c, error))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', {
      id: USER,
      username: 'tester',
      login: 'tester',
      name: 'Tester',
      avatarUrl: '',
      role,
      createdAt: 1,
      settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/clouddrive', clouddriveRoutes)
  return app
}

async function getJobs(role: 'owner' | 'member'): Promise<Response> {
  return appFor(role).fetch(new Request('http://localhost/api/clouddrive/jobs'), env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext)
}

function insertUsageFile(id: string, size: number): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO CloudDrive_files
       (id,user_id,mount_id,parent_id,kind,name,name_folded,name_initials,path,category,mime,size,
        etag,checksum,storage_kind,storage_key,metadata,color,starred_at,last_viewed_at,deleted_at,
        trash_batch,created_at,updated_at,uploaded_at,modified_at)
     VALUES (?, ?, 'primary', '', 'file', ?, ?, '', ?, 'txt', 'text/plain', ?,
             NULL, NULL, 'r2', ?, '{}', '', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).run(id, USER, id, id, `/${id}`, size, `CloudDrive/txt/${id}`, now, now, now, now)
}

describe('CloudDrive jobs and usage cache', () => {
  it('invalidates cached quota counts when file rows change', async () => {
    insertUsageFile('first.txt', 5)
    expect(await usedPrimaryBytes(env.DB, USER)).toBe(5)
    expect(sqlite.prepare('SELECT used_bytes FROM CloudDrive_usage WHERE user_id = ?').get(USER)).toMatchObject({ used_bytes: 5 })

    insertUsageFile('second.txt', 7)
    expect(sqlite.prepare('SELECT user_id FROM CloudDrive_usage WHERE user_id = ?').get(USER)).toBeUndefined()
    expect(await usedPrimaryBytes(env.DB, USER)).toBe(12)

    sqlite.prepare(
      `INSERT INTO CloudDrive_file_versions (user_id,file_id,version,storage_key,size,mime,etag,checksum,created_at)
       VALUES (?, 'first.txt', 1, 'CloudDrive/txt/version', 3, 'text/plain', NULL, NULL, ?)`,
    ).run(USER, Date.now())
    expect(await usedPrimaryBytes(env.DB, USER)).toBe(15)
    sqlite.prepare(
      `INSERT INTO CloudDrive_file_parts (user_id,file_id,part_number,mount_id,storage_key,size,etag,created_at)
       VALUES (?, 'first.txt', 1, 'primary', 'CloudDrive/txt/part', 2, NULL, ?)`,
    ).run(USER, Date.now())
    expect(await usedPrimaryBytes(env.DB, USER)).toBe(17)
  })

  it('recalibrates a drifted counter through the scheduled usage job', async () => {
    insertUsageFile('counted.txt', 9)
    expect(await usedPrimaryBytes(env.DB, USER)).toBe(9)
    sqlite.prepare('UPDATE CloudDrive_usage SET used_bytes = 999, live_bytes = 999 WHERE user_id = ?').run(USER)
    expect((await getJobs('owner')).status).toBe(200)

    const result = await runDueCloudDriveJobs(env, Date.now() + 1)
    expect(result.failed).toBe(0)
    expect(sqlite.prepare('SELECT used_bytes, live_bytes FROM CloudDrive_usage WHERE user_id = ?').get(USER))
      .toMatchObject({ used_bytes: 9, live_bytes: 9 })
  })
  it('allows the owner to manage scheduled jobs', async () => {
    const response = await getJobs('owner')
    expect(response.status).toBe(200)
    const jobs = (await response.json() as { jobs: Array<{ builtin: boolean }> }).jobs
    expect(jobs).toHaveLength(5)
    expect(jobs.every((job) => job.builtin)).toBe(true)
  })

  it('rejects members even though their data would be user-scoped', async () => {
    const response = await getJobs('member')
    expect(response.status).toBe(403)
  })
})
