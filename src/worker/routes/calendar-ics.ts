import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import { parseEventInput } from '../calendar/validation'
import {
  IcsParseError,
  parseIcsCalendar,
  serializeIcsCalendar,
} from '../calendar/ics'
import {
  MAX_ICS_BYTES,
  MAX_ICS_EVENTS,
  MAX_ICS_EXPORT_BYTES,
  isCalendarEntityId,
} from '@shared/calendar/model'

const IMPORT_BODY_LIMIT = MAX_ICS_BYTES * 2 + 64 * 1024
const IMPORT_CHUNK = 200
const importBudget = createMinuteBudget(10, 'Too many calendar imports. Try again in a minute.')

export const calendarIcsRoutes = new Hono<AppBindings>()

calendarIcsRoutes.use('*', requireAuth)
calendarIcsRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') importBudget(c.get('userId'))
  await next()
})

calendarIcsRoutes.post('/import', async (c) => {
  const body = await readJson<{ content?: unknown; calendarId?: unknown; defaultTimeZone?: unknown }>(
    c,
    IMPORT_BODY_LIMIT,
  )
  if (typeof body.content !== 'string' || body.content.length === 0) {
    throw ApiError.badRequest('content is required')
  }
  if (!isCalendarEntityId(body.calendarId)) throw ApiError.notFound('Calendar not found')

  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const calendar = (await store.listCalendars()).find((entry) => entry.id === body.calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')

  const defaultTimeZone = typeof body.defaultTimeZone === 'string' && body.defaultTimeZone
    ? body.defaultTimeZone
    : (await store.preferences()).timeZone

  let parsed: ReturnType<typeof parseIcsCalendar>
  try {
    parsed = parseIcsCalendar({
      content: body.content,
      defaultTimeZone,
      maxEvents: MAX_ICS_EVENTS,
    })
  } catch (error) {
    if (error instanceof IcsParseError) {
      if (error.code === 'too_large') throw ApiError.tooLarge(error.message)
      throw ApiError.badRequest(error.message)
    }
    throw new ApiError(502, 'internal', 'The calendar file could not be parsed')
  }

  const inputs = parsed.events.map((event) => {
    const uid = event.meta?.originalUid
    const externalId = typeof uid === 'string'
      ? `ics:${encodeURIComponent(calendar.id)}:${encodeURIComponent(uid)}`
      : null
    return parseEventInput({
      ...event,
      calendarIds: [calendar.id],
      source: 'ics',
      externalId: externalId && isCalendarEntityId(externalId) ? externalId : null,
    }, { defaultTimeZone })
  })

  let imported = 0
  try {
    for (let index = 0; index < inputs.length; index += IMPORT_CHUNK) {
      const chunk = inputs.slice(index, index + IMPORT_CHUNK)
      imported += (await store.createEvents(chunk, 'upsert')).length
    }
  } catch {
    // The events are idempotent by (source, external id), so a retry of the same file is safe.
    throw new ApiError(
      500,
      'internal',
      `The calendar was only partially imported (${imported} events). Retry the same file; existing events will be updated.`,
    )
  }

  return c.json({
    calendarId: calendar.id,
    imported,
    warnings: parsed.warnings,
  })
})

calendarIcsRoutes.get('/export', async (c) => {
  const calendarId = c.req.query('calendarId')
  if (!isCalendarEntityId(calendarId)) throw ApiError.notFound('Calendar not found')
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const calendar = (await store.listCalendars()).find((entry) => entry.id === calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const preferences = await store.preferences()
  const events = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendarId])
  const text = serializeIcsCalendar({
    name: calendar.name,
    events,
    timeZone: preferences.timeZone,
  })
  if (new TextEncoder().encode(text).byteLength > MAX_ICS_EXPORT_BYTES) {
    throw ApiError.tooLarge('That calendar is too large to export as one file')
  }
  const filename = `${safeFilename(calendar.name)}.ics`
  return c.body(text, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  })
})

function safeFilename(value: string): string {
  const cleaned = value.replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 120)
  return cleaned || 'calendar'
}
