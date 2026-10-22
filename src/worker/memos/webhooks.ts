import {
  MEMO_WEBHOOK_MAX_BYTES,
  MEMO_WEBHOOK_SECRET_PREFIX,
  MEMO_WEBHOOK_TIMEOUT_MS,
} from '@shared/memos/constants'
import type {
  Memo,
  MemoWebhook,
  MemoWebhookCreateResult,
} from '@shared/memos/types'
import type { PublicUser } from '@shared/types'
import type { Env } from '../env'
import { decryptMemoWebhookSecret, encryptMemoWebhookSecret } from '../lib/crypto'
import { fromBase64Url, toBase64, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { checkTarget, outbound } from '../lib/outbound'
import { loadUser, publicUser } from '../lib/session-info'

export const MEMO_WEBHOOK_TITLE_MAX_LENGTH = 120
export const MEMO_WEBHOOK_URL_MAX_LENGTH = 2048
export const MEMO_WEBHOOK_ACTIVITY_TYPES = [
  'memos.memo.created',
  'memos.memo.updated',
  'memos.memo.deleted',
  'memos.memo.comment.created',
] as const

export type MemoWebhookActivityType = (typeof MEMO_WEBHOOK_ACTIVITY_TYPES)[number]

export interface MemoWebhookFields {
  title?: unknown
  url?: unknown
}

export interface MemoWebhookPayload {
  url: string
  activityType: MemoWebhookActivityType
  creator: PublicUser
  memo: Memo
}

interface WebhookRow {
  id: string
  title: string
  url: string
  secret_ciphertext: string
  created_at: number
  updated_at: number
}

const WEBHOOK_COLUMNS = 'id, title, url, secret_ciphertext, created_at, updated_at'
const MAX_WEBHOOK_ID_ATTEMPTS = 5
const SECRET_BYTES = 32
const SIGNATURE_VERSION = 'v1'
const MESSAGE_ID_BYTES = 16

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function toWebhook(row: WebhookRow): MemoWebhook {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    signingSecretSet: Boolean(row.secret_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function webhookTitle(value: unknown): string {
  if (value === undefined || value === null) throw ApiError.badRequest('Webhook title is required')
  if (typeof value !== 'string') throw ApiError.badRequest('Webhook title must be a string')
  const title = value.trim()
  if (!title) throw ApiError.badRequest('Webhook title cannot be empty')
  if (title.length > MEMO_WEBHOOK_TITLE_MAX_LENGTH) {
    throw ApiError.badRequest(`Webhook title cannot exceed ${MEMO_WEBHOOK_TITLE_MAX_LENGTH} characters`)
  }
  return title
}

function webhookUrl(value: unknown): string {
  if (value === undefined || value === null) throw ApiError.badRequest('Webhook URL is required')
  if (typeof value !== 'string') throw ApiError.badRequest('Webhook URL must be a string')
  const raw = value.trim()
  if (!raw) throw ApiError.badRequest('Webhook URL cannot be empty')
  if (raw.length > MEMO_WEBHOOK_URL_MAX_LENGTH) {
    throw ApiError.badRequest(`Webhook URL cannot exceed ${MEMO_WEBHOOK_URL_MAX_LENGTH} characters`)
  }
  const target = checkTarget(raw)
  if (!target.url) throw ApiError.badRequest(`Webhook URL: ${target.error}`)
  if (target.url.protocol !== 'https:') {
    throw ApiError.badRequest('Webhook URL must use HTTPS')
  }
  return target.url.toString()
}

function createSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
  return `${MEMO_WEBHOOK_SECRET_PREFIX}${toBase64Url(bytes)}`
}

async function listWebhookRows(db: D1Database, userId: string): Promise<WebhookRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${WEBHOOK_COLUMNS}
         FROM memos_webhooks
        WHERE user_id = ?1
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId)
    .all<WebhookRow>()
  return results
}

