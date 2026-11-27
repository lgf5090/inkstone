import type { Context } from 'hono'
import {
  isSharedCalendarId,
  parseSharedCalendarId,
  sharedCalendarId,
  type CalendarEventDto,
} from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { CalendarStore, type CalendarEventWriteInput } from './store'
import { parseEntityId } from './validation'

type Ctx = Context<AppBindings>

export interface SharedWriterTarget {
  ownerId: string
  store: CalendarStore
  calendarIds: string[]
}

export interface SharedEventTarget {
  ownerId: string
  store: CalendarStore
  eventId: string
  event: CalendarEventDto
}

export function calendarPathId(c: Ctx): string {
  const value = c.req.param('id') ?? ''
  if (isSharedCalendarId(value)) {
    if (!parseSharedCalendarId(value)) throw ApiError.badRequest('id is not a valid id')
    return value
  }
  return parseEntityId(value, 'id')
}

export async function sharedWriterIds(c: Ctx, ids: readonly string[]): Promise<SharedWriterTarget> {
  const parsed = ids.map(id => parseSharedCalendarId(id))
  if (parsed.some(entry => entry === null)) {
    throw ApiError.badRequest('A shared write cannot mix shared and owned calendars')
  }
  const owners = new Set(parsed.map(entry => entry!.ownerId))
  if (owners.size !== 1) throw ApiError.badRequest('A shared write must name one owner')
  const ownerId = [...owners][0]!
  const raw = parsed.map(entry => entry!.calendarId)
  const writable = await new CalendarStore(c.env.DB, c.get('userId')).sharedWriterCalendarIds(ownerId, raw)
  if (raw.some(calendarId => !writable.has(calendarId))) {
    throw ApiError.forbidden('The shared calendar is read-only for this account')
  }
  return { ownerId, store: new CalendarStore(c.env.DB, ownerId), calendarIds: raw }
}

export function sharedEventDto(ownerId: string, event: CalendarEventDto): CalendarEventDto {
  return {
    ...event,
    id: sharedCalendarId(ownerId, event.id),
    calendarId: sharedCalendarId(ownerId, event.calendarId),
    calendarIds: event.calendarIds.map(calendarId => sharedCalendarId(ownerId, calendarId)),
  }
}

export async function prepareSharedWrite(
  c: Ctx,
  body: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; target: SharedWriterTarget | null }> {
  const named = Array.isArray(body.calendarIds)
    ? body.calendarIds.filter((id): id is string => typeof id === 'string')
    : typeof body.calendarId === 'string' ? [body.calendarId] : []
  if (!named.some(isSharedCalendarId)) return { body, target: null }
  if (named.some(id => !isSharedCalendarId(id))) {
    throw ApiError.badRequest('A shared write cannot mix shared and owned calendars')
  }
  const target = await sharedWriterIds(c, named)
  const next = { ...body }
  if (Array.isArray(body.calendarIds)) next.calendarIds = target.calendarIds
  if (typeof body.calendarId === 'string') next.calendarId = target.calendarIds[0]
  return { body: next, target }
}

export async function sharedEventTarget(c: Ctx, id: string): Promise<SharedEventTarget | null> {
  if (!parseSharedCalendarId(id)) return null
  const visible = await new CalendarStore(c.env.DB, c.get('userId')).sharedEvent(id)
  if (!visible) return null
  const store = new CalendarStore(c.env.DB, visible.ownerId)
  const event = await store.getEvent(visible.eventId)
  if (!event) return null
  await sharedWriterIds(c, event.calendarIds.map(calendarId => sharedCalendarId(visible.ownerId, calendarId)))
  return { ownerId: visible.ownerId, store, eventId: event.id, event }
}

export async function assertSharedBatchUpsertWritable(
  c: Ctx,
  target: SharedWriterTarget,
  inputs: readonly CalendarEventWriteInput[],
): Promise<void> {
  for (const input of inputs) {
    if (input.id === undefined) continue
    const existing = await target.store.getEvent(input.id)
    if (!existing) continue
    await sharedWriterIds(c, existing.calendarIds.map(calendarId => sharedCalendarId(target.ownerId, calendarId)))
  }
}
