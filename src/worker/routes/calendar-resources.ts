/**
 * Bookable resources: a named calendar plus an optional capacity.
 *
 * A resource is deliberately not a second kind of calendar. Reservations are ordinary events in the
 * resource's calendar, so every existing range read, conflict prompt and permission check still
 * applies; this route only keeps the label and capacity row in step with it.
 */
import { Hono } from 'hono'
import { MAX_CALENDAR_NAME } from '@shared/calendar/model'
import type { CalendarResourceDto } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import { deleteResourceRow, getResource, insertResource, listResources, updateResourceRow } from '../calendar/resources'
import { newId } from '../lib/id'
import { parseCalendarInput } from '../calendar/validation'

const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')
const writeBudget = createMinuteBudget(60, 'Too many calendar changes. Try again in a minute.')
const BODY_LIMIT = 8 * 1024

export const calendarResourceRoutes = new Hono<AppBindings>()
calendarResourceRoutes.use('*', requireAuth)

function name(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('name must be text')
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest('name is required')
  if (trimmed.length > MAX_CALENDAR_NAME) throw ApiError.badRequest('name is too long')
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw ApiError.badRequest('name contains control characters')
  return trimmed
}

function capacity(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000) {
    throw ApiError.badRequest('capacity must be a whole number between 1 and 10000')
  }
  return value
}

calendarResourceRoutes.get('/resources', async (c) => {
  readBudget(c.get('userId'))
  return c.json({ resources: await listResources(c.env.DB, c.get('userId')) })
})

calendarResourceRoutes.post('/resources', async (c) => {
  writeBudget(c.get('userId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const resourceName = name(body.name)
  const seats = capacity(body.capacity)
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const input = parseCalendarInput({
    name: resourceName,
    ...(body.color === undefined ? {} : { color: body.color }),
  })
  const calendar = await store.createCalendar(input)
  const id = newId()
  try {
    await insertResource(c.env.DB, c.get('userId'), { id, calendarId: calendar.id, name: resourceName, capacity: seats })
  } catch (error) {
    await store.deleteCalendar(calendar.id, { mode: 'delete' }).catch(() => { /* The insert error is the one to report. */ })
    throw error
  }
  return c.json({ resource: { id, calendarId: calendar.id, name: resourceName, capacity: seats } satisfies CalendarResourceDto })
})

calendarResourceRoutes.patch('/resources/:id', async (c) => {
  writeBudget(c.get('userId'))
  const existing = await getResource(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!existing) throw ApiError.notFound('Resource not found')
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const nextName = body.name === undefined ? existing.name : name(body.name)
  const nextCapacity = body.capacity === undefined ? existing.capacity : capacity(body.capacity)
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  if (nextName !== existing.name) {
    const calendar = (await store.listCalendars()).find(entry => entry.id === existing.calendarId)
    if (calendar) await store.updateCalendar(calendar.id, { rev: calendar.rev, name: nextName })
  }
  await updateResourceRow(c.env.DB, c.get('userId'), existing.id, { name: nextName, capacity: nextCapacity })
  return c.json({ resource: { ...existing, name: nextName, capacity: nextCapacity } satisfies CalendarResourceDto })
})

calendarResourceRoutes.delete('/resources/:id', async (c) => {
  writeBudget(c.get('userId'))
  const existing = await getResource(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!existing) throw ApiError.notFound('Resource not found')
  await deleteResourceRow(c.env.DB, c.get('userId'), existing.id)
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const calendar = (await store.listCalendars()).find(entry => entry.id === existing.calendarId)
  if (calendar) {
    await store.deleteCalendar(calendar.id, { mode: 'delete', rev: calendar.rev }).catch((error: unknown) => {
      console.warn('[inkstone] Resource calendar delete failed:', error instanceof Error ? error.message : error)
    })
  }
  return c.body(null, 204)
})
