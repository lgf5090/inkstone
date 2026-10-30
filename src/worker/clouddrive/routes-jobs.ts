/**
 * Scheduled CloudDrive jobs.
 *
 * There is no arbitrary code here: a job names one of four built-in handlers, a whitelist the route
 * enforces on create and update. Built-ins are seeded on the first listing and may be disabled but
 * not deleted. A run claims `lock_until` with a conditional UPDATE, so two cron fires (or a manual
 * run racing the cron) cannot execute the same job twice; the run and its result are recorded in
 * `CloudDrive_job_runs` whether the handler succeeded or failed.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { decodeCursor, encodeCursor } from './lib'
import { cloudDriveUsage, readCloudDriveSettings } from './store'
import { purgeTrashEntries } from './store-files'

export const clouddriveJobRoutes = new Hono<AppBindings>()

const HANDLERS = [
  'cleanup_upload_sessions',
  'purge_share_sessions',
  'purge_trash',
  'refresh_storage_usage',
] as const
type JobHandler = (typeof HANDLERS)[number]

const LEASE_MS = 5 * 60 * 1000
const MIN_INTERVAL_SEC = 60
const MAX_INTERVAL_SEC = 365 * 86_400
const RUN_PAGE_LIMIT = 50
const MAX_RUN_PAGE_LIMIT = 100
const MAX_CONFIG_BYTES = 4096
const PURGE_BATCH = 5000

interface JobRow {
  id: string
  user_id: string
  name: string
  handler: string
  schedule_type: string
  interval_sec: number
  cron: string | null
  enabled: number
  builtin: number
  config: string
  last_run_at: number | null
  next_run_after: number | null
  lock_until: number | null
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  user_id: string
  job_id: string
  status: string
  result: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
}

interface BuiltinSeed {
  id: string
  name: string
  handler: JobHandler
  intervalSec: number
}

const BUILTIN_SEEDS: readonly BuiltinSeed[] = [
  {
    id: 'builtin_cleanup_upload_sessions',
    name: 'Clean up expired upload sessions',
    handler: 'cleanup_upload_sessions',
    intervalSec: 86_400,
  },
  {
    id: 'builtin_purge_share_sessions',
    name: 'Purge expired share sessions',
    handler: 'purge_share_sessions',
    intervalSec: 3_600,
  },
  {
    id: 'builtin_purge_trash',
    name: 'Purge trash past its retention',
    handler: 'purge_trash',
    intervalSec: 86_400,
  },
  {
    id: 'builtin_refresh_storage_usage',
    name: 'Refresh storage usage',
    handler: 'refresh_storage_usage',
    intervalSec: 21_600,
  },
]

clouddriveJobRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function jobHandler(value: unknown): JobHandler {
  if (typeof value !== 'string' || !(HANDLERS as readonly string[]).includes(value)) {
    throw ApiError.badRequest('Unknown job handler')
  }
  return value as JobHandler
}

function scheduleTypeOf(value: unknown): 'interval' | 'cron' {
  if (value === 'interval' || value === 'cron') return value
  throw ApiError.badRequest('scheduleType must be interval or cron')
}

function intervalValue(value: unknown): number {
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds < MIN_INTERVAL_SEC || seconds > MAX_INTERVAL_SEC) {
    throw ApiError.badRequest(`intervalSec must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC}`)
  }
  return seconds
}

function cronValue(value: unknown, now: number): string {
  const expression = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!expression) throw ApiError.badRequest('cron is required for a cron schedule')
  if (nextCronAfter(expression, now) === null) {
    throw ApiError.badRequest('cron must be a five-field expression with an upcoming run')
  }
  return expression
}

function configValue(value: unknown): string {
  if (value === undefined) return '{}'
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('config must be a JSON object')
  }
  const json = JSON.stringify(value)
  if (json.length > MAX_CONFIG_BYTES) throw ApiError.badRequest('config is too large')
  return json
}

function cleanJobName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : ''
  if (name.length === 0 || name.length > 64) throw ApiError.badRequest('A job name must contain 1 to 64 characters')
  if (/[\u0000-\u001f]/.test(name)) throw ApiError.badRequest('A job name cannot contain a control character')
  return name
}

function configOf(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch (error) {
    // The column is written by this module; a corrupted value is reported rather than hidden.
    console.warn('[clouddrive] a scheduled job config is not valid JSON:', error)
    return {}
  }
}

function jobView(row: JobRow) {
  return {
    id: row.id,
    name: row.name,
    handler: row.handler,
    scheduleType: row.schedule_type,
    intervalSec: row.interval_sec,
    cron: row.cron,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    config: configOf(row.config),
    lastRunAt: row.last_run_at,
    nextRunAfter: row.next_run_after,
    lockedUntil: row.lock_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function runView(row: RunRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    result: row.result ? configOf(row.result) : null,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  }
}

async function ensureScheduledJobs(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_scheduled_jobs WHERE user_id = ?`,
  ).bind(userId).first<{ count: number }>()
  if ((row?.count ?? 0) > 0) return
  await db.batch(BUILTIN_SEEDS.map((seed) => db.prepare(
    `INSERT OR IGNORE INTO CloudDrive_scheduled_jobs
       (user_id, id, name, handler, schedule_type, interval_sec, cron, enabled, builtin, config,
        last_run_at, next_run_after, lock_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'interval', ?, NULL, 1, 1, '{}', NULL, ?, NULL, ?, ?)`,
  ).bind(
    userId, seed.id, seed.name, seed.handler, seed.intervalSec,
    now + seed.intervalSec * 1000, now, now,
  )))
}

async function jobById(db: D1Database, userId: string, id: string): Promise<JobRow | null> {
  return await db.prepare(
    `SELECT * FROM CloudDrive_scheduled_jobs WHERE user_id = ? AND id = ?`,
  ).bind(userId, id).first<JobRow>()
}

clouddriveJobRoutes.get('/jobs', async (c) => {
  const userId = userIdOf(c)
  await ensureScheduledJobs(c.env.DB, userId)
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_scheduled_jobs
      WHERE user_id = ? ORDER BY builtin DESC, created_at, id`,
  ).bind(userId).all<JobRow>()
  return c.json({ jobs: (results ?? []).map(jobView) })
})

clouddriveJobRoutes.post('/jobs', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const now = Date.now()
  const handler = jobHandler(body.handler)
  const scheduleType = scheduleTypeOf(body.scheduleType)
  const intervalSec = scheduleType === 'interval' ? intervalValue(body.intervalSec) : 0
  const cron = scheduleType === 'cron' ? cronValue(body.cron, now) : null
  const enabled = body.enabled !== false
  const config = configValue(body.config)
  const next = enabled ? nextRunFor(scheduleType, intervalSec, cron, now) : null
  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_scheduled_jobs
       (user_id, id, name, handler, schedule_type, interval_sec, cron, enabled, builtin, config,
        last_run_at, next_run_after, lock_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL, ?, ?)`,
  ).bind(
    userId, id, cleanJobName(body.name), handler, scheduleType, intervalSec, cron,
    enabled ? 1 : 0, config, next, now, now,
  ).run()
  const row = await jobById(c.env.DB, userId, id)
  return c.json({ job: jobView(row!) }, 201)
})

clouddriveJobRoutes.patch('/jobs/:id', async (c) => {
  const userId = userIdOf(c)
  const row = await jobById(c.env.DB, userId, c.req.param('id'))
  if (!row) throw ApiError.notFound('Job not found')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const now = Date.now()

  if (row.builtin === 1) {
    const extra = Object.keys(body).filter((key) => key !== 'enabled')
    if (extra.length > 0) throw ApiError.badRequest('A built-in job can only be enabled or disabled')
    if (body.enabled === undefined) return c.json({ job: jobView(row) })
    const enabled = body.enabled === true
    const next = enabled ? nextRunFor(row.schedule_type, row.interval_sec, row.cron, now) : null
    await c.env.DB.prepare(
      `UPDATE CloudDrive_scheduled_jobs SET enabled = ?, next_run_after = ?, updated_at = ?
        WHERE user_id = ? AND id = ?`,
    ).bind(enabled ? 1 : 0, next, now, userId, row.id).run()
    return c.json({ job: jobView((await jobById(c.env.DB, userId, row.id))!) })
  }

  const handler = body.handler === undefined ? row.handler : jobHandler(body.handler)
  const scheduleType = body.scheduleType === undefined
    ? row.schedule_type
    : scheduleTypeOf(body.scheduleType)
  const intervalSec = scheduleType === 'interval'
    ? (body.intervalSec === undefined ? row.interval_sec : intervalValue(body.intervalSec))
    : 0
  const cron = scheduleType === 'cron'
    ? (body.cron === undefined ? row.cron : cronValue(body.cron, now))
    : null
  if (scheduleType === 'cron' && cron === null) {
    throw ApiError.badRequest('cron is required for a cron schedule')
  }
  const enabled = body.enabled === undefined ? row.enabled === 1 : body.enabled === true
  const name = body.name === undefined ? row.name : cleanJobName(body.name)
  const config = body.config === undefined ? row.config : configValue(body.config)
  const next = enabled ? nextRunFor(scheduleType, intervalSec, cron, now) : null
  await c.env.DB.prepare(
    `UPDATE CloudDrive_scheduled_jobs
        SET name = ?, handler = ?, schedule_type = ?, interval_sec = ?, cron = ?, enabled = ?,
            config = ?, next_run_after = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(
    name, handler, scheduleType, intervalSec, cron, enabled ? 1 : 0,
    config, next, now, userId, row.id,
  ).run()
  return c.json({ job: jobView((await jobById(c.env.DB, userId, row.id))!) })
})

clouddriveJobRoutes.delete('/jobs/:id', async (c) => {
  const userId = userIdOf(c)
  const row = await jobById(c.env.DB, userId, c.req.param('id'))
  if (!row) throw ApiError.notFound('Job not found')
  if (row.builtin === 1) throw ApiError.forbidden('A built-in job can be disabled but not deleted')
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM CloudDrive_job_runs WHERE user_id = ? AND job_id = ?`)
      .bind(userId, row.id),
    c.env.DB.prepare(`DELETE FROM CloudDrive_scheduled_jobs WHERE user_id = ? AND id = ?`)
      .bind(userId, row.id),
  ])
  return c.json({ ok: true })
})

clouddriveJobRoutes.post('/jobs/:id/run', async (c) => {
  const run = await runJobNow(c.env, userIdOf(c), c.req.param('id'), Date.now())
  return c.json({ run })
})

clouddriveJobRoutes.get('/jobs/:id/runs', async (c) => {
  const userId = userIdOf(c)
  const job = await jobById(c.env.DB, userId, c.req.param('id'))
  if (!job) throw ApiError.notFound('Job not found')
  const requested = Number(c.req.query('limit'))
  const limit = Number.isSafeInteger(requested) && requested >= 1 && requested <= MAX_RUN_PAGE_LIMIT
    ? requested
    : RUN_PAGE_LIMIT
  const clauses = ['user_id = ?', 'job_id = ?']
  const params: unknown[] = [userId, job.id]
  const cursorParam = c.req.query('cursor')
  if (cursorParam) {
    const decoded = decodeCursor(cursorParam, 'uploaded')
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(started_at < ? OR (started_at = ? AND id < ?))')
    params.push(decoded.v, decoded.v, decoded.id)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_job_runs
      WHERE ${clauses.join(' AND ')}
      ORDER BY started_at DESC, id DESC
      LIMIT ?`,
  ).bind(...params, limit).all<RunRow>()
  const rows = results ?? []
  const last = rows[rows.length - 1]
  const cursor = last && rows.length === limit
    ? encodeCursor('uploaded', last.started_at, last.id)
    : null
  return c.json({ runs: rows.map(runView), cursor })
})

function nextRunFor(
  scheduleType: string,
  intervalSec: number,
  cron: string | null,
  now: number,
): number | null {
  if (scheduleType === 'interval') {
    return now + Math.max(MIN_INTERVAL_SEC, intervalSec) * 1000
  }
  return cron ? nextCronAfter(cron, now) : null
}

interface CronSchedule {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  dayWildcard: boolean
  weekdayWildcard: boolean
}

function parseCronField(raw: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (!part) return null
    const slash = part.indexOf('/')
    const rangePart = slash >= 0 ? part.slice(0, slash) : part
    const step = slash >= 0 ? Number(part.slice(slash + 1)) : 1
    if (!Number.isSafeInteger(step) || step < 1) return null
    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const pieces = rangePart.split('-')
      if (pieces.length !== 2) return null
      start = Number(pieces[0])
      end = Number(pieces[1])
    } else {
      start = Number(rangePart)
      end = start
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    if (start < min || end > max || end < start) return null
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values.size > 0 ? values : null
}

/** A deliberately small five-field cron: `*`, `a`, `a-b`, `a-b/n` and comma lists. */
export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseCronField(parts[0]!, 0, 59)
  const hour = parseCronField(parts[1]!, 0, 23)
  const day = parseCronField(parts[2]!, 1, 31)
  const month = parseCronField(parts[3]!, 1, 12)
  const rawWeekday = parseCronField(parts[4]!, 0, 7)
  if (!minute || !hour || !day || !month || !rawWeekday) return null
  const weekday = new Set([...rawWeekday].map((value) => value === 7 ? 0 : value))
  return {
    minute,
    hour,
    day,
    month,
    weekday,
    dayWildcard: parts[2] === '*',
    weekdayWildcard: parts[4] === '*',
  }
}

