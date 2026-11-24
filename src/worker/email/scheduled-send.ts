import type { EmailScheduledSend, EmailSendInput, EmailSendResult } from '@shared/email/model'
import {
  EMAIL_SCHEDULE_LEASE_MS,
  EMAIL_SCHEDULE_MAX_ATTEMPTS,
  EMAIL_SCHEDULE_MAX_MS,
  EMAIL_SCHEDULE_OPERATION_MAX_CHARS,
  EMAIL_SCHEDULE_RETRY_MS,
} from '@shared/email/model'
import { stripEmailHtmlToText } from '@shared/email/format'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import type { Env } from '../env'
import { getEmailAccount } from './account-store'
import { emailMailbox } from './mailbox-stub'
import { sendDraftEmail, sendStoredEmail } from './send-service'
import { loadEmailAttachments } from './attachments'
import type { EmailRow } from './mailbox-store'

export interface EmailScheduledSendRow {
  id: string
  user_id: string
  account_id: string
  draft_id: string
  operation_id: string
  send_at: number
  snapshot_json: string | null
  status: string
  attempts: number
  claimed_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface ScheduledSendSweep {
  started: number
  sent: number
  retried: number
  failed: number
}

export interface ScheduledSendPage {
  items: EmailScheduledSend[]
  nextCursor: string | null
}

const LIST_LIMIT = 100
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PROVIDER_RATE_LIMIT_RETRY_MS = HOUR_MS

export function toEmailScheduledSend(row: EmailScheduledSendRow): EmailScheduledSend {
  return {
    id: row.id,
    accountId: row.account_id,
    draftId: row.draft_id,
    sendAt: new Date(row.send_at).toISOString(),
    status: row.status as EmailScheduledSend['status'],
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

async function getScheduledSend(db: D1Database, userId: string, id: string): Promise<EmailScheduledSendRow | null> {
  return db.prepare(
    `SELECT * FROM email_scheduled_sends WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<EmailScheduledSendRow>()
}

function validateSendAt(sendAt: number, now = Date.now()): void {
  if (!Number.isSafeInteger(sendAt) || sendAt <= now) {
    throw ApiError.badRequest('The send time must be in the future')
  }
  if (sendAt > now + EMAIL_SCHEDULE_MAX_MS) {
    throw ApiError.badRequest('The send time must be within one year')
  }
}

function scheduledSnapshot(draft: EmailRow, attachmentIds: string[], operationId: string): EmailSendInput {
  if (!draft) throw ApiError.notFound('Draft not found')
  return {
    to: draft.recipient,
    cc: draft.cc ?? undefined,
    bcc: draft.bcc ?? undefined,
    subject: draft.subject,
    body: draft.body_source ?? stripEmailHtmlToText(draft.body),
    bodyHtml: draft.body,
    inReplyTo: draft.in_reply_to ?? undefined,
    threadId: draft.thread_id ?? undefined,
    attachmentIds,
    operationId,
  }
}

function parseScheduledSnapshot(value: string | null): EmailSendInput | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const row = parsed as Record<string, unknown>
    if (typeof row.to !== 'string' || typeof row.subject !== 'string' || typeof row.body !== 'string' || typeof row.operationId !== 'string') return null
    return parsed as EmailSendInput
  } catch {
    return null
  }
}

export async function scheduleDraftSend(
  env: Env,
  userId: string,
  accountId: string,
  draftId: string,
  sendAt: number,
  operationId?: string,
): Promise<EmailScheduledSend> {
  if (!isValidId(draftId)) throw ApiError.notFound('Draft not found')
  const now = Date.now()
  validateSendAt(sendAt, now)
  const requestedOperation = (operationId ?? '').trim()
  if (requestedOperation.length > EMAIL_SCHEDULE_OPERATION_MAX_CHARS) {
    throw ApiError.badRequest('The operation id is too long')
  }
  const operation = requestedOperation || newId()
  const account = await getEmailAccount(env.DB, userId, accountId)
  if (!account) throw ApiError.notFound('Mailbox not found')
  const existingOperation = await env.DB.prepare(
    `SELECT * FROM email_scheduled_sends WHERE user_id = ?1 AND operation_id = ?2`,
  ).bind(userId, operation).first<EmailScheduledSendRow>()
  if (existingOperation) {
    if (
      existingOperation.account_id === accountId
      && existingOperation.draft_id === draftId
      && existingOperation.send_at === sendAt
    ) {
      return toEmailScheduledSend(existingOperation)
    }
    throw ApiError.conflict('operationId was already used with different arguments')
  }
  const draft = await emailMailbox(env, account.id).getEmail(draftId)
  if (!draft || draft.folder_id !== 'draft') throw ApiError.notFound('Draft not found')
  const pending = await env.DB.prepare(
    `SELECT id FROM email_scheduled_sends
      WHERE user_id = ?1 AND account_id = ?2 AND draft_id = ?3
        AND status IN ('queued', 'running') LIMIT 1`,
  ).bind(userId, accountId, draftId).first<{ id: string }>()
  if (pending) throw new ApiError(409, 'conflict', 'A scheduled send already exists for this draft')
  const id = newId()
  const attachments = (await loadEmailAttachments(env.DB, userId, [draftId])).get(draftId) ?? []
  const snapshot = scheduledSnapshot(draft, attachments.map((entry) => entry.id), `scheduled:${id}`)
  try {
    await env.DB.prepare(
      `INSERT INTO email_scheduled_sends (
         id, user_id, account_id, draft_id, operation_id, send_at, snapshot_json, status, attempts, claimed_at, last_error, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, NULL, NULL, ?8, ?8)`,
    ).bind(id, userId, accountId, draftId, operation, sendAt, JSON.stringify(snapshot), now).run()
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new ApiError(409, 'conflict', 'A scheduled send already exists for this draft')
    }
    throw error
  }
  const created = await getScheduledSend(env.DB, userId, id)
  if (!created) throw new Error('The scheduled send could not be read back after creation')
  return toEmailScheduledSend(created)
}

export async function cancelScheduledSend(
  env: Env,
  userId: string,
  jobId: string,
  accountId?: string,
): Promise<boolean> {
  const now = Date.now()
  const result = accountId
    ? await env.DB.prepare(
      `UPDATE email_scheduled_sends SET status = 'cancelled', claimed_at = NULL, updated_at = ?1
        WHERE user_id = ?2 AND id = ?3 AND account_id = ?4 AND status = 'queued'`,
    ).bind(now, userId, jobId, accountId).run()
    : await env.DB.prepare(
      `UPDATE email_scheduled_sends SET status = 'cancelled', claimed_at = NULL, updated_at = ?1
        WHERE user_id = ?2 AND id = ?3 AND status = 'queued'`,
    ).bind(now, userId, jobId).run()
  return Boolean(result.meta.changes)
}

export async function rescheduleScheduledSend(
  env: Env,
  userId: string,
  accountId: string,
  jobId: string,
  sendAt: number,
): Promise<EmailScheduledSend | null> {
  const now = Date.now()
  validateSendAt(sendAt, now)
  const result = await env.DB.prepare(
    `UPDATE email_scheduled_sends
        SET send_at = ?1, last_error = NULL, updated_at = ?2
      WHERE user_id = ?3 AND account_id = ?4 AND id = ?5 AND status = 'queued'`,
  ).bind(sendAt, now, userId, accountId, jobId).run()
  if (!result.meta.changes) return null
  const updated = await getScheduledSend(env.DB, userId, jobId)
  if (!updated) throw new Error('The rescheduled send could not be read back')
  return toEmailScheduledSend(updated)
}

export async function claimScheduledSends(
  env: Env,
  now = Date.now(),
  limit = 3,
): Promise<EmailScheduledSendRow[]> {
  const stale = now - EMAIL_SCHEDULE_LEASE_MS
  const { results } = await env.DB.prepare(
    `SELECT * FROM email_scheduled_sends
      WHERE (status = 'queued' AND send_at <= ?1) OR (status = 'running' AND COALESCE(claimed_at, 0) < ?2)
      ORDER BY send_at ASC LIMIT ?3`,
  ).bind(now, stale, Math.max(1, Math.trunc(limit))).all<EmailScheduledSendRow>()
  const claimed: EmailScheduledSendRow[] = []
  for (const row of results) {
    const outcome = await env.DB.prepare(
      `UPDATE email_scheduled_sends
          SET status = 'running', claimed_at = ?1, attempts = attempts + 1, updated_at = ?1
        WHERE user_id = ?2 AND id = ?3
          AND ((status = 'queued' AND send_at <= ?1) OR (status = 'running' AND COALESCE(claimed_at, 0) < ?4))`,
    ).bind(now, row.user_id, row.id, stale).run()
    if (outcome.meta.changes) {
      claimed.push({ ...row, status: 'running', claimed_at: now, attempts: row.attempts + 1, updated_at: now })
    }
  }
  return claimed
}

interface ScheduledSendCursor {
  at: number
  id: string
}

function parseScheduledSendCursor(value: string | undefined): ScheduledSendCursor | null {
  if (!value) return null
  const separator = value.lastIndexOf(':')
  if (separator < 1) throw ApiError.badRequest('The scheduled send cursor is invalid')
  const id = value.slice(separator + 1)
  const at = Number(value.slice(0, separator))
  if (!isValidId(id) || !Number.isSafeInteger(at) || at < 0) {
    throw ApiError.badRequest('The scheduled send cursor is invalid')
  }
  return { at, id }
}

export async function listScheduledSendPage(
  env: Env,
  userId: string,
  accountId: string,
  options: { status?: 'active' | 'history', cursor?: string, limit?: number } = {},
): Promise<ScheduledSendPage> {
  const history = options.status === 'history'
  const limit = Math.min(LIST_LIMIT, Math.max(1, Math.trunc(options.limit ?? LIST_LIMIT)))
  const cursor = parseScheduledSendCursor(options.cursor)
  const order = history ? 'updated_at DESC, id DESC' : 'send_at ASC, id ASC'
  const comparison = history ? '(updated_at < ?3 OR (updated_at = ?3 AND id < ?4))' : '(send_at > ?3 OR (send_at = ?3 AND id > ?4))'
  const limitParameter = cursor ? '?5' : '?3'
  const statuses = history
    ? "status IN ('sent', 'failed', 'cancelled')"
    : "status IN ('queued', 'running')"
  const { results } = await env.DB.prepare(
    `SELECT * FROM email_scheduled_sends
      WHERE user_id = ?1 AND account_id = ?2 AND ${statuses}
        ${cursor ? `AND ${comparison}` : ''}
      ORDER BY ${order} LIMIT ${limitParameter}`,
  ).bind(
    userId,
    accountId,
    ...(cursor ? [cursor.at, cursor.id] : []),
    limit + 1,
  ).all<EmailScheduledSendRow>()
  const hasMore = results.length > limit
  const page = results.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(toEmailScheduledSend),
    nextCursor: hasMore && last
      ? `${history ? last.updated_at : last.send_at}:${last.id}`
      : null,
  }
}

export async function listScheduledSends(
  env: Env,
  userId: string,
  accountId: string,
  limit = LIST_LIMIT,
): Promise<EmailScheduledSend[]> {
  return (await listScheduledSendPage(env, userId, accountId, { status: 'active', limit })).items
}

export async function cleanupScheduledSends(
  env: Env,
  userId: string,
  accountId: string,
  olderThan: number,
  limit = LIST_LIMIT,
): Promise<number> {
  if (!Number.isSafeInteger(olderThan) || olderThan < 0) {
    throw ApiError.badRequest('The cleanup cutoff is invalid')
  }
  const count = Math.min(LIST_LIMIT, Math.max(1, Math.trunc(limit)))
  const result = await env.DB.prepare(
    `DELETE FROM email_scheduled_sends
      WHERE user_id = ?1 AND account_id = ?2
        AND status IN ('sent', 'failed', 'cancelled') AND updated_at < ?3
        AND (user_id, id) IN (
          SELECT user_id, id FROM email_scheduled_sends
          WHERE user_id = ?1 AND account_id = ?2
            AND status IN ('sent', 'failed', 'cancelled') AND updated_at < ?3
          ORDER BY updated_at ASC, id ASC LIMIT ?4
        )`,
  ).bind(userId, accountId, olderThan, count).run()
  return Number(result.meta.changes)
}

async function completeScheduledSend(env: Env, job: EmailScheduledSendRow, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_scheduled_sends SET status = 'sent', claimed_at = NULL, last_error = NULL, updated_at = ?1
      WHERE user_id = ?2 AND id = ?3`,
  ).bind(now, job.user_id, job.id).run()
}

async function failScheduledSend(env: Env, job: EmailScheduledSendRow, message: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_scheduled_sends SET status = 'failed', claimed_at = NULL, last_error = ?1, updated_at = ?2
      WHERE user_id = ?3 AND id = ?4`,
  ).bind(message, now, job.user_id, job.id).run()
}

async function retryScheduledSend(
  env: Env,
  job: EmailScheduledSendRow,
  message: string,
  now: number,
  rateLimited = false,
): Promise<'retried' | 'failed'> {
  if (!rateLimited && job.attempts >= EMAIL_SCHEDULE_MAX_ATTEMPTS) {
    await failScheduledSend(env, job, message, now)
    return 'failed'
  }
  const retryAt = rateLimited ? rateLimitRetryAt(now, message) : now + EMAIL_SCHEDULE_RETRY_MS
  await env.DB.prepare(
    `UPDATE email_scheduled_sends
        SET status = 'queued', send_at = ?1, attempts = MAX(0, attempts - ?2), claimed_at = NULL, last_error = ?3, updated_at = ?4
      WHERE user_id = ?5 AND id = ?6`,
  ).bind(retryAt, rateLimited ? 1 : 0, message, now, job.user_id, job.id).run()
  return 'retried'
}

function isRateLimited(error: unknown): boolean {
  return (error instanceof ApiError && error.status === 429)
    || (error instanceof Error && /(?:\b429\b|rate[ _-]?limit)/i.test(error.message))
}

function rateLimitRetryAt(now: number, message: string): number {
  // The mailbox store owns both D1 and KV counters. Waiting a full reported window from this refusal
  // clears either implementation without reading a second, potentially different copy of the mailbox.
  const duration = /per day/i.test(message) ? DAY_MS : /per hour/i.test(message) ? HOUR_MS : PROVIDER_RATE_LIMIT_RETRY_MS
  return now + duration + 1
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The scheduled send failed'
}

export async function runScheduledSends(
  env: Env,
  now = Date.now(),
  limit = 3,
): Promise<ScheduledSendSweep> {
  const jobs = await claimScheduledSends(env, now, limit)
  const result: ScheduledSendSweep = { started: jobs.length, sent: 0, retried: 0, failed: 0 }
  for (const job of jobs) {
    try {
      const account = await getEmailAccount(env.DB, job.user_id, job.account_id)
      if (!account) {
        await failScheduledSend(env, job, 'account_missing', now)
        result.failed++
        continue
      }
      const mailbox = emailMailbox(env, account.id)
      const row = await mailbox.getEmail(job.draft_id)
      if (!row) {
        await failScheduledSend(env, job, 'draft_missing', now)
        result.failed++
        continue
      }
      if (row.folder_id === 'sent') {
        if (row.delivery_status === 'sent') {
          await completeScheduledSend(env, job, now)
          result.sent++
          continue
        }
        if (row.delivery_status !== 'failed') {
          await failScheduledSend(env, job, 'delivery_unconfirmed', now)
          result.failed++
          continue
        }
        const stored = await sendStoredEmail(env, job.user_id, account, row)
        if (stored.status === 'sent') {
          await completeScheduledSend(env, job, now)
          result.sent++
          continue
        }
        const message = stored.error ?? 'email_send_failed'
        const outcome = await retryScheduledSend(env, job, message, now, isRateLimited(message))
        if (outcome === 'retried') result.retried++
        else result.failed++
        continue
      }
      if (row.folder_id !== 'draft') {
        await failScheduledSend(env, job, 'draft_missing', now)
        result.failed++
        continue
      }
      if (row.delivery_status === 'sent') {
        await completeScheduledSend(env, job, now)
        result.sent++
        continue
      }
      const snapshot = parseScheduledSnapshot(job.snapshot_json)
      if (job.snapshot_json && !snapshot) throw new Error('The scheduled send snapshot is invalid')
      const input: EmailSendInput = snapshot ?? {
        to: row.recipient,
        cc: row.cc ?? undefined,
        bcc: row.bcc ?? undefined,
        subject: row.subject,
        body: row.body_source ?? stripEmailHtmlToText(row.body),
        bodyHtml: row.body,
        operationId: `scheduled:${job.id}`,
      }
      const send: { result: EmailSendResult } = await sendDraftEmail(
        env,
        job.user_id,
        account,
        job.draft_id,
        input,
        snapshot ? { attachmentMode: 'snapshot' } : undefined,
      )
      if (send.result.status === 'sent') {
        await completeScheduledSend(env, job, now)
        result.sent++
        continue
      }
      const message = send.result.error ?? 'email_send_failed'
      const outcome = await retryScheduledSend(env, job, message, now, isRateLimited(message))
      if (outcome === 'retried') result.retried++
      else result.failed++
    } catch (error) {
      const message = failureMessage(error)
      const rateLimited = isRateLimited(error)
      const outcome = await retryScheduledSend(env, job, message, now, rateLimited)
      if (outcome === 'retried') result.retried++
      else result.failed++
      console.warn(`[inkstone] scheduled send ${job.id} ${rateLimited ? 'deferred' : 'failed'}:`, message)
    }
  }
  return result
}

export async function deleteScheduledSendsForAccount(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM email_scheduled_sends WHERE user_id = ?1 AND account_id = ?2`,
  ).bind(userId, accountId).run()
}
