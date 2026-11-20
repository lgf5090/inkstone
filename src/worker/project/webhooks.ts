/**
 * Outbound board events. Every target is checked against the shared SSRF guard both when it is saved
 * and when it is used, so a DNS answer that changes after creation cannot turn a saved webhook into a
 * request for a metadata endpoint. Delivery is a durable row: the same write that produced the event
 * answers the caller, while retries come from the cron rather than from an in-memory promise.
 */
import { newProjectId } from '@shared/project/limits'
import {
  PROJECT_WEBHOOK_EVENTS,
  PROJECT_WEBHOOK_MAX_ATTEMPTS,
  PROJECT_WEBHOOK_SECRET_PREFIX,
  projectWebhookMatches,
  projectWebhookRetryDelay,
  type ProjectWebhookEvent,
} from '@shared/project/integrations'
import type { ProjectWebhookCreateInput, ProjectWebhookPatchInput } from '@shared/project/validation'
import { fromBase64Url, toBase64, toBase64Url, utf8 } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { checkTarget, outbound } from '../lib/outbound'

const URL_MAX_LENGTH = 2048
const DELIVERY_TIMEOUT_MS = 10_000
const DELIVERY_MAX_BYTES = 4 * 1024
const DRAIN_LIMIT = 20

export interface ProjectWebhook {
  id: string
  url: string
  events: string[]
  enabled: boolean
  createdAt: number
  pending: number
  lastError: string
}

interface WebhookRow {
  id: string
  board_id: string
  url: string
  secret: string
  events: string
  enabled: number
  created_by: string
  created_at: number
  updated_at: number
  pending: number
  last_error: string
}

interface DeliveryRow {
  id: string
  webhook_id: string
  board_id: string
  event: string
  payload: string
  attempts: number
  next_attempt_at: number
  status: string
  last_error: string
  created_at: number
  url: string | null
  secret: string | null
  enabled: number | null
}

export interface ProjectWebhookPayload {
  boardId: string
  event: ProjectWebhookEvent
  targetId: string
  method: string
  path: string
  at: number
}

function assertWebhookUrl(raw: string): string {
  const target = checkTarget(raw)
  if (!target.url) throw ApiError.badRequest(`Webhook URL: ${target.error}`)
  if (target.url.protocol !== 'https:') throw ApiError.badRequest('Webhook URL must use HTTPS')
  return target.url.toString()
}

function normalizeEvents(value: readonly string[] | undefined): string[] {
  if (!value || !value.length) return ['*']
  const known = new Set<string>(['*', ...PROJECT_WEBHOOK_EVENTS])
  return [...new Set(value.filter((entry) => known.has(entry)))]
}

function parseEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : ['*']
  } catch {
    return ['*']
  }
}

const WEBHOOK_SELECT = `SELECT w.*,
    (SELECT COUNT(*) FROM project_webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending,
    (SELECT COALESCE(MAX(d.last_error), '') FROM project_webhook_deliveries d
      WHERE d.webhook_id = w.id AND d.status = 'failed') AS last_error
  FROM project_webhooks w`

function rowToWebhook(row: WebhookRow): ProjectWebhook {
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    pending: row.pending ?? 0,
    lastError: row.last_error ?? '',
  }
}

export async function listProjectWebhooks(db: D1Database, boardId: string): Promise<ProjectWebhook[]> {
  const { results } = await db.prepare(`${WEBHOOK_SELECT} WHERE w.board_id = ?1 ORDER BY w.created_at, w.id`)
    .bind(boardId).all<WebhookRow>()
  return results.map(rowToWebhook)
}

export async function createProjectWebhook(
  db: D1Database, boardId: string, userId: string, input: ProjectWebhookCreateInput, now: number,
): Promise<{ webhook: ProjectWebhook, secret: string }> {
  if (input.url.length > URL_MAX_LENGTH) throw ApiError.badRequest('Webhook URL is too long')
  const url = assertWebhookUrl(input.url)
  const secret = `${PROJECT_WEBHOOK_SECRET_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
  const id = newProjectId('webhook')
  await db.prepare(
    `INSERT INTO project_webhooks (id, board_id, url, secret, events, enabled, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  ).bind(
    id, boardId, url, secret, JSON.stringify(normalizeEvents(input.events)),
    input.enabled === false ? 0 : 1, userId, now,
  ).run()
  return {
    webhook: {
      id, url, events: normalizeEvents(input.events), enabled: input.enabled !== false,
      createdAt: now, pending: 0, lastError: '',
    },
    secret,
  }
}

