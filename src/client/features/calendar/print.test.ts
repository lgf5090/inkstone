import { describe, expect, it } from 'vitest'
import type { CalendarDto, CalendarEventDto } from '@shared/calendar/model'
import { buildPrintSheet, printPeriod } from './print'

function event(input: {
  id: string
  start: string
  end?: string
  allDay?: boolean
  meta?: Record<string, unknown>
}): CalendarEventDto {
  return {
    id: input.id,
    title: `Event ${input.id}`,
    description: '',
    kind: 'event',
    task: null,
    conference: null,
    start: { value: input.start, type: 'zoned', timeZone: 'UTC' },
    end: { value: input.end ?? input.start, type: 'zoned', timeZone: 'UTC' },
    allDay: input.allDay ?? false,
    calendarId: 'calendar-1',
    calendarIds: ['calendar-1'],
    meta: input.meta ?? {},
    icon: null,
    recurrenceRule: null,
    rev: 1,
    source: 'local',
    externalId: null,
  }
}

const calendars: CalendarDto[] = [{
  id: 'calendar-1',
  name: 'Work',
  color: '#112233',
  darkColor: '#445566',
  icon: null,
  groupId: null,
  isDefault: true,
  isVisible: true,
  readOnly: false,
  source: 'local',
  subscriptionId: null,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  rev: 1,
} as CalendarDto]

function sheet(events: CalendarEventDto[], overrides: Partial<Parameters<typeof buildPrintSheet>[0]> = {}) {
  return buildPrintSheet({
    events,
    calendars,
    fromMs: Date.parse('2026-11-01T00:00:00Z'),
    toMs: Date.parse('2026-11-30T23:59:59Z'),
    timeZone: 'UTC',
    locale: 'en-GB',
    timeFormat: '24h',
    title: 'November',
    subtitle: 'Work',
    emptyLabel: 'Nothing scheduled',
    ...overrides,
  })
}

describe('buildPrintSheet', () => {
  it('makes one section per day, all-day first and timed in order', () => {
    const answer = sheet([
      event({ id: 'b', start: '2026-11-03T09:00:00+00:00[UTC]' }),
      event({ id: 'a', start: '2026-11-03T08:00:00+00:00[UTC]' }),
      event({ id: 'c', start: '2026-11-02T00:00:00+00:00[UTC]', end: '2026-11-02T00:00:00+00:00[UTC]', allDay: true }),
    ])

    expect(answer.days.map((day) => day.key)).toEqual(['2026-11-02', '2026-11-03'])
    expect(answer.days[1]!.items.map((item) => item.key)).toEqual(['a', 'b'])
    expect(answer.days[1]!.items[0]!.time).toBe('08:00')
    expect(answer.days[0]!.items[0]!.time).toBe('')
    expect(answer.days[0]!.label).toContain('Monday')
  })

  it('carries the calendar name and colour of the first membership', () => {
    const answer = sheet([event({ id: 'a', start: '2026-11-04T10:00:00+00:00[UTC]', meta: { location: 'Room 2' } })])

    expect(answer.days[0]!.items[0]).toMatchObject({
      calendarName: 'Work',
      color: '#445566',
      location: 'Room 2',
    })
  })

  it('drops anything outside the printed period', () => {
    const answer = sheet([
      event({ id: 'before', start: '2026-10-31T23:00:00+00:00[UTC]' }),
      event({ id: 'inside', start: '2026-11-01T00:30:00+00:00[UTC]' }),
      event({ id: 'after', start: '2026-12-01T00:30:00+00:00[UTC]' }),
    ])

    expect(answer.days.flatMap((day) => day.items.map((item) => item.key))).toEqual(['inside'])
  })

  it('follows the hour convention the reader chose', () => {
    const events = [event({ id: 'a', start: '2026-11-04T15:30:00+00:00[UTC]' })]

    expect(sheet(events).days[0]!.items[0]!.time).toBe('15:30')
    expect(sheet(events, { timeFormat: '12h' }).days[0]!.items[0]!.time).toMatch(/3:30\s?pm/i)
  })

  it('places an event on the day it starts in the printing zone', () => {
    const answer = sheet(
      [event({ id: 'a', start: '2026-11-04T23:00:00+00:00[UTC]' })],
      { timeZone: 'Asia/Shanghai' },
    )

    expect(answer.days.map((day) => day.key)).toEqual(['2026-11-05'])
  })
})

describe('printPeriod', () => {
  const date = new Date(Date.parse('2026-11-04T12:00:00Z'))

  it('covers the month, the week, or the day the reader is looking at', () => {
    expect(printPeriod('month', date, 'UTC', 1)).toEqual({
      fromMs: Date.parse('2026-11-01T00:00:00Z'),
      toMs: Date.parse('2026-12-01T00:00:00Z') - 1,
    })
    expect(printPeriod('week', date, 'UTC', 1)).toEqual({
      fromMs: Date.parse('2026-11-02T00:00:00Z'),
      toMs: Date.parse('2026-11-09T00:00:00Z') - 1,
    })
    expect(printPeriod('day', date, 'UTC', 1)).toEqual({
      fromMs: Date.parse('2026-11-04T00:00:00Z'),
      toMs: Date.parse('2026-11-05T00:00:00Z') - 1,
    })
    expect(printPeriod('year', date, 'UTC', 1)).toEqual(printPeriod('month', date, 'UTC', 1))
  })

  it('respects a Sunday week start and a zone that shifts the date', () => {
    expect(printPeriod('week', date, 'UTC', 0)).toEqual({
      fromMs: Date.parse('2026-11-01T00:00:00Z'),
      toMs: Date.parse('2026-11-08T00:00:00Z') - 1,
    })
    expect(printPeriod('day', date, 'Pacific/Kiritimati', 1).fromMs)
      .toBe(Date.parse('2026-11-04T10:00:00Z'))
  })
})
