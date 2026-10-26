/**
 * Files hung on an event.
 *
 * The bytes and their row live in the shared attachment pipeline (`scope = 'calendar'`), so one quota,
 * one MIME policy, one cleanup queue and one file door (`/api/files/:id`) already cover them; this
 * module only owns the link between an event and a file, plus the cascade that removes both when the
 * event is deleted. Objects are filed under a category folder — `calendar/images/<id>.png`,
 * `calendar/docx/<id>.pdf` — because that is the layout this deployment is read with.
 *
 * Deleting a whole calendar deletes the link rows of the events it really removes, but not their files:
 * that is the same rule task attachments follow, and it keeps a file that a surviving event in another
 * calendar still links. The files stay counted against the account quota; reclaiming them is the job of
 * a sweep this app does not have yet.
 */
import type { CalendarAttachmentDto } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { attachmentCleanupTarget, attachmentCleanupTargetSql } from '../attachments/keys'

interface AttachmentRow {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  created_at: number
}

const ATTACHMENT_COLUMNS = 'a.id, a.filename, a.mime, a.size, a.width, a.height, a.created_at'

/** The wire shape; the download url is the account's own file door, never a bucket address. */
export function calendarAttachmentDto(fields: {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  createdAt: number
}): CalendarAttachmentDto {
  return {
    id: fields.id,
    filename: fields.filename,
    mime: fields.mime,
    size: Number(fields.size),
    width: fields.width === null ? null : Number(fields.width),
    height: fields.height === null ? null : Number(fields.height),
    url: `/api/files/${fields.id}`,
    createdAt: Number(fields.createdAt),
  }
}

function toAttachment(row: AttachmentRow): CalendarAttachmentDto {
  return calendarAttachmentDto({ ...row, createdAt: row.created_at })
}

export async function listEventAttachments(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  eventId: string,
): Promise<CalendarAttachmentDto[]> {
  const { results } = await db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS}
       FROM calendar_event_attachments l
       JOIN attachments a ON a.user_id = l.user_id AND a.id = l.attachment_id
      WHERE l.user_id = ? AND l.event_id = ?
      ORDER BY l.created_at ASC, a.id ASC`,
  ).bind(userId, eventId).all<AttachmentRow>()
  return (results ?? []).map(toAttachment)
}

export async function countEventAttachments(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  eventId: string,
): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE user_id = ? AND event_id = ?',
  ).bind(userId, eventId).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** True when the link was written; false means the event or the file is not this account's. */
export async function linkEventAttachment(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  eventId: string,
  attachmentId: string,
  now: number,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ?1 AND id = ?3)
        AND EXISTS (SELECT 1 FROM attachments WHERE user_id = ?1 AND id = ?2 AND scope = 'calendar')`,
  ).bind(userId, attachmentId, eventId, now).run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Unlink one file and forget it: the link, the attachment row and the object go together.
 *
 * The queue entry is written first and only while the link still exists, so a link that survived this
 * call cannot have lost its bytes. The link is deleted last, and its outcome is the answer.
 */
export async function deleteEventAttachment(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  eventId: string,
  attachmentId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT object_key, storage FROM attachments WHERE user_id = ? AND id = ? AND scope = 'calendar'`,
  ).bind(userId, attachmentId).first<{ object_key: string | null; storage: string }>()
  if (!row) return false
  const target = row.object_key ? attachmentCleanupTarget(row.storage === 'r2' ? 'r2' : 'kv', row.object_key) : null
  const linked = `EXISTS (SELECT 1 FROM calendar_event_attachments l
                            WHERE l.user_id = ?1 AND l.attachment_id = ?2 AND l.event_id = ?3)`
  const statements = [
    ...(target
      ? [db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?4, ?1, ?5 WHERE ${linked}`,
      ).bind(userId, attachmentId, eventId, target, Date.now())]
      : []),
    db.prepare(`DELETE FROM attachments WHERE user_id = ?1 AND id = ?2 AND scope = 'calendar' AND ${linked}`)
      .bind(userId, attachmentId, eventId),
    db.prepare('DELETE FROM calendar_event_attachments WHERE user_id = ?1 AND attachment_id = ?2 AND event_id = ?3')
      .bind(userId, attachmentId, eventId),
  ]
  const outcomes = await db.batch(statements)
  return (outcomes[outcomes.length - 1]?.meta.changes ?? 0) > 0
}

/**
 * The statements that hang off an event deletion, to run inside the caller's rev-guarded batch.
 *
 * `EXISTS (… rev = ?4)` is repeated on each one because the caller's batch is the transaction: if the
 * event changed under the caller, none of this runs either. The event row is deleted after these, so
 * the guards still see it.
 */
export function eventAttachmentDeleteStatements(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  eventId: string,
  rev: number,
): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ?1 AND id = ?2 AND rev = ?3)`
  return [
    db.prepare(
      `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
       SELECT ${attachmentCleanupTargetSql('a.storage', 'a.object_key')}, ?1, ?4
         FROM attachments a
         JOIN calendar_event_attachments l ON l.user_id = a.user_id AND l.attachment_id = a.id
        WHERE l.user_id = ?1 AND l.event_id = ?2 AND a.object_key IS NOT NULL AND ${guard}`,
    ).bind(userId, eventId, rev, Date.now()),
    db.prepare(
      `DELETE FROM attachments WHERE user_id = ?1 AND scope = 'calendar' AND id IN (
         SELECT attachment_id FROM calendar_event_attachments WHERE user_id = ?1 AND event_id = ?2
       ) AND ${guard}`,
    ).bind(userId, eventId, rev),
    db.prepare(
      `DELETE FROM calendar_event_attachments WHERE user_id = ?1 AND event_id = ?2 AND ${guard}`,
    ).bind(userId, eventId, rev),
  ]
}
