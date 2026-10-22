import type { EmailAccount, EmailAccountSettings } from '@shared/email/model'
import { EMAIL_AUTO_DRAFT_LEASE_MS } from '@shared/email/model'
import { storedObject } from '../lib/json'
import { newId } from '../lib/id'

export interface EmailAccountRow {
  id: string
  user_id: string
  address: string
  address_normalized: string
  display_name: string
  settings: string
  created_at: number
  updated_at: number
}

export interface EmailAccountOwnerRow extends EmailAccountRow {
  role: 'owner' | 'member'
}

export interface EmailAutoDraftJobRow {
  user_id: string
  account_id: string
  message_id: string
  thread_id: string | null
  status: string
  reason: string | null
  attempts: number
  claimed_at: number | null
  created_at: number
  updated_at: number
}

export function readAccountSettings(raw: string): EmailAccountSettings {
  return storedObject(raw) as EmailAccountSettings
}

export function toEmailAccount(row: EmailAccountRow): EmailAccount {
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    settings: readAccountSettings(row.settings),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function listEmailAccounts(db: D1Database, userId: string): Promise<EmailAccountRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM email_accounts WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
  ).bind(userId).all<EmailAccountRow>()
  return results
}

export async function getEmailAccount(
  db: D1Database,
  userId: string,
  id: string,
): Promise<EmailAccountRow | null> {
  return db.prepare(
    `SELECT * FROM email_accounts WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<EmailAccountRow>()
}

export async function findEmailAccountByAddress(
  db: D1Database,
  addressNormalized: string,
): Promise<EmailAccountOwnerRow | null> {
  return db.prepare(
    `SELECT a.*, u.role FROM email_accounts a
       JOIN users u ON u.id = a.user_id
      WHERE a.address_normalized = ?1`,
  ).bind(addressNormalized).first<EmailAccountOwnerRow>()
}

export async function createEmailAccount(
  db: D1Database,
  input: {
    id?: string
    userId: string
    address: string
    displayName: string
    settings?: EmailAccountSettings
    now?: number
  },
): Promise<EmailAccountRow> {
  const id = input.id ?? newId()
  const now = input.now ?? Date.now()
  const address = input.address.trim().toLowerCase()
  await db.prepare(
    `INSERT INTO email_accounts (
       id, user_id, address, address_normalized, display_name, settings, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?6)`,
  ).bind(
    id,
    input.userId,
    address,
    input.displayName.trim() || address.split('@')[0] || address,
    JSON.stringify(input.settings ?? {}),
    now,
  ).run()
  const created = await getEmailAccount(db, input.userId, id)
  if (!created) throw new Error('The email account could not be read back after creation')
  return created
}

export async function updateEmailAccount(
  db: D1Database,
  userId: string,
  id: string,
  input: { displayName?: string; settings?: EmailAccountSettings; now?: number },
): Promise<EmailAccountRow | null> {
  const current = await getEmailAccount(db, userId, id)
  if (!current) return null
  const now = input.now ?? Date.now()
  await db.prepare(
    `UPDATE email_accounts SET display_name = ?1, settings = ?2, updated_at = ?3
      WHERE user_id = ?4 AND id = ?5`,
  ).bind(
    input.displayName?.trim() || current.display_name,
    JSON.stringify(input.settings ?? readAccountSettings(current.settings)),
    now,
    userId,
    id,
  ).run()
  return getEmailAccount(db, userId, id)
}

export async function deleteEmailAccount(db: D1Database, userId: string, id: string): Promise<boolean> {
  await db.prepare(`DELETE FROM email_auto_draft_jobs WHERE user_id = ?1 AND account_id = ?2`)
    .bind(userId, id).run()
  const result = await db.prepare(`DELETE FROM email_accounts WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id).run()
  return Boolean(result.meta.changes)
}

export async function listEmailAttachmentKeys(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT object_key FROM email_attachments WHERE user_id = ?1 AND account_id = ?2`,
  ).bind(userId, accountId).all<{ object_key: string }>()
  return results.map((row) => row.object_key)
}

export async function deleteEmailAttachmentsForAccount(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM email_attachments WHERE user_id = ?1 AND account_id = ?2`)
    .bind(userId, accountId).run()
}

export async function queueAutoDraftJob(
  db: D1Database,
  input: { userId: string; accountId: string; messageId: string; threadId: string | null; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now()
  await db.prepare(
    `INSERT OR IGNORE INTO email_auto_draft_jobs (
       user_id, account_id, message_id, thread_id, status, reason, attempts, claimed_at, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, 'queued', NULL, 0, NULL, ?5, ?5)`,
  ).bind(input.userId, input.accountId, input.messageId, input.threadId, now).run()
}

export async function claimAutoDraftJobs(
  db: D1Database,
  now = Date.now(),
  limit = 3,
): Promise<EmailAutoDraftJobRow[]> {
  const stale = now - EMAIL_AUTO_DRAFT_LEASE_MS
  const { results } = await db.prepare(
    `SELECT * FROM email_auto_draft_jobs
      WHERE status = 'queued' OR (status = 'running' AND claimed_at < ?1)
      ORDER BY created_at ASC LIMIT ?2`,
  ).bind(stale, Math.max(1, Math.trunc(limit))).all<EmailAutoDraftJobRow>()
  const claimed: EmailAutoDraftJobRow[] = []
  for (const row of results) {
    const outcome = await db.prepare(
      `UPDATE email_auto_draft_jobs
          SET status = 'running', claimed_at = ?1, attempts = attempts + 1, updated_at = ?1
        WHERE user_id = ?2 AND account_id = ?3 AND message_id = ?4
          AND (status = 'queued' OR (status = 'running' AND claimed_at < ?5))`,
    ).bind(now, row.user_id, row.account_id, row.message_id, stale).run()
    if (outcome.meta.changes) claimed.push({ ...row, status: 'running', claimed_at: now, attempts: row.attempts + 1 })
  }
  return claimed
}

export async function finishAutoDraftJob(
  db: D1Database,
  input: { userId: string; accountId: string; messageId: string; status: string; reason: string | null; now?: number },
): Promise<void> {
  await db.prepare(
    `UPDATE email_auto_draft_jobs SET status = ?1, reason = ?2, claimed_at = NULL, updated_at = ?3
      WHERE user_id = ?4 AND account_id = ?5 AND message_id = ?6`,
  ).bind(input.status, input.reason, input.now ?? Date.now(), input.userId, input.accountId, input.messageId).run()
}

export async function pruneAutoDraftJobs(db: D1Database, before: number): Promise<void> {
  await db.prepare(
    `DELETE FROM email_auto_draft_jobs
      WHERE status IN ('done', 'skipped', 'failed') AND updated_at < ?1`,
  ).bind(before).run()
}
