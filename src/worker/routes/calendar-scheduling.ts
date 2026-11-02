/**
 * Calendly-style booking links.
 *
 * The owner's session manages a link; a visitor reads only the slot window and the aggregate busy
 * stretches of the next two weeks, then books one slot. Nothing identifies an event: the public
 * answer carries milliseconds, never titles, calendars or attendees.
 */
import { Hono, type Context } from 'hono'
import { Temporal } from 'temporal-polyfill'
import type { CalendarSchedulingLinkDto } from '@shared/calendar/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson, requestClientIp } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import {
  deleteSchedulingLink,
  getPublicSchedulingLink,
  getSchedulingLink,
  insertSchedulingLink,
  listSchedulingLinks,
  updateSchedulingLink,
  type SchedulingLinkRow,
} from '../calendar/scheduling'
import { expandRecurringEvents } from '../calendar/ics'
import { temporalValueToEpochMs } from '@shared/calendar/model'

const writeBudget = createMinuteBudget(60, 'Too many calendar changes. Try again in a minute.')
const readBudget = createMinuteBudget(240, 'Too many calendar reads. Try again in a minute.')
const BODY_LIMIT = 16 * 1024
const MAX_PUBLIC_RANGE_MS = 14 * 24 * 60 * 60 * 1000

function parseDays(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw ApiError.badRequest('days must name weekdays')
  const days = [...new Set(raw.map((day) => {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
      throw ApiError.badRequest('days must be whole numbers from 0 to 6')
    }
    return day
  }))]
  return days.sort((left, right) => left - right)
}

function hour(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 480) {
    throw ApiError.badRequest('durationMinutes must be between 5 and 480')
  }
  return value
}

function title(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('title must be text')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 160) throw ApiError.badRequest('title must be 1–160 characters')
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw ApiError.badRequest('title contains control characters')
  return trimmed
}

function toDto(row: SchedulingLinkRow): CalendarSchedulingLinkDto {
  let days = [1, 2, 3, 4, 5]
  try {
    const parsed: unknown = JSON.parse(row.days_json)
    if (Array.isArray(parsed)) days = parsed.filter((day): day is number => typeof day === 'number' && day >= 0 && day <= 6)
  } catch {
    // Keep the weekday default for a malformed row.
  }
  return {
    id: row.id,
    calendarId: row.calendar_id,
    slug: row.slug,
    title: row.title,
    durationMinutes: Number(row.duration_minutes),
    days,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    enabled: row.enabled === 1,
  }
}

function linkRow(c: Context<AppBindings>, id: string): Promise<SchedulingLinkRow | null> {
  return getSchedulingLink(c.env.DB, c.get('userId'), id)
}

/** The owner's links. Reading meta already returns them; this route is for a focused refresh. */
export const calendarSchedulingRoutes = new Hono<AppBindings>()
calendarSchedulingRoutes.use('*', requireAuth)

calendarSchedulingRoutes.get('/scheduling-links', async (c) => {
  readBudget(c.get('userId'))
  const links = await listSchedulingLinks(c.env.DB, c.get('userId'))
  return c.json({ links: links.map(toDto) })
})

