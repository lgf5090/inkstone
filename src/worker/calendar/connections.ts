/**
 * Calendar connections and the credentials behind them.
 *
 * A connection is the account-level half of remote sync: which provider, where its home collection
 * lives, what the reader may do there, and how the last attempt ended. The credential is a separate
 * row and exists only as vault ciphertext keyed to this connection's id, so listing connections never
 * touches a secret and a ciphertext copied to another connection cannot be read back.
 *
 * Every query carries `user_id`; a row that exists for another account is indistinguishable from one
 * that does not exist, which is the 404 the routes answer.
 */
import type { CalendarConnectionDto, CalendarConnectionKind } from '@shared/calendar/model'
import { CALENDAR_CONNECTION_KINDS } from '@shared/calendar/model'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { validateConnectionUrl } from './discovery'

export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/'
export const OUTLOOK_CALENDAR_API_BASE = 'https://graph.microsoft.com/v1.0/'

export const CALENDAR_CONNECTION_STATUSES = ['connected', 'error', 'expired', 'disconnected'] as const
export type CalendarConnectionStatus = (typeof CALENDAR_CONNECTION_STATUSES)[number]

export type CalendarCredentialKind = 'basic' | 'oauth'

/** The DTO is already sanitized and carries the home URL the proxy needs; the row maps to it. */
export type CalendarConnectionRecord = CalendarConnectionDto

export interface NewCalendarConnection {
  id: string
  kind: CalendarConnectionKind
  label: string
  baseUrl: string
  calendarHomeUrl: string | null
  username: string | null
  scope: 'read' | 'write'
  writable: boolean
  status?: CalendarConnectionStatus
  credential: { kind: CalendarCredentialKind; ciphertext: string }
}

export interface CalendarConnectionStatusUpdate {
  status: CalendarConnectionStatus
  lastSyncedAt?: number
  errorCode?: string | null
}

interface ConnectionRow {
  id: string
  kind: string
  label: string
  base_url: string
  calendar_home_url: string | null
  username: string | null
  scope: string
  writable: number
  status: string
  last_synced_at: number | null
  last_error_code: string | null
}

const CONNECTION_COLUMNS = `id, kind, label, base_url, calendar_home_url, username, scope, writable,
  status, last_synced_at, last_error_code`

const MAX_LABEL_LENGTH = 100
const MAX_USERNAME_LENGTH = 256
const MAX_CIPHERTEXT_LENGTH = 24 * 1024
const MAX_ERROR_CODE_LENGTH = 100
const ERROR_CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/

export function isCalendarConnectionKind(value: unknown): value is CalendarConnectionKind {
  return typeof value === 'string' && (CALENDAR_CONNECTION_KINDS as readonly string[]).includes(value)
}

export function isCalendarConnectionStatus(value: unknown): value is CalendarConnectionStatus {
  return typeof value === 'string' && (CALENDAR_CONNECTION_STATUSES as readonly string[]).includes(value)
}

export async function listCalendarConnections(
  db: D1Database,
  userId: string,
): Promise<CalendarConnectionDto[]> {
  if (!isValidId(userId)) return []
  const { results } = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM calendar_connections
        WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
    )
    .bind(userId)
    .all<ConnectionRow>()
  return (results ?? []).map(rowToConnectionDto)
}

export async function getCalendarConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<CalendarConnectionRecord | null> {
  if (!isValidId(userId) || !isValidId(connectionId)) return null
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM calendar_connections
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, connectionId)
    .first<ConnectionRow>()
  return row ? rowToConnectionRecord(row) : null
}

/**
 * Insert a connection and its sealed credential together.
 *
 * D1 batches are transactional, so a credential the vault refused to encrypt can never leave behind a
 * connection that looks usable but has no secret. The caller encrypts first, then calls this once.
 */
