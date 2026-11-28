import type { D1Database } from '@cloudflare/workers-types'

const PRESENCE_TTL_MS = 45_000

export async function touchProjectBoardPresence(
  db: D1Database,
  boardId: string,
  userId: string,
  now: number,
): Promise<void> {
  const cutoff = now - PRESENCE_TTL_MS
  await db.batch([
    db.prepare('DELETE FROM project_board_presence WHERE board_id = ?1 AND last_seen_at < ?2').bind(boardId, cutoff),
    db.prepare(`INSERT INTO project_board_presence (board_id, user_id, last_seen_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(board_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).bind(boardId, userId, now),
  ])
}

export async function listProjectBoardPresence(
  db: D1Database,
  boardId: string,
  now: number,
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT user_id FROM project_board_presence WHERE board_id = ?1 AND last_seen_at >= ?2 ORDER BY last_seen_at DESC, user_id')
    .bind(boardId, now - PRESENCE_TTL_MS)
    .all<{ user_id: string }>()
  return results.map((row) => row.user_id)
}
