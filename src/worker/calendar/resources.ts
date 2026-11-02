/** Rows behind bookable resources; the label lives beside the calendar it reserves. */
import type { CalendarResourceDto } from '@shared/calendar/model'

interface ResourceRow {
  id: string
  calendar_id: string
  name: string
  capacity: number | null
}

function toDto(row: ResourceRow): CalendarResourceDto {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    name: row.name,
    capacity: row.capacity === null ? null : Number(row.capacity),
  }
}

export async function listResources(db: D1Database, userId: string): Promise<CalendarResourceDto[]> {
  const { results } = await db.prepare(
    'SELECT id, calendar_id, name, capacity FROM calendar_resources WHERE user_id = ? ORDER BY lower(name) ASC, id ASC',
  ).bind(userId).all<ResourceRow>()
  return (results ?? []).map(toDto)
}

export async function getResource(db: D1Database, userId: string, id: string): Promise<CalendarResourceDto | null> {
  const row = await db.prepare(
    'SELECT id, calendar_id, name, capacity FROM calendar_resources WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).first<ResourceRow>()
  return row ? toDto(row) : null
}

export async function insertResource(
  db: D1Database,
  userId: string,
  input: { id: string; calendarId: string; name: string; capacity: number | null },
): Promise<void> {
  await db.prepare(
    `INSERT INTO calendar_resources (user_id, id, calendar_id, name, capacity, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  ).bind(userId, input.id, input.calendarId, input.name, input.capacity, Date.now()).run()
}

export async function updateResourceRow(
  db: D1Database,
  userId: string,
  id: string,
  next: { name: string; capacity: number | null },
): Promise<void> {
  await db.prepare(
    'UPDATE calendar_resources SET name = ?1, capacity = ?2, updated_at = ?3 WHERE user_id = ?4 AND id = ?5',
  ).bind(next.name, next.capacity, Date.now(), userId, id).run()
}

export async function deleteResourceRow(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare(
    'DELETE FROM calendar_resources WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run()
}
