import type { ProjectCalendarLink, ProjectCard } from '@shared/project/model'
import type { CalendarEventDto, TemporalValue } from '@shared/calendar/model'
import { temporalValueToEpochMs, toTemporalValue } from '@shared/calendar/model'
import { parseProjectDateValue, projectInputToStamp, projectStampToDay } from '@shared/project/date'
import { Temporal } from 'temporal-polyfill'
import { ApiError } from '../lib/errors'
import { CalendarStore } from '../calendar/store'
import { getProjectCard, patchProjectCard } from './cards'
import { readBoardProperties } from './boards'
import { ProjectStore } from './store'
import { newProjectId } from '@shared/project/limits'

interface CalendarLinkRow {
  id: string
  card_id: string
  user_id: string
  calendar_id: string
  event_id: string
  property_id: string
  event_title: string
  event_start: number
  event_end: number
  all_day: number
}

function rowToLink(row: CalendarLinkRow): ProjectCalendarLink {
  return {
    id: row.id,
    cardId: row.card_id,
    calendarId: row.calendar_id,
    eventId: row.event_id,
    propertyId: row.property_id,
    eventTitle: row.event_title,
    eventStart: row.event_start,
    eventEnd: row.event_end,
    allDay: row.all_day !== 0,
  }
}

const LINK_SELECT = `SELECT l.id, l.card_id, l.user_id, l.calendar_id, l.event_id, l.property_id,
  e.title AS event_title, e.start_ms AS event_start, e.end_ms AS event_end, e.all_day
  FROM project_calendar_links l
  JOIN calendar_events e ON e.user_id = l.user_id AND e.id = l.event_id`

export async function listProjectCalendarLinks(db: D1Database, userId: string, cardId: string): Promise<ProjectCalendarLink[]> {
  const { results } = await db.prepare(`${LINK_SELECT} WHERE l.user_id = ?1 AND l.card_id = ?2 ORDER BY l.created_at, l.id`)
    .bind(userId, cardId).all<CalendarLinkRow>()
  return results.map(rowToLink)
}

