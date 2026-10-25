import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type {
  CalendarDto,
  CalendarEventDto,
  CalendarGroupDto,
  CalendarPreferences,
} from '@shared/calendar/model'
import {
  MAX_CALENDARS,
  MAX_EVENTS_PER_BATCH,
  MAX_GROUPS,
  isCalendarEntityId,
  isCalendarSource,
} from '@shared/calendar/model'
import { ApiError } from '../lib/errors'
import { parseCalendarInput, parseEventInput, parseGroupInput, parsePreferences } from './validation'
import { CalendarStore, type CalendarEventWriteInput } from './store'

export const CALENDAR_BACKUP_VERSION = 1 as const

interface CalendarBackupDocument {
  version: typeof CALENDAR_BACKUP_VERSION
  exportedAt: string
  calendars: CalendarDto[]
  groups: CalendarGroupDto[]
  events: CalendarEventDto[]
  preferences: CalendarPreferences
}

export interface CalendarBackupSummary {
  calendars: number
  groups: number
  events: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function readBackupCalendar(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const store = new CalendarStore(db, userId)
  const [calendars, groups, events, preferences] = await Promise.all([
    store.listCalendars(),
    store.listGroups(),
    store.listAllEvents(),
    store.preferences(),
  ])
  if (calendars.length === 0 && events.length === 0) return null
  const document: CalendarBackupDocument = {
    version: CALENDAR_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    calendars,
    groups,
    events,
    preferences,
  }
  return JSON.stringify(document)
}

export async function applyBackupCalendar(
  db: D1Database,
  userId: string,
  text: string,
): Promise<CalendarBackupSummary> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw ApiError.badRequest('The calendar backup is not valid JSON')
  }
  if (!isRecord(raw) || raw.version !== CALENDAR_BACKUP_VERSION
    || !Array.isArray(raw.calendars) || !Array.isArray(raw.groups) || !Array.isArray(raw.events)) {
    throw ApiError.badRequest('The calendar backup has an unsupported shape')
  }
  if (raw.calendars.length > MAX_CALENDARS || raw.groups.length > MAX_GROUPS) {
    throw ApiError.badRequest('The calendar backup names too many calendars or groups')
  }
  if (raw.events.length > 50_000) {
    throw ApiError.badRequest('The calendar backup names too many events')
  }

  const groups = raw.groups.map((value) => {
    if (!isRecord(value) || !isCalendarEntityId(value.id)) throw ApiError.badRequest('The calendar backup has an invalid group')
    const input = parseGroupInput(value)
    return { id: value.id, name: input.name, position: typeof value.position === 'number' ? value.position : 0 }
  })
  const groupIds = new Set(groups.map((group) => group.id))

  const calendars = raw.calendars.map((value) => {
    if (!isRecord(value) || !isCalendarEntityId(value.id)) throw ApiError.badRequest('The calendar backup has an invalid calendar')
    const input = parseCalendarInput({
      ...value,
      ...(typeof value.groupId === 'string' && !groupIds.has(value.groupId) ? { groupId: null } : {}),
    })
    return {
      id: value.id,
      input,
      color: input.color ?? '#3b82f6',
      darkColor: input.darkColor ?? input.color ?? '#3b82f6',
      position: typeof value.position === 'number' ? value.position : 0,
      source: isCalendarSource(value.source) ? value.source : 'local',
      rev: typeof value.rev === 'number' && value.rev > 0 ? value.rev : 1,
    }
  })
  if (calendars.length === 0 && groups.length === 0 && raw.events.length === 0) {
    return { calendars: 0, groups: 0, events: 0 }
  }
  if (calendars.length > MAX_CALENDARS) throw ApiError.badRequest('The calendar backup names too many calendars')

  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  for (const group of groups) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(userId, group.id, group.name, group.position, now))
  }
  if (calendars.some((calendar) => calendar.input.isDefault === true)) {
    statements.push(db.prepare(
      `UPDATE calendar_calendars SET is_default = 0 WHERE user_id = ?1 AND is_default = 1`,
    ).bind(userId))
  }
  const calendarIds = new Set(calendars.map((calendar) => calendar.id))
  for (const calendar of calendars) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO calendar_calendars (
         user_id, id, name, color, dark_color, icon, group_id, is_default, is_visible,
         read_only, source, subscription_id, position, created_at, updated_at, rev
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?13, ?14)`,
    ).bind(
      userId,
      calendar.id,
      calendar.input.name,
      calendar.color,
      calendar.darkColor,
      calendar.input.icon ?? null,
      calendar.input.groupId ?? null,
      calendar.input.isDefault === true ? 1 : 0,
      calendar.input.isVisible === false ? 0 : 1,
      calendar.input.readOnly === true ? 1 : 0,
      calendar.source,
      calendar.position,
      now,
      calendar.rev,
    ))
  }
  await db.batch(statements)

  const preferences = parsePreferences(raw.preferences ?? {})
  const store = new CalendarStore(db, userId)
  await store.savePreferences(preferences)

  const inputs: CalendarEventWriteInput[] = raw.events.map((value) => {
    if (!isRecord(value) || !isCalendarEntityId(value.id)) throw ApiError.badRequest('The calendar backup has an invalid event')
    const ids = Array.isArray(value.calendarIds)
      ? value.calendarIds.filter((id): id is string => typeof id === 'string' && calendarIds.has(id))
      : []
    if (ids.length === 0) throw ApiError.badRequest('A backed-up event names no calendar in this backup')
    return parseEventInput({ ...value, calendarIds: ids }, { defaultTimeZone: preferences.timeZone })
  })
  for (let index = 0; index < inputs.length; index += MAX_EVENTS_PER_BATCH) {
    await store.createEvents(inputs.slice(index, index + MAX_EVENTS_PER_BATCH), 'upsert', { allowReadOnly: true })
  }
  return { calendars: calendars.length, groups: groups.length, events: inputs.length }
}
