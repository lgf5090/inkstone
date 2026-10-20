/**
 * What happened, in two grains.
 *
 * A notification log line answers "did this channel deliver that message, and if not why" — the
 * question a reader asks when nothing arrived. A schedule log line answers "did the sweep run at all,
 * and what did it find" — the question they ask when the first answer is "no line at all". Keeping
 * both is what makes the difference between a bug the reader can diagnose and one they can only report.
 *
 * Both are pruned by age rather than by count: a busy month should not push out last week, and an idle
 * month should not keep a year of nothing.
 */
import {
  DEDUPE_RETENTION_MS,
  LOG_RETENTION_MS,
  type ChannelKind,
  type NotifyLogEntry,
  type NotifyLogFilter,
  type ScheduleLogEntry,
} from '@shared/subscriptions/model'
import { newId } from '../lib/id'

export interface NotifyLogInput {
  subscriptionId: string
  ruleId: string
  channel: ChannelKind
  status: 'success' | 'failed'
  title: string
  body: string
  error: string
  detail: string
}

interface NotifyLogRow {
  id: string
  subscription_id: string
  rule_id: string
  channel: string
  status: string
  title: string
  body: string
  error: string
  detail: string
  created_at: number
  name: string | null
}

export async function writeNotifyLog(db: D1Database, userId: string, input: NotifyLogInput): Promise<void> {
  await db.prepare(
    `INSERT INTO sub_notify_log (user_id, id, subscription_id, rule_id, channel, status, title, body, error, detail, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    userId,
    newId(),
    input.subscriptionId,
    input.ruleId,
    input.channel,
    input.status,
    input.title.slice(0, 200),
    input.body.slice(0, 8000),
    input.error.slice(0, 500),
    input.detail.slice(0, 2000),
    Date.now(),
  ).run()
}

/** The delivery log, newest first, filtered by whatever the reader narrowed to. */
export async function queryNotifyLogs(
  db: D1Database,
  userId: string,
  filter: NotifyLogFilter = {},
): Promise<NotifyLogEntry[]> {
  const where: string[] = ['l.user_id = ?1']
  const binds: Array<string | number> = [userId]
  if (filter.subscriptionId) {
    where.push(`l.subscription_id = ?${binds.length + 1}`)
    binds.push(filter.subscriptionId)
  }
  if (filter.channel) {
    where.push(`l.channel = ?${binds.length + 1}`)
    binds.push(filter.channel)
  }
  if (filter.status) {
    where.push(`l.status = ?${binds.length + 1}`)
    binds.push(filter.status)
  }
  if (filter.since) {
    where.push(`l.created_at >= ?${binds.length + 1}`)
    binds.push(Date.parse(filter.since))
  }
  if (filter.until) {
    where.push(`l.created_at <= ?${binds.length + 1}`)
    binds.push(Date.parse(filter.until))
  }
  const limit = Math.min(200, Math.max(1, Math.trunc(filter.limit ?? 100)))
  const { results } = await db.prepare(
    `SELECT l.id, l.subscription_id, l.rule_id, l.channel, l.status, l.title, l.body, l.error,
            l.detail, l.created_at, i.name AS name
       FROM sub_notify_log l
       LEFT JOIN sub_item i ON i.user_id = l.user_id AND i.id = l.subscription_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC
      LIMIT ${limit}`,
  ).bind(...binds).all<NotifyLogRow>()
  return results.map((row) => ({
    id: row.id,
    subscriptionId: row.subscription_id,
    subscriptionName: row.name ?? '',
    ruleId: row.rule_id,
    channel: row.channel as ChannelKind,
    status: row.status === 'success' ? 'success' : 'failed',
    title: row.title,
    body: row.body,
    error: row.error,
    detail: row.detail,
    createdAt: new Date(row.created_at).toISOString(),
  }))
}

export interface ScheduleLogInput {
  startedAt: number
  finishedAt: number
  timezone: string
  hour: string
  hours: string[]
  inWindow: boolean
  checkedCount: number
  matchedCount: number
  dedupedCount: number
  sentCount: number
  renewedCount: number
  status: 'ok' | 'skipped' | 'error'
  reason: string
  detail: string
}

interface ScheduleLogRow {
  id: string
  started_at: number
  finished_at: number
  timezone: string
  hour: string
  hours: string
  in_window: number
  checked_count: number
  matched_count: number
  deduped_count: number
  sent_count: number
  renewed_count: number
  status: string
  reason: string
  detail: string
}

export async function writeScheduleLog(db: D1Database, userId: string, input: ScheduleLogInput): Promise<ScheduleLogEntry> {
  const id = newId()
  await db.prepare(
    `INSERT INTO sub_schedule_log (user_id, id, started_at, finished_at, timezone, hour, hours, in_window,
       checked_count, matched_count, deduped_count, sent_count, renewed_count, status, reason, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  ).bind(
    userId,
    id,
    input.startedAt,
    input.finishedAt,
    input.timezone,
    input.hour,
    JSON.stringify(input.hours),
    input.inWindow ? 1 : 0,
    input.checkedCount,
    input.matchedCount,
    input.dedupedCount,
    input.sentCount,
    input.renewedCount,
    input.status,
    input.reason.slice(0, 500),
    input.detail.slice(0, 4000),
  ).run()
  return toScheduleLog({
    id,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    timezone: input.timezone,
    hour: input.hour,
    hours: JSON.stringify(input.hours),
    in_window: input.inWindow ? 1 : 0,
    checked_count: input.checkedCount,
    matched_count: input.matchedCount,
    deduped_count: input.dedupedCount,
    sent_count: input.sentCount,
    renewed_count: input.renewedCount,
    status: input.status,
    reason: input.reason,
    detail: input.detail,
  })
}

export async function recentScheduleLogs(db: D1Database, userId: string, limit = 10): Promise<ScheduleLogEntry[]> {
  const capped = Math.min(50, Math.max(1, Math.trunc(limit)))
  const { results } = await db.prepare(
    `SELECT id, started_at, finished_at, timezone, hour, hours, in_window, checked_count,
            matched_count, deduped_count, sent_count, renewed_count, status, reason, detail
       FROM sub_schedule_log WHERE user_id = ?1 ORDER BY started_at DESC LIMIT ${capped}`,
  ).bind(userId).all<ScheduleLogRow>()
  return results.map(toScheduleLog)
}

function toScheduleLog(row: ScheduleLogRow): ScheduleLogEntry {
  let hours: string[] = []
  try {
    const parsed = JSON.parse(row.hours) as unknown
    if (Array.isArray(parsed)) hours = parsed.map(String)
  } catch {
    // A delivery log whose hour list cannot be read says nothing about the window; an empty one is the
    // honest record of what this row knows, and the log is read-only history either way.
    hours = []
  }
  return {
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date(row.finished_at).toISOString(),
    timezone: row.timezone,
    hour: row.hour,
    hours,
    inWindow: row.in_window === 1,
    checkedCount: row.checked_count,
    matchedCount: row.matched_count,
    dedupedCount: row.deduped_count,
    sentCount: row.sent_count,
    renewedCount: row.renewed_count,
    status: row.status === 'error' ? 'error' : row.status === 'skipped' ? 'skipped' : 'ok',
    reason: row.reason,
    detail: row.detail,
  }
}

/** Drop log lines past their window. Run on the hourly pass, where the other purges already live. */
export async function purgeExpiredSubscriptionData(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = now - LOG_RETENTION_MS
  const result = await db.batch([
    db.prepare(`DELETE FROM sub_notify_log WHERE created_at < ?1`).bind(cutoff),
    db.prepare(`DELETE FROM sub_schedule_log WHERE started_at < ?1`).bind(cutoff),
    db.prepare(`DELETE FROM sub_notify_dedupe WHERE created_at < ?1`).bind(now - DEDUPE_RETENTION_MS),
  ])
  return result.reduce((total, entry) => total + (entry.meta.changes ?? 0), 0)
}
