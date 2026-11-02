/** Booking-link rows; the public page reads them by slug without an account. */
export interface SchedulingLinkRow {
  id: string
  calendar_id: string
  slug: string
  title: string
  duration_minutes: number
  days_json: string
  start_hour: number
  end_hour: number
  enabled: number
}

export interface SchedulingLinkWithOwner extends SchedulingLinkRow {
  user_id: string
}

const COLUMNS = 'id, calendar_id, slug, title, duration_minutes, days_json, start_hour, end_hour, enabled'

export async function listSchedulingLinks(db: D1Database, userId: string): Promise<SchedulingLinkRow[]> {
  const { results } = await db.prepare(
    `SELECT ${COLUMNS} FROM calendar_scheduling_links WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
  ).bind(userId).all<SchedulingLinkRow>()
  return results ?? []
}

export async function getSchedulingLink(
  db: D1Database,
  userId: string,
  id: string,
): Promise<SchedulingLinkRow | null> {
  return db.prepare(
    `SELECT ${COLUMNS} FROM calendar_scheduling_links WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<SchedulingLinkRow>()
}

export async function getPublicSchedulingLink(db: D1Database, slug: string): Promise<SchedulingLinkWithOwner | null> {
  return db.prepare(
    `SELECT user_id, ${COLUMNS} FROM calendar_scheduling_links WHERE slug = ?1 AND enabled = 1 LIMIT 1`,
  ).bind(slug).first<SchedulingLinkWithOwner>()
}

export async function insertSchedulingLink(
  db: D1Database,
  input: {
    userId: string
    id: string
    calendarId: string
    slug: string
    title: string
    durationMinutes: number
    daysJson: string
    startHour: number
    endHour: number
    enabled: boolean
    now: number
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO calendar_scheduling_links
       (user_id, id, calendar_id, slug, title, duration_minutes, days_json, start_hour, end_hour, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
  ).bind(
    input.userId, input.id, input.calendarId, input.slug, input.title, input.durationMinutes,
    input.daysJson, input.startHour, input.endHour, input.enabled ? 1 : 0, input.now,
  ).run()
}

export async function updateSchedulingLink(
  db: D1Database,
  userId: string,
  id: string,
  next: { title: string; durationMinutes: number; daysJson: string; startHour: number; endHour: number; enabled: boolean },
): Promise<void> {
  await db.prepare(
    `UPDATE calendar_scheduling_links
        SET title = ?1, duration_minutes = ?2, days_json = ?3, start_hour = ?4, end_hour = ?5,
            enabled = ?6, updated_at = ?7
      WHERE user_id = ?8 AND id = ?9`,
  ).bind(
    next.title, next.durationMinutes, next.daysJson, next.startHour, next.endHour,
    next.enabled ? 1 : 0, Date.now(), userId, id,
  ).run()
}

export async function deleteSchedulingLink(db: D1Database, userId: string, id: string): Promise<number> {
  const result = await db.prepare(
    'DELETE FROM calendar_scheduling_links WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run()
  return result.meta.changes ?? 0
}
