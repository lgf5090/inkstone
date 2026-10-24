// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailScheduledSend } from '../../src/shared/email/model'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailScheduleRoutes } from '../../src/worker/routes/email-schedule'
import { testBindings } from '../doubles/bindings'
import { makeD1 } from '../doubles/d1-sqlite'
import { mailboxHarness, seedUser, type MailboxHarness } from '../fixtures/email/harness'

const OWNER = 'owner-user'
const HOUR_MS = 60 * 60 * 1000

let sqlite: DatabaseSync
let db: D1Database
let harness: MailboxHarness
let env: Env
let userId: string
let userRole: 'owner' | 'member'
let accountId: string

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('/api/email/*', async (c, next) => {
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: 'owner',
        login: 'owner',
        name: 'Owner',
        avatarUrl: '',
        role: userRole,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/email', emailScheduleRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return await app().request(`/api/email${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return (await json<{ error: { code: string; message: string } }>(response)).error
}

function seedDraft(id: string): void {
  expect(harness.store(accountId).createEmail('draft', {
    id,
    subject: 'Hello',
    sender: 'owner@example.com',
    recipient: 'bob@example.com',
    date: Date.now(),
    body: '<p>Hello</p>',
    bodySource: 'Hello',
  })).toBe(true)
}

function jobStatus(id: string): string {
  return (sqlite.prepare('SELECT status FROM email_scheduled_sends WHERE id = ?').get(id) as { status: string }).status
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  seedUser(sqlite, OWNER, 'owner')
  harness = mailboxHarness()
  env = testBindings(db, { EMAIL_MAILBOX: harness.namespace })
  userId = OWNER
  userRole = 'owner'
  accountId = (await createEmailAccount(db, {
    userId: OWNER,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
})

describe('scheduled send routes', () => {
  it('requires an owner session', async () => {
    const draftId = newId()
    seedDraft(draftId)
    userId = ''
    const anonymous = await call('GET', `/accounts/${accountId}/scheduled`)
    expect(anonymous.status).toBe(401)

    userId = newId()
    userRole = 'member'
    const member = await call('GET', `/accounts/${accountId}/scheduled`)
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')
  })

  it('treats another account as absent', async () => {
    const draftId = newId()
    seedDraft(draftId)
    userId = newId()
    const response = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt: new Date(Date.now() + HOUR_MS).toISOString(),
    })
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
  })

  it('validates the send time and the draft', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const missing = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {})
    expect(missing.status).toBe(400)
    const bad = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, { sendAt: 'not-a-date' })
    expect(bad.status).toBe(400)
    const past = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, { sendAt: Date.now() - 1 })
    expect(past.status).toBe(400)
    const distant = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt: Date.now() + 366 * 24 * HOUR_MS,
    })
    expect(distant.status).toBe(400)
    const invalidDraft = await call('POST', `/accounts/${accountId}/drafts/not-an-id/schedule`, {
      sendAt: Date.now() + HOUR_MS,
    })
    expect(invalidDraft.status).toBe(404)
    const missingDraft = await call('POST', `/accounts/${accountId}/drafts/${newId()}/schedule`, {
      sendAt: Date.now() + HOUR_MS,
    })
    expect(missingDraft.status).toBe(404)
  })

  it('schedules, lists and cancels a job', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const sendAt = Date.now() + HOUR_MS

    const created = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt: new Date(sendAt).toISOString(),
      operationId: 'op-1',
    })
    expect(created.status).toBe(201)
    const job = await json<EmailScheduledSend>(created)
    expect(job).toMatchObject({
      accountId,
      draftId,
      sendAt: new Date(sendAt).toISOString(),
      status: 'queued',
      attempts: 0,
    })

    const listed = await call('GET', `/accounts/${accountId}/scheduled`)
    expect(listed.status).toBe(200)
    expect((await json<EmailScheduledSend[]>(listed)).map((entry) => entry.id)).toEqual([job.id])

    const cancelled = await call('DELETE', `/accounts/${accountId}/scheduled/${job.id}`)
    expect(cancelled.status).toBe(204)
    expect(jobStatus(job.id)).toBe('cancelled')
    expect((await call('DELETE', `/accounts/${accountId}/scheduled/${job.id}`)).status).toBe(404)
    expect((await call('DELETE', `/accounts/${accountId}/scheduled/not-an-id`)).status).toBe(404)
  })

  it('rejects a second job for the same draft and replays an operation', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const sendAt = Date.now() + HOUR_MS
    const first = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt,
      operationId: 'op-1',
    })
    const firstJob = await json<EmailScheduledSend>(first)
    const replay = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt,
      operationId: 'op-1',
    })
    expect(replay.status).toBe(201)
    expect((await json<EmailScheduledSend>(replay)).id).toBe(firstJob.id)

    const duplicate = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt,
      operationId: 'op-2',
    })
    expect(duplicate.status).toBe(409)
  })

  it('does not let another mailbox cancel the job', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const other = await createEmailAccount(db, {
      userId: OWNER,
      address: 'other@example.com',
      displayName: 'Other',
    })
    const created = await call('POST', `/accounts/${accountId}/drafts/${draftId}/schedule`, {
      sendAt: Date.now() + HOUR_MS,
    })
    const job = await json<EmailScheduledSend>(created)

    const response = await call('DELETE', `/accounts/${other.id}/scheduled/${job.id}`)
    expect(response.status).toBe(404)
    expect(jobStatus(job.id)).toBe('queued')
  })
})
