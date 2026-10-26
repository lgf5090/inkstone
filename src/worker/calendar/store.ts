/**
 * Every read and write the calendar HTTP routes make against D1.
 *
 * The shape follows the other stores: built per request from the account it serves, methods take
 * already-validated input and answer with the record the route needs, and nothing here knows about
 * HTTP. Three rules hold throughout:
 *  - every statement carries `user_id`, so one account's calendars can never surface in another's read;
 *  - a mutation's statements stay in one D1 batch, and every guarded write names the revision it read;
 *  - event membership lives in `calendar_event_calendars`, never as a column on the event, so a
 *    multi-calendar event has exactly one row per calendar and `calendarId` is derived (the lowest
 *    position) rather than stored twice.
 *
 * Batches are chunked because D1 bounds both the statement count of a batch and the variables one
 * statement may bind. A multi-chunk write is not one transaction, so a failed batch write cleans its
 * own rows through `batch_key` before rethrowing.
 */

import type {
  CalendarConferenceDto,
  CalendarConnectionDto,
  CalendarDto,
  CalendarEventDto,
  CalendarEventInput,
  CalendarEventKind,
  CalendarGroupDto,
  CalendarMetaDto,
  CalendarPreferences,
  CalendarSearchResultDto,
  CalendarSource,
  CalendarSubscriptionDto,
  CalendarTaskDto,
  CalendarTaskPriority,
  TemporalValue,
} from '@shared/calendar/model'
import {
  defaultCalendarPreferences,
  isCalendarEntityId,
  isCalendarSource,
  isTemporalKind,
  MAX_CALENDARS,
  MAX_CALENDAR_IDS_PER_EVENT,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_QUERY,
  MAX_GROUPS,
  normalizeCalendarPreferences,
  temporalValueToEpochMs,
} from '@shared/calendar/model'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { parseStoredJson, storedObject } from '../lib/json'

/** Light/dark pairs the first calendar and any uncoloured create draw from, in order. */
const DEFAULT_CALENDAR_COLORS: ReadonlyArray<{ color: string; darkColor: string }> = [
  { color: '#3b82f6', darkColor: '#60a5fa' },
  { color: '#10b981', darkColor: '#34d399' },
  { color: '#f59e0b', darkColor: '#fbbf24' },
  { color: '#ef4444', darkColor: '#f87171' },
  { color: '#8b5cf6', darkColor: '#a78bfa' },
  { color: '#ec4899', darkColor: '#f472b6' },
  { color: '#06b6d4', darkColor: '#22d3ee' },
  { color: '#84cc16', darkColor: '#a3e635' },
]

// D1 refuses a statement with more than 100 bound variables. The external-id lookup binds two
// variables per pair, so it keeps its own smaller window; the single-column IN lookups can use
// the wider one because they add only one variable per id.
const SQL_CHUNK = 80
const EXTERNAL_MATCH_CHUNK = 40
const MAX_BATCH_STATEMENTS = 80

export interface CalendarTaskWrite {
  completed: boolean
  completedAt: TemporalValue | null
  completedAtMs: number | null
  priority: CalendarTaskPriority | null
}

/**
 * One event a write may carry. Validation hands over every field, while import/sync callers may hand
 * over the shared `CalendarEventInput` shape; `fillTimeline` supplies the defaults and the epoch
 * milliseconds the range columns need.
 */
export interface CalendarEventWriteInput extends Omit<CalendarEventInput, 'task'> {
  task?: CalendarTaskDto | CalendarTaskWrite | null
  startMs?: number
  endMs?: number
}

type TimelineEventWrite = CalendarEventWriteInput & {
  description: string
  kind: CalendarEventKind
  task: CalendarTaskWrite | null
  conference: CalendarConferenceDto | null
  startMs: number
  endMs: number
  allDay: boolean
  calendarIds: string[]
  meta: Record<string, unknown>
  icon: boolean | null
  recurrenceRule: string | null
  source: CalendarSource
  externalId: string | null
}

export interface CalendarEventPatchInput {
  rev: number
  title?: string
  description?: string
  kind?: CalendarEventKind
  task?: CalendarTaskWrite | null
  conference?: CalendarConferenceDto | null
  start?: TemporalValue
  end?: TemporalValue
  startMs?: number
  endMs?: number
  allDay?: boolean
  calendarIds?: string[]
  meta?: Record<string, unknown>
  icon?: boolean | null
  recurrenceRule?: string | null
}

export interface CalendarWriteInput {
  id?: string
  name: string
  color?: string
  darkColor?: string
  icon?: string | null
  groupId?: string | null
  isDefault?: boolean
  isVisible?: boolean
  readOnly?: boolean
  source?: CalendarSource
}

export interface CalendarPatchInput {
  rev: number
  name?: string
  color?: string
  darkColor?: string
  icon?: string | null
  groupId?: string | null
  isDefault?: boolean
  isVisible?: boolean
  readOnly?: boolean
}

export interface CalendarGroupWriteInput {
  id?: string
  name: string
}

export interface CalendarDeleteOptions {
  mode: 'merge' | 'delete'
  targetId?: string | null
  rev?: number | null
}

interface CalendarRow {
  id: string
  name: string
  color: string
  dark_color: string
  icon: string | null
  group_id: string | null
  is_default: number
  is_visible: number
  read_only: number
  source: string
  subscription_id: string | null
  position: number
  rev: number
}

interface GroupRow {
  id: string
  name: string
  position: number
}

interface EventRow {
  id: string
  title: string
  description: string
  kind: string
  task_completed: number | null
  task_completed_at: number | null
  task_completed_at_value: string | null
  task_priority: string | null
  conference_json: string | null
  start_value: string
  start_type: string
  time_zone: string | null
  start_ms: number
  end_value: string
  end_type: string
  end_ms: number
  all_day: number
  icon_json: string | null
  meta_json: string
  recurrence_rule: string | null
  calendar_source: string
  external_scope: string
  external_id: string | null
  rev: number
}

interface SubscriptionRow {
  id: string
  calendar_id: string
  kind: string
  url: string | null
  enabled: number
  last_sync_at: number | null
  last_error_code: string | null
  created_at: number
  updated_at: number
}

interface ConnectionRow {
  id: string
  kind: string
  label: string
  base_url: string
  calendar_home_url: string | null
  username: string | null
  scope: string | null
  writable: number
  status: string
  last_synced_at: number | null
  last_error_code: string | null
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function conflictFromWrite(error: unknown, message: string): never {
  if (isUniqueViolation(error)) throw ApiError.conflict(message)
  throw error
}

function temporalFromRow(value: string, type: string, timeZone: string | null): TemporalValue {
  const kind = isTemporalKind(type) ? type : 'datetime'
  return kind === 'zoned' && timeZone ? { value, type: kind, timeZone } : { value, type: kind }
}

function readCompletedAt(raw: string | null): TemporalValue | null {
  if (!raw) return null
  const value = parseStoredJson(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.value !== 'string' || !isTemporalKind(record.type)) return null
  return record.timeZone === undefined
    ? { value: record.value, type: record.type }
    : typeof record.timeZone === 'string'
      ? { value: record.value, type: record.type, timeZone: record.timeZone }
      : { value: record.value, type: record.type }
}

function readIcon(raw: string | null): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function asPriority(value: string | null): CalendarTaskPriority | null {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high' ? value : null
}

function asKind(value: string): CalendarEventKind {
  return value === 'task' ? 'task' : 'event'
}

function toCalendarDto(row: CalendarRow): CalendarDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    darkColor: row.dark_color,
    icon: row.icon,
    groupId: row.group_id,
    isDefault: row.is_default === 1,
    isVisible: row.is_visible === 1,
    readOnly: row.read_only === 1,
    source: isCalendarSource(row.source) ? row.source : 'local',
    subscriptionId: row.subscription_id,
    position: row.position,
    rev: row.rev,
  }
}

