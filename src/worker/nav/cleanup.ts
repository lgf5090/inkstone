import type { Env } from '../env'
import { pruneOrphanIcons } from './icons'
import { runScheduledNavBackups } from './backup-scheduler'

export async function runNavMaintenance(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM nav_category_unlocks WHERE expires_at <= ?1').bind(Date.now()).run()
  await pruneOrphanIcons(env)
  await runScheduledNavBackups(env)
}