/** First matching minute strictly after `afterMs`, searched in UTC for at most a year. */
export function nextCronAfter(expression: string, afterMs: number): number | null {
  const schedule = parseCron(expression)
  if (!schedule) return null
  const after = new Date(afterMs)
  const start = Date.UTC(
    after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(),
    after.getUTCHours(), after.getUTCMinutes(),
  ) + 60_000
  const hours = [...schedule.hour].sort((left, right) => left - right)
  const minutes = [...schedule.minute].sort((left, right) => left - right)
  for (let offset = 0; offset <= 366; offset++) {
    const dayStart = start + offset * 86_400_000
    const date = new Date(dayStart)
    if (!schedule.month.has(date.getUTCMonth() + 1)) continue
    const dayOfMonth = date.getUTCDate()
    const dayOfWeek = date.getUTCDay()
    const dayOfMonthOk = schedule.dayWildcard || schedule.day.has(dayOfMonth)
    const dayOfWeekOk = schedule.weekdayWildcard || schedule.weekday.has(dayOfWeek)
    const dayOk = schedule.dayWildcard
      ? dayOfWeekOk
      : schedule.weekdayWildcard ? dayOfMonthOk : (dayOfMonthOk || dayOfWeekOk)
    if (!dayOk) continue
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = Date.UTC(
          date.getUTCFullYear(), date.getUTCMonth(), dayOfMonth, hour, minute,
        )
        if (candidate >= start) return candidate
      }
    }
  }
  return null
}