async function loadWebhookRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<WebhookRow | null> {
  return db
    .prepare(
      `SELECT ${WEBHOOK_COLUMNS}
         FROM memos_webhooks
        WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(id, userId)
    .first<WebhookRow>()
}

export async function listMemoWebhooks(db: D1Database, userId: string): Promise<MemoWebhook[]> {
  return (await listWebhookRows(db, userId)).map(toWebhook)
}

export async function createMemoWebhook(
  env: Env,
  userId: string,
  input: MemoWebhookFields,
): Promise<MemoWebhookCreateResult> {
  const title = webhookTitle(input.title)
  const url = webhookUrl(input.url)
  const now = nowSeconds()

  for (let attempt = 0; attempt < MAX_WEBHOOK_ID_ATTEMPTS; attempt++) {
    const id = newId()
    const signingSecret = createSecret()
    const secretCiphertext = await encryptMemoWebhookSecret(env, id, signingSecret)
    const { meta } = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO memos_webhooks
           (id, user_id, title, url, secret_ciphertext, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      )
      .bind(id, userId, title, url, secretCiphertext, now)
      .run()
    if (meta.changes > 0) {
      return {
        webhook: { id, title, url, signingSecretSet: true, createdAt: now, updatedAt: now },
        signingSecret,
      }
    }
  }
  throw ApiError.conflict('Could not allocate a webhook id. Try again')
}

export async function updateMemoWebhook(
  db: D1Database,
  userId: string,
  id: string,
  input: MemoWebhookFields,
): Promise<MemoWebhook | null> {
  const current = await loadWebhookRow(db, userId, id)
  if (!current) return null
  if (input.title === undefined && input.url === undefined) return toWebhook(current)

  const title = input.title === undefined ? current.title : webhookTitle(input.title)
  const url = input.url === undefined ? current.url : webhookUrl(input.url)
  const row = await db
    .prepare(
      `UPDATE memos_webhooks
          SET title = ?3, url = ?4, updated_at = MAX(?5, updated_at + 1)
        WHERE id = ?1 AND user_id = ?2
        RETURNING ${WEBHOOK_COLUMNS}`,
    )
    .bind(id, userId, title, url, nowSeconds())
    .first<WebhookRow>()
  return row ? toWebhook(row) : null
}

export async function deleteMemoWebhook(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const { meta } = await db
    .prepare('DELETE FROM memos_webhooks WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run()
  return meta.changes > 0
}

export async function regenerateMemoWebhookSecret(
  env: Env,
  userId: string,
  id: string,
): Promise<MemoWebhookCreateResult | null> {
  if (!(await loadWebhookRow(env.DB, userId, id))) return null
  const signingSecret = createSecret()
  const secretCiphertext = await encryptMemoWebhookSecret(env, id, signingSecret)
  const row = await env.DB
    .prepare(
      `UPDATE memos_webhooks
          SET secret_ciphertext = ?3, updated_at = MAX(?4, updated_at + 1)
        WHERE id = ?1 AND user_id = ?2
        RETURNING ${WEBHOOK_COLUMNS}`,
    )
    .bind(id, userId, secretCiphertext, nowSeconds())
    .first<WebhookRow>()
  return row ? { webhook: toWebhook(row), signingSecret } : null
}

/**
 * Standard Webhooks signs `id.timestamp.body` with the decoded secret, and the versioned prefix is what
 * lets a receiver tell which scheme produced the value. The body is the JSON exactly as sent, so a
 * re-serialised copy at the receiver would not verify.
 */
async function signMemoWebhook(
  secret: string,
  messageId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const keyBytes = fromBase64Url(secret.slice(MEMO_WEBHOOK_SECRET_PREFIX.length))
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    utf8(`${messageId}.${timestamp}.${body}`) as BufferSource,
  )
  return `${SIGNATURE_VERSION},${toBase64(signature)}`
}

function createMessageId(): string {
  return `msg_${toBase64Url(crypto.getRandomValues(new Uint8Array(MESSAGE_ID_BYTES)))}`
}

function memoPageUrl(origin: string, memoId: string): string {
  return `${origin.replace(/\/+$/, '')}/memos/m/${memoId}`
}

async function deliverMemoWebhook(env: Env, row: WebhookRow, body: string): Promise<void> {
  try {
    const secret = await decryptMemoWebhookSecret(env, row.id, row.secret_ciphertext)
    if (!secret) {
      console.warn(`[inkstone] Memo webhook ${row.id} has no readable signing secret; delivery skipped`)
      return
    }
    const messageId = createMessageId()
    const timestamp = nowSeconds()
    const signature = await signMemoWebhook(secret, messageId, timestamp, body)
    const response = await outbound(row.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Inkstone-Memos-Webhook/1',
        'webhook-id': messageId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      },
      body,
      timeoutMs: MEMO_WEBHOOK_TIMEOUT_MS,
      maxBytes: MEMO_WEBHOOK_MAX_BYTES,
    })
    if (!response.ok) {
      console.warn(
        `[inkstone] Memo webhook ${row.id} delivery failed: ${response.status || response.error}`,
      )
    }
  } catch (error) {
    // Best-effort by design: a webhook that cannot be reached must not make the memo write disappear,
    // and there is no retry queue, so the row id and the reason are all the record that will exist.
    console.warn(`[inkstone] Memo webhook ${row.id} delivery failed:`, error)
  }
}

/**
 * Deliver one memo activity to every webhook the account owns.
 *
 * The caller runs this through `waitUntil`: the mutation has already been committed and answered, and
 * the delivery is not allowed to change that answer. Failures reach the log by webhook id only, never
 * with the secret or the memo body.
 */
export async function dispatchMemoWebhookEvent(
  env: Env,
  userId: string,
  activityType: MemoWebhookActivityType,
  memo: Memo,
  origin: string,
): Promise<void> {
  try {
    const rows = await listWebhookRows(env.DB, userId)
    if (!rows.length) return
    const user = await loadUser(env, userId)
    if (!user) {
      console.warn(`[inkstone] Memo webhooks for user ${userId} were skipped: the account is gone`)
      return
    }
    const payload: MemoWebhookPayload = {
      url: memoPageUrl(origin, memo.id),
      activityType,
      creator: publicUser(user),
      memo,
    }
    const body = JSON.stringify(payload)
    await Promise.all(rows.map((row) => deliverMemoWebhook(env, row, body)))
  } catch (error) {
    // The mutation already answered; a failure to even list the targets belongs in the log beside the
    // delivery failures, not in the response.
    console.warn(`[inkstone] Memo webhooks for user ${userId} could not be dispatched:`, error)
  }
}
