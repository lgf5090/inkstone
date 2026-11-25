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

describe('CloudDrive jobs authorization', () => {
  it('allows the owner to manage scheduled jobs', async () => {
    const response = await getJobs('owner')
    expect(response.status).toBe(200)
    const jobs = (await response.json() as { jobs: Array<{ builtin: boolean }> }).jobs
    expect(jobs).toHaveLength(4)
    expect(jobs.every((job) => job.builtin)).toBe(true)
  })

  it('rejects members even though their data would be user-scoped', async () => {
    const response = await getJobs('member')
    expect(response.status).toBe(403)
  })
})
