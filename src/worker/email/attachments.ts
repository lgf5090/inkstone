import type { EmailAttachment } from '@shared/email/model'
import { deleteAttachmentObjects } from '../attachments/backend'
import type { Env } from '../env'

const DELETE_ID_CHUNK = 500
const R2_DELETE_CHUNK = 900
const CLEANUP_BATCH = 100

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size))
  return chunks
}

interface EmailAttachmentRow {
  id: string
  email_id: string | null
  account_id: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  content_id: string | null
  disposition: string | null
  object_key: string
  storage: string
  locked: number
  created_at: number
}

export interface EmailAttachmentFileRow {
  id: string
  email_id: string | null
  account_id: string | null
  filename: string
  mime: string
  size: number
  object_key: string
  storage: string
  locked: number
  created_at: number
}

function toAttachment(row: EmailAttachmentRow): EmailAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    contentId: row.content_id,
    disposition: row.disposition,
    url: `/api/email/files/${row.id}`,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export async function loadEmailAttachments(
  db: D1Database,
  userId: string,
  emailIds: readonly string[],
): Promise<Map<string, EmailAttachment[]>> {
  const result = new Map<string, EmailAttachment[]>()
  if (!emailIds.length) return result
  for (const group of chunk(emailIds, DELETE_ID_CHUNK)) {
    const placeholders = group.map((_, index) => `?${index + 2}`).join(',')
    const { results } = await db.prepare(
      `SELECT * FROM email_attachments
        WHERE user_id = ?1 AND email_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    ).bind(userId, ...group).all<EmailAttachmentRow>()
    for (const row of results) {
      if (!row.email_id) continue
      const list = result.get(row.email_id) ?? []
      list.push(toAttachment(row))
      result.set(row.email_id, list)
    }
  }
  return result
}

export async function getEmailAttachmentRow(
  db: D1Database,
  userId: string,
  attachmentId: string,
): Promise<EmailAttachmentRow | null> {
  return db.prepare(
    `SELECT * FROM email_attachments WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, attachmentId).first<EmailAttachmentRow>()
}

export async function linkEmailAttachment(
  db: D1Database,
  userId: string,
  attachmentId: string,
  accountId: string,
  emailId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE email_attachments
        SET email_id = ?1, account_id = ?2
      WHERE user_id = ?3 AND id = ?4 AND email_id IS NULL AND locked = 0`,
  ).bind(emailId, accountId, userId, attachmentId).run()
  return Boolean(result.meta.changes)
}

export async function unlinkEmailAttachment(
  db: D1Database,
  userId: string,
  attachmentId: string,
  emailId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT object_key FROM email_attachments
      WHERE user_id = ?1 AND id = ?2 AND email_id = ?3 AND locked = 0`,
  ).bind(userId, attachmentId, emailId).first<{ object_key: string }>()
  if (!row) return null
  await db.prepare(
    `DELETE FROM email_attachments WHERE user_id = ?1 AND id = ?2 AND email_id = ?3 AND locked = 0`,
  ).bind(userId, attachmentId, emailId).run()
  return row.object_key
}

export async function countEmailAttachments(
  db: D1Database,
  userId: string,
  emailId: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM email_attachments WHERE user_id = ?1 AND email_id = ?2`,
  ).bind(userId, emailId).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function lockEmailAttachments(
  db: D1Database,
  userId: string,
  emailId: string,
): Promise<number> {
  const result = await db.prepare(
    `UPDATE email_attachments SET locked = 1 WHERE user_id = ?1 AND email_id = ?2`,
  ).bind(userId, emailId).run()
  return Number(result.meta.changes ?? 0)
}

export async function deleteEmailAttachments(
  db: D1Database,
  userId: string,
  emailIds: readonly string[],
): Promise<string[]> {
  if (!emailIds.length) return []
  const placeholders = emailIds.map((_, index) => `?${index + 2}`).join(',')
  const { results } = await db.prepare(
    `SELECT object_key FROM email_attachments
      WHERE user_id = ?1 AND email_id IN (${placeholders})`,
  ).bind(userId, ...emailIds).all<{ object_key: string }>()
  await db.prepare(
    `DELETE FROM email_attachments WHERE user_id = ?1 AND email_id IN (${placeholders})`,
  ).bind(userId, ...emailIds).run()
  return results.map((row) => row.object_key)
}

export async function deleteEmailAttachmentById(
  db: D1Database,
  userId: string,
  attachmentId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT object_key FROM email_attachments WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, attachmentId).first<{ object_key: string }>()
  if (!row) return null
  await db.prepare(`DELETE FROM email_attachments WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, attachmentId).run()
  return row.object_key
}

export async function getEmailAttachmentFileRow(
  db: D1Database,
  userId: string,
  attachmentId: string,
): Promise<EmailAttachmentFileRow | null> {
  return db.prepare(
    `SELECT id, email_id, account_id, filename, mime, size, object_key, storage, locked, created_at
       FROM email_attachments WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, attachmentId).first<EmailAttachmentFileRow>()
}

async function queueEmailAttachmentCleanup(
  db: D1Database,
  userId: string,
  objectKeys: readonly string[],
): Promise<void> {
  if (!objectKeys.length) return
  const now = Date.now()
  for (const group of chunk(objectKeys, CLEANUP_BATCH)) {
    await db.batch(group.map((key) =>
      db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
      ).bind(`r2:${key}`, userId, now),
    ))
  }
}

export async function deleteEmailAttachmentObjects(
  env: Env,
  userId: string,
  objectKeys: readonly string[],
): Promise<boolean> {
  if (!objectKeys.length) return false
  if (!env.FILES) {
    await queueEmailAttachmentCleanup(env.DB, userId, objectKeys)
    return true
  }
  try {
    for (const group of chunk(objectKeys, R2_DELETE_CHUNK)) {
      await deleteAttachmentObjects(env, 'r2', group)
    }
    return false
  } catch (error) {
    console.warn('[inkstone] Email attachment cleanup will retry later:', (error as Error).message)
    await queueEmailAttachmentCleanup(env.DB, userId, objectKeys)
    return true
  }
}

export async function deleteEmailAttachmentObject(
  env: Env,
  userId: string,
  objectKey: string,
): Promise<boolean> {
  return deleteEmailAttachmentObjects(env, userId, [objectKey])
}

export async function deleteEmailAttachmentsForMessages(
  env: Env,
  userId: string,
  emailIds: readonly string[],
): Promise<boolean> {
  if (!emailIds.length) return false
  let pending = false
  for (const group of chunk(emailIds, DELETE_ID_CHUNK)) {
    const placeholders = group.map((_, index) => `?${index + 2}`).join(',')
    const { results } = await env.DB.prepare(
      `SELECT object_key FROM email_attachments
        WHERE user_id = ?1 AND email_id IN (${placeholders})`,
    ).bind(userId, ...group).all<{ object_key: string }>()
    const cleanupPending = await deleteEmailAttachmentObjects(
      env,
      userId,
      results.map((row) => row.object_key),
    )
    pending = pending || cleanupPending
    await env.DB.prepare(
      `DELETE FROM email_attachments WHERE user_id = ?1 AND email_id IN (${placeholders})`,
    ).bind(userId, ...group).run()
  }
  return pending
}