function toGroupDto(row: GroupRow): CalendarGroupDto {
  return { id: row.id, name: row.name, position: row.position }
}

function toEventDto(row: EventRow, calendarIds: readonly string[]): CalendarEventDto {
  const hasTask = row.task_completed !== null
    || row.task_completed_at_value !== null
    || row.task_priority !== null
  const completedAt = readCompletedAt(row.task_completed_at_value)
  const priority = asPriority(row.task_priority)
  const task: CalendarTaskDto | null = hasTask
    ? {
        completed: row.task_completed === 1,
        ...(completedAt ? { completedAt } : {}),
        ...(priority ? { priority } : {}),
      }
    : asKind(row.kind) === 'task'
      ? { completed: false }
      : null
  const conference = row.conference_json ? parseStoredJson(row.conference_json) : null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: asKind(row.kind),
    task,
    conference: conference && typeof conference === 'object' && !Array.isArray(conference)
      ? conference as CalendarConferenceDto
      : null,
    start: temporalFromRow(row.start_value, row.start_type, row.time_zone),
    end: temporalFromRow(row.end_value, row.end_type, row.time_zone),
    allDay: row.all_day === 1,
    calendarId: calendarIds[0] ?? '',
    calendarIds: [...calendarIds],
    meta: storedObject(row.meta_json),
    icon: readIcon(row.icon_json),
    recurrenceRule: row.recurrence_rule,
    rev: row.rev,
    source: isCalendarSource(row.calendar_source) ? row.calendar_source : 'local',
    externalId: row.external_id,
  }
}

/** The event columns a write binds, in the order both statements below spell them. */
const EVENT_WRITE_COLUMNS = [
  'title', 'description', 'kind', 'task_completed', 'task_completed_at',
  'task_completed_at_value', 'task_priority', 'conference_json', 'start_value', 'start_type',
  'time_zone', 'start_ms', 'end_value', 'end_type', 'end_ms', 'all_day', 'icon_json',
  'meta_json', 'recurrence_rule', 'calendar_source', 'external_scope', 'external_id',
] as const

