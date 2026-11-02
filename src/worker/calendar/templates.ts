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
  meta_json: string
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
  metaJson: string
}

const COLUMNS = 'id, name, title, description, kind, all_day, duration_minutes, color, meta_json, rev'

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
         (user_id, id, name, title, description, kind, all_day, duration_minutes, color, meta_json, created_at, updated_at, rev)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 1)`,
    ).bind(
      userId, id, write.name, write.title, write.description, write.kind,
      write.allDay ? 1 : 0, write.durationMinutes, write.color, write.metaJson, now,
    ),
    db.prepare(`SELECT ${COLUMNS} FROM calendar_event_templates WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, id),
  ])
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
              duration_minutes = ?6, color = ?7, meta_json = ?8, updated_at = ?9, rev = rev + 1
        WHERE user_id = ?10 AND id = ?11 AND rev = ?12`,
    ).bind(
      write.name, write.title, write.description, write.kind, write.allDay ? 1 : 0,
      write.durationMinutes, write.color, write.metaJson, Date.now(), userId, id, rev,
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
