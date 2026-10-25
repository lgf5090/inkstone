import { describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import type { CalendarDto, CalendarEventDto } from '@shared/calendar/model'
import {
  calendarSourceOf,
  deriveDarkColor,
  eventCalendarIds,
  eventDateInZone,
  toCalendarType,
  toDayFlowEvent,
  toEventInput,
  toSearchEvent,
} from './model'

function eventDto(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: 'evt_work',
    title: 'Design review',
    description: 'Walk through the plan',
    kind: 'event',
    task: null,
    conference: null,
    start: { value: '2026-10-26T09:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
    end: { value: '2026-10-26T10:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
    allDay: false,
    calendarId: 'cal_work',
    calendarIds: ['cal_work'],
    meta: {},
    icon: null,
    recurrenceRule: null,
    rev: 3,
    source: 'local',
    externalId: null,
    ...overrides,
  }
}

function calendarDto(overrides: Partial<CalendarDto> = {}): CalendarDto {
  return {
    id: 'cal_work',
    name: 'Work',
    color: '#3e63dd',
    darkColor: '#8da4f7',
    icon: null,
    groupId: null,
    isDefault: true,
    isVisible: true,
    readOnly: false,
    source: 'local',
    subscriptionId: null,
    position: 0,
    rev: 2,
    ...overrides,
  }
}

describe('calendar DTO mapping', () => {
  it('keeps each Temporal kind', () => {
    expect(toDayFlowEvent(eventDto()).start).toBeInstanceOf(Temporal.ZonedDateTime)

    const allDay = toDayFlowEvent(eventDto({
      allDay: true,
      start: { value: '2026-10-26', type: 'date' },
      end: { value: '2026-10-27', type: 'date' },
    }))
    expect(allDay.start).toBeInstanceOf(Temporal.PlainDate)
    expect(allDay.end).toBeInstanceOf(Temporal.PlainDate)

    const floating = toDayFlowEvent(eventDto({
      start: { value: '2026-10-26T09:00', type: 'datetime' },
      end: { value: '2026-10-26T10:00', type: 'datetime' },
    }))
    expect(floating.start).toBeInstanceOf(Temporal.PlainDateTime)
  })

  it('maps recurrence, task completion and multi-calendar membership', () => {
    const event = toDayFlowEvent(eventDto({
      calendarIds: ['cal_team', 'cal_work'],
      meta: { originalUid: 'uid-1' },
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
      kind: 'task',
      task: {
        completed: true,
        completedAt: { value: '2026-10-25T18:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
        priority: 'high',
      },
    }))
    expect(event.meta?.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(event.meta?.originalUid).toBe('uid-1')
    expect(event.task?.completed).toBe(true)
    expect(event.task?.completedAt).toBeInstanceOf(Temporal.ZonedDateTime)
    expect(event.task?.priority).toBe('high')
    expect(eventCalendarIds(event).sort()).toEqual(['cal_team', 'cal_work'])
    expect(event.calendarIds).toContain('cal_work')
  })

  it('drops a conference URL the client cannot safely render', () => {
    const event = toDayFlowEvent(eventDto({
      conference: { provider: 'custom', joinUrl: 'javascript:alert(1)' },
    }))
    expect(event.conference).toBeUndefined()
  })

  it('serialises back to the API shape and strips render-only fields', () => {
    const event = toDayFlowEvent(eventDto({
      meta: { location: 'Room 4', _recurrenceKey: 'r1', day: 2, _recurrenceMasterId: 'master' },
      recurrenceRule: 'FREQ=DAILY',
      icon: true,
    }))
    const input = toEventInput(event, { fallbackTitle: 'Untitled', timeZone: 'Asia/Shanghai' })
    expect(input.id).toBe('evt_work')
    expect(input.calendarId).toBe('cal_work')
    expect(input.calendarIds).toEqual(['cal_work'])
    expect(input.recurrenceRule).toBe('FREQ=DAILY')
    expect(input.meta).toEqual({ location: 'Room 4', recurrenceRule: 'FREQ=DAILY' })
    expect(input.start).toEqual({ value: '2026-10-26T09:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' })
    expect(input.icon).toBe(true)
  })

  it('falls back to an untitled title and clears incomplete task dates', () => {
    const event = toDayFlowEvent(eventDto({ title: '   ', kind: 'task', task: { completed: false, priority: 'low' } }))
    const input = toEventInput(event, { fallbackTitle: 'Untitled', timeZone: 'UTC' })
    expect(input.title).toBe('Untitled')
    expect(input.task).toEqual({ completed: false, priority: 'low' })
  })

  it('maps a calendar with light and dark colours and read-only metadata', () => {
    const calendar = toCalendarType(calendarDto({ readOnly: true, source: 'ics', isDefault: false }))
    expect(calendar.id).toBe('cal_work')
    expect(calendar.isVisible).toBe(true)
    expect(calendar.readOnly).toBe(true)
    expect(calendar.source).toBe('ics')
    expect(calendar.colors.eventColor).toBeTruthy()
    expect(calendar.darkColors?.eventColor).toBeTruthy()
  })

  it('derives a storable dark colour for palette entries whose dark event colour is rgba', () => {
    for (const color of ['#3b82f6', '#f59e0b']) {
      expect(deriveDarkColor(color)).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('gives a search hit its calendar line colour', () => {
    const result = toSearchEvent({
      event: eventDto({ title: 'Search me' }),
      calendarName: 'Work',
      calendarColor: '#123456',
    })
    expect(result.title).toBe('Search me')
    expect(result.color).toBe('#123456')
  })

  it('keeps provider source and external identity when writing a remote event back', () => {
    const event = toDayFlowEvent(eventDto({
      source: 'caldav',
      meta: { caldav: { uid: 'uid-1@example.com', href: '/cal/1.ics' } },
    }))
    const input = toEventInput(event, { fallbackTitle: 'Untitled', timeZone: 'Asia/Shanghai' })
    expect(input.source).toBe('caldav')
    expect(input.externalId).toBe('uid-1@example.com')
    expect(calendarSourceOf('CalDAV')).toBe('caldav')
    expect(calendarSourceOf('Google')).toBe('google')
    expect(calendarSourceOf(undefined)).toBe('local')
  })

  it('projects zoned events onto the display timezone day', () => {
    const event = toDayFlowEvent(eventDto({
      start: { value: '2026-10-26T23:30:00-04:00[America/New_York]', type: 'zoned', timeZone: 'America/New_York' },
      end: { value: '2026-10-27T00:30:00-04:00[America/New_York]', type: 'zoned', timeZone: 'America/New_York' },
    }))
    expect(eventDateInZone(event.start, 'Asia/Shanghai').toString()).toBe('2026-10-27')
  })
})
