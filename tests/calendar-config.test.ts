// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_ICS_ATTENDEES,
  MAX_ICS_ATTENDEE_NAME_CHARS,
  MAX_ICS_CATEGORY_CHARS,
  parseIcsCalendar,
} from '../src/worker/calendar/ics'
import { ICS_IMPORT_BODY_LIMIT, ICS_IMPORT_EVENT_CHUNK } from '../src/worker/calendar/ics-import'
import {
  PROXY_HEADER_VALUE_MAX_CHARS,
  PROXY_PATH_MAX_CHARS,
  proxyHeaders,
  resolveProxyUrl,
} from '../src/worker/calendar/proxy'
import { MAX_SUBSCRIPTION_NAME_CHARS, SUBSCRIPTION_COLORS } from '../src/worker/calendar/subscriptions'
import { MAX_ICS_BYTES } from '../src/shared/calendar/model'

function calendarWith(lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inkstone//Config Test//EN',
    'BEGIN:VEVENT',
    'UID:config@example.com',
    'DTSTART:20261126T010000Z',
    'DTEND:20261126T020000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

describe('calendar named limits and palette', () => {
  it('keeps the subscription palette valid, unique and bounded by a named name limit', () => {
    expect(SUBSCRIPTION_COLORS.length).toBeGreaterThan(0)
    expect(new Set(SUBSCRIPTION_COLORS).size).toBe(SUBSCRIPTION_COLORS.length)
    expect(SUBSCRIPTION_COLORS.every(color => /^#[0-9a-f]{6}$/.test(color))).toBe(true)
    expect(MAX_SUBSCRIPTION_NAME_CHARS).toBe(80)
  })

  it('applies the attendee and category limits while parsing ICS', () => {
    const attendees = Array.from({ length: MAX_ICS_ATTENDEES + 5 }, (_, index) =>
      `ATTENDEE;CN=${'n'.repeat(MAX_ICS_ATTENDEE_NAME_CHARS + 5)};PARTSTAT=ACCEPTED:mailto:guest${index}@example.com`)
    const result = parseIcsCalendar({
      content: calendarWith([...attendees, `CATEGORIES:${'c'.repeat(MAX_ICS_CATEGORY_CHARS + 5)}`]),
      defaultTimeZone: 'UTC',
      maxEvents: 10,
    })
    expect(result.events[0]?.meta?.attendees).toHaveLength(MAX_ICS_ATTENDEES)
    expect(result.events[0]?.meta?.categories).toEqual(['c'.repeat(MAX_ICS_CATEGORY_CHARS)])
  })

  it('enforces proxy header and path boundaries using the exported limits', () => {
    expect(proxyHeaders({ Depth: '1'.repeat(PROXY_HEADER_VALUE_MAX_CHARS) }).Depth)
      .toHaveLength(PROXY_HEADER_VALUE_MAX_CHARS)
    expect(() => proxyHeaders({ Depth: '1'.repeat(PROXY_HEADER_VALUE_MAX_CHARS + 1) })).toThrow()

    const base = 'https://dav.example.com/calendars/alice/'
    const prefix = '/calendars/alice/'
    const path = `${prefix}${'a'.repeat(PROXY_PATH_MAX_CHARS - prefix.length)}`
    expect(resolveProxyUrl(base, path).pathname).toHaveLength(PROXY_PATH_MAX_CHARS)
    expect(() => resolveProxyUrl(base, `${path}a`)).toThrow()
  })

  it('keeps import capacity constants aligned with the shared ICS ceiling', () => {
    expect(ICS_IMPORT_BODY_LIMIT).toBeGreaterThan(MAX_ICS_BYTES)
    expect(ICS_IMPORT_EVENT_CHUNK).toBeGreaterThan(0)
  })
})
