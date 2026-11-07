// Read-only audit retrieval and the local health signals (plan W7-03). Nothing here writes: the
// audit table is append-only from the session paths, and the health report is derived on request so
// no cron or external notification channel is implied.

import { Hono, type Context } from 'hono'
import type {
  WebsshAuditEventView,
  WebsshAuditListResponse,
  WebsshHealthAlert,
  WebsshHealthReport,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { WEBSSH_AUDIT_EVENT_TYPES } from './audit'
import { clampPage, clampPageSize } from './hosts'

const DAY_MS = 24 * 60 * 60 * 1000
const FAILURE_WINDOW_MS = DAY_MS
const SIGNAL_WINDOW_MS = 7 * DAY_MS
const SESSION_FAILURE_MIN_SESSIONS = 5
const SESSION_FAILURE_RATE = 0.3

interface AuditRow {
  id: string
  event_type: string
  session_id: string
  host_id: string
  metadata: string
  ip_hash: string
  created_at: number
}

const AUDIT_COLUMNS = 'id, event_type, session_id, host_id, metadata, ip_hash, created_at'

function parseMetadata(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const metadata: Record<string, string | number | boolean | null> = {}
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        metadata[key] = item
      }
    }
    return metadata
  } catch {
    return {}
  }
}

function toView(row: AuditRow): WebsshAuditEventView {
  return {
    id: row.id,
    eventType: row.event_type,
    sessionId: row.session_id,
    hostId: row.host_id,
    metadata: parseMetadata(row.metadata),
    ipHash: row.ip_hash,
    createdAt: Number(row.created_at),
  }
}

function readTime(value: string | undefined, field: string): number {
  if (value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw ApiError.badRequest(`${field} must be a positive epoch millisecond value`)
  return Math.trunc(parsed)
}

function readEventType(value: string | undefined): string {
  if (!value) return ''
  if (!(WEBSSH_AUDIT_EVENT_TYPES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('eventType is not a known WebSSH audit event')
  }
  return value
}

export const websshAuditRoutes = new Hono<AppBindings>()

websshAuditRoutes.use('*', requireAuth)

websshAuditRoutes.get('/audit', async (c: Context<AppBindings>) => {
  const userId = c.get('userId')
  const eventType = readEventType(c.req.query('eventType'))
  const from = readTime(c.req.query('from'), 'from')
  const to = readTime(c.req.query('to'), 'to')
  const pageSize = clampPageSize(c.req.query('pageSize'))
  const requestedPage = clampPage(c.req.query('page'), 1)
  const where = `user_id = ?1
      AND (?2 = '' OR event_type = ?2)
      AND (?3 = 0 OR created_at >= ?3)
      AND (?4 = 0 OR created_at <= ?4)`
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM webssh_audit_events WHERE ${where}`)
    .bind(userId, eventType, from, to)
    .first<{ total: number }>()
  const total = Number(totalRow?.total ?? 0)
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize) || 1))
  const rows = await c.env.DB.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM webssh_audit_events
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?5 OFFSET ?6`,
  )
    .bind(userId, eventType, from, to, pageSize, (page - 1) * pageSize)
    .all<AuditRow>()
  return c.json<WebsshAuditListResponse>({ items: rows.results.map(toView), total, page, pageSize })
})

websshAuditRoutes.get('/audit/health', async (c: Context<AppBindings>) => {
  const userId = c.get('userId')
  const now = Date.now()
  const sessionSince = now - FAILURE_WINDOW_MS
  const signalSince = now - SIGNAL_WINDOW_MS

  const sessionRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
       FROM webssh_sessions WHERE user_id = ?1 AND started_at >= ?2`,
  )
    .bind(userId, sessionSince)
    .first<{ total: number | null; failed: number | null }>()
  const total = Number(sessionRow?.total ?? 0)
  const failed = Number(sessionRow?.failed ?? 0)
  const failureRate = total > 0 ? failed / total : 0

  const signalRows = await c.env.DB.prepare(
    `SELECT event_type, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM webssh_audit_events
      WHERE user_id = ?1
        AND ((event_type IN ('host_key_changed', 'retention_fail') AND created_at >= ?2)
             OR (event_type = 'ticket_rejected' AND created_at >= ?3))
      GROUP BY event_type`,
  )
    .bind(userId, signalSince, sessionSince)
    .all<{ event_type: string; count: number; last_at: number | null }>()
  const signals = { hostKeyChanged: 0, retentionFailed: 0, ticketRejected: 0 }
  const lastAt: Partial<Record<string, number | null>> = {}
  for (const row of signalRows.results) {
    const count = Number(row.count)
    if (row.event_type === 'host_key_changed') signals.hostKeyChanged = count
    else if (row.event_type === 'retention_fail') signals.retentionFailed = count
    else if (row.event_type === 'ticket_rejected') signals.ticketRejected = count
    lastAt[row.event_type] = row.last_at === null ? null : Number(row.last_at)
  }

  const alerts: WebsshHealthAlert[] = []
  if (total >= SESSION_FAILURE_MIN_SESSIONS && failureRate >= SESSION_FAILURE_RATE) {
    alerts.push({
      code: 'session_failures',
      severity: 'danger',
      count: failed,
      lastAt: null,
    })
  }
  if (signals.hostKeyChanged > 0) {
    alerts.push({
      code: 'host_key_changed',
      severity: signals.hostKeyChanged > 1 ? 'danger' : 'warning',
      count: signals.hostKeyChanged,
      lastAt: lastAt.host_key_changed ?? null,
    })
  }
  if (signals.retentionFailed > 0) {
    alerts.push({
      code: 'retention_failed',
      severity: 'danger',
      count: signals.retentionFailed,
      lastAt: lastAt.retention_fail ?? null,
    })
  }
  if (signals.ticketRejected > 0) {
    alerts.push({
      code: 'ticket_anomaly',
      severity: 'warning',
      count: signals.ticketRejected,
      lastAt: lastAt.ticket_rejected ?? null,
    })
  }

  return c.json<WebsshHealthReport>({
    generatedAt: now,
    sessions: { total, failed, failureRate },
    signals,
    alerts,
  })
})