export async function createCalendarConnection(
  db: D1Database,
  userId: string,
  input: NewCalendarConnection,
): Promise<CalendarConnectionDto> {
  if (!isValidId(userId) || !isValidId(input.id)) throw ApiError.badRequest('Invalid calendar connection id')
  if (!isCalendarConnectionKind(input.kind)) throw ApiError.badRequest('Invalid calendar provider')
  if (input.scope !== 'read' && input.scope !== 'write') throw ApiError.badRequest('Invalid calendar scope')
  if (input.scope === 'read' && input.writable) throw ApiError.badRequest('A read-only connection cannot be writable')
  if (input.kind === 'caldav' && input.credential.kind !== 'basic') {
    throw ApiError.badRequest('A CalDAV connection needs a username and password')
  }
  if (input.kind !== 'caldav' && input.credential.kind !== 'oauth') {
    throw ApiError.badRequest('A Google or Outlook connection needs OAuth tokens')
  }
  const label = validatedLabel(input.label)
  const baseUrl = validateConnectionUrl(input.baseUrl).toString()
  const calendarHomeUrl = input.calendarHomeUrl === null
    ? null
    : validateConnectionUrl(input.calendarHomeUrl).toString()
  const username = input.username === null ? null : validatedUsername(input.username)
  if (!input.credential.ciphertext || input.credential.ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw ApiError.badRequest('Invalid calendar credential')
  }
  const status = input.status ?? 'connected'
  if (!isCalendarConnectionStatus(status)) throw ApiError.badRequest('Invalid calendar connection status')

  const now = Date.now()
  await db.batch([
    db.prepare(
      `INSERT INTO calendar_connections
        (user_id, id, kind, label, base_url, calendar_home_url, username, scope, writable,
         status, last_synced_at, last_error_code, last_error_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL, ?11, ?11)`,
    ).bind(
      userId,
      input.id,
      input.kind,
      label,
      baseUrl,
      calendarHomeUrl,
      username,
      input.scope,
      input.writable ? 1 : 0,
      status,
      now,
    ),
    credentialStatement(db, userId, input.id, input.credential.kind, input.credential.ciphertext, now),
  ])

  const created = await getCalendarConnection(db, userId, input.id)
  if (!created) throw new ApiError(500, 'internal', 'The calendar connection could not be read back')
  return toCalendarConnectionDto(created)
}

