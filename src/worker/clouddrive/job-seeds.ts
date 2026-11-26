interface BuiltinSeed {
  id: string
  name: string
  handler: 'cleanup_upload_sessions' | 'purge_share_sessions' | 'purge_trash' | 'refresh_storage_usage' | 'backup_snapshot'
  intervalSec: number
}

const BUILTIN_SEEDS: readonly BuiltinSeed[] = [
  { id: 'builtin_cleanup_upload_sessions', name: 'Clean up expired upload sessions', handler: 'cleanup_upload_sessions', intervalSec: 86_400 },
  { id: 'builtin_purge_share_sessions', name: 'Purge expired share sessions', handler: 'purge_share_sessions', intervalSec: 3_600 },
  { id: 'builtin_purge_trash', name: 'Purge trash past its retention', handler: 'purge_trash', intervalSec: 86_400 },
  { id: 'builtin_refresh_storage_usage', name: 'Refresh storage usage', handler: 'refresh_storage_usage', intervalSec: 21_600 },
  { id: 'builtin_backup_snapshot', name: 'Automatic drive snapshot', handler: 'backup_snapshot', intervalSec: 86_400 },
]

export async function ensureScheduledJobs(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM CloudDrive_scheduled_jobs WHERE user_id = ? AND id = 'builtin_backup_snapshot'`,
  ).bind(userId).first<{ found: number }>()
  if (row?.found) return
  await db.batch(BUILTIN_SEEDS.map((seed) => db.prepare(
    `INSERT OR IGNORE INTO CloudDrive_scheduled_jobs
       (user_id, id, name, handler, schedule_type, interval_sec, cron, enabled, builtin, config,
        last_run_at, next_run_after, lock_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'interval', ?, NULL, 1, 1, '{}', NULL, ?, NULL, ?, ?)`,
  ).bind(userId, seed.id, seed.name, seed.handler, seed.intervalSec, now, now, now)))
}
