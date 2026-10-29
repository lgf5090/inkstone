import type { Env } from '../env'
import { parseNavBackupState } from '@shared/nav/validation'
import type { NavBackupSchedule, NavBackupState } from '@shared/nav/model'
import { forEachConcurrent } from '../backup/concurrency'
import { performNavBackup } from './backup-service'

const USER_PAGE_SIZE = 100
const DUE_TOLERANCE_MS = 5 * 60 * 1000

const INTERVALS: Record<Exclude<NavBackupSchedule, 'off'>, number> = {
  hourly: 60 * 60 * 1000,
  sixHourly: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

export function isNavBackupDue(state: Pick<NavBackupState, 'schedule' | 'lastRunAt'>, now: number): boolean {
  if (state.schedule === 'off') return false
  const interval = INTERVALS[state.schedule]
  if (!interval) return false
  if (state.lastRunAt === null) return true
  return now - state.lastRunAt >= interval - DUE_TOLERANCE_MS
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function connectionOf(raw: unknown): { url: string; username: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { url?: unknown; username?: unknown }
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  const username = typeof value.username === 'string' ? value.username.trim() : ''
  return url && username ? { url, username } : null
}

export async function runScheduledNavBackups(env: Env, now = Date.now()): Promise<void> {
  let afterUserId = ''
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT s.user_id, s.value AS state, w.value AS webdav
         FROM nav_settings s
         JOIN nav_settings w ON w.user_id = s.user_id AND w.key = 'webdav'
         JOIN nav_secrets n ON n.user_id = s.user_id AND n.key = 'webdav'
        WHERE s.key = 'backup' AND s.user_id > ?1
        ORDER BY s.user_id LIMIT ?2`,
    ).bind(afterUserId, USER_PAGE_SIZE).all<{ user_id: string; state: string; webdav: string }>()
    if (!results.length) break
    await forEachConcurrent(results, 2, async (row) => {
      const state = parseNavBackupState(parseJson(row.state))
      if (!isNavBackupDue(state, now)) return
      if (!connectionOf(parseJson(row.webdav))) return
      try {
        const result = await performNavBackup(env, row.user_id, { timestamped: true })
        console.log(`[inkstone] Scheduled navigation backup ${row.user_id}: ${result.filename}`)
      } catch (error) {
        console.warn(
          `[inkstone] Scheduled navigation backup ${row.user_id} failed:`,
          error instanceof Error ? error.message : error,
        )
      }
    })
    afterUserId = results[results.length - 1]!.user_id
    if (results.length < USER_PAGE_SIZE) break
  }
}