export async function updateCalendarConnectionStatus(
  db: D1Database,
  userId: string,
  connectionId: string,
  update: CalendarConnectionStatusUpdate,
): Promise<boolean> {
  if (!isValidId(userId) || !isValidId(connectionId)) return false
  if (!isCalendarConnectionStatus(update.status)) return false
  const errorCode = update.errorCode === undefined || update.errorCode === null
    ? null
    : validatedErrorCode(update.errorCode)
  if (update.lastSyncedAt !== undefined && !isTimestamp(update.lastSyncedAt)) {
    throw ApiError.badRequest('Invalid last sync time')
  }
  const now = Date.now()
  const result = await db
    .prepare(
      `UPDATE calendar_connections
          SET status = ?3,
              last_synced_at = CASE WHEN ?4 IS NULL THEN last_synced_at ELSE ?4 END,
              last_error_code = ?5,
              last_error_at = CASE WHEN ?5 IS NULL THEN NULL ELSE ?6 END,
              updated_at = ?6
        WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, connectionId, update.status, update.lastSyncedAt ?? null, errorCode, now)
    .run()
  return Number(result.meta?.changes ?? 0) > 0
}

/**
 * Remove a connection and everything tied to its authorization.
 *
 * Pending OAuth states for the same provider are removed too, because they can no longer produce a
 * connection the reader asked for. Subscriptions and events are deliberately left alone: the route
 * and the sync layer own that policy, and deleting a connection must not silently delete a calendar.
 */
export async function deleteCalendarConnection(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<CalendarConnectionRecord | null> {
  const connection = await getCalendarConnection(db, userId, connectionId)
  if (!connection) return null
  const statements = [
    db.prepare('DELETE FROM calendar_credentials WHERE user_id = ?1 AND connection_id = ?2')
      .bind(userId, connectionId),
  ]
  if (connection.kind !== 'caldav') {
    statements.push(
      db.prepare('DELETE FROM calendar_oauth_states WHERE user_id = ?1 AND provider = ?2')
        .bind(userId, connection.kind),
    )
  }
  statements.push(
    db.prepare('DELETE FROM calendar_connections WHERE user_id = ?1 AND id = ?2')
      .bind(userId, connectionId),
  )
  await db.batch(statements)
  return connection
}

/** Upsert the one credential row a connection may have for its kind. Reconnecting replaces it. */
export async function saveCalendarCredential(
  db: D1Database,
  userId: string,
  connectionId: string,
  kind: CalendarCredentialKind,
  ciphertext: string,
): Promise<void> {
  if (!isValidId(userId) || !isValidId(connectionId)) throw ApiError.badRequest('Invalid calendar connection')
  if (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw ApiError.badRequest('Invalid calendar credential')
  }
  await credentialStatement(db, userId, connectionId, kind, ciphertext, Date.now()).run()
}

export async function loadCalendarCredential(
  db: D1Database,
  userId: string,
  connectionId: string,
  kind: CalendarCredentialKind,
): Promise<string | null> {
  if (!isValidId(userId) || !isValidId(connectionId)) return null
  const row = await db
    .prepare(
      `SELECT ciphertext FROM calendar_credentials
        WHERE user_id = ?1 AND connection_id = ?2 AND kind = ?3`,
    )
    .bind(userId, connectionId, kind)
    .first<{ ciphertext: string }>()
  return row?.ciphertext ?? null
}

function credentialStatement(
  db: D1Database,
  userId: string,
  connectionId: string,
  kind: CalendarCredentialKind,
  ciphertext: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO calendar_credentials
      (user_id, id, connection_id, kind, ciphertext, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(user_id, connection_id, kind) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       updated_at = excluded.updated_at`,
  ).bind(userId, newId(), connectionId, kind, ciphertext, now)
}

function rowToConnectionRecord(row: ConnectionRow): CalendarConnectionRecord {
  return {
    id: row.id,
    kind: isCalendarConnectionKind(row.kind) ? row.kind : 'caldav',
    label: row.label,
    baseUrl: row.base_url,
    calendarHomeUrl: row.calendar_home_url,
    username: row.username,
    scope: row.scope === 'write' ? 'write' : 'read',
    writable: row.writable === 1,
    status: isCalendarConnectionStatus(row.status) ? row.status : 'error',
    lastSyncedAt: typeof row.last_synced_at === 'number' ? row.last_synced_at : null,
    lastErrorCode: row.last_error_code,
  }
}

function rowToConnectionDto(row: ConnectionRow): CalendarConnectionDto {
  return toCalendarConnectionDto(rowToConnectionRecord(row))
}

export function toCalendarConnectionDto(connection: CalendarConnectionRecord): CalendarConnectionDto {
  return {
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    baseUrl: connection.baseUrl,
    calendarHomeUrl: connection.calendarHomeUrl,
    username: connection.username,
    scope: connection.scope,
    writable: connection.writable,
    status: connection.status,
    lastSyncedAt: connection.lastSyncedAt,
    lastErrorCode: connection.lastErrorCode,
  }
}

function validatedLabel(value: string): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Invalid calendar connection name')
  const label = value.trim()
  if (label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) {
    throw ApiError.badRequest('Invalid calendar connection name')
  }
  return label
}

function validatedUsername(value: string): string {
  if (typeof value !== 'string') throw ApiError.badRequest('Invalid calendar username')
  const username = value.trim()
  if (!username || username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f:]/.test(username)) {
    throw ApiError.badRequest('Invalid calendar username')
  }
  return username
}

function validatedErrorCode(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_ERROR_CODE_LENGTH || !ERROR_CODE_RE.test(value)) {
    throw ApiError.badRequest('Invalid calendar error code')
  }
  return value
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + 5 * 60 * 1000
}