interface ExpiredUploadSession {
  id: string
  strategy: string
  storage_key: string | null
  provider_upload_id: string | null
}

async function cleanupUploadSessions(env: Env, userId: string, now: number): Promise<Record<string, unknown>> {
  const { results } = await env.DB.prepare(
    `SELECT id, strategy, storage_key, provider_upload_id
       FROM CloudDrive_upload_sessions
      WHERE user_id = ? AND status = 'active' AND expires_at <= ?
      LIMIT 1000`,
  ).bind(userId, now).all<ExpiredUploadSession>()
  const sessions = results ?? []
  const statements: D1PreparedStatement[] = []
  for (const session of sessions) {
    if (session.strategy === 'multipart' && session.storage_key && session.provider_upload_id && env.FILES) {
      try {
        await env.FILES.resumeMultipartUpload(session.storage_key, session.provider_upload_id).abort()
      } catch (error) {
        // R2 may already have dropped an upload the platform expired; the D1 row still must close.
        console.warn('[clouddrive] aborting an expired multipart upload failed:', error)
      }
    } else if (session.strategy === 'direct' && session.storage_key && env.FILES) {
      try {
        await env.FILES.delete(session.storage_key)
      } catch (error) {
        // The object is unreferenced once the session expires; a failed delete is orphan-scan work.
        console.warn('[clouddrive] deleting an expired direct upload failed:', error)
      }
    }
    statements.push(env.DB.prepare(`DELETE FROM CloudDrive_upload_parts WHERE session_id = ?`)
      .bind(session.id))
    statements.push(env.DB.prepare(
      `UPDATE CloudDrive_upload_sessions SET status = 'expired', updated_at = ?
        WHERE user_id = ? AND id = ? AND status = 'active'`,
    ).bind(now, userId, session.id))
  }
  for (let offset = 0; offset < statements.length; offset += 90) {
    await env.DB.batch(statements.slice(offset, offset + 90))
  }
  return { sessions: sessions.length }
}