export async function patchProjectWebhook(
  db: D1Database, boardId: string, id: string, patch: ProjectWebhookPatchInput, now: number,
): Promise<ProjectWebhook | null> {
  const row = await db.prepare('SELECT * FROM project_webhooks WHERE board_id = ?1 AND id = ?2')
    .bind(boardId, id).first<WebhookRow>()
  if (!row) return null
  const url = patch.url === undefined ? row.url : assertWebhookUrl(patch.url)
  const events = patch.events === undefined ? row.events : JSON.stringify(normalizeEvents(patch.events))
  const enabled = patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0)
  await db.prepare(
    'UPDATE project_webhooks SET url = ?1, events = ?2, enabled = ?3, updated_at = ?4 WHERE board_id = ?5 AND id = ?6',
  ).bind(url, events, enabled, now, boardId, id).run()
  return {
    id, url, events: parseEvents(events), enabled: enabled === 1,
    createdAt: row.created_at, pending: 0, lastError: '',
  }
}

export async function deleteProjectWebhook(db: D1Database, boardId: string, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM project_webhook_deliveries WHERE webhook_id = ?1 AND board_id = ?2').bind(id, boardId),
    db.prepare('DELETE FROM project_webhooks WHERE board_id = ?1 AND id = ?2').bind(boardId, id),
  ])
}

export async function enqueueProjectWebhookEvents(
  db: D1Database, boardId: string, event: ProjectWebhookEvent, payload: ProjectWebhookPayload, now: number,
): Promise<string[]> {
  const { results } = await db.prepare('SELECT id, events FROM project_webhooks WHERE board_id = ?1 AND enabled = 1')
    .bind(boardId).all<{ id: string, events: string }>()
  const matching = results.filter((row) => projectWebhookMatches(parseEvents(row.events), event))
  if (!matching.length) return []
  const body = JSON.stringify(payload)
  const ids: string[] = []
  const statements = matching.map((row) => {
    const id = newProjectId('delivery')
    ids.push(id)
    return db.prepare(
      `INSERT INTO project_webhook_deliveries
        (id, webhook_id, board_id, event, payload, attempts, next_attempt_at, status, last_error, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'pending', '', ?6)`,
    ).bind(id, row.id, boardId, event, body, now)
  })
  await db.batch(statements)
  return ids
}

async function signProjectWebhook(secret: string, messageId: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', fromBase64Url(secret.slice(PROJECT_WEBHOOK_SECRET_PREFIX.length)) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, utf8(`${messageId}.${timestamp}.${body}`) as BufferSource)
  return `v1,${toBase64(signature)}`
}

/** One attempt. A missing webhook, a blocked target and a refused network all end as a retry or a failure. */
export async function deliverProjectWebhook(db: D1Database, deliveryId: string, now: number): Promise<void> {
  const row = await db.prepare(
    `SELECT d.*, w.url, w.secret, w.enabled FROM project_webhook_deliveries d
      LEFT JOIN project_webhooks w ON w.id = d.webhook_id
     WHERE d.id = ?1`,
  ).bind(deliveryId).first<DeliveryRow>()
  if (!row || row.status !== 'pending') return
  let error = ''
  if (!row.url || !row.secret || row.enabled !== 1) {
    error = 'Webhook is no longer active'
  } else {
    const target = checkTarget(row.url)
    if (!target.url || target.url.protocol !== 'https:') {
      error = 'Webhook target is not reachable'
    } else {
      const messageId = `msg_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`
      const timestamp = Math.floor(now / 1000)
      try {
        const signature = await signProjectWebhook(row.secret, messageId, timestamp, row.payload)
        const result = await outbound(row.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Inkstone-Project-Webhook/1',
            'webhook-id': messageId,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signature,
          },
          body: row.payload,
          timeoutMs: DELIVERY_TIMEOUT_MS,
          maxBytes: DELIVERY_MAX_BYTES,
        })
        error = result.ok ? '' : (result.error || `HTTP ${result.status}`)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
  }
  const attempts = row.attempts + 1
  const status = !error ? 'delivered' : attempts >= PROJECT_WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'pending'
  await db.prepare(
    `UPDATE project_webhook_deliveries
        SET attempts = ?1, status = ?2, last_error = ?3, next_attempt_at = ?4
      WHERE id = ?5`,
  ).bind(attempts, status, error.slice(0, 240), now + projectWebhookRetryDelay(attempts), deliveryId).run()
  if (error) console.warn('[inkstone] project webhook delivery failed:', { deliveryId, attempts, status, error })
}

export async function drainProjectWebhookDeliveries(db: D1Database, now: number, limit = DRAIN_LIMIT): Promise<number> {
  const { results } = await db.prepare(
    `SELECT id FROM project_webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at, id LIMIT ?2`,
  ).bind(now, Math.min(Math.max(limit, 1), DRAIN_LIMIT)).all<{ id: string }>()
  for (const row of results) {
    try {
      await deliverProjectWebhook(db, row.id, now)
    } catch (cause) {
      console.warn('[inkstone] project webhook drain failed:', cause instanceof Error ? cause.message : cause)
    }
  }
  return results.length
}
