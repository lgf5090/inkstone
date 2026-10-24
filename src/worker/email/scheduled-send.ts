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

export interface EmailScheduledSendRow {
  id: string
  user_id: string
  account_id: string
  draft_id: string
  operation_id: string
  send_at: number
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

const LIST_LIMIT = 100

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
  if (!Number.isSafeInteger(sendAt) || sendAt <= now) {
    throw ApiError.badRequest('The send time must be in the future')
  }
  if (sendAt > now + EMAIL_SCHEDULE_MAX_MS) {
    throw ApiError.badRequest('The send time must be within one year')
  }
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
  try {
    await env.DB.prepare(
      `INSERT INTO email_scheduled_sends (
         id, user_id, account_id, draft_id, operation_id, send_at, status, attempts, claimed_at, last_error, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, NULL, NULL, ?7, ?7)`,
    ).bind(id, userId, accountId, draftId, operation, sendAt, now).run()
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

export async function listScheduledSends(
  env: Env,
  userId: string,
  accountId: string,
  limit = LIST_LIMIT,
): Promise<EmailScheduledSend[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM email_scheduled_sends
      WHERE user_id = ?1 AND account_id = ?2
      ORDER BY send_at ASC, id ASC LIMIT ?3`,
  ).bind(userId, accountId, Math.max(1, Math.trunc(limit))).all<EmailScheduledSendRow>()
  return results.map(toEmailScheduledSend)
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
): Promise<'retried' | 'failed'> {
  if (job.attempts >= EMAIL_SCHEDULE_MAX_ATTEMPTS) {
    await failScheduledSend(env, job, message, now)
    return 'failed'
  }
  await env.DB.prepare(
    `UPDATE email_scheduled_sends
        SET status = 'queued', send_at = ?1, claimed_at = NULL, last_error = ?2, updated_at = ?3
      WHERE user_id = ?4 AND id = ?5`,
  ).bind(now + EMAIL_SCHEDULE_RETRY_MS, message, now, job.user_id, job.id).run()
  return 'retried'
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
        const outcome = await retryScheduledSend(env, job, stored.error ?? 'email_send_failed', now)
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
      const input: EmailSendInput = {
        to: row.recipient,
        cc: row.cc ?? undefined,
        bcc: row.bcc ?? undefined,
        subject: row.subject,
        body: row.body_source ?? stripEmailHtmlToText(row.body),
        bodyHtml: row.body,
        operationId: `scheduled:${job.id}`,
      }
      const send: { result: EmailSendResult } = await sendDraftEmail(env, job.user_id, account, job.draft_id, input)
      if (send.result.status === 'sent') {
        await completeScheduledSend(env, job, now)
        result.sent++
        continue
      }
      const outcome = await retryScheduledSend(env, job, send.result.error ?? 'email_send_failed', now)
      if (outcome === 'retried') result.retried++
      else result.failed++
    } catch (error) {
      const message = failureMessage(error)
      const outcome = await retryScheduledSend(env, job, message, now)
      if (outcome === 'retried') result.retried++
      else result.failed++
      console.warn(`[inkstone] scheduled send ${job.id} failed:`, message)
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
