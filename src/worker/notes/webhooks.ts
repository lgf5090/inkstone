import { NOTE_WEBHOOK_EVENTS } from '@shared/constants'
import type { NoteWebhook, NoteWebhookCreateResult } from '@shared/types'
import type { Env } from '../env'
import { decryptNoteWebhookSecret, encryptNoteWebhookSecret } from '../lib/crypto'
import { fromBase64Url, toBase64, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { checkTarget, outbound } from '../lib/outbound'

const TITLE_MAX = 120
const URL_MAX = 2048
const SECRET_BYTES = 32
const MAX_ATTEMPTS = 5
const DELIVERY_TIMEOUT_MS = 10_000
const DELIVERY_MAX_BYTES = 4 * 1024
const DRAIN_LIMIT = 20
const COLUMNS = 'id, user_id, title, url, secret_ciphertext, events, enabled, created_at, updated_at'

interface WebhookRow {
  id: string
  user_id: string
  title: string
  url: string
  secret_ciphertext: string
  events: string
  enabled: number
  created_at: number
  updated_at: number
  pending?: number
  last_error?: string
}

interface DeliveryRow {
  id: string
  webhook_id: string
  event: string
  payload: string
  attempts: number
  status: string
  url: string | null
  secret_ciphertext: string | null
  enabled: number | null
}

function titleOf(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Webhook title must be a string')
  const title = value.trim()
  if (!title || title.length > TITLE_MAX) throw ApiError.badRequest(`Webhook title must be 1-${TITLE_MAX} characters`)
  return title
}

function urlOf(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Webhook URL must be a string')
  const raw = value.trim()
  if (!raw || raw.length > URL_MAX) throw ApiError.badRequest('Webhook URL is invalid')
  const target = checkTarget(raw)
  if (!target.url || target.url.protocol !== 'https:') throw ApiError.badRequest('Webhook URL must use HTTPS and a public address')
  return target.url.toString()
}

function eventsOf(value: unknown): string[] {
  if (value === undefined) return ['*']
  if (!Array.isArray(value)) throw ApiError.badRequest('events must be an array')
  const allowed = new Set<string>(['*', ...NOTE_WEBHOOK_EVENTS])
  const events = [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry)))]
  return events.length ? events : ['*']
}

function parseEvents(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : ['*']
  }
  catch {
    return ['*']
  }
}

function toWebhook(row: WebhookRow): NoteWebhook {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    events: parseEvents(row.events),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pending: row.pending ?? 0,
    lastError: row.last_error ?? '',
  }
}

function createSecret(): string {
  return `whsec_${toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))}`
}

export async function listNoteWebhooks(db: D1Database, userId: string): Promise<NoteWebhook[]> {
  const { results } = await db.prepare(
    `SELECT w.*,
       (SELECT COUNT(*) FROM note_webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
       (SELECT COALESCE(MAX(d.last_error), '') FROM note_webhook_deliveries d
         WHERE d.webhook_id = w.id AND d.status = 'failed') AS last_error
       FROM note_webhooks w WHERE w.user_id = ?1 ORDER BY w.created_at DESC, w.id DESC`,
  ).bind(userId).all<WebhookRow>()
  return results.map(toWebhook)
}

export async function createNoteWebhook(
  env: Env,
  userId: string,
  input: { title?: unknown; url?: unknown; events?: unknown; enabled?: unknown },
): Promise<NoteWebhookCreateResult> {
  const title = titleOf(input.title)
  const url = urlOf(input.url)
  const events = eventsOf(input.events)
  const enabled = input.enabled !== false
  const now = Date.now()
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId()
    const signingSecret = createSecret()
    const secretCiphertext = await encryptNoteWebhookSecret(env, id, signingSecret)
    const { meta } = await env.DB.prepare(
      `INSERT OR IGNORE INTO note_webhooks
         (id, user_id, title, url, secret_ciphertext, events, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    ).bind(id, userId, title, url, secretCiphertext, JSON.stringify(events), enabled ? 1 : 0, now).run()
    if (meta.changes > 0) {
      return {
        webhook: { id, title, url, events, enabled, createdAt: now, updatedAt: now, pending: 0, lastError: '' },
        signingSecret,
      }
    }
  }
  throw ApiError.conflict('Could not allocate a webhook id. Try again')
}

export async function updateNoteWebhook(
  db: D1Database,
  userId: string,
  id: string,
  input: { title?: unknown; url?: unknown; events?: unknown; enabled?: unknown },
): Promise<NoteWebhook | null> {
  const current = await db.prepare(`SELECT ${COLUMNS} FROM note_webhooks WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId).first<WebhookRow>()
  if (!current) return null
  const title = input.title === undefined ? current.title : titleOf(input.title)
  const url = input.url === undefined ? current.url : urlOf(input.url)
  const events = input.events === undefined ? current.events : JSON.stringify(eventsOf(input.events))
  const enabled = input.enabled === undefined ? current.enabled : input.enabled === true ? 1 : 0
  const row = await db.prepare(
    `UPDATE note_webhooks SET title = ?3, url = ?4, events = ?5, enabled = ?6, updated_at = MAX(?7, updated_at + 1)
      WHERE id = ?1 AND user_id = ?2 RETURNING ${COLUMNS}`,
  ).bind(id, userId, title, url, events, enabled, Date.now()).first<WebhookRow>()
  return row ? toWebhook(row) : null
}

