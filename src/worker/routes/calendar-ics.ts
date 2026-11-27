import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import { encodeIcsChunks } from '../calendar/ics'
import { ICS_IMPORT_BODY_LIMIT, importCalendarIcs } from '../calendar/ics-import'
import { safeFilename } from '../calendar/filename'
import {
  MAX_ICS_EXPORT_BYTES,
  isCalendarEntityId,
} from '@shared/calendar/model'
import type { CalendarEventDto } from '@shared/calendar/model'

const importBudget = createMinuteBudget(10, 'Too many calendar imports. Try again in a minute.')
const exportBudget = createMinuteBudget(30, 'Too many calendar exports. Try again in a minute.')

export const calendarIcsRoutes = new Hono<AppBindings>()

calendarIcsRoutes.use('*', requireAuth)
calendarIcsRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') importBudget(c.get('userId'))
  await next()
})

calendarIcsRoutes.post('/import', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, ICS_IMPORT_BODY_LIMIT)
  const result = await importCalendarIcs(c.env, c.get('userId'), body)
  return c.json(result)
})

calendarIcsRoutes.get('/export', async (c) => {
  exportBudget(c.get('userId'))
  const calendarId = c.req.query('calendarId')
  if (!isCalendarEntityId(calendarId)) throw ApiError.notFound('Calendar not found')
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const calendar = (await store.listCalendars()).find((entry) => entry.id === calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const preferences = await store.preferences()
  const eventId = c.req.query('eventId')
  let events: CalendarEventDto[]
  if (eventId !== undefined) {
    // A single event can be forwarded or imported elsewhere without handing over the whole
    // calendar; the row still has to belong to the calendar the session named.
    if (!isCalendarEntityId(eventId)) throw ApiError.notFound('Event not found')
    const event = await store.getEvent(eventId)
    if (!event || !event.calendarIds.includes(calendarId)) throw ApiError.notFound('Event not found')
    events = [event]
  } else {
    const size = await store.exportSizeFor(calendarId)
    if (size.storedBytes > MAX_ICS_EXPORT_BYTES) {
      throw ApiError.tooLarge('That calendar holds more text than one file can carry')
    }
    const range = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendarId])
    if (range.truncated) {
      throw ApiError.tooLarge('That calendar has too many events to export as one file')
    }
    events = range.events
  }
  const guests = await store.eventAttendeesFor(events.map(event => event.id))
  const chunks = encodeIcsChunks({
    name: calendar.name,
    events: events.map(event => ({ ...event, attendees: guests.get(event.id) })),
    timeZone: preferences.timeZone,
    organizerEmail: preferences.organizerEmail,
  }, MAX_ICS_EXPORT_BYTES)
  if (!chunks) throw ApiError.tooLarge('That calendar is too large to export as one file')
  const filename = `${safeFilename(eventId ? events[0]!.title : calendar.name, 'calendar')}.ics`
  return c.body(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  })
})
