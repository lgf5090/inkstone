/**
 * The calendar address book and the birthday projection built from it.
 *
 * A contact is private account data, so every route is session-scoped and every id this account does
 * not own is a 404. The birthday calendar is a normal local calendar with yearly all-day events;
 * syncing it again updates rows in place rather than minting a second copy.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore } from '../calendar/store'
import { createContact, deleteContact, listContacts, updateContact } from '../calendar/contacts'
import { parseCalendarInput } from '../calendar/validation'
import type { CalendarEventInput } from '@shared/calendar/model'


const readBudget = createMinuteBudget(240, 'Too many calendar reads at once. Try again in a minute.')
const writeBudget = createMinuteBudget(120, 'Too many calendar changes at once. Try again in a minute.')
const BODY_LIMIT = 64 * 1024

export const calendarContactRoutes = new Hono<AppBindings>()

calendarContactRoutes.use('*', requireAuth)

calendarContactRoutes.get('/contacts', async (c) => {
  readBudget(c.get('userId'))
  return c.json({ contacts: await listContacts(c.env.DB, c.get('userId'), c.req.query('q') ?? '') })
})

calendarContactRoutes.post('/contacts', async (c) => {
  writeBudget(c.get('userId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  return c.json({ contact: await createContact(c.env.DB, c.get('userId'), body) })
})

calendarContactRoutes.patch('/contacts/:id', async (c) => {
  writeBudget(c.get('userId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  return c.json({ contact: await updateContact(c.env.DB, c.get('userId'), c.req.param('id'), body) })
})

calendarContactRoutes.delete('/contacts/:id', async (c) => {
  writeBudget(c.get('userId'))
  if (!await deleteContact(c.env.DB, c.get('userId'), c.req.param('id'))) {
    throw ApiError.notFound('Contact not found')
  }
  return c.body(null, 204)
})

/** Build the yearly birthday events for every contact that recorded a birthday. */
calendarContactRoutes.post('/birthdays/sync', async (c) => {
  const userId = c.get('userId')
  writeBudget(userId)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const label = typeof body.calendarName === 'string' && body.calendarName.trim()
    ? body.calendarName.trim().slice(0, 80)
    : 'Birthdays'
  const template = typeof body.titleTemplate === 'string' && body.titleTemplate.includes('{name}')
    ? body.titleTemplate.slice(0, 120)
    : '{name}'
  const store = new CalendarStore(c.env.DB, userId)
  const calendars = await store.listCalendars()
  let calendar = calendars.find(entry => entry.name === label)
  if (!calendar) {
    calendar = await store.createCalendar(parseCalendarInput({ name: label, color: '#d6409f' }))
  }
  const contacts = (await listContacts(c.env.DB, userId)).filter(contact => contact.birthday)
  const now = new Date()
  const inputs: CalendarEventInput[] = []
  const wanted = new Set<string>()
  for (const contact of contacts) {
    const [year, month, day] = contact.birthday!.split('-').map(Number)
    const date = new Date(year!, month! - 1, day!)
    const thisYear = new Date(now.getFullYear(), date.getMonth(), date.getDate())
    if (thisYear.getMonth() !== date.getMonth()) thisYear.setDate(0)
    const key = `${thisYear.getFullYear()}-${String(thisYear.getMonth() + 1).padStart(2, '0')}-${String(thisYear.getDate()).padStart(2, '0')}`
    const id = `birthday-${contact.id}`
    wanted.add(id)
    inputs.push({
      id,
      title: template.replaceAll('{name}', contact.name || contact.email),
      description: '',
      kind: 'event',
      start: { value: key, type: 'date' },
      end: { value: key, type: 'date' },
      allDay: true,
      calendarIds: [calendar.id],
      meta: {},
      recurrenceRule: 'FREQ=YEARLY',
    })
  }
  if (inputs.length > 0) await store.createEvents(inputs, 'upsert')
  const existing = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendar.id])
  for (const event of existing.events) {
    if (event.id.startsWith('birthday-') && !wanted.has(event.id)) {
      await store.deleteEvent(event.id, event.rev).catch((error: unknown) => {
        console.warn('[inkstone] Birthday cleanup failed:', error instanceof Error ? error.message : error)
      })
    }
  }
  return c.json({ calendarId: calendar.id, imported: inputs.length, removed: Math.max(0, existing.events.length - inputs.length) })
})

/** A holiday calendar is data supplied by the client's locale table; the server only files it. */
calendarContactRoutes.post('/holidays', async (c) => {
  const userId = c.get('userId')
  writeBudget(userId)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const calendarName = typeof body.calendarName === 'string' && body.calendarName.trim()
    ? body.calendarName.trim().slice(0, 80)
    : 'Holidays'
  const raw = Array.isArray(body.holidays) ? body.holidays : []
  if (raw.length === 0) throw ApiError.badRequest('holidays are required')
  if (raw.length > 100) throw ApiError.badRequest('too many holidays')
  const store = new CalendarStore(c.env.DB, userId)
  const calendar = await store.createCalendar(parseCalendarInput({ name: calendarName, color: '#e5484d' }))
  const events: CalendarEventInput[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) continue
    if (typeof record.title !== 'string' || !record.title.trim()) continue
    events.push({
      id: `holiday-${record.date}`,
      title: record.title.trim().slice(0, 120),
      description: '',
      kind: 'event',
      start: { value: record.date, type: 'date' },
      end: { value: record.date, type: 'date' },
      allDay: true,
      calendarIds: [calendar.id],
      meta: {},
    })
  }
  if (events.length > 0) await store.createEvents(events, 'create')
  return c.json({ calendarId: calendar.id, imported: events.length })
})
