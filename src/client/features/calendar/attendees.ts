/**
 * The guest list's client-side rules.
 *
 * The server re-checks all of this (`parseAttendeeList`); these helpers exist so the card can refuse a
 * half-typed address before it costs a round trip, and so it never offers the same guest twice.
 */
import type { CalendarAttendeeDto } from '@shared/calendar/model'

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/** The address as the list stores it, or null when the text is not one yet. */
export function normalizeAttendeeEmail(value: string): string | null {
  const email = value.trim().toLowerCase()
  if (email.length === 0 || email.length > 254) return null
  return EMAIL.test(email) ? email : null
}

export function addAttendee(
  list: readonly CalendarAttendeeDto[],
  email: string,
): CalendarAttendeeDto[] | null {
  if (list.some((attendee) => attendee.email === email)) return null
  return [...list, { email, name: '', status: 'needs-action' }]
}

export function withoutAttendee(
  list: readonly CalendarAttendeeDto[],
  email: string,
): CalendarAttendeeDto[] {
  return list.filter((attendee) => attendee.email !== email)
}

export function withAttendeeStatus(
  list: readonly CalendarAttendeeDto[],
  email: string,
  status: CalendarAttendeeDto['status'],
): CalendarAttendeeDto[] {
  return list.map((attendee) => (attendee.email === email ? { ...attendee, status } : attendee))
}
