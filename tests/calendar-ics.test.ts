import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import {
  IcsParseError,
  icsExternalId,
  parseIcsCalendar,
  serializeIcsCalendar,
} from '../src/worker/calendar/ics'
import type { IcsParseInput } from '../src/worker/calendar/ics'
import type { CalendarEventInput, TemporalValue } from '../src/shared/calendar/model'

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures/calendar', name), 'utf8')
}

function parseFixture(name: string, overrides: Partial<IcsParseInput> = {}) {
  return parseIcsCalendar({
    content: fixture(name),
    defaultTimeZone: 'UTC',
    maxEvents: 100,
    ...overrides,
  })
}

function byUid(events: readonly CalendarEventInput[], uid: string): CalendarEventInput {
  const event = events.find((candidate) => candidate.meta?.originalUid === uid)
  if (!event) throw new Error(`No event with UID ${uid}`)
  return event
}

function captureError(input: IcsParseInput): IcsParseError {
  try {
    parseIcsCalendar(input)
  } catch (error) {
    if (error instanceof IcsParseError) return error
    throw error
  }
  throw new Error('Expected parseIcsCalendar to throw')
}

function timedEvent(uid: string, day: number): string {
  const date = `202501${String(day).padStart(2, '0')}`
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${date}T000000Z`,
    `DTSTART:${date}T090000Z`,
    `DTEND:${date}T100000Z`,
    'SUMMARY:Batch event',
    'END:VEVENT',
  ].join('\r\n')
}

describe('parseIcsCalendar', () => {
  it('maps timed, all-day, zoned and floating events from one calendar', () => {
    const result = parseFixture('simple.ics')

    expect(result.name).toBe('Fixture Calendar')
    expect(result.events).toHaveLength(5)

    const timed = byUid(result.events, 'timed-1@example.com')
    expect(timed.start).toEqual({
      value: '2025-01-15T09:00:00+00:00[UTC]',
      type: 'zoned',
      timeZone: 'UTC',
    })
    expect(timed.end).toEqual({
      value: '2025-01-15T10:00:00+00:00[UTC]',
      type: 'zoned',
      timeZone: 'UTC',
    })
    expect(timed.allDay).toBe(false)
    expect(timed.title).toBe('Team sync')
    expect(timed.description).toBe('Weekly planning, agenda in the shared doc.')
    expect(timed.meta?.location).toBe('Room 1')
    expect(timed.meta?.categories).toEqual(['Work', 'Planning'])
    expect(timed.meta?.url).toBe('https://example.com/events/team-sync')
    expect(timed.conference?.joinUrl).toBe('https://meet.google.com/abc-defg-hij')
    expect(timed.recurrenceRule).toBeNull()

    const allDay = byUid(result.events, 'all-day-1@example.com')
    expect(allDay.allDay).toBe(true)
    expect(allDay.start).toEqual({ value: '2025-02-01', type: 'date' })
    expect(allDay.end).toEqual({ value: '2025-02-03', type: 'date' })

    const zoned = byUid(result.events, 'zoned-1@example.com')
    expect(zoned.start).toEqual({
      value: '2025-05-05T14:00:00+02:00[Europe/Berlin]',
      type: 'zoned',
      timeZone: 'Europe/Berlin',
    })
    expect(zoned.allDay).toBe(false)

    const floating = byUid(result.events, 'floating-1@example.com')
    expect(floating.start).toEqual({ value: '2025-06-01T10:00:00', type: 'datetime' })
    expect(floating.start.timeZone).toBeUndefined()
    expect(floating.allDay).toBe(false)

    expect(result.events.some((event) => event.meta?.originalUid === 'cancelled-1@example.com'))
      .toBe(false)
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cancelled_event', uid: 'cancelled-1@example.com' }),
    ]))
  })

  it('registers an embedded VTIMEZONE and converts an unrecognized TZID to the account zone', () => {
    const result = parseFixture('simple.ics')
    const custom = byUid(result.events, 'custom-zone-1@example.com')

    expect(custom.start).toEqual({
      value: '2025-01-15T08:00:00+00:00[UTC]',
      type: 'zoned',
      timeZone: 'UTC',
    })
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_timezone',
        uid: 'custom-zone-1@example.com',
      }),
    ]))
  })

  it('keeps a recurrence master when the series has no exceptions', () => {
    const result = parseFixture('recurring.ics')
    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=3;BYDAY=MO')
    expect(event.meta?.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=3;BYDAY=MO')
    expect(event.start.value).toBe('2025-01-06T09:00:00+00:00[UTC]')
    expect(event.meta?.recurrenceId).toBeUndefined()
  })

  it('flattens EXDATE, RDATE and RECURRENCE-ID instances without duplicates', () => {
    const result = parseFixture('exceptions.ics')
    expect(result.events).toHaveLength(5)

    const starts = result.events.map((event) => event.start.value).sort()
    expect(starts).toEqual([
      '2025-02-03T10:00:00+00:00[UTC]',
      '2025-02-05T10:00:00+00:00[UTC]',
      '2025-02-06T12:00:00+00:00[UTC]',
      '2025-02-07T10:00:00+00:00[UTC]',
      '2025-02-10T10:00:00+00:00[UTC]',
    ])

    const recurrenceIds = result.events.map((event) => {
      return (event.meta?.recurrenceId as TemporalValue | undefined)?.value
    })
    expect(recurrenceIds.filter((value): value is string => Boolean(value))).toHaveLength(5)
    expect(new Set(recurrenceIds).size).toBe(5)
    expect(result.events.every((event) => event.recurrenceRule === null)).toBe(true)
    expect(result.events.every((event) => event.meta?.recurrenceRule === undefined)).toBe(true)
    expect(byUid(result.events, 'daily-1@example.com')).toBeDefined()
    expect(result.events.find((event) => event.title === 'Moved standup')?.start.value)
      .toBe('2025-02-06T12:00:00+00:00[UTC]')
    expect(result.warnings.filter((warning) => warning.code === 'flattened')).toHaveLength(1)
    expect(result.warnings.find((warning) => warning.code === 'flattened')?.message)
      .toContain('5 independent occurrences')
  })

  it('resolves a DST boundary in the event zone rather than in UTC', () => {
    const result = parseFixture('dst.ics')
    const spring = byUid(result.events, 'dst-spring@example.com')
    expect(spring.start).toEqual({
      value: '2025-03-30T01:30:00+01:00[Europe/Berlin]',
      type: 'zoned',
      timeZone: 'Europe/Berlin',
    })
    expect(spring.end).toEqual({
      value: '2025-03-30T03:30:00+02:00[Europe/Berlin]',
      type: 'zoned',
      timeZone: 'Europe/Berlin',
    })
    expect(Temporal.ZonedDateTime.from(spring.start.value).epochMilliseconds)
      .toBe(Temporal.Instant.from('2025-03-30T00:30:00Z').epochMilliseconds)
    expect(Temporal.ZonedDateTime.from(spring.end.value).epochMilliseconds)
      .toBe(Temporal.Instant.from('2025-03-30T01:30:00Z').epochMilliseconds)
  })

  it('rejects malformed input and over-long content lines as invalid_ics', () => {
    const html = captureError({
      content: '<html><body>Not a calendar</body></html>',
      defaultTimeZone: 'UTC',
      maxEvents: 10,
    })
    expect(html.code).toBe('invalid_ics')

    const giant = captureError({
      content: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-GIANT:${'a'.repeat(20_000)}\r\nEND:VCALENDAR`,
      defaultTimeZone: 'UTC',
      maxEvents: 10,
    })
    expect(giant.code).toBe('invalid_ics')
  })

  it('stops at maxEvents with a typed too_many_events error', () => {
    const content = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      timedEvent('batch-1@example.com', 2),
      timedEvent('batch-2@example.com', 3),
      timedEvent('batch-3@example.com', 4),
      'END:VCALENDAR',
    ].join('\r\n')
    const error = captureError({ content, defaultTimeZone: 'UTC', maxEvents: 2 })
    expect(error.code).toBe('too_many_events')
  })
})

