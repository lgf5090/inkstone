import { describe, expect, it } from 'vitest'
import type { CalendarAttendeeDto } from '@shared/calendar/model'
import { addAttendee, normalizeAttendeeEmail, withAttendeeStatus, withoutAttendee } from './attendees'

const guest = (email: string, status: CalendarAttendeeDto['status'] = 'needs-action'): CalendarAttendeeDto => ({
  email,
  name: '',
  status,
})

describe('normalizeAttendeeEmail', () => {
  it('accepts an address and lower-cases it', () => {
    expect(normalizeAttendeeEmail('  Kim.Song@Example.COM ')).toBe('kim.song@example.com')
  })

  it('refuses the shapes that would turn one field into two guests', () => {
    for (const value of ['', 'a@b', 'a b@example.com', 'a,b@example.com', 'a;b@c.de', 'a@c.de,f@c.de', 'plain']) {
      expect(normalizeAttendeeEmail(value)).toBeNull()
    }
    expect(normalizeAttendeeEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
  })
})

describe('guest list edits', () => {
  it('adds a guest once and refuses a duplicate', () => {
    const list = [guest('a@example.com')]

    expect(addAttendee(list, 'b@example.com')).toEqual([guest('a@example.com'), guest('b@example.com')])
    expect(addAttendee(list, 'a@example.com')).toBeNull()
  })

  it('removes and re-labels without touching the others', () => {
    const list = [guest('a@example.com'), guest('b@example.com', 'accepted')]

    expect(withoutAttendee(list, 'a@example.com')).toEqual([guest('b@example.com', 'accepted')])
    expect(withAttendeeStatus(list, 'a@example.com', 'declined')).toEqual([
      guest('a@example.com', 'declined'),
      guest('b@example.com', 'accepted'),
    ])
    expect(list).toHaveLength(2)
  })
})
