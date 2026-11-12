/** Per-reader, per-board card marks. They are a preference, not board content, so they live beside the
 * user in project_settings rather than on the card row. */
import type { ProjectCardMarks } from '@shared/project/model'

function key(boardId: string): string {
  return `card-marks:${boardId}`
}

export async function readProjectCardMarks(db: D1Database, userId: string, boardId: string): Promise<ProjectCardMarks> {
  const row = await db.prepare('SELECT value FROM project_settings WHERE user_id = ?1 AND key = ?2')
    .bind(userId, key(boardId)).first<{ value: string }>()
  if (!row) return { starred: [], pinned: [] }
  try {
    const parsed = JSON.parse(row.value) as Partial<ProjectCardMarks>
    return {
      starred: Array.isArray(parsed.starred) ? parsed.starred.filter((id): id is string => typeof id === 'string') : [],
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((id): id is string => typeof id === 'string') : [],
    }
  } catch {
    return { starred: [], pinned: [] }
  }
}

export async function writeProjectCardMarks(db: D1Database, userId: string, boardId: string, marks: ProjectCardMarks, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO project_settings (user_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(userId, key(boardId), JSON.stringify(marks), now).run()
}