export async function deleteNoteWebhook(db: D1Database, userId: string, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM note_webhook_deliveries WHERE webhook_id = ?1 AND user_id = ?2').bind(id, userId),
    db.prepare('DELETE FROM note_webhooks WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ])
  return Boolean(results.at(-1)?.meta.changes)
}

export async function regenerateNoteWebhookSecret(
  env: Env,
  userId: string,
  id: string,
): Promise<NoteWebhookCreateResult | null> {
  const current = await env.DB.prepare(`SELECT ${COLUMNS} FROM note_webhooks WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId).first<WebhookRow>()
  if (!current) return null
  const signingSecret = createSecret()
  const secretCiphertext = await encryptNoteWebhookSecret(env, id, signingSecret)
  const row = await env.DB.prepare(
    `UPDATE note_webhooks SET secret_ciphertext = ?3, updated_at = MAX(?4, updated_at + 1)
      WHERE id = ?1 AND user_id = ?2 RETURNING ${COLUMNS}`,
  ).bind(id, userId, secretCiphertext, Date.now()).first<WebhookRow>()
  return row ? { webhook: toWebhook(row), signingSecret } : null
}

async function sign(secret: string, messageId: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', fromBase64Url(secret.slice('whsec_'.length)) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, utf8(`${messageId}.${timestamp}.${body}`) as BufferSource)
  return `v1,${toBase64(signature)}`
}

export async function deliverNoteWebhook(env: Env, deliveryId: string, now: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempts, d.status,
            w.url, w.secret_ciphertext, w.enabled
       FROM note_webhook_deliveries d
       LEFT JOIN note_webhooks w ON w.id = d.webhook_id
      WHERE d.id = ?1`,
  ).bind(deliveryId).first<DeliveryRow>()
  if (!row || row.status !== 'pending') return
  let error = ''
  if (!row.url || !row.secret_ciphertext || row.enabled !== 1) {
    error = 'Webhook is no longer active'
  }
  else {
    const target = checkTarget(row.url)
    if (!target.url || target.url.protocol !== 'https:') error = 'Webhook target is not reachable'
    else {
      const secret = await decryptNoteWebhookSecret(env, row.webhook_id, row.secret_ciphertext)
      if (!secret) error = 'Webhook signing secret is unavailable'
      else {
        const messageId = `msg_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`
        const timestamp = Math.floor(now / 1000)
        try {
          const result = await outbound(row.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'Inkstone-Note-Webhook/1',
              'webhook-id': messageId,
              'webhook-timestamp': String(timestamp),
              'webhook-signature': await sign(secret, messageId, timestamp, row.payload),
            },
            body: row.payload,
            timeoutMs: DELIVERY_TIMEOUT_MS,
            maxBytes: DELIVERY_MAX_BYTES,
          })
          error = result.ok ? '' : (result.error || `HTTP ${result.status}`)
        }
        catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
      }
    }
  }
  const attempts = row.attempts + 1
  const status = !error ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  const retryDelay = Math.min(3_600_000, 60_000 * 2 ** (attempts - 1))
  await env.DB.prepare(
    `UPDATE note_webhook_deliveries SET attempts = ?1, status = ?2, last_error = ?3, next_attempt_at = ?4 WHERE id = ?5`,
  ).bind(attempts, status, error.slice(0, 240), now + retryDelay, deliveryId).run()
  if (error) console.warn('[inkstone] note webhook delivery failed:', { deliveryId, attempts, status, error })
}

export async function drainNoteWebhookDeliveries(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM note_webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at, id LIMIT ?2`,
  ).bind(now, DRAIN_LIMIT).all<{ id: string }>()
  for (const row of results) {
    try {
      await deliverNoteWebhook(env, row.id, now)
    }
    catch (cause) {
      console.warn('[inkstone] note webhook drain failed:', cause instanceof Error ? cause.message : cause)
    }
  }
  return results.length
}
