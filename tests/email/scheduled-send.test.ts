// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { EMAIL_SEND_RATE_LIMIT_HOUR } from '../../src/shared/email/model'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import {
  cancelScheduledSend,
  claimScheduledSends,
  cleanupScheduledSends,
  listScheduledSendPage,
  listScheduledSends,
  rescheduleScheduledSend,
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

afterEach(() => {
  vi.useRealTimers()
})

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

  it('sends the queued snapshot after the draft body or attachments change', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    const draft = harness.store(accountId).getEmail(draftId)!
    expect(harness.store(accountId).saveDraft(draftId, {
      id: draftId,
      subject: 'Edited subject',
      sender: draft.sender,
      recipient: draft.recipient,
      date: Date.now(),
      body: '<p>Edited body</p>',
      bodySource: 'Edited body',
      threadId: draft.thread_id,
    })).toBe(draftId)
    await seedAttachment(draftId)

    expect(await runScheduledSends(env, now + 2 * MINUTE_MS, 5)).toEqual({
      started: 1,
      sent: 1,
      retried: 0,
      failed: 0,
    })
    expect(sentMessage(0)).toMatchObject({
      subject: 'Hello',
      html: '<p>Hello <strong>there</strong></p>',
      text: 'Hello there',
    })
    expect(sentMessage(0)).not.toHaveProperty('attachments')
    expect(harness.store(accountId).getEmail(draftId)).toMatchObject({
      folder_id: 'sent',
      subject: 'Hello',
      body: '<p>Hello <strong>there</strong></p>',
      delivery_status: 'sent',
    })
    expect(jobRow(job.id).status).toBe('sent')
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

  it('reschedules only queued jobs and keeps the operation stable', async () => {
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, Date.now() + HOUR_MS, 'reschedule-op')
    const sendAt = Date.now() + 2 * HOUR_MS
    const updated = await rescheduleScheduledSend(env, OWNER, accountId, job.id, sendAt)
    expect(updated).toMatchObject({ id: job.id, sendAt: new Date(sendAt).toISOString(), status: 'queued' })
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', send_at: sendAt })
    await expect(rescheduleScheduledSend(env, OWNER, accountId, job.id, Date.now() - 1)).rejects.toMatchObject({ status: 400 })

    const running = insertJob({ draftId: newId(), sendAt: Date.now(), status: 'running' })
    expect(await rescheduleScheduledSend(env, OWNER, accountId, running, sendAt)).toBeNull()
  })

  it('pages terminal history separately and cleans only old terminal jobs', async () => {
    const now = Date.now()
    const terminal: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const id = insertJob({ draftId: newId(), sendAt: now + index, status: index % 2 ? 'failed' : 'sent' })
      sqlite.prepare('UPDATE email_scheduled_sends SET updated_at = ? WHERE id = ?').run(now + index, id)
      terminal.push(id)
    }
    const active = insertJob({ draftId: newId(), sendAt: now + HOUR_MS, status: 'queued' })
    sqlite.prepare('UPDATE email_scheduled_sends SET updated_at = ? WHERE id = ?').run(now - 24 * HOUR_MS, active)

    const first = await listScheduledSendPage(env, OWNER, accountId, { status: 'history', limit: 2 })
    expect(first.items.map((job) => job.id)).toEqual([terminal[4], terminal[3]])
    expect(first.nextCursor).not.toBeNull()
    const second = await listScheduledSendPage(env, OWNER, accountId, { status: 'history', limit: 2, cursor: first.nextCursor! })
    expect(second.items.map((job) => job.id)).toEqual([terminal[2], terminal[1]])
    const activePage = await listScheduledSendPage(env, OWNER, accountId, { status: 'active' })
    expect(activePage.items.map((job) => job.id)).toEqual([active])

    expect(await cleanupScheduledSends(env, OWNER, accountId, now + 2, 2)).toBe(2)
    expect(sqlite.prepare('SELECT status FROM email_scheduled_sends WHERE id = ?').get(terminal[0]!)).toBeUndefined()
    expect(sqlite.prepare('SELECT status FROM email_scheduled_sends WHERE id = ?').get(terminal[1]!)).toBeUndefined()
    expect(jobRow(active).status).toBe('queued')
    expect(jobRow(terminal[4]!).status).toBe('sent')
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

  it('does not complete a fixed-operation replay when its attachment was not loaded', async () => {
    const now = Date.now()
    const draftId = newId()
    seedDraft(draftId)
    const attachmentId = await seedAttachment(draftId)
    const key = `mail/docs/${attachmentId}.pdf`
    bucket.objects.delete(key)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    const claim = vi.spyOn(harness.store(accountId), 'claimOperation')

    const first = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(first).toEqual({ started: 1, sent: 0, retried: 1, failed: 0 })
    expect(jobRow(job.id)).toMatchObject({ status: 'queued', attempts: 1 })
    expect(harness.store(accountId).getEmail(draftId)).toMatchObject({ folder_id: 'draft', delivery_status: null })
    expect(provider).not.toHaveBeenCalled()

    await bucket.put(key, new TextEncoder().encode('attachment bytes'), {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { sha256: `sha-${attachmentId}` },
    })
    const second = await runScheduledSends(env, now + 8 * MINUTE_MS, 5)
    expect(second).toEqual({ started: 1, sent: 1, retried: 0, failed: 0 })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(claim.mock.calls.map(([operationId]) => operationId)).toEqual([`scheduled:${job.id}`, `scheduled:${job.id}`])
    expect(harness.store(accountId).getEmail(draftId)).toMatchObject({ folder_id: 'sent', delivery_status: 'sent' })
    expect(jobRow(job.id)).toMatchObject({ status: 'sent', attempts: 2, last_error: null })
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

  it('defers a 429 to the mailbox window without consuming an ordinary attempt', async () => {
    const now = Date.now()
    sqlite.prepare("INSERT INTO email_send_budget (user_id, bucket, window_start, count) VALUES (?, 'hour', ?, ?)")
      .run(OWNER, Math.floor(now / HOUR_MS) * HOUR_MS, EMAIL_SEND_RATE_LIMIT_HOUR)
    const draftId = newId()
    seedDraft(draftId)
    const job = await scheduleDraftSend(env, OWNER, accountId, draftId, now + MINUTE_MS)
    sqlite.prepare('UPDATE email_scheduled_sends SET attempts = 2 WHERE id = ?').run(job.id)
    const retryAt = now + 2 * MINUTE_MS + HOUR_MS + 1
    const first = await runScheduledSends(env, now + 2 * MINUTE_MS, 5)
    expect(first).toEqual({ started: 1, sent: 0, retried: 1, failed: 0 })
    expect(jobRow(job.id)).toMatchObject({
      status: 'queued',
      attempts: 2,
      send_at: retryAt,
      last_error: expect.stringMatching(/rate limit exceeded/i),
    })
    expect(provider).not.toHaveBeenCalled()
    expect(await runScheduledSends(env, retryAt - 1, 5)).toEqual({ started: 0, sent: 0, retried: 0, failed: 0 })

    vi.useFakeTimers()
    vi.setSystemTime(retryAt)
    const second = await runScheduledSends(env, retryAt, 5)
    expect(second).toEqual({ started: 1, sent: 1, retried: 0, failed: 0 })
    expect(jobRow(job.id)).toMatchObject({ status: 'sent', attempts: 3, last_error: null })
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
