// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import {
  cancelScheduledSend,
  claimScheduledSends,
  listScheduledSends,
  runScheduledSends,
  scheduleDraftSend,
} from '../../src/worker/email/scheduled-send'
import { newId } from '../../src/worker/lib/id'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'
import { makeD1 } from '../doubles/d1-sqlite'
import { mailboxHarness, seedUser, type MailboxHarness } from '../fixtures/email/harness'

const OWNER = 'owner-user'
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

let sqlite: DatabaseSync
let db: D1Database
let harness: MailboxHarness
let bucket: TestR2Bucket
let env: Env
let accountId: string
let provider: ReturnType<typeof vi.fn>

interface JobColumns {
  status: string
  attempts: number
  send_at: number
  last_error: string | null
  claimed_at: number | null
}

function jobRow(id: string): JobColumns {
  return sqlite.prepare(
    'SELECT status, attempts, send_at, last_error, claimed_at FROM email_scheduled_sends WHERE id = ?',
  ).get(id) as unknown as JobColumns
}

function seedDraft(id: string, folder = 'draft', deliveryStatus: string | null = null): void {
  expect(harness.store(accountId).createEmail(folder, {
    id,
    subject: 'Hello',
    sender: 'owner@example.com',
    recipient: 'bob@example.com',
    cc: null,
    bcc: null,
    date: Date.now(),
    body: '<p>Hello <strong>there</strong></p>',
    bodySource: 'Hello **there**',
    deliveryStatus,
  })).toBe(true)
}

async function seedAttachment(draftId: string): Promise<string> {
  const id = newId()
  const objectKey = `mail/docs/${id}.pdf`
  await bucket.put(objectKey, new TextEncoder().encode('attachment bytes'), {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { sha256: `sha-${id}` },
  })
  sqlite.prepare(
    `INSERT INTO email_attachments (
       id, user_id, account_id, email_id, filename, mime, size, width, height,
       content_id, disposition, object_key, storage, folder_id, is_starred,
       is_pinned, tags, locked, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'attachment', ?, 'r2', NULL, 0, 0, '[]', 0, ?)`,
  ).run(id, OWNER, accountId, draftId, 'report.pdf', 'application/pdf', 16, objectKey, Date.now())
  harness.store(accountId).setHasAttachment(draftId, true)
  return id
}

