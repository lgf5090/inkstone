import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type {
  CalendarContactDto,
  CalendarDto,
  CalendarEventDto,
  CalendarGroupDto,
  CalendarMemberDto,
  CalendarPreferences,
  CalendarResourceDto,
} from '@shared/calendar/model'
import {
  MAX_CALENDARS,
  MAX_EVENTS_PER_BATCH,
  MAX_GROUPS,
  MAX_REMINDER_MINUTES,
  isCalendarAttendeeStatus,
  isCalendarEntityId,
  isCalendarSource,
} from '@shared/calendar/model'
import type { CalendarCountdownDto } from '@shared/calendar/countdown'
import { ApiError } from '../lib/errors'
import { Temporal } from 'temporal-polyfill'
import { parseCalendarInput, parseCountdownInput, parseEventInput, parseGroupInput, parsePreferences } from './validation'
import { CalendarStore, type CalendarEventWriteInput } from './store'
import { MAX_CONTACTS } from './contacts'
import { listMembers } from './members'
import { listContacts } from './contacts'
import { listTemplateRows, type TemplateRow } from './templates'
import { CountdownStore } from './countdowns'
import { listResources } from './resources'
import { listSchedulingLinks, type SchedulingLinkRow } from './scheduling'

export const CALENDAR_BACKUP_VERSION = 1 as const

interface ReminderBackupRow {
  event_id: string
  minutes: number
  created_at: number
}

interface AttendeeBackupRow {
  event_id: string
  email: string
  name: string
  status: string
  created_at: number
}

interface AttachmentBackupRow {
  attachment_id: string
  event_id: string
  created_at: number
}

interface CalendarBackupDocument {
  version: typeof CALENDAR_BACKUP_VERSION
  exportedAt: string
  calendars: CalendarDto[]
  groups: CalendarGroupDto[]
  events: CalendarEventDto[]
  preferences: CalendarPreferences
  reminders: ReminderBackupRow[]
  attendees: AttendeeBackupRow[]
  attachments: AttachmentBackupRow[]
  members: CalendarMemberDto[]
  contacts: CalendarContactDto[]
  templates: TemplateRow[]
  countdowns: CalendarCountdownDto[]
  resources: CalendarResourceDto[]
  schedulingLinks: SchedulingLinkRow[]
}

export interface CalendarBackupSummary {
  calendars: number
  groups: number
  events: number
}

const MAX_BACKUP_REMINDERS = 400_000
const MAX_BACKUP_ATTENDEES = 250_000
const MAX_BACKUP_ATTACHMENTS = 50_000
const MAX_BACKUP_MEMBERS = 10_000
const MAX_BACKUP_TEMPLATES = 100
const MAX_BACKUP_RESOURCES = 100
const MAX_BACKUP_SCHEDULING_LINKS = 20
const MAX_BACKUP_COUNTDOWNS = 500
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function records(value: unknown, max: number, field: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max || value.some(entry => !isRecord(entry))) {
    throw ApiError.badRequest(`The calendar backup has an invalid ${field} list`)
  }
  return value as Record<string, unknown>[]
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max) throw ApiError.badRequest(`The calendar backup has an invalid ${field}`)
  return value
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isCalendarEntityId(value)) throw ApiError.badRequest(`The calendar backup has an invalid ${field}`)
  return value
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`The calendar backup has an invalid ${field}`)
  }
  return value
}

function timestamp(value: unknown, field: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, field)
}

async function runStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80))
}

function parseJson(value: unknown, field: string): unknown {
  try {
    return JSON.parse(text(value, 16 * 1024, field))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest(`The calendar backup has invalid ${field}`)
  }
}

