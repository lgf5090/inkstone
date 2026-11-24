import { EMAIL_INBOUND_MAX_BYTES } from '@shared/email/model'
import { deleteEmailAttachmentObjects } from './attachments'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'

const DELETE_ID_CHUNK = 80

export interface EmailRawMimeRow {
  message_id: string
  user_id: string
  account_id: string
  object_key: string
  size: number
  sha256: string
  created_at: number
}

export interface SaveEmailRawMimeInput {
  userId: string
  accountId: string
  messageId: string
  receivedAt: number
  bytes: Uint8Array
}

export interface EmailRawMimeDeletionResult {
  messages: number
  cleanupPending: boolean
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size))
  return chunks
}

export async function saveEmailRawMime(
  env: Env,
  input: SaveEmailRawMimeInput,
): Promise<EmailRawMimeRow> {
  if (!env.FILES) throw new Error('Email raw MIME storage is not configured')
  if (!input.userId || !input.accountId || !input.messageId) throw new Error('Email raw MIME ownership is required')
  if (!Number.isSafeInteger(input.receivedAt) || input.receivedAt <= 0) throw new Error('Email raw MIME receipt time is invalid')
  if (!input.bytes.byteLength || input.bytes.byteLength > EMAIL_INBOUND_MAX_BYTES) {
    throw new Error(`Email raw MIME exceeds the ${EMAIL_INBOUND_MAX_BYTES}-byte limit`)
  }
  const account = await env.DB.prepare(
    `SELECT 1 AS owned FROM email_accounts WHERE user_id = ?1 AND id = ?2`,
  ).bind(input.userId, input.accountId).first<{ owned: number }>()
  if (!account) throw new Error('The email account for raw MIME storage does not exist')

  const row: EmailRawMimeRow = {
    message_id: input.messageId,
    user_id: input.userId,
    account_id: input.accountId,
    object_key: `mail/raw/${newId()}.eml`,
    size: input.bytes.byteLength,
    sha256: await sha256Hex(input.bytes),
    created_at: input.receivedAt,
  }
  await env.FILES.put(row.object_key, input.bytes, {
    httpMetadata: { contentType: 'message/rfc822', cacheControl: 'private, no-store' },
    customMetadata: {
      userId: row.user_id,
      accountId: row.account_id,
      messageId: row.message_id,
      sha256: row.sha256,
    },
  })
  try {
    await env.DB.prepare(
      `INSERT INTO email_raw_messages (
         message_id, user_id, account_id, object_key, size, sha256, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      row.message_id,
      row.user_id,
      row.account_id,
      row.object_key,
      row.size,
      row.sha256,
      row.created_at,
    ).run()
  } catch (error) {
    try {
      await env.FILES.delete(row.object_key)
    } catch (cleanupError) {
      console.error('[inkstone] Email raw MIME rollback could not remove its object:', cleanupError)
    }
    throw new Error(`Email raw MIME metadata could not be saved for message ${row.message_id}`, { cause: error })
  }
  return row
}

export async function getEmailRawMimeMetadata(
  db: D1Database,
  userId: string,
  accountId: string,
  messageId: string,
): Promise<EmailRawMimeRow | null> {
  return db.prepare(
    `SELECT message_id, user_id, account_id, object_key, size, sha256, created_at
       FROM email_raw_messages
      WHERE user_id = ?1 AND account_id = ?2 AND message_id = ?3`,
  ).bind(userId, accountId, messageId).first<EmailRawMimeRow>()
}

export async function getEmailRawMimeOwner(
  db: D1Database,
  messageId: string,
): Promise<Pick<EmailRawMimeRow, 'user_id' | 'account_id'> | null> {
  return db.prepare(
    `SELECT user_id, account_id FROM email_raw_messages WHERE message_id = ?1`,
  ).bind(messageId).first<Pick<EmailRawMimeRow, 'user_id' | 'account_id'>>()
}

export async function listEmailRawMimesForAccount(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<EmailRawMimeRow[]> {
  const { results } = await db.prepare(
    `SELECT message_id, user_id, account_id, object_key, size, sha256, created_at
       FROM email_raw_messages
      WHERE user_id = ?1 AND account_id = ?2
      ORDER BY created_at ASC, message_id ASC`,
  ).bind(userId, accountId).all<EmailRawMimeRow>()
  return results
}

export async function readEmailRawMime(
  env: Env,
  row: EmailRawMimeRow,
): Promise<Uint8Array | null> {
  if (!env.FILES) throw new Error('Email raw MIME storage is not configured')
  const object = await env.FILES.get(row.object_key)
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== row.size) throw new Error(`Email raw MIME size changed for message ${row.message_id}`)
  if (await sha256Hex(bytes) !== row.sha256) throw new Error(`Email raw MIME checksum failed for message ${row.message_id}`)
  return bytes
}

export async function readEmailRawMimeRange(
  env: Env,
  row: EmailRawMimeRow,
  offset: number,
  length: number,
): Promise<Uint8Array | null> {
  if (!env.FILES) throw new Error('Email raw MIME storage is not configured')
  if (length <= 0) return new Uint8Array()
  const object = await env.FILES.get(row.object_key, { range: { offset, length } })
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== length) throw new Error(`Email raw MIME range is incomplete for message ${row.message_id}`)
  return bytes
}

export async function openEmailRawMime(
  env: Env,
  row: EmailRawMimeRow,
): Promise<ReadableStream<Uint8Array>> {
  if (!env.FILES) throw new Error('Email raw MIME storage is not configured')
  const object = await env.FILES.get(row.object_key)
  if (!object) throw new Error(`Email raw MIME data is missing for message ${row.message_id}`)
  if (object.size !== row.size) {
    await object.body.cancel().catch((error) => {
      console.warn('[inkstone] Email raw MIME stream could not be cancelled:', (error as Error).message)
    })
    throw new Error(`Email raw MIME size changed for message ${row.message_id}`)
  }
  return object.body
}

async function deleteRows(
  env: Env,
  rows: readonly EmailRawMimeRow[],
): Promise<EmailRawMimeDeletionResult> {
  const result: EmailRawMimeDeletionResult = { messages: rows.length, cleanupPending: false }
  if (!rows.length) return result
  result.cleanupPending = await deleteEmailAttachmentObjects(env, rows[0]!.user_id, rows.map((row) => row.object_key))
  for (const group of chunk(rows, DELETE_ID_CHUNK)) {
    const placeholders = group.map((_, index) => `?${index + 3}`).join(',')
    await env.DB.prepare(
      `DELETE FROM email_raw_messages WHERE user_id = ?1 AND account_id = ?2 AND message_id IN (${placeholders})`,
    ).bind(rows[0]!.user_id, rows[0]!.account_id, ...group.map((row) => row.message_id)).run()
  }
  return result
}

export async function deleteEmailRawMimeForMessage(
  env: Env,
  userId: string,
  accountId: string,
  messageId: string,
): Promise<EmailRawMimeDeletionResult> {
  const row = await getEmailRawMimeMetadata(env.DB, userId, accountId, messageId)
  return row ? deleteRows(env, [row]) : { messages: 0, cleanupPending: false }
}

export async function deleteEmailRawMimesForMessages(
  env: Env,
  userId: string,
  accountId: string,
  messageIds: readonly string[],
): Promise<EmailRawMimeDeletionResult> {
  const rows: EmailRawMimeRow[] = []
  for (const group of chunk(messageIds, DELETE_ID_CHUNK)) {
    const placeholders = group.map((_, index) => `?${index + 3}`).join(',')
    const { results } = await env.DB.prepare(
      `SELECT message_id, user_id, account_id, object_key, size, sha256, created_at
         FROM email_raw_messages
        WHERE user_id = ?1 AND account_id = ?2 AND message_id IN (${placeholders})`,
    ).bind(userId, accountId, ...group).all<EmailRawMimeRow>()
    rows.push(...results)
  }
  return deleteRows(env, rows)
}

export async function deleteEmailRawMimesForAccount(
  env: Env,
  userId: string,
  accountId: string,
): Promise<EmailRawMimeDeletionResult> {
  const rows = await listEmailRawMimesForAccount(env.DB, userId, accountId)
  return deleteRows(env, rows)
}

export async function sumEmailRawMimeBytes(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM email_raw_messages WHERE user_id = ?1`,
  ).bind(userId).first<{ bytes: number }>()
  return Number(row?.bytes ?? 0)
}
