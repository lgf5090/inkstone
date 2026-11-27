import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { decodeCursor, encodeCursor } from './lib'

const DESTRUCTIVE_WINDOW_MS = 60 * 60 * 1000
const DESTRUCTIVE_ALERT_THRESHOLD = 20
const PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

export interface ActivityRow {
  id: string
  action: string
  target_path: string
  severity: string
  detail: string
  created_at: number
}

export interface ActivityInput {
  action: string
  targetPath: string
  detail?: string
  destructive?: boolean
}

/** Audit successful mutations and flag a burst of destructive operations in the past hour. */
export async function recordActivity(db: D1Database, userId: string, input: ActivityInput): Promise<ActivityRow> {
  const now = Date.now()
  let severity = 'info'
  let detail = input.detail ?? ''
  if (input.destructive) {
    const recent = await db.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_activities
        WHERE user_id = ?1 AND action IN ('delete', 'purge') AND created_at >= ?2`,
    ).bind(userId, now - DESTRUCTIVE_WINDOW_MS).first<{ count: number }>()
    if ((recent?.count ?? 0) + 1 >= DESTRUCTIVE_ALERT_THRESHOLD) {
      severity = 'warning'
      detail = detail || 'Unusual number of destructive file operations in the last hour'
    }
  }
  const activity: ActivityRow = {
    id: newId(), action: input.action, target_path: input.targetPath.slice(0, 1000),
    severity, detail: detail.slice(0, 500), created_at: now,
  }
  await db.prepare(
    `INSERT INTO CloudDrive_activities (id, user_id, action, target_path, severity, detail, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(activity.id, userId, activity.action, activity.target_path, activity.severity, activity.detail, now).run()
  return activity
}

export async function listActivities(
  db: D1Database,
  userId: string,
  options: { cursor?: string; alerts?: boolean; limit?: number },
): Promise<{ activities: ActivityRow[]; cursor: string | null; alerts: number }> {
  const requested = options.limit ?? PAGE_LIMIT
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(MAX_PAGE_LIMIT, requested)) : PAGE_LIMIT
  const clauses = ['user_id = ?']
  const params: unknown[] = [userId]
  if (options.alerts) clauses.push("severity = 'warning'")
  if (options.cursor) {
    let decoded
    try { decoded = decodeCursor(options.cursor, 'uploaded') } catch { throw ApiError.badRequest('The cursor is invalid') }
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
    params.push(decoded.v, decoded.v, decoded.id)
  }
  params.push(limit)
  const [{ results }, alerts] = await Promise.all([
    db.prepare(
      `SELECT id, action, target_path, severity, detail, created_at FROM CloudDrive_activities
        WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...params).all<ActivityRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_activities WHERE user_id = ? AND severity = 'warning'`,
    ).bind(userId).first<{ count: number }>(),
  ])
  const rows = results ?? []
  const last = rows[rows.length - 1]
  return {
    activities: rows,
    alerts: alerts?.count ?? 0,
    cursor: last && rows.length === limit ? encodeCursor('uploaded', last.created_at, last.id) : null,
  }
}