function insertJob(input: {
  id?: string
  userId?: string
  account?: string
  draftId: string
  operationId?: string
  sendAt: number
  status?: string
  attempts?: number
  claimedAt?: number | null
}): string {
  const id = input.id ?? newId()
  sqlite.prepare(
    `INSERT INTO email_scheduled_sends (
       id, user_id, account_id, draft_id, operation_id, send_at, status, attempts, claimed_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.userId ?? OWNER,
    input.account ?? accountId,
    input.draftId,
    input.operationId ?? newId(),
    input.sendAt,
    input.status ?? 'queued',
    input.attempts ?? 0,
    input.claimedAt ?? null,
    Date.now(),
    Date.now(),
  )
  return id
}

function sentMessage(index: number): Record<string, unknown> {
  return provider.mock.calls[index]?.[0] as Record<string, unknown>
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  seedUser(sqlite, OWNER, 'owner')
  harness = mailboxHarness()
  bucket = testR2Bucket()
  provider = vi.fn(async () => ({ messageId: `provider-${provider.mock.calls.length}` }))
  env = testBindings(db, {
    EMAIL_MAILBOX: harness.namespace,
    FILES: bucket,
    EMAIL: { send: provider } as unknown as Env['EMAIL'],
  })
  accountId = (await createEmailAccount(db, {
    userId: OWNER,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
})

describe('scheduled send store', () => {
  it('queues a future job for a draft and lists it for the mailbox', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const sendAt = Date.now() + HOUR_MS
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, sendAt, 'op-1')

    expect(job).toMatchObject({
      accountId,
      draftId,
      sendAt: new Date(sendAt).toISOString(),
      status: 'queued',
      attempts: 0,
      lastError: null,
    })
    const listed = await listScheduledSends(env, OWNER, accountId)
    expect(listed.map((entry) => entry.id)).toEqual([job.id])
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 0, claimed_at: null })
  })

  it('replays the same operation and rejects a second queued job for the draft', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const sendAt = Date.now() + HOUR_MS
    const first = await scheduleDraftSend(env, OWNER, accountId, draftId, sendAt, 'op-1')
    const replay = await scheduleDraftSend(env, OWNER, accountId, draftId, sendAt, 'op-1')
    expect(replay.id).toBe(first.id)

    await expect(scheduleDraftSend(env, OWNER, accountId, draftId, sendAt, 'op-2'))
      .rejects.toMatchObject({ status: 409 })
    await expect(scheduleDraftSend(env, OWNER, accountId, draftId, sendAt + 1000, 'op-1'))
      .rejects.toMatchObject({ status: 409 })
  })

  it('rejects past, distant and missing drafts', async () => {
    const draftId = newId()
    seedDraft(draftId)
    await expect(scheduleDraftSend(env, OWNER, accountId, draftId, Date.now() - 1))
      .rejects.toMatchObject({ status: 400 })
    await expect(scheduleDraftSend(env, OWNER, accountId, draftId, Date.now() + 366 * 24 * HOUR_MS))
      .rejects.toMatchObject({ status: 400 })
    await expect(scheduleDraftSend(env, OWNER, accountId, newId(), Date.now() + HOUR_MS))
      .rejects.toMatchObject({ status: 404 })
    const sentDraft = newId()
    seedDraft(sentDraft, 'sent', 'sent')
    await expect(scheduleDraftSend(env, OWNER, accountId, sentDraft, Date.now() + HOUR_MS))
      .rejects.toMatchObject({ status: 404 })
  })

  it('cancels only a queued job', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, Date.now() + HOUR_MS)
    expect(await cancelScheduledSend(env, OWNER, job.id, accountId)).toBe(true)
    expect(jobRow(job.id).status).toBe('cancelled')
    expect(await cancelScheduledSend(env, OWNER, job.id, accountId)).toBe(false)

    const running = insertJob({ draftId: newId(), sendAt: Date.now(), status: 'running' })
    expect(await cancelScheduledSend(env, OWNER, running, accountId)).toBe(false)
    expect(jobRow(running).status).toBe('running')
  })

  it('never sends a cancelled job', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    expect(await cancelScheduledSend(env, OWNER, job.id, accountId)).toBe(true)
    const sweep = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(sweep).toEqual({ started: 0, sent: 0, retried: 0, failed: 0 })
    expect(provider).not.toHaveBeenCalled()
    expect(harness.store(accountId).getEmail(draftId)?.folder_id).toBe('draft')
  })

  it('claims only due jobs and reclaims a stale lease', async () => {
    const now = Date.now()
    const dueDraft = newId()
    const futureDraft = newId()
    seedDraft(dueDraft)
    seedDraft(futureDraft)
    const due = await scheduleDraftSend(env, OWNER, accountId, dueDraft, now + MINUTE_MS)
    const future = await scheduleDraftSend(env, OWNER, accountId, futureDraft, now + HOUR_MS)

    const claimed = await claimScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(claimed.map((row) => row.id)).toEqual([due.id])
    expect(claimed[0]).toMatchObject({ status: 'running', attempts: 1 })
    expect(jobRow(future.id).status).toBe('queued')

    const second = await claimScheduledSends(env, now + 3 * MINUTE_MS, 5)
    expect(second).toEqual([])

    const stale = await claimScheduledSends(env, now + 2 * MINUTE_MS + 11 * MINUTE_MS, 5)
    expect(stale.map((row) => row.id)).toEqual([due.id])
    expect(stale[0]?.attempts).toBe(2)
  })
})

describe('scheduled send cron sweep', () => {
  it('sends a due draft with its attachments and marks the job sent', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    const attachmentId = await seedAttachment(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)

    const sweep = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)

    expect(sweep).toEqual({ started: 1, sent: 1, retried: 0, failed: 0 })
    expect(provider).toHaveBeenCalledTimes(1)
    const message = sentMessage(0)
    expect(message).toMatchObject({
      to: 'bob@example.com',
      from: { email: 'owner@example.com', name: 'Owner' },
      subject: 'Hello',
      html: '<p>Hello <strong>there</strong></p>',
    })
    const attachments = message.attachments as { filename: string; content: string }[]
    expect(attachments.map((entry) => entry.filename)).toEqual(['report.pdf'])
    expect(attachments[0]?.content).toBe(Buffer.from('attachment bytes').toString('base64'))
    expect(harness.store(accountId).getEmail(draftId)).toMatchObject({
      folder_id: 'sent',
      delivery_status: 'sent',
    })
    expect(jobRow(job.id)).toMatchObject({ status: 'sent', attempts: 1, last_error: null })
    expect(sqlite.prepare('SELECT locked FROM email_attachments WHERE id = ?').get(attachmentId))
      .toEqual({ locked: 1 })
  })

  it('does not send a draft that was already sent', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId, 'sent', 'sent')
    const job = insertJob({ draftId, sendAt: now + MINUTE_MS })

    const sweep = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)

    expect(sweep).toEqual({ started: 1, sent: 1, retried: 0, failed: 0 })
    expect(provider).not.toHaveBeenCalled()
    expect(jobRow(job).status).toBe('sent')
  })

  it('retries a refused send and succeeds on the next pass', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    await seedAttachment(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    provider.mockRejectedValueOnce(new Error('The mail service refused the message'))

    const first = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(first).toEqual({ started: 1, sent: 0, retried: 1, failed: 0 })
    expect(jobRow(job.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error: 'The mail service refused the message',
      send_at: now + 2 * MINUTE_MS + 5 * MINUTE_MS,
    })
    expect(harness.store(accountId).getEmail(draftId)?.delivery_status).toBe('failed')

    const second = await runScheduledSends(env, now + 8 * MINUTE_MS, 5)
    expect(second).toEqual({ started: 1, sent: 1, retried: 0, failed: 0 })
    expect(provider).toHaveBeenCalledTimes(2)
    const retried = sentMessage(1)
    const attachments = retried.attachments as { filename: string }[]
    expect(attachments.map((entry) => entry.filename)).toEqual(['report.pdf'])
    expect(harness.store(accountId).getEmail(draftId)?.delivery_status).toBe('sent')
    expect(jobRow(job.id)).toMatchObject({ status: 'sent', attempts: 2, last_error: null })
  })

  it('stops after three refused attempts', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    provider.mockRejectedValue(new Error('The mail service refused the message'))

    const first = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(first.retried).toBe(1)
    const secondAt = now + 2 * MINUTE_MS + 5 * MINUTE_MS
    const second = await runScheduledSends(env, secondAt, 5)
    expect(second.retried).toBe(1)
    const third = await runScheduledSends(env, secondAt + 5 * MINUTE_MS, 5)
    expect(third).toEqual({ started: 1, sent: 0, retried: 0, failed: 1 })
    expect(provider).toHaveBeenCalledTimes(3)
    expect(jobRow(job.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'The mail service refused the message',
    })
  })

  it('fails a job whose account or draft is gone', async () => {
    const now = Date.now()
    const orphan = insertJob({
      userId: newId(),
      account: newId(),
      draftId: newId(),
      sendAt: now + MINUTE_MS,
    })
    const missingDraft = insertJob({ draftId: newId(), sendAt: now + MINUTE_MS })

    const sweep = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)

    expect(sweep).toEqual({ started: 2, sent: 0, retried: 0, failed: 2 })
    expect(jobRow(orphan)).toMatchObject({ status: 'failed', last_error: 'account_missing' })
    expect(jobRow(missingDraft)).toMatchObject({ status: 'failed', last_error: 'draft_missing' })
    expect(provider).not.toHaveBeenCalled()
  })
})
