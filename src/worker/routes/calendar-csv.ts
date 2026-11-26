/** A deliberately small CSV importer: one row per event, ISO-like start/end values. */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { CalendarStore, type CalendarEventWriteInput } from '../calendar/store'
import { safeFilename } from '../calendar/filename'
import { parseCalendarInput, parseEventInput } from '../calendar/validation'
import { CSV_HEADER_ALIASES } from '@shared/locales/zh-CN-calendar-csv'
import { utf8ByteLength } from '@shared/text-utils'
import { isCalendarEntityId, type CalendarEventDto, type TemporalValue } from '@shared/calendar/model'
import { Temporal } from 'temporal-polyfill'

const MAX_CSV_BYTES = 5 * 1024 * 1024
const BODY_LIMIT = MAX_CSV_BYTES + 64 * 1024
const IMPORT_CHUNK = 200
const MAX_CSV_ROWS = 50_000
const importBudget = createMinuteBudget(10, 'Too many calendar imports. Try again in a minute.')
const exportBudget = createMinuteBudget(30, 'Too many calendar exports. Try again in a minute.')

export const calendarCsvRoutes = new Hono<AppBindings>()
calendarCsvRoutes.use('*', requireAuth)
calendarCsvRoutes.use('/csv/*', async (c, next) => {
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
    try {
      return { value: Temporal.Instant.from(normalized).toZonedDateTimeISO('UTC').toString(), type: 'zoned', timeZone: 'UTC' }
    } catch {
      return null
    }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\[[^\]]+\]$/.test(normalized)) {
    return { value: normalized, type: 'zoned', timeZone: defaultTimeZone }
  }
  return null
}

function addDefaultDuration(start: TemporalValue, timeZone: string): TemporalValue {
  if (start.type === 'date') return start
  const end = start.type === 'datetime'
    ? Temporal.PlainDateTime.from(start.value).toZonedDateTime(timeZone).add({ minutes: 60 })
    : Temporal.ZonedDateTime.from(start.value).add({ minutes: 60 })
  return { value: end.toString({ smallestUnit: 'second' }), type: 'zoned', timeZone: end.timeZoneId }
}

calendarCsvRoutes.post('/csv/import', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (typeof body.content !== 'string' || !body.content.trim()) {
    throw ApiError.badRequest('content is required')
  }
  if (utf8ByteLength(body.content) > MAX_CSV_BYTES) throw ApiError.tooLarge('The CSV is too large')
  const rows = parseCsv(body.content.replace(/^\uFEFF/, ''))
  if (rows.length - 1 > MAX_CSV_ROWS) throw ApiError.tooLarge(`The CSV may hold at most ${MAX_CSV_ROWS} events`)
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
      end = addDefaultDuration(start, preferences.timeZone)
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
  const written: CalendarEventDto[] = []
  try {
    for (let index = 0; index < inputs.length; index += IMPORT_CHUNK) {
      const events = await store.createEvents(inputs.slice(index, index + IMPORT_CHUNK), 'create')
      written.push(...events)
      imported += events.length
    }
  } catch {
    const rollbackErrors: string[] = []
    for (const event of written) {
      try {
        await store.deleteEvent(event.id, event.rev)
      } catch (rollbackError) {
        rollbackErrors.push(`${event.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
    }
    if (created) {
      try {
        await store.deleteCalendar(calendar.id, { mode: 'delete' })
      } catch (cleanupError) {
        rollbackErrors.push(`calendar: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
    }
    throw new ApiError(500, 'internal', `The CSV import failed after ${imported} events${rollbackErrors.length > 0 ? `; rollback incomplete: ${rollbackErrors.join('; ')}` : ''}`)
  }
  return c.json({ calendarId: calendar.id, imported, warnings })
})

function csvCell(value: string): string {
  const safe = /^\s*[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

function csvValue(value: TemporalValue): string {
  return value.value
}

calendarCsvRoutes.get('/csv/export', async (c) => {
  exportBudget(c.get('userId'))
  const calendarId = c.req.query('calendarId')
  if (!isCalendarEntityId(calendarId)) throw ApiError.notFound('Calendar not found')
  const store = new CalendarStore(c.env.DB, c.get('userId'))
  const calendar = (await store.listCalendars()).find(entry => entry.id === calendarId)
  if (!calendar) throw ApiError.notFound('Calendar not found')
  const range = await store.listEvents(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [calendarId])
  if (range.truncated) throw ApiError.tooLarge('That calendar has too many events to export as one file')
  const lines = ['title,start,end,all_day,description']
  for (const event of range.events) {
    lines.push([
      csvCell(event.title),
      csvCell(csvValue(event.start)),
      csvCell(csvValue(event.end)),
      event.allDay ? '1' : '0',
      csvCell(event.description),
    ].join(','))
  }
  const body = `${lines.join('\r\n')}\r\n`
  if (utf8ByteLength(body) > MAX_CSV_BYTES) throw ApiError.tooLarge('That calendar is too large to export as one file')
  const filename = `${safeFilename(calendar.name, 'calendar')}.csv`
  return c.body(body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  })
})
