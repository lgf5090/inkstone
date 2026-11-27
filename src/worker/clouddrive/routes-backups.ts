import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { createSnapshot, snapshotView } from './snapshots'
import { ensureScheduledJobs } from './job-seeds'

export const BACKUP_JOB_ID = 'builtin_backup_snapshot'
const MIN_BACKUP_INTERVAL_SEC = 6 * 60 * 60
const MAX_BACKUP_INTERVAL_SEC = 30 * 86_400

export const clouddriveBackupRoutes = new Hono<AppBindings>()
clouddriveBackupRoutes.use('/backups', requireOwner)
clouddriveBackupRoutes.use('/backups/*', requireOwner)
clouddriveBackupRoutes.use('/backups/*', async (c, next) => {
  await ensureScheduledJobs(c.env.DB, c.get('userId'))
  await next()
})

clouddriveBackupRoutes.get('/backups/status', async (c) => {
  const job = await c.env.DB.prepare(
    `SELECT enabled, interval_sec, last_run_at, next_run_after FROM CloudDrive_scheduled_jobs
      WHERE user_id = ? AND id = ?`,
  ).bind(c.get('userId'), BACKUP_JOB_ID).first<{ enabled: number; interval_sec: number; last_run_at: number | null; next_run_after: number | null }>()
  if (!job) throw ApiError.notFound('Backup job not found')
  return c.json({
    backup: {
      enabled: job.enabled === 1, intervalSec: job.interval_sec,
      lastRunAt: job.last_run_at, nextRunAfter: job.next_run_after,
      note: 'Runs only while the Cloudflare scheduled trigger is active; it does not run after the browser closes.',
    },
  })
})

clouddriveBackupRoutes.patch('/backups/schedule', async (c) => {
  const body = await readJson<{ enabled?: unknown; intervalSec?: unknown }>(c, 4096)
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be boolean')
  const intervalSec = body.intervalSec === undefined ? null : Number(body.intervalSec)
  if (intervalSec !== null && (!Number.isSafeInteger(intervalSec) || intervalSec < MIN_BACKUP_INTERVAL_SEC || intervalSec > MAX_BACKUP_INTERVAL_SEC)) {
    throw ApiError.badRequest(`intervalSec must be between ${MIN_BACKUP_INTERVAL_SEC} and ${MAX_BACKUP_INTERVAL_SEC}`)
  }
  const current = await c.env.DB.prepare(
    `SELECT enabled, interval_sec FROM CloudDrive_scheduled_jobs WHERE user_id = ? AND id = ?`,
  ).bind(c.get('userId'), BACKUP_JOB_ID).first<{ enabled: number; interval_sec: number }>()
  if (!current) throw ApiError.notFound('Backup job not found')
  const enabled = body.enabled ?? current.enabled === 1
  const interval = intervalSec ?? current.interval_sec
  const now = Date.now()
  await c.env.DB.prepare(
    `UPDATE CloudDrive_scheduled_jobs SET enabled = ?, interval_sec = ?, next_run_after = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(enabled ? 1 : 0, interval, enabled ? now + interval * 1000 : null, now, c.get('userId'), BACKUP_JOB_ID).run()
  return c.json({ ok: true })
})

clouddriveBackupRoutes.post('/backups/run', async (c) => {
  const snapshot = await createSnapshot(c.env, c.get('userId'), `Manual backup ${new Date().toISOString()}`)
  const now = Date.now()
  const job = await c.env.DB.prepare(
    `SELECT enabled, interval_sec FROM CloudDrive_scheduled_jobs WHERE user_id = ? AND id = ?`,
  ).bind(c.get('userId'), BACKUP_JOB_ID).first<{ enabled: number; interval_sec: number }>()
  await c.env.DB.prepare(
    `UPDATE CloudDrive_scheduled_jobs SET last_run_at = ?, next_run_after = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(now, job?.enabled ? now + job.interval_sec * 1000 : null, now, c.get('userId'), BACKUP_JOB_ID).run()
  return c.json({ snapshot: snapshotView(snapshot) }, 201)
})