export class CalendarStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  // ------------------------------------------------------------- calendars

  /**
   * The account's calendars, creating the first one when it has none.
   *
   * The insert selects only when the account still owns no row, so two tabs opening the app at once
   * do not both create a "Calendar". The default flag is the palette's first pair; a later create
   * that asks to be default clears the old one in the same batch.
   */
  async ensureDefaultCalendar(): Promise<CalendarDto[]> {
    const existing = await this.listCalendars()
    if (existing.length > 0) return existing
    const now = Date.now()
    const palette = DEFAULT_CALENDAR_COLORS[0]!
    await this.db.prepare(
      `INSERT INTO calendar_calendars (
         user_id, id, name, color, dark_color, icon, group_id, is_default, is_visible,
         read_only, source, subscription_id, position, created_at, updated_at, rev
       )
       SELECT ?1, ?2, 'Calendar', ?3, ?4, NULL, NULL, 1, 1, 0, 'local', NULL, 0, ?5, ?5, 1
        WHERE NOT EXISTS (SELECT 1 FROM calendar_calendars WHERE user_id = ?1)`,
    ).bind(this.userId, newId(), palette.color, palette.darkColor, now).run()
    return this.listCalendars()
  }

  async listCalendars(): Promise<CalendarDto[]> {
    const { results } = await this.db.prepare(
      `SELECT id, name, color, dark_color, icon, group_id, is_default, is_visible, read_only,
              source, subscription_id, position, rev
         FROM calendar_calendars
        WHERE user_id = ?
        ORDER BY position ASC, created_at ASC, id ASC`,
    ).bind(this.userId).all<CalendarRow>()
    return (results ?? []).map(toCalendarDto)
  }

  async meta(): Promise<CalendarMetaDto> {
    const [calendars, groups, subscriptions, connections, preferences, preferencesInitialized] = await Promise.all([
      this.ensureDefaultCalendar(),
      this.listGroups(),
      this.listSubscriptions(),
      this.listConnections(),
      this.preferences(),
      this.hasPreferences(),
    ])
    return { calendars, groups, subscriptions, connections, preferences, preferencesInitialized }
  }

  private async hasPreferences(): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM calendar_preferences WHERE user_id = ?1`,
    ).bind(this.userId).first<{ present: number }>()
    return Boolean(row)
  }

  private async calendarRow(id: string): Promise<CalendarRow | null> {
    return (await this.db.prepare(
      `SELECT id, name, color, dark_color, icon, group_id, is_default, is_visible, read_only,
              source, subscription_id, position, rev
         FROM calendar_calendars WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<CalendarRow>()) ?? null
  }

  private async calendarCount(): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?1`,
    ).bind(this.userId).first<{ count: number }>()
    return Number(row?.count ?? 0)
  }

  private async assertGroupOwned(groupId: string | null | undefined): Promise<void> {
    if (!groupId) return
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM calendar_groups WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, groupId).first<{ present: number }>()
    if (!row) throw ApiError.notFound('Calendar group not found')
  }

  async createCalendar(input: CalendarWriteInput): Promise<CalendarDto> {
    const count = await this.calendarCount()
    if (count >= MAX_CALENDARS) throw ApiError.badRequest(`An account may hold at most ${MAX_CALENDARS} calendars`)
    await this.assertGroupOwned(input.groupId)
    const palette = DEFAULT_CALENDAR_COLORS[count % DEFAULT_CALENDAR_COLORS.length]!
    const id = input.id ?? newId()
    const isDefault = input.isDefault === true || count === 0
    const positionRow = await this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM calendar_calendars WHERE user_id = ?1`,
    ).bind(this.userId).first<{ next: number }>()
    const now = Date.now()
    const statements: D1PreparedStatement[] = []
    if (isDefault) {
      statements.push(this.db.prepare(
        `UPDATE calendar_calendars SET is_default = 0 WHERE user_id = ?1 AND is_default = 1`,
      ).bind(this.userId))
    }
    statements.push(this.db.prepare(
      `INSERT INTO calendar_calendars (
         user_id, id, name, color, dark_color, icon, group_id, is_default, is_visible,
         read_only, source, subscription_id, position, created_at, updated_at, rev
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
    ).bind(
      this.userId,
      id,
      input.name,
      input.color ?? palette.color,
      input.darkColor ?? input.color ?? palette.darkColor,
      input.icon ?? null,
      input.groupId ?? null,
      isDefault ? 1 : 0,
      input.isVisible === false ? 0 : 1,
      input.readOnly === true ? 1 : 0,
      input.source ?? 'local',
      positionRow?.next ?? 0,
      now,
      now,
    ))
    statements.push(this.calendarSelectStatement(id))
    let outcomes: D1Result[]
    try {
      outcomes = await this.db.batch(statements)
    } catch (error) {
      conflictFromWrite(error, 'A calendar with that id already exists')
    }
    const row = (outcomes.at(-1) as D1Result<CalendarRow>).results?.[0]
    if (!row) throw new Error('Calendar create did not persist')
    return toCalendarDto(row)
  }

  async updateCalendar(id: string, patch: CalendarPatchInput): Promise<CalendarDto> {
    const existing = await this.calendarRow(id)
    if (!existing) throw ApiError.notFound('Calendar not found')
    if (existing.rev !== patch.rev) throw ApiError.conflict('The calendar changed elsewhere. Refresh and try again')
    if (patch.groupId !== undefined) await this.assertGroupOwned(patch.groupId)
    if (patch.isDefault === false && existing.is_default === 1) {
      throw ApiError.conflict('Another calendar must become the default first')
    }
    const assignments: string[] = ['rev = rev + 1', 'updated_at = ?']
    const values: unknown[] = [Date.now()]
    const set = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.name !== undefined) set('name', patch.name)
    if (patch.color !== undefined) set('color', patch.color)
    if (patch.darkColor !== undefined) set('dark_color', patch.darkColor)
    if (patch.icon !== undefined) set('icon', patch.icon)
    if (patch.groupId !== undefined) set('group_id', patch.groupId)
    if (patch.isVisible !== undefined) set('is_visible', patch.isVisible ? 1 : 0)
    if (patch.readOnly !== undefined) set('read_only', patch.readOnly ? 1 : 0)
    const makeDefault = patch.isDefault === true
    if (makeDefault) set('is_default', 1)
    const update = this.db.prepare(
      `UPDATE calendar_calendars SET ${assignments.join(', ')}
        WHERE user_id = ? AND id = ? AND rev = ?`,
    ).bind(...values, this.userId, id, patch.rev)
    const statements: D1PreparedStatement[] = []
    if (makeDefault && existing.is_default !== 1) {
      // Guarded by the same id and revision the update names, so a stale write cannot clear the
      // account's default on its way to failing.
      statements.push(this.db.prepare(
        `UPDATE calendar_calendars SET is_default = 0
          WHERE user_id = ?1 AND is_default = 1 AND id <> ?2
            AND EXISTS (SELECT 1 FROM calendar_calendars WHERE user_id = ?1 AND id = ?2 AND rev = ?3)`,
      ).bind(this.userId, id, patch.rev))
    }
    statements.push(update, this.calendarSelectStatement(id))
    const outcomes = await this.db.batch(statements)
    const updateIndex = statements.length - 2
    if (!outcomes[updateIndex]?.meta.changes) {
      throw ApiError.conflict('The calendar changed elsewhere. Refresh and try again')
    }
    const row = (outcomes.at(-1) as D1Result<CalendarRow>).results?.[0]
    if (!row) throw new Error('Calendar update did not persist')
    return toCalendarDto(row)
  }

  /**
   * Remove one calendar, either moving its events to a target or deleting the events only it held.
   *
   * The last calendar is never removed: every event needs a home and the client's empty state is the
   * create flow, not a calendar-less account. Removing the default hands the flag to the first
   * remaining calendar in the same batch.
   */
  async deleteCalendar(id: string, options: CalendarDeleteOptions): Promise<void> {
    const source = await this.calendarRow(id)
    if (!source) throw ApiError.notFound('Calendar not found')
    if (options.rev !== null && options.rev !== undefined && options.rev !== source.rev) {
      throw ApiError.conflict('The calendar changed elsewhere. Refresh and try again')
    }
    const calendars = await this.listCalendars()
    if (calendars.length <= 1) throw ApiError.conflict('The last calendar cannot be deleted')
    let targetId: string | null = null
    if (options.mode === 'merge') {
      targetId = options.targetId ?? null
      if (!targetId) throw ApiError.badRequest('A merge target is required')
      if (targetId === id) throw ApiError.badRequest('A calendar cannot be merged into itself')
      if (!calendars.some((calendar) => calendar.id === targetId)) {
        throw ApiError.notFound('Calendar merge target not found')
      }
    }
    const remaining = calendars.filter((calendar) => calendar.id !== id)
    const nextDefault = source.is_default === 1
      ? remaining[0]!.id
      : (calendars.find((calendar) => calendar.isDefault)?.id ?? remaining[0]!.id)
    const statements: D1PreparedStatement[] = []
    if (options.mode === 'merge') {
      statements.push(this.db.prepare(
        `INSERT OR IGNORE INTO calendar_event_calendars (user_id, event_id, calendar_id, position)
         SELECT user_id, event_id, ?3, position
           FROM calendar_event_calendars
          WHERE user_id = ?1 AND calendar_id = ?2`,
      ).bind(this.userId, id, targetId))
      statements.push(this.db.prepare(
        `DELETE FROM calendar_event_calendars WHERE user_id = ?1 AND calendar_id = ?2`,
      ).bind(this.userId, id))
    } else {
      statements.push(this.db.prepare(
        `DELETE FROM calendar_events
          WHERE user_id = ?1 AND id IN (
            SELECT ec.event_id FROM calendar_event_calendars ec
             WHERE ec.user_id = ?1 AND ec.calendar_id = ?2
               AND NOT EXISTS (
                 SELECT 1 FROM calendar_event_calendars other
                  WHERE other.user_id = ?1 AND other.event_id = ec.event_id AND other.calendar_id <> ?2
               )
          )`,
      ).bind(this.userId, id))
      statements.push(this.db.prepare(
        `DELETE FROM calendar_event_calendars WHERE user_id = ?1 AND calendar_id = ?2`,
      ).bind(this.userId, id))
    }
    statements.push(this.db.prepare(
      `DELETE FROM calendar_subscriptions WHERE user_id = ?1 AND calendar_id = ?2`,
    ).bind(this.userId, id))
    const guarded = options.rev !== null && options.rev !== undefined
    statements.push(guarded
      ? this.db.prepare(
        `DELETE FROM calendar_calendars WHERE user_id = ?1 AND id = ?2 AND rev = ?3`,
      ).bind(this.userId, id, options.rev)
      : this.db.prepare(
        `DELETE FROM calendar_calendars WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id))
    statements.push(this.db.prepare(
      `UPDATE calendar_calendars SET is_default = CASE WHEN id = ?2 THEN 1 ELSE 0 END WHERE user_id = ?1`,
    ).bind(this.userId, nextDefault))
    const outcomes = await this.db.batch(statements)
    if (!outcomes[statements.length - 2]?.meta.changes) {
      throw ApiError.conflict('The calendar changed elsewhere. Refresh and try again')
    }
  }

  async mergeCalendar(sourceId: string, targetId: string): Promise<void> {
    await this.deleteCalendar(sourceId, { mode: 'merge', targetId })
  }

  /** Write the order the client dragged the calendars into; every live calendar must be named once. */
  async reorderCalendars(ids: readonly string[]): Promise<void> {
    const existing = await this.listCalendars()
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) {
      throw ApiError.badRequest('The calendar order must name every calendar exactly once')
    }
    const known = new Set(existing.map((calendar) => calendar.id))
    if (ids.some((id) => !known.has(id))) {
      throw ApiError.badRequest('The calendar order names a calendar this account does not own')
    }
    const statements = ids.map((id, position) => this.db.prepare(
      `UPDATE calendar_calendars SET position = ?1, rev = rev + 1, updated_at = ?2
        WHERE user_id = ?3 AND id = ?4`,
    ).bind(position, Date.now(), this.userId, id))
    for (const chunk of chunks(statements, MAX_BATCH_STATEMENTS)) await this.db.batch(chunk)
  }

  private calendarSelectStatement(id: string): D1PreparedStatement {
    return this.db.prepare(
      `SELECT id, name, color, dark_color, icon, group_id, is_default, is_visible, read_only,
              source, subscription_id, position, rev
         FROM calendar_calendars WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id)
  }

  // ------------------------------------------------------------- groups

  async listGroups(): Promise<CalendarGroupDto[]> {
    const { results } = await this.db.prepare(
      `SELECT id, name, position FROM calendar_groups
        WHERE user_id = ?
        ORDER BY position ASC, created_at ASC, id ASC`,
    ).bind(this.userId).all<GroupRow>()
    return (results ?? []).map(toGroupDto)
  }

  async createGroup(input: CalendarGroupWriteInput): Promise<CalendarGroupDto> {
    const count = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM calendar_groups WHERE user_id = ?1`,
    ).bind(this.userId).first<{ count: number }>()
    if (Number(count?.count ?? 0) >= MAX_GROUPS) {
      throw ApiError.badRequest(`An account may hold at most ${MAX_GROUPS} groups`)
    }
    const id = input.id ?? newId()
    const now = Date.now()
    const positionRow = await this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM calendar_groups WHERE user_id = ?1`,
    ).bind(this.userId).first<{ next: number }>()
    const select = this.groupSelectStatement(id)
    try {
      const outcomes = await this.db.batch([
        this.db.prepare(
          `INSERT INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(this.userId, id, input.name, positionRow?.next ?? 0, now, now),
        select,
      ])
      const row = (outcomes.at(-1) as D1Result<GroupRow>).results?.[0]
      if (!row) throw new Error('Calendar group create did not persist')
      return toGroupDto(row)
    } catch (error) {
      conflictFromWrite(error, 'A group with that name already exists')
    }
  }

  async renameGroup(id: string, name: string): Promise<CalendarGroupDto> {
    const existing = await this.groupRow(id)
    if (!existing) throw ApiError.notFound('Calendar group not found')
    try {
      const outcomes = await this.db.batch([
        this.db.prepare(
          `UPDATE calendar_groups SET name = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4`,
        ).bind(name, Date.now(), this.userId, id),
        this.groupSelectStatement(id),
      ])
      const row = (outcomes.at(-1) as D1Result<GroupRow>).results?.[0]
      if (!row) throw new Error('Calendar group rename did not persist')
      return toGroupDto(row)
    } catch (error) {
      conflictFromWrite(error, 'A group with that name already exists')
    }
  }

  async deleteGroup(id: string): Promise<void> {
    const existing = await this.groupRow(id)
    if (!existing) throw ApiError.notFound('Calendar group not found')
    await this.db.batch([
      this.db.prepare(
        `UPDATE calendar_calendars SET group_id = NULL WHERE user_id = ?1 AND group_id = ?2`,
      ).bind(this.userId, id),
      this.db.prepare(
        `DELETE FROM calendar_groups WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id),
    ])
  }

  async reorderGroups(ids: readonly string[]): Promise<void> {
    const existing = await this.listGroups()
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) {
      throw ApiError.badRequest('The group order must name every group exactly once')
    }
    const known = new Set(existing.map((group) => group.id))
    if (ids.some((id) => !known.has(id))) {
      throw ApiError.badRequest('The group order names a group this account does not own')
    }
    const statements = ids.map((id, position) => this.db.prepare(
      `UPDATE calendar_groups SET position = ?1, updated_at = ?2 WHERE user_id = ?3 AND id = ?4`,
    ).bind(position, Date.now(), this.userId, id))
    for (const chunk of chunks(statements, MAX_BATCH_STATEMENTS)) await this.db.batch(chunk)
  }

  private async groupRow(id: string): Promise<GroupRow | null> {
    return (await this.db.prepare(
      `SELECT id, name, position FROM calendar_groups WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<GroupRow>()) ?? null
  }

  private groupSelectStatement(id: string): D1PreparedStatement {
    return this.db.prepare(
      `SELECT id, name, position FROM calendar_groups WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id)
  }

  // ------------------------------------------------------------- events

  /**
   * Events overlapping the range, plus every recurrence master so the client can expand a series
   * wherever it navigates. A master outside the window still belongs to the answer.
   *
   * Membership is joined into the same query: a year view can hold thousands of rows, and asking for
   * their calendars eighty ids at a time used to multiply one page into dozens of D1 round trips.
   */
  async listEvents(
    fromMs: number,
    toMs: number,
    calendarIds?: readonly string[],
  ): Promise<{ events: CalendarEventDto[]; truncated: boolean }> {
    const filter = calendarIds && calendarIds.length > 0
      ? `AND EXISTS (
           SELECT 1 FROM calendar_event_calendars ec
            WHERE ec.user_id = e.user_id AND ec.event_id = e.id
              AND ec.calendar_id IN (${placeholders(calendarIds.length)})
         )`
      : ''
    const { results } = await this.db.prepare(
      `SELECT e.*, m.calendar_id AS membership_calendar_id
         FROM (
           SELECT * FROM calendar_events e
            WHERE e.user_id = ?
              AND ((e.start_ms <= ? AND e.end_ms >= ?) OR e.recurrence_rule IS NOT NULL)
              ${filter}
            ORDER BY e.start_ms ASC, e.id ASC
            LIMIT ?
         ) e
         JOIN calendar_event_calendars m
           ON m.user_id = e.user_id AND m.event_id = e.id
        ORDER BY e.start_ms ASC, e.id ASC, m.position ASC, m.calendar_id ASC`,
    ).bind(
      this.userId,
      toMs,
      fromMs,
      ...(calendarIds ?? []),
      MAX_EVENTS_PER_QUERY + 1,
    ).all<EventRow & { membership_calendar_id: string }>()
    const groups = new Map<string, { row: EventRow; calendarIds: string[] }>()
    for (const row of results ?? []) {
      const group = groups.get(row.id)
      if (group) group.calendarIds.push(row.membership_calendar_id)
      else groups.set(row.id, { row, calendarIds: [row.membership_calendar_id] })
    }
    const entries = [...groups.values()]
    const truncated = entries.length > MAX_EVENTS_PER_QUERY
    return {
      truncated,
      events: entries.slice(0, MAX_EVENTS_PER_QUERY).map(({ row, calendarIds: ids }) => toEventDto(row, ids)),
    }
  }

  async listAllEvents(): Promise<CalendarEventDto[]> {
    const { results } = await this.db.prepare(
      `SELECT e.* FROM calendar_events e
        WHERE e.user_id = ? ORDER BY e.start_ms ASC, e.id ASC`,
    ).bind(this.userId).all<EventRow>()
    const rows = results ?? []
    const memberships = await this.membershipsFor(rows.map((row) => row.id))
    return rows
      .filter((row) => (memberships.get(row.id)?.length ?? 0) > 0)
      .map((row) => toEventDto(row, memberships.get(row.id) ?? []))
  }

  async getEvent(id: string): Promise<CalendarEventDto | null> {
    const row = await this.eventRow(id)
    if (!row) return null
    const memberships = await this.membershipsFor([id])
    const ids = memberships.get(id) ?? []
    return ids.length > 0 ? toEventDto(row, ids) : null
  }

  private async eventRow(id: string): Promise<EventRow | null> {
    return (await this.db.prepare(
      `SELECT * FROM calendar_events WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<EventRow>()) ?? null
  }

  private async eventRowsByIds(ids: readonly string[]): Promise<EventRow[]> {
    const rows: EventRow[] = []
    for (const chunk of chunks(ids, SQL_CHUNK)) {
      const { results } = await this.db.prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ? AND id IN (${placeholders(chunk.length)})`,
      ).bind(this.userId, ...chunk).all<EventRow>()
      rows.push(...(results ?? []))
    }
    return rows
  }

  private async membershipsFor(eventIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    for (const chunk of chunks(eventIds, SQL_CHUNK)) {
      const { results } = await this.db.prepare(
        `SELECT event_id, calendar_id FROM calendar_event_calendars
          WHERE user_id = ? AND event_id IN (${placeholders(chunk.length)})
          ORDER BY position ASC, calendar_id ASC`,
      ).bind(this.userId, ...chunk).all<{ event_id: string; calendar_id: string }>()
      for (const row of results ?? []) {
        const list = map.get(row.event_id)
        if (list) list.push(row.calendar_id)
        else map.set(row.event_id, [row.calendar_id])
      }
    }
    return map
  }

  private async calendarAccess(ids: readonly string[]): Promise<Array<{ id: string; read_only: number }>> {
    const rows: Array<{ id: string; read_only: number }> = []
    for (const chunk of chunks(ids, SQL_CHUNK)) {
      const { results } = await this.db.prepare(
        `SELECT id, read_only FROM calendar_calendars
          WHERE user_id = ? AND id IN (${placeholders(chunk.length)})`,
      ).bind(this.userId, ...chunk).all<{ id: string; read_only: number }>()
      rows.push(...(results ?? []))
    }
    return rows
  }

  /**
   * Every named calendar must belong to this account. A client-facing write also refuses a set whose
   * calendars are all read-only (an imported/subscribed calendar), while import and sync paths may
   * write into one because the server, not the reader, owns that change.
   */
  private async assertCalendarsForWrite(ids: readonly string[], allowReadOnly: boolean): Promise<void> {
    if (ids.length === 0) throw ApiError.badRequest('An event needs at least one calendar')
    if (ids.length > MAX_CALENDAR_IDS_PER_EVENT) {
      throw ApiError.badRequest(`An event may belong to at most ${MAX_CALENDAR_IDS_PER_EVENT} calendars`)
    }
    if (ids.some((id) => !isCalendarEntityId(id))) throw ApiError.badRequest('Invalid calendar id')
    const rows = await this.calendarAccess(ids)
    if (rows.length !== ids.length) throw ApiError.notFound('Calendar not found')
    if (!allowReadOnly && rows.every((row) => row.read_only === 1)) {
      throw ApiError.forbidden('The calendar is read-only')
    }
  }

  private async assertEventWritable(eventId: string): Promise<void> {
    const ids = (await this.membershipsFor([eventId])).get(eventId) ?? []
    if (ids.length === 0) return
    const rows = await this.calendarAccess(ids)
    if (rows.length === ids.length && rows.every((row) => row.read_only === 1)) {
      throw ApiError.forbidden('The event belongs to a read-only calendar')
    }
  }

  /**
   * Fill the fields a write needs but the shared input shape leaves optional.
   *
   * Validation already supplies all of them; import/sync callers may not. The account's zone is read
   * only when a value without its own zone has to be placed on the timeline.
   */
  private async fillTimeline(inputs: readonly CalendarEventWriteInput[]): Promise<TimelineEventWrite[]> {
    const needsZone = inputs.some((input) =>
      (input.startMs === undefined && input.start.timeZone === undefined)
      || (input.endMs === undefined && input.end.timeZone === undefined && input.start.timeZone === undefined))
    const zone = needsZone ? (await this.preferences()).timeZone : 'UTC'
    return inputs.map((input) => {
      const meta = input.meta ?? {}
      const task = input.task === undefined || input.task === null
        ? null
        : {
            completed: input.task.completed === true,
            completedAt: input.task.completedAt ?? null,
            completedAtMs: (input.task as CalendarTaskWrite).completedAtMs
              ?? (input.task.completedAt
                ? temporalValueToEpochMs(input.task.completedAt, input.task.completedAt.timeZone ?? zone)
                : null),
            priority: input.task.priority ?? null,
          }
      const calendarIds = input.calendarIds
        ?? (input.calendarId === undefined ? [] : [input.calendarId])
      const metaRule = typeof meta.recurrenceRule === 'string' ? meta.recurrenceRule : null
      const startMs = input.startMs ?? temporalValueToEpochMs(input.start, input.start.timeZone ?? zone)
      const endMs = input.endMs ?? temporalValueToEpochMs(
        input.end,
        input.end.timeZone ?? input.start.timeZone ?? zone,
      )
      if (endMs < startMs) throw ApiError.badRequest('An event cannot end before it starts')
      const bothDates = input.start.type === 'date' && input.end.type === 'date'
      const allDay = input.allDay ?? bothDates
      if (allDay !== bothDates) {
        throw ApiError.badRequest('An all-day event must use date values for start and end')
      }
      return {
        ...input,
        description: input.description ?? '',
        kind: input.kind ?? 'event',
        task,
        conference: input.conference ?? null,
        startMs,
        endMs,
        allDay,
        calendarIds,
        meta,
        icon: input.icon ?? null,
        recurrenceRule: input.recurrenceRule ?? metaRule,
        source: input.source ?? 'local',
        externalId: input.externalId ?? null,
      }
    })
  }

  async createEvent(incoming: CalendarEventWriteInput): Promise<CalendarEventDto> {
    if (incoming.id !== undefined && !isCalendarEntityId(incoming.id)) {
      throw ApiError.badRequest('Invalid event id')
    }
    const input = (await this.fillTimeline([incoming]))[0]!
    await this.assertCalendarsForWrite(input.calendarIds, false)
    const id = input.id ?? newId()
    const duplicate = await this.db.prepare(
      `SELECT 1 AS present FROM calendar_events WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<{ present: number }>()
    if (duplicate) throw ApiError.conflict('An event with that id already exists')
    const now = Date.now()
    const statements: D1PreparedStatement[] = [this.insertEventStatement(input, id, now, null)]
    statements.push(...this.membershipInsertStatements(id, input.calendarIds))
    try {
      await this.db.batch(statements)
    } catch (error) {
      conflictFromWrite(error, 'An event with that id or external id already exists')
    }
    const event = await this.getEvent(id)
    if (!event) throw new Error('Event create did not persist')
    return event
  }

  async upsertEvent(input: CalendarEventWriteInput): Promise<CalendarEventDto> {
    const events = await this.createEvents([input], 'upsert')
    const event = events[0]
    if (!event) throw new Error('Event upsert did not persist')
    return event
  }

  /**
   * Create or upsert up to 200 events as a small number of D1 batches.
   *
   * `batch_key` names every row this call created, so a failure in a later chunk can remove the rows
   * earlier chunks committed. Rows an upsert merely updated keep their old key and are never removed
   * by that cleanup.
   */
  async createEvents(
    inputs: readonly CalendarEventWriteInput[],
    mode: 'create' | 'upsert',
    options: { allowReadOnly?: boolean } = {},
  ): Promise<CalendarEventDto[]> {
    if (inputs.length === 0) throw ApiError.badRequest('A batch needs at least one event')
    if (inputs.length > MAX_EVENTS_PER_BATCH) {
      throw ApiError.badRequest(`A batch may hold at most ${MAX_EVENTS_PER_BATCH} events`)
    }
    if (inputs.some((input) => input.id !== undefined && !isCalendarEntityId(input.id))) {
      throw ApiError.badRequest('Invalid event id')
    }
    const timelineInputs = await this.fillTimeline(inputs)
    const calendarIds = [...new Set(timelineInputs.flatMap((input) => input.calendarIds))]
    // A provider sync writes its own remote events into a read-only calendar; a local edit must not.
    // Choosing the branch from each input's source/external identity keeps batch import from becoming
    // a general read-only bypass.
    const readOnlySources = timelineInputs.length > 0
      && timelineInputs.every((input) => input.source !== 'local' && input.externalId !== null)
    await this.assertCalendarsForWrite(calendarIds, options.allowReadOnly === true || readOnlySources)

    const existingIds = new Set<string>()
    for (const chunk of chunks(timelineInputs.map((input) => input.id).filter((id): id is string => Boolean(id)), SQL_CHUNK)) {
      const { results } = await this.db.prepare(
        `SELECT id FROM calendar_events WHERE user_id = ? AND id IN (${placeholders(chunk.length)})`,
      ).bind(this.userId, ...chunk).all<{ id: string }>()
      for (const row of results ?? []) existingIds.add(row.id)
    }
    if (mode === 'create') {
      const duplicate = timelineInputs.find((input) => input.id !== undefined && existingIds.has(input.id))
      if (duplicate) throw ApiError.conflict('An event with that id already exists')
    }

    const externalMatch = new Map<string, string>()
    const externalKey = (input: Pick<TimelineEventWrite, 'source' | 'externalId' | 'calendarIds'>): string =>
      `${input.source}\u0000${input.calendarIds[0] ?? ''}\u0000${input.externalId ?? ''}`
    const externalKeys = [...new Set(timelineInputs
      .filter((input) => input.externalId !== null)
      .map((input) => externalKey(input)))]
    for (const chunk of chunks(externalKeys, EXTERNAL_MATCH_CHUNK)) {
      const triples = chunk.map((key) => key.split('\u0000') as [string, string, string])
      const clauses = triples.map(() => '(calendar_source = ? AND external_scope = ? AND external_id = ?)').join(' OR ')
      const { results } = await this.db.prepare(
        `SELECT id, calendar_source, external_scope, external_id FROM calendar_events
          WHERE user_id = ? AND (${clauses})`,
      ).bind(this.userId, ...triples.flat()).all<{
        id: string
        calendar_source: string
        external_scope: string
        external_id: string
      }>()
      for (const row of results ?? []) {
        externalMatch.set(
          `${row.calendar_source}\u0000${row.external_scope}\u0000${row.external_id}`,
          row.id,
        )
      }
    }

    const batchKey = newId()
    const now = Date.now()
    const resolved: Array<{ input: TimelineEventWrite; id: string }> = timelineInputs.map((input) => {
      const matched = input.externalId === null
        ? undefined
        : externalMatch.get(externalKey(input))
      return { input, id: input.id ?? matched ?? newId() }
    })
    if (mode === 'upsert') {
      // An upsert by id may come from a client that does not carry the remote identity at all.
      // Keep the stored source/external id rather than turning a remote event into a local one.
      const existingRows = await this.eventRowsByIds(resolved.map((entry) => entry.id))
      const existingById = new Map(existingRows.map((row) => [row.id, row]))
      for (const entry of resolved) {
        const row = existingById.get(entry.id)
        if (!row) continue
        entry.input = {
          ...entry.input,
          source: entry.input.source === 'local' && row.calendar_source !== 'local'
            ? (isCalendarSource(row.calendar_source) ? row.calendar_source : entry.input.source)
            : entry.input.source,
          externalId: entry.input.externalId ?? row.external_id,
        }
      }
    }

    const statements: D1PreparedStatement[][] = []
    for (const { input, id } of resolved) {
      const group: D1PreparedStatement[] = []
      const exists = existingIds.has(id) || externalMatch.get(externalKey(input)) === id
      if (exists && mode === 'upsert') {
        group.push(this.upsertEventStatement(input, id, now))
        group.push(this.db.prepare(
          `DELETE FROM calendar_event_calendars WHERE user_id = ?1 AND event_id = ?2`,
        ).bind(this.userId, id))
      } else {
        group.push(this.insertEventStatement(input, id, now, batchKey))
      }
      group.push(...this.membershipInsertStatements(id, input.calendarIds))
      statements.push(group)
    }

    try {
      // One event's statements stay together: a chunk boundary inside a membership rewrite would let
      // a later chunk fail after removing an existing event's rows.
      const chunksOfStatements: D1PreparedStatement[][] = []
      let current: D1PreparedStatement[] = []
      for (const group of statements) {
        if (current.length > 0 && current.length + group.length > MAX_BATCH_STATEMENTS) {
          chunksOfStatements.push(current)
          current = []
        }
        current.push(...group)
      }
      if (current.length > 0) chunksOfStatements.push(current)
      for (const chunk of chunksOfStatements) await this.db.batch(chunk)
    } catch (error) {
      // Best-effort cleanup: failing to remove the staging rows must not mask the write error that
      // sent us here, but it is worth a log line because a retry would collide with them.
      try {
        await this.db.batch([
          this.db.prepare(
            `DELETE FROM calendar_event_calendars
              WHERE user_id = ?1 AND event_id IN (
                SELECT id FROM calendar_events WHERE user_id = ?1 AND batch_key = ?2
              )`,
          ).bind(this.userId, batchKey),
          this.db.prepare(
            `DELETE FROM calendar_events WHERE user_id = ?1 AND batch_key = ?2`,
          ).bind(this.userId, batchKey),
        ])
      } catch (cleanupError) {
        console.error('[inkstone] Calendar batch cleanup failed:', cleanupError)
      }
      conflictFromWrite(error, 'An event with that id or external id already exists')
    }

    const rows = await this.eventRowsByIds(resolved.map((entry) => entry.id))
    const byId = new Map(rows.map((row) => [row.id, row]))
    const memberships = await this.membershipsFor(resolved.map((entry) => entry.id))
    return resolved.map(({ id }) => {
      const row = byId.get(id)
      if (!row) throw new Error('Event batch write did not persist')
      return toEventDto(row, memberships.get(id) ?? [])
    })
  }

  async updateEvent(id: string, patch: CalendarEventPatchInput): Promise<CalendarEventDto> {
    const row = await this.eventRow(id)
    if (!row) throw ApiError.notFound('Event not found')
    if (row.rev !== patch.rev) throw ApiError.conflict('The event changed elsewhere. Refresh and try again')
    await this.assertEventWritable(id)

    const start = patch.start ?? temporalFromRow(row.start_value, row.start_type, row.time_zone)
    const end = patch.end ?? temporalFromRow(row.end_value, row.end_type, row.time_zone)
    const needsZone = (patch.start !== undefined && patch.startMs === undefined)
      || (patch.end !== undefined && patch.endMs === undefined)
    const zone = needsZone ? (await this.preferences()).timeZone : null
    const startMs = patch.start
      ? patch.startMs ?? temporalValueToEpochMs(patch.start, patch.start.timeZone ?? zone ?? 'UTC')
      : row.start_ms
    const endMs = patch.end
      ? patch.endMs ?? temporalValueToEpochMs(
        patch.end,
        patch.end.timeZone ?? patch.start?.timeZone ?? zone ?? 'UTC',
      )
      : row.end_ms
    const allDay = patch.allDay ?? row.all_day === 1
    if (allDay !== (start.type === 'date' && end.type === 'date')) {
      throw ApiError.badRequest('All-day events must use date values for start and end')
    }
    if (endMs < startMs) throw ApiError.badRequest('An event cannot end before it starts')

    let meta = patch.meta ?? storedObject(row.meta_json)
    let recurrenceRule = row.recurrence_rule
    if (patch.recurrenceRule !== undefined) {
      recurrenceRule = patch.recurrenceRule
      meta = { ...meta }
      if (recurrenceRule) meta.recurrenceRule = recurrenceRule
      else delete meta.recurrenceRule
    } else if (patch.meta !== undefined) {
      const fromMeta = meta.recurrenceRule
      recurrenceRule = typeof fromMeta === 'string' ? fromMeta : null
    }

    const task = patch.task !== undefined
      ? patch.task
      : row.task_completed === null && row.task_completed_at_value === null && row.task_priority === null
        ? null
        : {
            completed: row.task_completed === 1,
            completedAt: readCompletedAt(row.task_completed_at_value),
            completedAtMs: row.task_completed_at ?? null,
            priority: asPriority(row.task_priority),
          } satisfies CalendarTaskWrite
    const conference = patch.conference !== undefined
      ? patch.conference
      : row.conference_json
        ? this.readConference(row.conference_json)
        : null
    const icon = patch.icon !== undefined ? patch.icon : readIcon(row.icon_json)
    const calendarIds = patch.calendarIds ?? (await this.membershipsFor([id])).get(id) ?? []
    if (patch.calendarIds) await this.assertCalendarsForWrite(patch.calendarIds, false)

    const merged: TimelineEventWrite = {
      id,
      title: patch.title ?? row.title,
      description: patch.description ?? row.description,
      kind: patch.kind ?? asKind(row.kind),
      task,
      conference,
      start,
      end,
      startMs,
      endMs,
      allDay,
      calendarIds,
      meta,
      icon,
      recurrenceRule,
      source: isCalendarSource(row.calendar_source) ? row.calendar_source : 'local',
      externalId: row.external_id,
    }
    const now = Date.now()
    const nextRev = patch.rev + 1
    const statements: D1PreparedStatement[] = [this.updateEventStatement(merged, patch.rev, now)]
    if (patch.calendarIds) {
      statements.push(this.db.prepare(
        `DELETE FROM calendar_event_calendars
          WHERE user_id = ?1 AND event_id = ?2
            AND EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ?1 AND id = ?2 AND rev = ?3)`,
      ).bind(this.userId, id, nextRev))
      statements.push(...this.membershipInsertStatements(id, patch.calendarIds, nextRev))
    }
    const outcomes = await this.db.batch(statements)
    if (!outcomes[0]?.meta.changes) {
      throw ApiError.conflict('The event changed elsewhere. Refresh and try again')
    }
    const event = await this.getEvent(id)
    if (!event) throw new Error('Event update did not persist')
    return event
  }

  async deleteEvent(id: string, rev: number): Promise<void> {
    const row = await this.eventRow(id)
    if (!row) throw ApiError.notFound('Event not found')
    if (row.rev !== rev) throw ApiError.conflict('The event changed elsewhere. Refresh and try again')
    await this.assertEventWritable(id)
    const outcomes = await this.db.batch([
      this.db.prepare(
        `DELETE FROM calendar_event_calendars
          WHERE user_id = ?1 AND event_id = ?2
            AND EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ?1 AND id = ?2 AND rev = ?3)`,
      ).bind(this.userId, id, rev),
      this.db.prepare(
        `DELETE FROM calendar_events WHERE user_id = ?1 AND id = ?2 AND rev = ?3`,
      ).bind(this.userId, id, rev),
    ])
    if (!outcomes[1]?.meta.changes) {
      throw ApiError.conflict('The event changed elsewhere. Refresh and try again')
    }
  }

  private readConference(raw: string): CalendarConferenceDto | null {
    const value = parseStoredJson(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as CalendarConferenceDto
  }

  /**
   * Title and description search across every calendar, newest first.
   *
   * The pattern is escaped (`\\`, `%`, `_`) before it becomes a LIKE, so a reader typing `%` asks for
   * a percent sign rather than for everything. `truncated` is answered by fetching one row past the
   * limit instead of counting the whole match set.
   */
  async searchEvents(q: string, limit: number): Promise<{ results: CalendarSearchResultDto[]; truncated: boolean }> {
    const max = Math.min(Math.max(1, limit), 50)
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
    const { results } = await this.db.prepare(
      `SELECT * FROM calendar_events
        WHERE user_id = ?1
          AND (title LIKE ?2 ESCAPE '\\' OR description LIKE ?2 ESCAPE '\\')
        ORDER BY start_ms DESC, id ASC
        LIMIT ?3`,
    ).bind(this.userId, pattern, max + 1).all<EventRow>()
    const rows = results ?? []
    const truncated = rows.length > max
    const page = rows.slice(0, max)
    const memberships = await this.membershipsFor(page.map((row) => row.id))
    const calendarIds = [...new Set([...memberships.values()].flatMap((ids) => ids.slice(0, 1)))]
    const calendars = new Map<string, { name: string; color: string }>()
    for (const chunk of chunks(calendarIds, SQL_CHUNK)) {
      const { results: found } = await this.db.prepare(
        `SELECT id, name, color FROM calendar_calendars
          WHERE user_id = ? AND id IN (${placeholders(chunk.length)})`,
      ).bind(this.userId, ...chunk).all<{ id: string; name: string; color: string }>()
      for (const row of found ?? []) calendars.set(row.id, { name: row.name, color: row.color })
    }
    const answers: CalendarSearchResultDto[] = []
    for (const row of page) {
      const ids = memberships.get(row.id) ?? []
      const calendar = ids.length > 0 ? calendars.get(ids[0]!) : undefined
      if (!calendar) continue
      answers.push({ event: toEventDto(row, ids), calendarName: calendar.name, calendarColor: calendar.color })
    }
    return { results: answers, truncated }
  }

  // ------------------------------------------------------------- preferences

  async preferences(): Promise<CalendarPreferences> {
    const row = await this.db.prepare(
      `SELECT preferences_json FROM calendar_preferences WHERE user_id = ?1`,
    ).bind(this.userId).first<{ preferences_json: string }>()
    return row ? normalizeCalendarPreferences(parseStoredJson(row.preferences_json)) : defaultCalendarPreferences()
  }

  async savePreferences(preferences: CalendarPreferences): Promise<CalendarPreferences> {
    const normalized = normalizeCalendarPreferences(preferences)
    await this.db.prepare(
      `INSERT INTO calendar_preferences (user_id, preferences_json, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = excluded.updated_at`,
    ).bind(this.userId, JSON.stringify(normalized), Date.now()).run()
    return normalized
  }

  // ------------------------------------------------------------- subscriptions and connections

  private async listSubscriptions(): Promise<CalendarSubscriptionDto[]> {
    const { results } = await this.db.prepare(
      `SELECT id, calendar_id, kind, url, enabled, last_sync_at, last_error_code, created_at, updated_at
         FROM calendar_subscriptions WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
    ).bind(this.userId).all<SubscriptionRow>()
    return (results ?? []).map((row) => ({
      id: row.id,
      calendarId: row.calendar_id,
      kind: row.kind === 'caldav' || row.kind === 'google' || row.kind === 'outlook' ? row.kind : 'ics',
      url: row.url,
      enabled: row.enabled === 1,
      lastSyncAt: row.last_sync_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  /** Connections as the meta read exposes them: identifiers and state, never credentials. */
  private async listConnections(): Promise<CalendarConnectionDto[]> {
    const { results } = await this.db.prepare(
      `SELECT id, kind, label, base_url, calendar_home_url, username, scope, writable, status,
              last_synced_at, last_error_code
         FROM calendar_connections WHERE user_id = ?1 ORDER BY created_at ASC, id ASC`,
    ).bind(this.userId).all<ConnectionRow>()
    return (results ?? []).map((row) => ({
      id: row.id,
      kind: row.kind === 'caldav' || row.kind === 'google' || row.kind === 'outlook' ? row.kind : 'caldav',
      label: row.label,
      baseUrl: row.base_url,
      calendarHomeUrl: row.calendar_home_url,
      username: row.username,
      scope: row.scope === 'write' ? 'write' : 'read',
      writable: row.writable === 1,
      status: row.status === 'error' || row.status === 'expired' || row.status === 'disconnected'
        ? row.status
        : 'connected',
      lastSyncedAt: row.last_synced_at,
      lastErrorCode: row.last_error_code,
    }))
  }

  // ------------------------------------------------------------- statements

  private eventWriteValues(input: TimelineEventWrite): unknown[] {
    return [
      input.title,
      input.description,
      input.kind,
      input.task ? (input.task.completed ? 1 : 0) : null,
      input.task?.completedAtMs ?? null,
      input.task?.completedAt ? JSON.stringify(input.task.completedAt) : null,
      input.task?.priority ?? null,
      input.conference ? JSON.stringify(input.conference) : null,
      input.start.value,
      input.start.type,
      input.start.timeZone ?? null,
      input.startMs,
      input.end.value,
      input.end.type,
      input.endMs,
      input.allDay ? 1 : 0,
      input.icon === null ? null : JSON.stringify(input.icon),
      JSON.stringify(input.meta),
      input.recurrenceRule,
      input.source,
      input.calendarIds[0] ?? '',
      input.externalId,
    ]
  }

  private insertEventStatement(
    input: TimelineEventWrite,
    id: string,
    now: number,
    batchKey: string | null,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO calendar_events (
         user_id, id, ${EVENT_WRITE_COLUMNS.join(', ')}, batch_key, created_at, updated_at, rev
       ) VALUES (?, ?, ${placeholders(EVENT_WRITE_COLUMNS.length)}, ?, ?, ?, 1)`,
    ).bind(this.userId, id, ...this.eventWriteValues(input), batchKey, now, now)
  }

  private upsertEventStatement(input: TimelineEventWrite, id: string, now: number): D1PreparedStatement {
    const updates = EVENT_WRITE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')
    return this.db.prepare(
      `INSERT INTO calendar_events (
         user_id, id, ${EVENT_WRITE_COLUMNS.join(', ')}, batch_key, created_at, updated_at, rev
       ) VALUES (?, ?, ${placeholders(EVENT_WRITE_COLUMNS.length)}, NULL, ?, ?, 1)
       ON CONFLICT(user_id, id) DO UPDATE SET
         ${updates}, updated_at = excluded.updated_at, rev = calendar_events.rev + 1`,
    ).bind(this.userId, id, ...this.eventWriteValues(input), now, now)
  }

  private updateEventStatement(input: TimelineEventWrite, rev: number, now: number): D1PreparedStatement {
    const assignments = EVENT_WRITE_COLUMNS.map((column) => `${column} = ?`).join(', ')
    return this.db.prepare(
      `UPDATE calendar_events SET ${assignments}, updated_at = ?, rev = rev + 1
        WHERE user_id = ? AND id = ? AND rev = ?`,
    ).bind(...this.eventWriteValues(input), now, this.userId, input.id!, rev)
  }

  private membershipInsertStatements(
    eventId: string,
    calendarIds: readonly string[],
    rev?: number,
  ): D1PreparedStatement[] {
    return calendarIds.map((calendarId, position) => rev === undefined
      ? this.db.prepare(
        `INSERT INTO calendar_event_calendars (user_id, event_id, calendar_id, position)
         VALUES (?, ?, ?, ?)`,
      ).bind(this.userId, eventId, calendarId, position)
      : this.db.prepare(
        `INSERT INTO calendar_event_calendars (user_id, event_id, calendar_id, position)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM calendar_events WHERE user_id = ? AND id = ? AND rev = ?)`,
      ).bind(this.userId, eventId, calendarId, position, this.userId, eventId, rev))
  }
}