export async function linkProjectCalendar(
  db: D1Database,
  userId: string,
  card: ProjectCard,
  input: { calendarId: string, eventId: string, propertyId: string },
  now: number,
): Promise<ProjectCalendarLink> {
  const properties = await readBoardProperties(db, card.boardId)
  if (!properties.some((property) => property.id === input.propertyId && property.type === 'date')) {
    throw ApiError.badRequest('A date property is required')
  }
  const event = await new CalendarStore(db, userId).getEvent(input.eventId)
  if (!event || !event.calendarIds.includes(input.calendarId)) throw ApiError.notFound('Calendar event not found')
  const id = newProjectId('activity')
  await db.prepare(
    `INSERT INTO project_calendar_links (id, card_id, user_id, calendar_id, event_id, property_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  ).bind(id, card.id, userId, input.calendarId, input.eventId, input.propertyId, now).run()
  await syncProjectCalendarLinksForCard(db, card, card, userId, now)
  const { results } = await db.prepare(`${LINK_SELECT} WHERE l.id = ?1`).bind(id).all<CalendarLinkRow>()
  return rowToLink(results[0]!)
}

export async function unlinkProjectCalendar(db: D1Database, userId: string, cardId: string, linkId: string): Promise<void> {
  await db.prepare('DELETE FROM project_calendar_links WHERE id = ?1 AND user_id = ?2 AND card_id = ?3')
    .bind(linkId, userId, cardId).run()
}

function projectDateToEvent(value: string | undefined): { start: TemporalValue, end: TemporalValue, allDay: boolean } | null {
  if (!value) return null
  const parsed = parseProjectDateValue(value)
  if (parsed?.from === undefined) return null
  const includeTime = parsed.includeTime === true
  const timeZone = parsed.timeZone ?? 'UTC'
  if (includeTime) {
    const start = Temporal.Instant.fromEpochMilliseconds(parsed.from).toZonedDateTimeISO(timeZone)
    const end = Temporal.Instant.fromEpochMilliseconds(parsed.to ?? parsed.from + 30 * 60_000).toZonedDateTimeISO(timeZone)
    return { start: toTemporalValue(start), end: toTemporalValue(end), allDay: false }
  }
  const day = projectStampToDay(parsed.from, false, timeZone)
  const start = Temporal.PlainDate.from({ year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() })
  const last = projectStampToDay(parsed.to ?? parsed.from, false, timeZone)
  const end = Temporal.PlainDate.from({ year: last.getFullYear(), month: last.getMonth() + 1, day: last.getDate() }).add({ days: 1 })
  return { start: toTemporalValue(start), end: toTemporalValue(end), allDay: true }
}

function eventToProjectDate(event: CalendarEventDto): string {
  const timeZone = event.start.timeZone ?? 'UTC'
  if (event.allDay) {
    const start = Temporal.PlainDate.from(event.start.value)
    const end = Temporal.PlainDate.from(event.end.value)
    const last = end.subtract({ days: 1 })
    return JSON.stringify({
      from: projectInputToStamp(start.toString(), false, timeZone),
      to: projectInputToStamp(last.toString(), false, timeZone),
      includeTime: false,
      timeZone,
    })
  }
  const from = temporalValueToEpochMs(event.start, timeZone)
  const end = temporalValueToEpochMs(event.end, timeZone)
  return JSON.stringify({ from, to: end, includeTime: true, timeZone })
}

export async function syncProjectCalendarLinksForCard(
  db: D1Database,
  before: ProjectCard,
  after: ProjectCard,
  userId: string,
  now: number,
): Promise<void> {
  const { results } = await db.prepare('SELECT * FROM project_calendar_links WHERE card_id = ?1 AND user_id = ?2')
    .bind(after.id, userId).all<{
      id: string; event_id: string; property_id: string
    }>()
  for (const link of results) {
    try {
      const store = new CalendarStore(db, userId)
      const event = await store.getEvent(link.event_id)
      if (!event) {
        await db.prepare('DELETE FROM project_calendar_links WHERE id = ?1').bind(link.id).run()
        continue
      }
      const next = projectDateToEvent(after.values[link.property_id])
      if (!next) {
        await store.deleteEvent(event.id, event.rev)
        await db.prepare('DELETE FROM project_calendar_links WHERE id = ?1').bind(link.id).run()
        continue
      }
      const dateChanged = before.values[link.property_id] !== after.values[link.property_id]
      const titleChanged = before.title !== after.title
      if (!dateChanged && !titleChanged) continue
      await store.updateEvent(event.id, {
        rev: event.rev,
        ...(titleChanged ? { title: after.title } : {}),
        ...(dateChanged ? next : {}),
      })
      await db.prepare('UPDATE project_calendar_links SET updated_at = ?1 WHERE id = ?2').bind(now, link.id).run()
    } catch (error) {
      console.warn('[inkstone] project calendar link sync failed:', link.id, error instanceof Error ? error.message : error)
    }
  }
}

export async function syncProjectCardForCalendarEvent(
  db: D1Database,
  userId: string,
  eventId: string,
  deleted = false,
): Promise<void> {
  const { results } = await db.prepare('SELECT * FROM project_calendar_links WHERE user_id = ?1 AND event_id = ?2')
    .bind(userId, eventId).all<{ id: string; card_id: string; property_id: string }>()
  if (results.length === 0) return
  const event = deleted ? null : await new CalendarStore(db, userId).getEvent(eventId)
  for (const link of results) {
    const card = await getProjectCard(db, link.card_id)
    if (!card || card.deleteAt !== 0) {
      await db.prepare('DELETE FROM project_calendar_links WHERE id = ?1').bind(link.id).run()
      continue
    }
    const board = (await new ProjectStore(db, userId).boards()).find((entry) => entry.id === card.boardId)
    if (!board || board.role !== 'admin' && board.role !== 'editor') continue
    const value = event ? eventToProjectDate(event) : null
    if ((card.values[link.property_id] ?? null) === value) continue
    await patchProjectCard(db, card, { values: { [link.property_id]: value } }, userId, Date.now())
  }
}