async function purgeShareSessions(env: Env, userId: string, now: number): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare(
    `DELETE FROM CloudDrive_share_sessions WHERE user_id = ? AND expires_at <= ?`,
  ).bind(userId, now).run()
  return { deleted: result.meta.changes ?? 0 }
}

async function purgeTrash(env: Env, userId: string, now: number): Promise<Record<string, unknown>> {
  const settings = await readCloudDriveSettings(env.DB, userId)
  const cutoff = now - settings.trashRetentionDays * 86_400_000
  const { results } = await env.DB.prepare(
    `SELECT id, mount_id FROM CloudDrive_files
      WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?
      ORDER BY deleted_at
      LIMIT ${PURGE_BATCH}`,
  ).bind(userId, cutoff).all<{ id: string; mount_id: string }>()
  const byMount = new Map<string, string[]>()
  for (const row of results ?? []) {
    const ids = byMount.get(row.mount_id) ?? []
    ids.push(row.id)
    byMount.set(row.mount_id, ids)
  }
  let deleted = 0
  let failed = 0
  for (const [mountId, ids] of byMount) {
    const result = await purgeTrashEntries(env.DB, userId, mountId, ids, env)
    deleted += result.deleted
    failed += result.failed
  }
  return { deleted, failed, cutoff }
}

