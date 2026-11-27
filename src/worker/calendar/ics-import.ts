import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  MAX_ICS_BYTES,
  MAX_ICS_EVENTS,
  isCalendarAttendeeStatus,
  isCalendarEntityId,
  type CalendarAttendeeDto,
  type CalendarDto,
} from '@shared/calendar/model'
import { isValidTimeZone } from '@shared/time-zone'
import {
  IcsParseError,
  MAX_ICS_ATTENDEES,
  MAX_ICS_ATTENDEE_NAME_CHARS,
  icsExternalId,
  parseIcsCalendar,
} from './ics'
import { CalendarStore, type CalendarEventWriteInput } from './store'
import { parseCalendarInput, parseEventInput } from './validation'

const ICS_IMPORT_JSON_ENVELOPE_BYTES = 64 * 1024
export const ICS_IMPORT_BODY_LIMIT = MAX_ICS_BYTES * 2 + ICS_IMPORT_JSON_ENVELOPE_BYTES
export const ICS_IMPORT_EVENT_CHUNK = 200
const MAX_ATTENDEE_EMAIL_CHARS = 254
const ATTENDEE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface CalendarIcsImportInput {
  content?: unknown
  calendarId?: unknown
  newCalendar?: unknown
  defaultTimeZone?: unknown
}

export interface CalendarIcsImportResult {
  calendarId: string
  imported: number
  warnings: ReturnType<typeof parseIcsCalendar>['warnings']
}

/** Validate, parse and persist one uploaded iCalendar document for its owning account. */
export async function importCalendarIcs(
  env: Env,
  userId: string,
  body: CalendarIcsImportInput,
): Promise<CalendarIcsImportResult> {
  if (typeof body.content !== 'string' || body.content.length === 0) {
    throw ApiError.badRequest('content is required')
  }
  if (!isCalendarEntityId(body.calendarId) && !body.newCalendar) {
    throw ApiError.badRequest('calendarId or newCalendar is required')
  }

  const store = new CalendarStore(env.DB, userId)
  const preferences = await store.preferences()
  // An imported file without a usable zone is placed in the account's zone, not refused: the
  // calendar's own default is the meaningful answer for a missing or unrecognised `defaultTimeZone`.
  const defaultTimeZone = typeof body.defaultTimeZone === 'string' && body.defaultTimeZone
    && isValidTimeZone(body.defaultTimeZone)
    ? body.defaultTimeZone
    : preferences.timeZone

  let parsed: ReturnType<typeof parseIcsCalendar>
  try {
    parsed = parseIcsCalendar({
      content: body.content,
      defaultTimeZone,
      maxEvents: MAX_ICS_EVENTS,
    })
  } catch (error) {
    if (error instanceof IcsParseError) {
      if (error.code === 'too_large' || error.code === 'too_many_events') throw ApiError.tooLarge(error.message)
      throw ApiError.badRequest(error.message)
    }
    throw new ApiError(502, 'internal', 'The calendar file could not be parsed')
  }

  let calendar: CalendarDto | undefined
  let created = false
  let newCalendarInput: ReturnType<typeof parseCalendarInput> | null = null
  let newCalendarId: string | null = null
  if (isCalendarEntityId(body.calendarId)) {
    calendar = (await store.listCalendars()).find((entry) => entry.id === body.calendarId)
    if (!calendar) throw ApiError.notFound('Calendar not found')
    if (calendar.readOnly) throw ApiError.forbidden('The target calendar is read-only')
  } else {
    const requested = body.newCalendar
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
      throw ApiError.badRequest('newCalendar must be an object')
    }
    const record = requested as Record<string, unknown>
    const requestedName = typeof record.name === 'string' ? record.name : ''
    const name = requestedName.trim() || parsed.name || 'Imported calendar'
    newCalendarInput = parseCalendarInput({
      name,
      ...(record.color === undefined ? {} : { color: record.color }),
    })
    newCalendarId = newId()
  }
  const targetCalendarId = calendar?.id ?? newCalendarId!

  const inputs: CalendarEventWriteInput[] = []
  for (let index = 0; index < parsed.events.length; index++) {
    const event = parsed.events[index]!
    try {
      const uid = event.meta?.originalUid
      const externalId = typeof uid === 'string'
        ? await icsExternalId(targetCalendarId, uid, recurrenceIdOf(event.meta?.recurrenceId))
        : null
      inputs.push(parseEventInput({
        ...event,
        calendarIds: [targetCalendarId],
        source: 'ics',
        externalId,
      }, { defaultTimeZone }))
    } catch (error) {
      parsed.warnings.push({
        line: index + 1,
        ...(typeof event.meta?.originalUid === 'string' ? { uid: event.meta.originalUid } : {}),
        code: 'invalid_event',
        message: error instanceof Error ? error.message : 'The event could not be imported',
      })
    }
  }
  if (inputs.length === 0) {
    throw ApiError.badRequest('The calendar file contains no valid events')
  }
  if (!calendar) {
    if (!newCalendarInput || !newCalendarId) throw new Error('Calendar import target was not prepared')
    calendar = await store.createCalendar({ ...newCalendarInput, id: newCalendarId })
    created = true
  }

  let imported = 0
  try {
    for (let index = 0; index < inputs.length; index += ICS_IMPORT_EVENT_CHUNK) {
      const chunk = inputs.slice(index, index + ICS_IMPORT_EVENT_CHUNK)
      const written = await store.createEvents(chunk, 'upsert')
      imported += written.length
      for (const event of written) {
        const guests = importedAttendees(event.meta)
        if (guests.length > 0) {
          await store.setEventAttendees(event.id, guests, event.rev)
        }
      }
    }
  } catch {
    if (created) {
      await store.deleteCalendar(calendar.id, { mode: 'delete', allowLast: true }).catch((cleanupError) => {
        console.warn('[inkstone] Calendar import cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError)
      })
    }
    // The events are idempotent by (source, external id), so a retry of the same file is safe.
    throw new ApiError(
      500,
      'internal',
      `The calendar was only partially imported (${imported} events). Retry the same file; existing events will be updated.`,
    )
  }

  return {
    calendarId: calendar.id,
    imported,
    warnings: parsed.warnings,
  }
}

function importedAttendees(meta: Record<string, unknown>): CalendarAttendeeDto[] {
  const raw = meta.attendees
  if (!Array.isArray(raw)) return []
  const guests: CalendarAttendeeDto[] = []
  for (const entry of raw.slice(0, MAX_ICS_ATTENDEES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : ''
    if (!email || email.length > MAX_ATTENDEE_EMAIL_CHARS || !ATTENDEE_EMAIL.test(email)) continue
    if (guests.some(guest => guest.email === email)) continue
    guests.push({
      email,
      name: typeof record.name === 'string' ? record.name.trim().slice(0, MAX_ICS_ATTENDEE_NAME_CHARS) : '',
      status: isCalendarAttendeeStatus(record.status) ? record.status : 'needs-action',
    })
  }
  return guests
}

function recurrenceIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return typeof record.value === 'string' ? record.value : null
}
