/**
 * Board-scoped realtime fan-out (D-11). The shared sync hub is per-user, so a project write notifies
 * every member's hub individually with the board's fresh cursor and the writer's origin; a client
 * ignores notifications whose origin is its own tab and otherwise refetches the open board. Members
 * are capped at the board-member ceiling, and a hub failure is best-effort (the 30s client poll is the
 * fallback), so one unreachable member never fails the write.
 */
import type { AppBindings } from '../env'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { notifySyncHub } from '../realtime/sync-hub'

export async function broadcastProjectChange(
  env: AppBindings['Bindings'],
  boardId: string,
  cursor: number,
  origin: string | null,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<void> {
  const { results } = await env.DB
    .prepare('SELECT user_id FROM project_board_members WHERE board_id = ?1 LIMIT ?2')
    .bind(boardId, PROJECT_LIMITS.boardMembers)
    .all<{ user_id: string }>()
  const tasks = results.map((row) => notifySyncHub(env.SYNC_HUB, row.user_id, cursor, origin, env.DO_AUTH_KEY))
  const all = Promise.all(tasks).then(() => undefined)
  if (waitUntil) waitUntil(all)
  else await all
}