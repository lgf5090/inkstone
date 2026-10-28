/** A new account's first subject and notebook, created once and reused after that. */
import { newId } from '../lib/id'

export async function ensureInknoteSeed(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  const existing = await db.prepare(
    `SELECT id FROM inknote_subjects WHERE user_id = ?1 LIMIT 1`,
  ).bind(userId).first<{ id: string }>()
  if (existing) return
  const subjectId = newId()
  const notebookId = newId()
  await db.batch([
    db.prepare(
      `INSERT INTO inknote_subjects (user_id, id, name, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?4)`,
    ).bind(userId, subjectId, 'My notebook', now),
    db.prepare(
      `INSERT INTO inknote_notebooks (user_id, id, subject_id, name, cover_color, emoji, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '', '', 0, ?5, ?5)`,
    ).bind(userId, notebookId, subjectId, 'First notebook', now),
  ])
}
