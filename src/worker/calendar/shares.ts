/**
 * Public calendar links.
 *
 * A shared calendar is read by someone who will never log in, so the unguessable slug *is* the
 * capability — the same model the task feeds and note shares already use. This module owns the rows:
 * minting, revoking, looking one up, and rendering the document a visitor gets. Nothing here decides
 * what the visitor may do, because there is nothing they may do but read.
 *
 * Revoking deletes the row, so an address someone wrote down before the revoke stays dead and publishing
 * again necessarily hands out a new one. Deleting a calendar deletes its row in the same batch, and a
 * row is gone with the account: nothing about a link outlives the thing it pointed at.
 */
import type { CalendarEventDto, CalendarShareDto } from '@shared/calendar/model'
import { MAX_ICS_EXPORT_BYTES } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newSlug } from '../lib/id'
import { encodeIcsChunks } from './ics'
import { CalendarStore } from './store'

interface ShareRow {
  slug: string
  user_id: string
  calendar_id: string
  views: number
  created_at: number
  last_viewed_at: number | null
}

function toShare(row: ShareRow): CalendarShareDto {
  return {
    slug: row.slug,
    calendarId: row.calendar_id,
    views: Number(row.views),
    createdAt: Number(row.created_at),
    lastViewedAt: row.last_viewed_at === null ? null : Number(row.last_viewed_at),
  }
}

async function shareRow(db: AppBindings['Bindings']['DB'], userId: string, calendarId: string) {
  const { results } = await db.prepare(
    `SELECT slug, user_id, calendar_id, views, created_at, last_viewed_at
       FROM calendar_shares WHERE user_id = ? AND calendar_id = ?`,
  ).bind(userId, calendarId).all<ShareRow>()
  return results?.[0] ?? null
}

/** The calendar's live link, or null while it is private. */
export async function findShare(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  calendarId: string,
): Promise<CalendarShareDto | null> {
  const row = await shareRow(db, userId, calendarId)
  return row ? toShare(row) : null
}

/** Publish the calendar, or answer with the address it already has. */
export async function mintShare(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  calendarId: string,
): Promise<CalendarShareDto> {
  const store = new CalendarStore(db, userId)
  const calendar = (await store.listCalendars()).find(entry => entry.id === calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const existing = await shareRow(db, userId, calendarId)
  if (existing) return toShare(existing)
  // `OR IGNORE` because two presses can arrive together: the second one loses the unique key and then
  // reads back the address the first one wrote, instead of turning a double click into a 500.
  await db.prepare(
    `INSERT OR IGNORE INTO calendar_shares (slug, user_id, calendar_id, views, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0, ?4, ?4)`,
  ).bind(newSlug(), userId, calendarId, Date.now()).run()
  const row = await shareRow(db, userId, calendarId)
  if (!row) throw new Error('Calendar share did not persist')
  return toShare(row)
}

/** Unpublish. The row goes with the address: whoever held the old link cannot be handed a live one. */
export async function revokeShare(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  calendarId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM calendar_shares WHERE user_id = ?1 AND calendar_id = ?2`,
  ).bind(userId, calendarId).run()
  return (result.meta.changes ?? 0) > 0
}

/** Which calendar a live address belongs to. The visitor has no session, so this is the whole check. */
export async function shareOwner(
  db: AppBindings['Bindings']['DB'],
  slug: string,
): Promise<{ userId: string; calendarId: string } | null> {
  const { results } = await db.prepare(
    `SELECT user_id, calendar_id FROM calendar_shares WHERE slug = ?`,
  ).bind(slug).all<{ user_id: string; calendar_id: string }>()
  const row = results?.[0]
  return row ? { userId: row.user_id, calendarId: row.calendar_id } : null
}

export async function recordShareView(
  db: AppBindings['Bindings']['DB'],
  slug: string,
): Promise<void> {
  await db.prepare('UPDATE calendar_shares SET views = views + 1, last_viewed_at = ?2 WHERE slug = ?1')
    .bind(slug, Date.now()).run()
    .catch((error: unknown) => {
      // A view counter is bookkeeping: losing one must not cost the visitor their calendar.
      console.warn('[inkstone] calendar share view count failed:', error instanceof Error ? error.message : error)
    })
}

/** The published document: the whole calendar, in the owner's zone, without the account's other data. */
export async function sharedCalendarChunks(
  db: AppBindings['Bindings']['DB'],
  userId: string,
  calendarId: string,
  maxBytes: number,
): Promise<{ chunks: Uint8Array[] | null; name: string }> {
  const store = new CalendarStore(db, userId)
  const calendar = (await store.listCalendars()).find(entry => entry.id === calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const size = await store.exportSizeFor(calendarId)
  if (size.storedBytes > maxBytes || size.storedBytes > MAX_ICS_EXPORT_BYTES) {
    return { chunks: null, name: calendar.name }
  }
  const range = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendarId])
  const events: CalendarEventDto[] = range.events
  return {
    chunks: encodeIcsChunks({
      name: calendar.name,
      events,
      timeZone: (await store.preferences()).timeZone,
    }, maxBytes),
    name: calendar.name,
  }
}