describe('serializeIcsCalendar', () => {
  it('round-trips UID, RRULE and time through parse and serialize', () => {
    const parsed = parseFixture('recurring.ics')
    const output = serializeIcsCalendar({
      name: 'Recurring Fixture',
      events: parsed.events,
      timeZone: 'UTC',
    })

    expect(output).toContain('BEGIN:VCALENDAR\r\n')
    expect(output).toContain('UID:weekly-1@example.com')
    expect(output).toContain('RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO')
    expect(output).toContain('DTSTART:20250106T090000Z')
    expect(output).toContain('DTEND:20250106T100000Z')
    expect(output).toContain('SUMMARY:Weekly sync')
    expect(output.endsWith('\r\n')).toBe(true)
    expect(output.replace(/\r\n/g, '')).not.toContain('\n')

    const again = parseIcsCalendar({
      content: output,
      defaultTimeZone: 'UTC',
      maxEvents: 10,
    })
    expect(again.events).toHaveLength(1)
    const event = again.events[0]!
    expect(event.meta?.originalUid).toBe('weekly-1@example.com')
    expect(event.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=3;BYDAY=MO')
    expect(event.start).toEqual(parsed.events[0]!.start)
    expect(event.end).toEqual(parsed.events[0]!.end)
  })

  it('writes EXDATE and RDATE values kept in meta', () => {
    const events: CalendarEventInput[] = [{
      id: 'series-event',
      title: 'Series',
      description: '',
      start: { value: '2025-01-06T09:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
      end: { value: '2025-01-06T10:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
      recurrenceRule: 'FREQ=WEEKLY;COUNT=4',
      meta: {
        originalUid: 'series-1@example.com',
        exdates: [{ value: '2025-01-13', type: 'date' }],
        rdates: [{
          value: '2025-01-20T09:00:00+00:00[UTC]',
          type: 'zoned',
          timeZone: 'UTC',
        }],
      },
    }]
    const output = serializeIcsCalendar({ name: 'Series', events, timeZone: 'UTC' })
    expect(output).toContain('EXDATE;VALUE=DATE:20250113')
    expect(output).toContain('RDATE:20250120T090000Z')
  })

  it('preserves all-day, TZID and conference URL forms', () => {
    const parsed = parseFixture('simple.ics')
    const output = serializeIcsCalendar({
      name: 'Fixture Calendar',
      events: parsed.events,
      timeZone: 'UTC',
    })

    expect(output).toContain('X-WR-CALNAME:Fixture Calendar')
    expect(output).toContain('DTSTART;VALUE=DATE:20250201')
    expect(output).toContain('DTEND;VALUE=DATE:20250203')
    expect(output).toContain('DTSTART;TZID=Europe/Berlin:20250505T140000')
    expect(output).toContain('DTEND;TZID=Europe/Berlin:20250505T150000')
    expect(output).toContain('URL:https://meet.google.com/abc-defg-hij')

    const again = parseIcsCalendar({
      content: output,
      defaultTimeZone: 'UTC',
      maxEvents: 10,
    })
    expect(again.events).toHaveLength(5)
    expect(byUid(again.events, 'zoned-1@example.com').start).toEqual(
      byUid(parsed.events, 'zoned-1@example.com').start,
    )
    expect(byUid(again.events, 'all-day-1@example.com').end).toEqual({
      value: '2025-02-03',
      type: 'date',
    })
  })

  it('gives flattened occurrences distinct external ids without losing the series uid', async () => {
    const first = await icsExternalId('cal-1', 'series@example.com', '2026-10-26')
    const second = await icsExternalId('cal-1', 'series@example.com', '2026-10-27')
    const otherCalendar = await icsExternalId('cal-2', 'series@example.com', '2026-10-26')
    expect(first).not.toBe(second)
    expect(first).not.toBe(otherCalendar)
    expect(first).toContain('ics:')
  })
})
