import {
  MAX_ATTENDEES_PER_EVENT,
  MAX_ATTENDEE_EMAIL,
  MAX_ATTENDEE_NAME,
  isCalendarAttendeeStatus,
  type CalendarAttendeeDto,
} from '@shared/calendar/model'

const ATTENDEE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/** Canonical guest shape shared by imports, provider sync, backups and the event store. */
export function normalizeEventAttendees(value: unknown): CalendarAttendeeDto[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const attendees: CalendarAttendeeDto[] = []
  for (const entry of value.slice(0, MAX_ATTENDEES_PER_EVENT)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const guest = entry as Record<string, unknown>
    const email = typeof guest.email === 'string' ? guest.email.trim().toLowerCase() : ''
    if (!email || email.length > MAX_ATTENDEE_EMAIL || !ATTENDEE_EMAIL.test(email) || seen.has(email)) continue
    seen.add(email)
    attendees.push({
      email,
      name: typeof guest.name === 'string' ? guest.name.trim().slice(0, MAX_ATTENDEE_NAME) : '',
      status: isCalendarAttendeeStatus(guest.status) ? guest.status : 'needs-action',
    })
  }
  return attendees
}
