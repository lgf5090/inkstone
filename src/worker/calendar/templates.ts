/** Reusable event drafts; the palette stores fields, not dates. */
import { ApiError } from '../lib/errors'
export interface TemplateRow {
  id: string
  name: string
  title: string
  description: string
  kind: string
  all_day: number
  duration_minutes: number
  color: string | null
  rev: number
}

export interface TemplateWrite {
  name: string
  title: string
  description: string
  kind: string
  allDay: boolean
  durationMinutes: number
  color: string | null
}

const COLUMNS = 'id, name, title, description, kind, all_day, duration_minutes, color, rev'
export const MAX_TEMPLATES = 100

export async function listTemplateRows(db: D1Database, userId: string): Promise<TemplateRow[]> {
  const { results } = await db.prepare(
    `SELECT ${COLUMNS} FROM calendar_event_templates WHERE user_id = ? ORDER BY lower(name) ASC, id ASC`,
  ).bind(userId).all<TemplateRow>()
  return results ?? []
}

export async function getTemplateRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<TemplateRow | null> {
  return db.prepare(
    `SELECT ${COLUMNS} FROM calendar_event_templates WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<TemplateRow>()
}

export async function insertTemplateRow(
  db: D1Database,
  userId: string,
  id: string,
  write: TemplateWrite,
): Promise<TemplateRow> {
  const now = Date.now()
  const outcomes = await db.batch([
    db.prepare(
      `INSERT INTO calendar_event_templates
         (user_id, id, name, title, description, kind, all_day, duration_minutes, color, created_at, updated_at, rev)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1
        WHERE (SELECT COUNT(*) FROM calendar_event_templates WHERE user_id = ?1) < ?11`,
    ).bind(
      userId, id, write.name, write.title, write.description, write.kind,
      write.allDay ? 1 : 0, write.durationMinutes, write.color, now, MAX_TEMPLATES,
    ),
    db.prepare(`SELECT ${COLUMNS} FROM calendar_event_templates WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, id),
  ])
  if ((outcomes[0]?.meta.changes ?? 0) === 0) {
    throw ApiError.conflict('The template limit has been reached')
  }
  const row = (outcomes.at(-1) as D1Result<TemplateRow>).results?.[0]
  if (!row) throw new Error('Calendar template create did not persist')
  return row
}

export async function updateTemplateRow(
  db: D1Database,
  userId: string,
  id: string,
  rev: number,
  write: TemplateWrite,
): Promise<TemplateRow> {
  const outcomes = await db.batch([
    db.prepare(
      `UPDATE calendar_event_templates
          SET name = ?1, title = ?2, description = ?3, kind = ?4, all_day = ?5,
              duration_minutes = ?6, color = ?7, updated_at = ?8, rev = rev + 1
        WHERE user_id = ?9 AND id = ?10 AND rev = ?11`,
    ).bind(
      write.name, write.title, write.description, write.kind, write.allDay ? 1 : 0,
      write.durationMinutes, write.color, Date.now(), userId, id, rev,
    ),
    db.prepare(`SELECT ${COLUMNS} FROM calendar_event_templates WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, id),
  ])
  if ((outcomes[0]?.meta.changes ?? 0) === 0) {
    throw ApiError.conflict('The template changed elsewhere')
  }
  const row = (outcomes.at(-1) as D1Result<TemplateRow>).results?.[0]
  if (!row) throw new Error('Calendar template update did not persist')
  return row
}

export async function deleteTemplateRow(db: D1Database, userId: string, id: string): Promise<number> {
  const result = await db.prepare(
    'DELETE FROM calendar_event_templates WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run()
  return result.meta.changes ?? 0
}
