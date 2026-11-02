/** A deliberately small CSV importer: one row per event, ISO-like start/end values. */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore, type CalendarEventWriteInput } from '../calendar/store'
import { parseCalendarInput, parseEventInput } from '../calendar/validation'
import { CSV_HEADER_ALIASES } from '@shared/locales/zh-CN-calendar-csv'
import type { TemporalValue } from '@shared/calendar/model'

const MAX_CSV_BYTES = 5 * 1024 * 1024
const BODY_LIMIT = MAX_CSV_BYTES + 64 * 1024
const IMPORT_CHUNK = 200
const importBudget = createMinuteBudget(10, 'Too many calendar imports. Try again in a minute.')

export const calendarCsvRoutes = new Hono<AppBindings>()
calendarCsvRoutes.use('*', requireAuth)
calendarCsvRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') importBudget(c.get('userId'))
  await next()
})

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      cell = ''
      if (row.some(value => value.trim())) rows.push(row)
      row = []
    } else cell += char
  }
  if (cell || row.length > 0) {
    row.push(cell)
    if (row.some(value => value.trim())) rows.push(row)
  }
  return rows
}

function temporal(value: string, defaultTimeZone: string): TemporalValue | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { value: trimmed, type: 'date' }
  const normalized = trimmed.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    return { value: normalized, type: 'datetime', timeZone: defaultTimeZone }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    return { value: normalized, type: 'zoned', timeZone: 'UTC' }
  }
  return null
}

calendarCsvRoutes.post('/csv/import', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw ApiError.badRequest('content is required')
  }
  if (body.content.length > MAX_CSV_BYTES) throw ApiError.tooLarge('The CSV is too large')
  const rows = parseCsv(body.content.replace(/^\uFEFF/, ''))
  if (rows.length < 2) throw ApiError.badRequest('The CSV needs a header and at least one row')
  const header = rows[0]!.map(value => value.trim().toLowerCase())
  const column = (...names: string[]): number => names.reduce((found, name) => found >= 0 ? found : header.indexOf(name), -1)
  const titleColumn = column('title', 'subject', 'summary', CSV_HEADER_ALIASES.title)
  const startColumn = column('start', 'start_date', CSV_HEADER_ALIASES.start)
  const endColumn = column('end', 'end_date', CSV_HEADER_ALIASES.end)
  const allDayColumn = column('allday', 'all_day', CSV_HEADER_ALIASES.allDay)
  const descriptionColumn = column('description', 'notes', CSV_HEADER_ALIASES.description)
  if (titleColumn < 0 || startColumn < 0) {
    throw ApiError.badRequest('The CSV needs title and start columns')
  }
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const preferences = await store.preferences()
  let calendar
  let created = false
  if (typeof body.calendarId === 'string') {
    calendar = (await store.listCalendars()).find(entry => entry.id === body.calendarId)
    if (!calendar) throw ApiError.notFound('Calendar not found')
    if (calendar.readOnly) throw ApiError.forbidden('The target calendar is read-only')
  } else {
    const requested = body.newCalendar && typeof body.newCalendar === 'object' && !Array.isArray(body.newCalendar)
      ? body.newCalendar as Record<string, unknown>
      : {}
    calendar = await store.createCalendar(parseCalendarInput({
      name: typeof requested.name === 'string' && requested.name.trim() ? requested.name : 'Imported CSV',
      ...(requested.color === undefined ? {} : { color: requested.color }),
    }))
    created = true
  }
  const inputs: CalendarEventWriteInput[] = []
  const warnings: Array<{ line: number; message: string }> = []
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!
    const title = (row[titleColumn] ?? '').trim()
    const start = temporal(row[startColumn] ?? '', preferences.timeZone)
    if (!title || !start) {
      warnings.push({ line: index + 1, message: 'Missing title or start; the row was skipped' })
      continue
    }
    let end = endColumn >= 0 ? temporal(row[endColumn] ?? '', preferences.timeZone) : null
    if (!end) {
      end = start.type === 'date'
        ? start
        : { ...start, value: new Date(new Date(start.value).getTime() + 60 * 60 * 1000).toISOString().slice(0, 19) }
    }
    const allDay = allDayColumn >= 0
      ? ['1', 'true', 'yes', CSV_HEADER_ALIASES.yes].includes((row[allDayColumn] ?? '').trim().toLowerCase())
      : start.type === 'date'
    try {
      inputs.push(parseEventInput({
        title,
        description: descriptionColumn >= 0 ? row[descriptionColumn] ?? '' : '',
        start,
        end,
        allDay,
        calendarIds: [calendar.id],
      }, { defaultTimeZone: preferences.timeZone }))
    } catch (error) {
      warnings.push({ line: index + 1, message: error instanceof Error ? error.message : 'Invalid row' })
    }
  }
  let imported = 0
  try {
    for (let index = 0; index < inputs.length; index += IMPORT_CHUNK) {
      imported += (await store.createEvents(inputs.slice(index, index + IMPORT_CHUNK), 'create')).length
    }
  } catch (error) {
    if (created) await store.deleteCalendar(calendar.id, { mode: 'delete' }).catch(() => { /* The import error is the one that explains the request. */ })
    throw error
  }
  return c.json({ calendarId: calendar.id, imported, warnings })
})