calendarSchedulingRoutes.post('/scheduling-links', async (c) => {
  writeBudget(c.get('userId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (typeof body.calendarId !== 'string') throw ApiError.badRequest('calendarId is required')
  const calendars = await new CalendarStore(c.env.DB, c.get('userId')).listCalendars()
  const calendar = calendars.find(entry => entry.id === body.calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  if (calendar.readOnly) throw ApiError.forbidden('The calendar is read-only')
  const days = parseDays(body.days ?? [1, 2, 3, 4, 5])
  const startHour = hour(body.startHour ?? 9, 'startHour', 0, 23)
  const endHour = hour(body.endHour ?? 17, 'endHour', 1, 24)
  if (endHour <= startHour) throw ApiError.badRequest('endHour must come after startHour')
  const slug = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
  const id = newId()
  const now = Date.now()
  await insertSchedulingLink(c.env.DB, {
    userId: c.get('userId'),
    id,
    calendarId: calendar.id,
    slug,
    title: title(body.title ?? 'Meeting'),
    durationMinutes: duration(body.durationMinutes ?? 30),
    daysJson: JSON.stringify(days),
    startHour,
    endHour,
    enabled: body.enabled !== false,
    now,
  })
  return c.json({ link: toDto(await linkRow(c, id) as SchedulingLinkRow) })
})

calendarSchedulingRoutes.patch('/scheduling-links/:id', async (c) => {
  writeBudget(c.get('userId'))
  const existing = await linkRow(c, c.req.param('id'))
  if (!existing) throw ApiError.notFound('Scheduling link not found')
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const days = body.days === undefined ? null : parseDays(body.days)
  const startHour = body.startHour === undefined ? Number(existing.start_hour) : hour(body.startHour, 'startHour', 0, 23)
  const endHour = body.endHour === undefined ? Number(existing.end_hour) : hour(body.endHour, 'endHour', 1, 24)
  if (endHour <= startHour) throw ApiError.badRequest('endHour must come after startHour')
  await updateSchedulingLink(c.env.DB, c.get('userId'), existing.id, {
    title: body.title === undefined ? existing.title : title(body.title),
    durationMinutes: body.durationMinutes === undefined
      ? Number(existing.duration_minutes)
      : duration(body.durationMinutes),
    daysJson: days === null ? existing.days_json : JSON.stringify(days),
    startHour,
    endHour,
    enabled: body.enabled === undefined ? existing.enabled === 1 : body.enabled === true,
  })
  return c.json({ link: toDto(await linkRow(c, existing.id) as SchedulingLinkRow) })
})

calendarSchedulingRoutes.delete('/scheduling-links/:id', async (c) => {
  writeBudget(c.get('userId'))
  if (await deleteSchedulingLink(c.env.DB, c.get('userId'), c.req.param('id')) === 0) {
    throw ApiError.notFound('Scheduling link not found')
  }
  return c.body(null, 204)
})

// ------------------------------------------------------------- public

export const calendarBookingRoutes = new Hono<AppBindings>()

function publicSlug(c: Context<AppBindings>): string {
  const raw = c.req.param('slug') ?? ''
  if (!/^[a-z0-9]{8,64}$/.test(raw)) throw ApiError.notFound('Scheduling link not found')
  return raw
}

async function publicLink(c: Context<AppBindings>): Promise<{ row: SchedulingLinkRow; userId: string }> {
  const slug = publicSlug(c)
  const row = await getPublicSchedulingLink(c.env.DB, slug)
  if (!row) throw ApiError.notFound('Scheduling link not found')
  return { row, userId: row.user_id }
}

async function throttle(c: Context<AppBindings>, slug: string): Promise<void> {
  const ip = requestClientIp(c)
  await assertAttemptBudget(async () => {
    await consumeAttemptBudget(c.env.DB, [
      { key: `calendar-booking:${slug}:ip:${ip}`, maxAttempts: 30, windowMs: 10 * 60 * 1000 },
    ])
  })
}

async function busyFor(
  c: Context<AppBindings>,
  userId: string,
  fromMs: number,
  toMs: number,
): Promise<Array<{ startMs: number; endMs: number }>> {
  const store = new CalendarStore(c.env.DB, userId)
  const preferences = await store.preferences()
  const result = await store.listEvents(fromMs, toMs)
  const expansion = expandRecurringEvents(result.events, fromMs, toMs, preferences.timeZone)
  return [...result.events, ...expansion.occurrences]
    .filter(event => event.kind !== 'task')
    .map(event => ({
      startMs: temporalValueToEpochMs(event.start, preferences.timeZone),
      endMs: temporalValueToEpochMs(event.end, preferences.timeZone),
    }))
    .filter(block => block.endMs > fromMs && block.startMs < toMs)
    .sort((left, right) => left.startMs - right.startMs)
}

calendarBookingRoutes.get('/scheduling/:slug', async (c) => {
  await throttle(c, publicSlug(c))
  const { row, userId } = await publicLink(c)
  const preferences = await new CalendarStore(c.env.DB, userId).preferences()
  const now = Date.now()
  const busy = await busyFor(c, userId, now, now + MAX_PUBLIC_RANGE_MS)
  return c.json({
    link: toDto(row),
    timeZone: preferences.timeZone,
    fromMs: now,
    toMs: now + MAX_PUBLIC_RANGE_MS,
    busy,
  })
})

async function reserve(
  c: Context<AppBindings>,
  row: SchedulingLinkRow,
  userId: string,
  startMs: number,
  guestName: string,
  email: string,
): Promise<{ eventId: string; startMs: number; endMs: number }> {
  if (!Number.isFinite(startMs)) throw ApiError.badRequest('startMs is required')
  if (!guestName) throw ApiError.badRequest('name is required')
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw ApiError.badRequest('email is invalid')
  const preferences = await new CalendarStore(c.env.DB, userId).preferences()
  const zone = preferences.timeZone
  const start = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(zone)
  const end = start.add({ minutes: Number(row.duration_minutes) })
  const day = start.dayOfWeek % 7
  let days: number[] = [1, 2, 3, 4, 5]
  try {
    const parsed: unknown = JSON.parse(row.days_json)
    if (Array.isArray(parsed)) days = parsed.filter((value): value is number => typeof value === 'number')
  } catch {
    // Defaults stay.
  }
  if (!days.includes(day)) throw ApiError.badRequest('That day is not offered')
  if (start.hour < Number(row.start_hour) || end.hour > Number(row.end_hour)
    || (end.hour === Number(row.end_hour) && end.minute > 0)) {
    throw ApiError.badRequest('That time is outside the booking window')
  }
  if (startMs < Date.now() - 60_000) throw ApiError.badRequest('That time has passed')
  const busy = await busyFor(c, userId, startMs, end.epochMilliseconds)
  if (busy.some(block => block.startMs < end.epochMilliseconds && block.endMs > startMs)) {
    throw ApiError.conflict('That slot was just booked')
  }
  const owner = new CalendarStore(c.env.DB, userId)
  const event = await owner.createEvent({
    title: `${row.title} · ${guestName}`,
    description: email
      ? `Booked through a scheduling link: ${guestName} <${email}>`
      : `Booked through a scheduling link: ${guestName}`,
    start: { type: 'zoned', value: start.toString({ smallestUnit: 'minute' }), timeZone: zone },
    end: { type: 'zoned', value: end.toString({ smallestUnit: 'minute' }), timeZone: zone },
    allDay: false,
    calendarIds: [row.calendar_id],
    meta: {},
    source: 'local',
    externalId: null,
  })
  if (email) {
    await owner.setEventAttendees(event.id, [{ email, name: guestName, status: 'needs-action' }], event.rev)
  }
  return { eventId: event.id, startMs, endMs: end.epochMilliseconds }
}

calendarBookingRoutes.post('/scheduling/:slug/book', async (c) => {
  await throttle(c, publicSlug(c))
  const { row, userId } = await publicLink(c)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const startMs = body.startMs
  if (typeof startMs !== 'number') throw ApiError.badRequest('startMs is required')
  const guestName = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  return c.json(await reserve(c, row, userId, startMs, guestName, email))
})

// ------------------------------------------------------------- public booking page

export const calendarBookingPageRoutes = new Hono<AppBindings>()

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

interface OfferedSlot {
  startMs: number
  dayLabel: string
  timeLabel: string
}

function offeredSlots(
  row: SchedulingLinkRow,
  zone: string,
  busy: ReadonlyArray<{ startMs: number; endMs: number }>,
  locale: string,
): OfferedSlot[] {
  let days: number[] = [1, 2, 3, 4, 5]
  try {
    const parsed: unknown = JSON.parse(row.days_json)
    if (Array.isArray(parsed)) days = parsed.filter((value): value is number => typeof value === 'number')
  } catch {
    // Defaults stay.
  }
  const duration = Number(row.duration_minutes)
  const startHour = Number(row.start_hour)
  const endHour = Number(row.end_hour)
  const now = Date.now()
  const today = Temporal.Now.zonedDateTimeISO(zone).toPlainDate()
  const slots: OfferedSlot[] = []
  for (let offset = 0; offset < 14 && slots.length < 60; offset += 1) {
    const day = today.add({ days: offset })
    if (!days.includes(day.dayOfWeek % 7)) continue
    const windowStart = day.toZonedDateTime(zone).add({ hours: startHour })
    const windowEnd = day.toZonedDateTime(zone).add({ hours: endHour })
    let cursor = windowStart
    const earliest = now + 30 * 60_000
    if (cursor.epochMilliseconds < earliest) {
      cursor = Temporal.Instant.fromEpochMilliseconds(earliest).toZonedDateTimeISO(zone)
    }
    while (cursor.add({ minutes: duration }).epochMilliseconds <= windowEnd.epochMilliseconds && slots.length < 60) {
      const startMs = cursor.epochMilliseconds
      const endMs = startMs + duration * 60_000
      if (!busy.some(block => block.startMs < endMs && block.endMs > startMs)) {
        slots.push({
          startMs,
          dayLabel: new Intl.DateTimeFormat(locale, {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: zone,
          }).format(new Date(startMs)),
          timeLabel: new Intl.DateTimeFormat(locale, {
            hour: '2-digit', minute: '2-digit', timeZone: zone,
          }).format(new Date(startMs)),
        })
      }
      cursor = cursor.add({ minutes: 15 })
    }
  }
  return slots
}

function pageShell(title: string, body: string, lang: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/schedule.css">
</head>
<body>
<main class="booking-card">
${body}
</main>
</body>
</html>`
}

function bookingForm(row: SchedulingLinkRow, slots: OfferedSlot[], slug: string, error: string | null): string {
  const grouped = new Map<string, OfferedSlot[]>()
  for (const slot of slots) {
    const list = grouped.get(slot.dayLabel) ?? []
    list.push(slot)
    grouped.set(slot.dayLabel, list)
  }
  const days = [...grouped.entries()].map(([day, entries]) => `
    <section class="booking-day">
      <h2>${escapeHtml(day)}</h2>
      <div class="booking-slots">
        ${entries.map(slot => `
          <label class="booking-slot">
            <input type="radio" name="startMs" value="${slot.startMs}" required>
            <span>${escapeHtml(slot.timeLabel)}</span>
          </label>`).join('')}
      </div>
    </section>`).join('')
  return `
  <h1>${escapeHtml(row.title)}</h1>
  <p class="booking-meta">${escapeHtml(String(row.duration_minutes))} min</p>
  ${error ? `<p class="booking-error" role="alert">${escapeHtml(error)}</p>` : ''}
  ${slots.length === 0
    ? '<p class="booking-empty">No open slots in the next two weeks.</p>'
    : `<form method="post" action="/schedule/${escapeHtml(slug)}/book">
        ${days}
        <div class="booking-fields">
          <label>Your name<input name="name" required maxlength="120" autocomplete="name"></label>
          <label>Email (optional)<input name="email" type="email" maxlength="200" autocomplete="email"></label>
          <label class="booking-honeypot" aria-hidden="true">Company<input name="company" tabindex="-1" autocomplete="off"></label>
        </div>
        <button type="submit">Book this time</button>
      </form>`}`
}

calendarBookingPageRoutes.get('/:slug', async (c) => {
  const slug = publicSlug(c)
  await throttle(c, slug)
  const { row, userId } = await publicLink(c)
  const preferences = await new CalendarStore(c.env.DB, userId).preferences()
  const now = Date.now()
  const busy = await busyFor(c, userId, now, now + MAX_PUBLIC_RANGE_MS)
  const locale = (c.req.header('accept-language') ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  const slots = offeredSlots(row, preferences.timeZone, busy, locale)
  return c.html(pageShell(row.title, bookingForm(row, slots, slug, null), locale), 200, {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
})

calendarBookingPageRoutes.post('/:slug/book', async (c) => {
  const slug = publicSlug(c)
  await throttle(c, slug)
  const { row, userId } = await publicLink(c)
  const body = await c.req.parseBody()
  const value = (field: string): string => typeof body[field] === 'string' ? String(body[field]).trim() : ''
  const locale = (c.req.header('accept-language') ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  if (value('company')) {
    return c.html(pageShell(row.title, '<p class="booking-error" role="alert">Could not book that time.</p>', locale), 400, {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    })
  }
  const startMs = Number(value('startMs'))
  try {
    const booked = await reserve(c, row, userId, startMs, value('name').slice(0, 120), value('email').toLowerCase())
    const when = new Intl.DateTimeFormat(locale, {
      dateStyle: 'full', timeStyle: 'short', timeZone: (await new CalendarStore(c.env.DB, userId).preferences()).timeZone,
    }).format(new Date(booked.startMs))
    const body = `
      <h1>${escapeHtml(row.title)}</h1>
      <p class="booking-success">Booked for ${escapeHtml(when)}.</p>
      <p class="booking-meta">A calendar event was added to the owner's calendar.</p>`
    return c.html(pageShell(row.title, body, locale), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
  } catch (error) {
    const message = error instanceof ApiError
      ? error.status === 409
        ? 'That slot was just booked. Pick another time.'
        : 'That time cannot be booked. Pick another time.'
      : 'The booking could not be saved.'
    if (!(error instanceof ApiError)) {
      console.error('[inkstone] public booking failed:', error instanceof Error ? error.message : error)
    }
    const preferences = await new CalendarStore(c.env.DB, userId).preferences()
    const now = Date.now()
    const busy = await busyFor(c, userId, now, now + MAX_PUBLIC_RANGE_MS)
    const slots = offeredSlots(row, preferences.timeZone, busy, locale)
    return c.html(pageShell(row.title, bookingForm(row, slots, slug, message), locale), error instanceof ApiError ? error.status : 500, {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    })
  }
})