async function refreshStorageUsage(env: Env, userId: string, now: number): Promise<Record<string, unknown>> {
  const usage = await cloudDriveUsage(env.DB, userId, env)
  await env.DB.prepare(`UPDATE CloudDrive_storages SET last_used_at = ? WHERE user_id = ?`)
    .bind(now, userId).run()
  return { ...usage }
}

async function executeHandler(
  env: Env,
  userId: string,
  handler: JobHandler,
  now: number,
): Promise<Record<string, unknown>> {
  switch (handler) {
    case 'cleanup_upload_sessions':
      return await cleanupUploadSessions(env, userId, now)
    case 'purge_share_sessions':
      return await purgeShareSessions(env, userId, now)
    case 'purge_trash':
      return await purgeTrash(env, userId, now)
    case 'refresh_storage_usage':
      return await refreshStorageUsage(env, userId, now)
  }
}

/**
 * Claim the job, run its handler and record the outcome. Throws `conflict` when another run holds
 * the lease; a handler that throws is recorded as a failed run instead of failing the request.
 */
async function runJobNow(env: Env, userId: string, jobId: string, now: number) {
  const job = await jobById(env.DB, userId, jobId)
  if (!job) throw ApiError.notFound('Job not found')
  const leased = await env.DB.prepare(
    `UPDATE CloudDrive_scheduled_jobs SET lock_until = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND (lock_until IS NULL OR lock_until < ?)`,
  ).bind(now + LEASE_MS, now, userId, jobId, now).run()
  if (!(leased.meta.changes ?? 0)) throw ApiError.conflict('This job is already running')

  const runId = newId()
  const startedAt = Date.now()
  await env.DB.prepare(
    `INSERT INTO CloudDrive_job_runs
       (id, user_id, job_id, status, result, error, started_at, finished_at, duration_ms)
     VALUES (?, ?, ?, 'running', NULL, NULL, ?, NULL, NULL)`,
  ).bind(runId, userId, jobId, startedAt).run()

  let status = 'success'
  let result: Record<string, unknown> | null = null
  let error: string | null = null
  try {
    result = await executeHandler(env, userId, job.handler as JobHandler, startedAt)
  } catch (caught) {
    status = 'failed'
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500)
    console.error('[clouddrive] scheduled job failed:', job.handler, caught)
  }

  const finished = Date.now()
  const next = job.enabled === 1 ? nextRunFor(job.schedule_type, job.interval_sec, job.cron, finished) : null
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE CloudDrive_job_runs
            SET status = ?, result = ?, error = ?, finished_at = ?, duration_ms = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(
        status,
        result ? JSON.stringify(result) : null,
        error,
        finished,
        finished - startedAt,
        userId,
        runId,
      ),
      env.DB.prepare(
        `UPDATE CloudDrive_scheduled_jobs
            SET lock_until = NULL, last_run_at = ?, next_run_after = ?, updated_at = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(finished, next, finished, userId, jobId),
    ])
  } catch (caught) {
    // The handler already ran; leaving the run unrecorded silently would be worse than a 500.
    console.error('[clouddrive] recording a scheduled job run failed:', caught)
    throw caught
  }

  return {
    id: runId,
    jobId,
    status,
    result,
    error,
    startedAt,
    finishedAt: finished,
    durationMs: finished - startedAt,
  }
}

/**
 * The cron entry point: run every enabled job whose next slot has arrived. The scan is necessarily
 * across users (the scheduler has no session); each run still binds its own `user_id`.
 */
export async function runDueCloudDriveJobs(
  env: Env,
  now = Date.now(),
  limit = 20,
): Promise<{ ran: number; failed: number; skipped: number }> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, id FROM CloudDrive_scheduled_jobs
      WHERE enabled = 1 AND next_run_after IS NOT NULL AND next_run_after <= ?
      ORDER BY next_run_after
      LIMIT ?`,
  ).bind(now, Math.max(1, Math.min(100, limit))).all<{ user_id: string; id: string }>()
  let ran = 0
  let failed = 0
  let skipped = 0
  for (const row of results ?? []) {
    try {
      const run = await runJobNow(env, row.user_id, row.id, now)
      if (run.status === 'failed') failed++
      else ran++
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        skipped++
        continue
      }
      console.warn('[clouddrive] a due scheduled job could not start:', row.id, error)
      failed++
    }
  }
  return { ran, failed, skipped }
}
