/**
 * The connection↔calendar map the background provider sync is allowed to touch.
 *
 * The browser discovers provider calendars and reports the remote/local id pair after it has created
 * the local rows. The server never invents this map: a calendar without a row here is read-only from
 * the cron's point of view. A local calendar may belong to one connection only, so two same-kind
 * accounts cannot both write the same rows.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { ApiError } from '../lib/errors'
import { isCalendarEntityId } from '@shared/calendar/model'

export interface ProviderCalendarMapping {
  remoteId: string
  localId: string
}

export interface ProviderCalendarRow {
  connection_id: string
  remote_calendar_id: string
  local_calendar_id: string
  sync_token: string | null
  last_sync_at: number | null
  last_error_code: string | null
}

const MAX_MAPPINGS = 500
const MAX_REMOTE_ID = 4096

export function parseProviderCalendarMappings(value: unknown): ProviderCalendarMapping[] {
  if (!Array.isArray(value)) throw ApiError.badRequest('calendars must be an array')
  if (value.length > MAX_MAPPINGS) throw ApiError.badRequest('Too many calendars in one report')
  const mappings: ProviderCalendarMapping[] = []
  const remoteIds = new Set<string>()
  const localIds = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest('Each calendar mapping must be an object')
    }
    const record = entry as Record<string, unknown>
    const remoteId = typeof record.remoteId === 'string' ? record.remoteId.trim() : ''
    const localId = record.localId
    if (!remoteId || remoteId.length > MAX_REMOTE_ID) {
      throw ApiError.badRequest('A remote calendar id is not valid')
    }
    if (!isCalendarEntityId(localId)) throw ApiError.badRequest('A local calendar id is not valid')
    if (remoteIds.has(remoteId)) throw ApiError.badRequest('A remote calendar is reported twice')
    if (localIds.has(localId)) throw ApiError.badRequest('A local calendar is reported twice')
    remoteIds.add(remoteId)
    localIds.add(localId)
    mappings.push({ remoteId, localId })
  }
  return mappings
}

/** Replace this connection's map; rows omitted from the report stop being background-synced. */
export async function saveProviderCalendarMappings(
  db: D1Database,
  userId: string,
  connectionId: string,
  mappings: readonly ProviderCalendarMapping[],
): Promise<number> {
  const existing = await db.prepare(
    `SELECT connection_id, local_calendar_id FROM calendar_provider_calendars
      WHERE user_id = ?1 AND local_calendar_id IN (
        SELECT value FROM json_each(?2)
      )`,
  ).bind(userId, JSON.stringify(mappings.map(mapping => mapping.localId))).all<{
    connection_id: string
    local_calendar_id: string
  }>()
  const conflicts = (existing.results ?? [])
    .filter(row => row.connection_id !== connectionId)
    .map(row => row.local_calendar_id)
  if (conflicts.length > 0) {
    throw ApiError.conflict('A calendar is already mapped to another connection')
  }

  const now = Date.now()
  const statements = [
    db.prepare(
      `DELETE FROM calendar_provider_calendars
        WHERE user_id = ?1 AND connection_id = ?2
          AND remote_calendar_id NOT IN (SELECT value FROM json_each(?3))`,
    ).bind(userId, connectionId, JSON.stringify(mappings.map(mapping => mapping.remoteId))),
  ]
  for (const mapping of mappings) {
    statements.push(db.prepare(
      `INSERT INTO calendar_provider_calendars
        (user_id, connection_id, remote_calendar_id, local_calendar_id, last_sync_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
       ON CONFLICT(user_id, connection_id, remote_calendar_id) DO UPDATE SET
         local_calendar_id = excluded.local_calendar_id,
         updated_at = excluded.updated_at`,
    ).bind(userId, connectionId, mapping.remoteId, mapping.localId, now))
  }
  try {
    await db.batch(statements)
  } catch {
    throw ApiError.conflict('A calendar is already mapped to another connection')
  }
  return mappings.length
}

export async function listProviderCalendarMappings(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<ProviderCalendarRow[]> {
  const { results } = await db.prepare(
    `SELECT connection_id, remote_calendar_id, local_calendar_id, sync_token, last_sync_at, last_error_code
       FROM calendar_provider_calendars
      WHERE user_id = ?1 AND connection_id = ?2
      ORDER BY local_calendar_id ASC`,
  ).bind(userId, connectionId).all<ProviderCalendarRow>()
  return results ?? []
}