export async function readBackupCalendar(
  db: D1Database,
  userId: string,
): Promise<string | null> {
  const store = new CalendarStore(db, userId)
  const [calendars, groups, events, preferences, reminders, attendees, attachments, members, contacts, templates, countdowns, resources, schedulingLinks] = await Promise.all([
    store.listCalendars(),
    store.listGroups(),
    store.listAllEvents(),
    store.preferences(),
    db.prepare('SELECT event_id, minutes, created_at FROM calendar_event_reminders WHERE user_id = ?').bind(userId).all<ReminderBackupRow>(),
    db.prepare('SELECT event_id, email, name, status, created_at FROM calendar_event_attendees WHERE user_id = ?').bind(userId).all<AttendeeBackupRow>(),
    db.prepare('SELECT attachment_id, event_id, created_at FROM calendar_event_attachments WHERE user_id = ?').bind(userId).all<AttachmentBackupRow>(),
    listMembers(db, userId),
    listContacts(db, userId),
    listTemplateRows(db, userId),
    new CountdownStore(db, userId).list(),
    listResources(db, userId),
    listSchedulingLinks(db, userId),
  ])
  const hasAuxiliary = reminders.results?.length || attendees.results?.length || attachments.results?.length
    || members.length || contacts.length || templates.length || countdowns.length || resources.length || schedulingLinks.length
  if (calendars.length === 0 && events.length === 0 && !hasAuxiliary) return null
  const document: CalendarBackupDocument = {
    version: CALENDAR_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    calendars,
    groups,
    events,
    preferences,
    reminders: reminders.results ?? [],
    attendees: attendees.results ?? [],
    attachments: attachments.results ?? [],
    members,
    contacts,
    templates,
    countdowns,
    resources,
    schedulingLinks,
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
  if (raw.events.length > 50_000) throw ApiError.badRequest('The calendar backup names too many events')

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

  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  for (const group of groups) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(userId, group.id, group.name, group.position, now))
  }
  if (calendars.some((calendar) => calendar.input.isDefault === true)) {
    statements.push(db.prepare('UPDATE calendar_calendars SET is_default = 0 WHERE user_id = ?1 AND is_default = 1').bind(userId))
  }
  const calendarIds = new Set(calendars.map((calendar) => calendar.id))
  for (const calendar of calendars) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO calendar_calendars (
         user_id, id, name, color, dark_color, icon, group_id, is_default, is_visible,
         read_only, source, subscription_id, position, created_at, updated_at, rev
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?13, ?14)`,
    ).bind(
      userId, calendar.id, calendar.input.name, calendar.color, calendar.darkColor,
      calendar.input.icon ?? null, calendar.input.groupId ?? null,
      calendar.input.isDefault === true ? 1 : 0, calendar.input.isVisible === false ? 0 : 1,
      calendar.input.readOnly === true ? 1 : 0, calendar.source, calendar.position, now, calendar.rev,
    ))
  }
  await db.batch(statements)

  const preferences = parsePreferences(raw.preferences ?? {})
  const store = new CalendarStore(db, userId)
  await store.savePreferences(preferences)

  const inputs: CalendarEventWriteInput[] = raw.events.map((value) => {
    if (!isRecord(value) || !isCalendarEntityId(value.id)) throw ApiError.badRequest('The calendar backup has an invalid event')
    const ids = Array.isArray(value.calendarIds)
      ? value.calendarIds.filter((calendarId): calendarId is string => typeof calendarId === 'string' && calendarIds.has(calendarId))
      : []
    if (ids.length === 0) throw ApiError.badRequest('A backed-up event names no calendar in this backup')
    return parseEventInput({ ...value, rev: undefined, calendarIds: ids }, { defaultTimeZone: preferences.timeZone, allowSourceIdentity: true })
  })
  for (let index = 0; index < inputs.length; index += MAX_EVENTS_PER_BATCH) {
    await store.createEvents(inputs.slice(index, index + MAX_EVENTS_PER_BATCH), 'upsert', { allowReadOnly: true })
  }
  await restoreEventExtras(db, userId, raw, new Set(inputs.map(input => input.id!)))
  await restoreCalendarExtras(db, userId, raw, calendarIds)
  return { calendars: calendars.length, groups: groups.length, events: inputs.length }
}

async function restoreEventExtras(
  db: D1Database,
  userId: string,
  raw: Record<string, unknown>,
  eventIds: Set<string>,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const row of records(raw.reminders, MAX_BACKUP_REMINDERS, 'reminders')) {
    const eventId = id(row.event_id, 'reminder event')
    if (!eventIds.has(eventId)) continue
    statements.push(db.prepare(
      `INSERT INTO calendar_event_reminders (user_id, event_id, minutes, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, event_id, minutes) DO UPDATE SET created_at = excluded.created_at`,
    ).bind(userId, eventId, integer(row.minutes, 0, MAX_REMINDER_MINUTES, 'reminder minutes'), timestamp(row.created_at, 'reminder timestamp')))
  }
  for (const row of records(raw.attendees, MAX_BACKUP_ATTENDEES, 'attendees')) {
    const eventId = id(row.event_id, 'attendee event')
    if (!eventIds.has(eventId)) continue
    const email = text(row.email, 254, 'attendee email').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) throw ApiError.badRequest('The calendar backup has an invalid attendee email')
    if (typeof row.status !== 'string' || !isCalendarAttendeeStatus(row.status)) throw ApiError.badRequest('The calendar backup has an invalid attendee status')
    statements.push(db.prepare(
      `INSERT INTO calendar_event_attendees (user_id, event_id, email, name, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(user_id, event_id, email) DO UPDATE SET name = excluded.name, status = excluded.status, created_at = excluded.created_at`,
    ).bind(userId, eventId, email, text(row.name, 120, 'attendee name'), row.status, timestamp(row.created_at, 'attendee timestamp')))
  }
  for (const row of records(raw.attachments, MAX_BACKUP_ATTACHMENTS, 'attachments')) {
    const eventId = id(row.event_id, 'attachment event')
    if (!eventIds.has(eventId)) continue
    statements.push(db.prepare(
      'INSERT OR IGNORE INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(userId, id(row.attachment_id, 'attachment id'), eventId, timestamp(row.created_at, 'attachment timestamp')))
  }
  await runStatements(db, statements)
}

async function restoreCalendarExtras(
  db: D1Database,
  userId: string,
  raw: Record<string, unknown>,
  calendarIds: Set<string>,
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const row of records(raw.members, MAX_BACKUP_MEMBERS, 'members')) {
    const calendarId = id(row.calendarId, 'member calendar')
    if (!calendarIds.has(calendarId)) continue
    if (row.role !== 'reader' && row.role !== 'writer') throw ApiError.badRequest('The calendar backup has an invalid member role')
    if (row.status !== 'pending' && row.status !== 'accepted' && row.status !== 'declined') throw ApiError.badRequest('The calendar backup has an invalid member status')
    statements.push(db.prepare(
      `INSERT INTO calendar_members (owner_user_id, calendar_id, member_user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(owner_user_id, calendar_id, member_user_id) DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at`,
    ).bind(userId, calendarId, id(row.memberId, 'member id'), row.role, row.status, timestamp(row.createdAt, 'member timestamp'), timestamp(row.updatedAt ?? row.createdAt, 'member update timestamp')))
  }
  for (const row of records(raw.contacts, MAX_CONTACTS, 'contacts')) {
    const email = text(row.email, 254, 'contact email').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) throw ApiError.badRequest('The calendar backup has an invalid contact email')
    const birthday = row.birthday === null || row.birthday === undefined ? null : text(row.birthday, 10, 'contact birthday')
    if (birthday !== null) {
      if (!DATE_RE.test(birthday)) throw ApiError.badRequest('The calendar backup has an invalid contact birthday')
      try {
        Temporal.PlainDate.from(birthday)
      } catch {
        throw ApiError.badRequest('The calendar backup has an invalid contact birthday')
      }
    }
    statements.push(db.prepare(
      `INSERT INTO calendar_contacts (user_id, id, name, email, birthday, created_at, updated_at, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
       ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, email = excluded.email, birthday = excluded.birthday, updated_at = excluded.updated_at, rev = excluded.rev`,
    ).bind(userId, id(row.id, 'contact id'), text(row.name, 120, 'contact name'), email, birthday, Date.now(), integer(row.rev, 1, Number.MAX_SAFE_INTEGER, 'contact revision')))
  }
  for (const row of records(raw.templates, MAX_BACKUP_TEMPLATES, 'templates')) {
    if (row.kind !== 'event' && row.kind !== 'task') throw ApiError.badRequest('The calendar backup has an invalid template kind')
    let metaJson = '{}'
    if (row.meta_json !== undefined) {
      const parsed = parseJson(row.meta_json, 'template meta')
      if (!isRecord(parsed)) throw ApiError.badRequest('The calendar backup has invalid template meta')
      metaJson = JSON.stringify(parsed)
    }
    const color = row.color === null || row.color === undefined ? null : text(row.color, 7, 'template color')
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw ApiError.badRequest('The calendar backup has an invalid template color')
    statements.push(db.prepare(
      `INSERT INTO calendar_event_templates
         (user_id, id, name, title, description, kind, all_day, duration_minutes, color, meta_json, created_at, updated_at, rev)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)
       ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, title = excluded.title, description = excluded.description,
         kind = excluded.kind, all_day = excluded.all_day, duration_minutes = excluded.duration_minutes,
         color = excluded.color, meta_json = excluded.meta_json, updated_at = excluded.updated_at, rev = excluded.rev`,
    ).bind(
      userId, id(row.id, 'template id'), text(row.name, 80, 'template name'), text(row.title, 300, 'template title'),
      text(row.description, 20_000, 'template description'), row.kind, row.all_day === 1 || row.all_day === true ? 1 : 0,
      integer(row.duration_minutes, 0, 1440, 'template duration'), color, metaJson, Date.now(),
      integer(row.rev, 1, Number.MAX_SAFE_INTEGER, 'template revision'),
    ))
  }
  for (const row of records(raw.countdowns, MAX_BACKUP_COUNTDOWNS, 'countdowns')) {
    const input = parseCountdownInput(row)
    const repeat = input.repeat
    const lunarMonth = repeat === 'lunar' ? integer(row.lunarMonth, 1, 12, 'lunar month') : null
    const lunarDay = repeat === 'lunar' ? integer(row.lunarDay, 1, 30, 'lunar day') : null
    const lunarLeap = repeat === 'lunar' && row.lunarLeap === true ? 1 : 0
    statements.push(db.prepare(
      `INSERT INTO calendar_countdowns
         (user_id, id, title, target_date, repeat_mode, lunar_month, lunar_day, lunar_leap, note, color, pinned, created_at, updated_at, rev)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)
       ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, target_date = excluded.target_date,
         repeat_mode = excluded.repeat_mode, lunar_month = excluded.lunar_month, lunar_day = excluded.lunar_day,
         lunar_leap = excluded.lunar_leap, note = excluded.note, color = excluded.color, pinned = excluded.pinned,
         updated_at = excluded.updated_at, rev = excluded.rev`,
    ).bind(
      userId, id(row.id, 'countdown id'), input.title, input.date, repeat, lunarMonth, lunarDay, lunarLeap,
      input.note, input.color, input.pinned ? 1 : 0, Date.now(), integer(row.rev, 1, Number.MAX_SAFE_INTEGER, 'countdown revision'),
    ))
  }
  for (const row of records(raw.resources, MAX_BACKUP_RESOURCES, 'resources')) {
    const calendarId = id(row.calendarId, 'resource calendar')
    if (!calendarIds.has(calendarId)) continue
    const capacity = row.capacity === null || row.capacity === undefined ? null : integer(row.capacity, 1, 10_000, 'resource capacity')
    statements.push(db.prepare(
      `INSERT INTO calendar_resources (user_id, id, calendar_id, name, capacity, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(user_id, id) DO UPDATE SET calendar_id = excluded.calendar_id, name = excluded.name, capacity = excluded.capacity, updated_at = excluded.updated_at`,
    ).bind(userId, id(row.id, 'resource id'), calendarId, text(row.name, 100, 'resource name'), capacity, Date.now()))
  }
  for (const row of records(raw.schedulingLinks, MAX_BACKUP_SCHEDULING_LINKS, 'scheduling links')) {
    const calendarId = id(row.calendar_id, 'scheduling calendar')
    if (!calendarIds.has(calendarId)) continue
    const slug = text(row.slug, 80, 'scheduling slug')
    if (!/^[a-z0-9-]{8,80}$/i.test(slug)) throw ApiError.badRequest('The calendar backup has an invalid scheduling slug')
    const linkId = id(row.id, 'scheduling id')
    const existing = await db.prepare('SELECT slug FROM calendar_scheduling_links WHERE user_id = ?1 AND id = ?2')
      .bind(userId, linkId).first<{ slug: string }>()
    let restoreSlug = existing?.slug ?? slug
    if (!existing && await db.prepare('SELECT 1 AS present FROM calendar_scheduling_links WHERE slug = ?1')
      .bind(restoreSlug).first<{ present: number }>()) {
      restoreSlug = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
    }
    const days = parseJson(row.days_json, 'scheduling days')
    if (!Array.isArray(days) || days.length === 0 || days.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)) {
      throw ApiError.badRequest('The calendar backup has invalid scheduling days')
    }
    statements.push(db.prepare(
      `INSERT INTO calendar_scheduling_links
         (user_id, id, calendar_id, slug, title, duration_minutes, days_json, start_hour, end_hour, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
       ON CONFLICT(user_id, id) DO UPDATE SET calendar_id = excluded.calendar_id, slug = excluded.slug,
         title = excluded.title, duration_minutes = excluded.duration_minutes, days_json = excluded.days_json,
         start_hour = excluded.start_hour, end_hour = excluded.end_hour, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).bind(
      userId, linkId, calendarId, restoreSlug, text(row.title, 160, 'scheduling title'),
      integer(row.duration_minutes, 5, 480, 'scheduling duration'), JSON.stringify(days),
      integer(row.start_hour, 0, 23, 'scheduling start'), integer(row.end_hour, 1, 24, 'scheduling end'),
      row.enabled === 1 || row.enabled === true ? 1 : 0, Date.now(),
    ))
  }
  await runStatements(db, statements)
}
