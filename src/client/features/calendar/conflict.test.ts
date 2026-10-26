import { describe, expect, it } from 'vitest'
import type { CalendarEventDto, CalendarEventInput } from '../../../shared/calendar/model'
import { conflictFields, mergeConflict } from './conflict'
import { t } from '../../lib/i18n'

function value(over: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: 'event-1',
    title: 'Standup',
    description: 'Bring the roadmap',
    kind: 'event',
    task: null,
    conference: null,
    start: { value: '2026-10-26T09:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
    end: { value: '2026-10-26T09:30:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
    allDay: false,
    calendarId: 'calendar-1',
    calendarIds: ['calendar-1'],
    meta: { location: 'Room 2' },
    icon: null,
    recurrenceRule: null,
    rev: 4,
    source: 'local',
    externalId: null,
    ...over,
  }
}

function inputOf(dto: CalendarEventDto): CalendarEventInput {
  return {
    id: dto.id,
    title: dto.title,
    description: dto.description,
    kind: dto.kind,
    task: dto.task,
    conference: dto.conference,
    start: dto.start,
    end: dto.end,
    allDay: dto.allDay,
    calendarId: dto.calendarId,
    calendarIds: dto.calendarIds,
    meta: dto.meta,
    icon: dto.icon,
    recurrenceRule: dto.recurrenceRule,
  }
}

const names = new Map([['calendar-1', 'Work'], ['calendar-2', 'Personal']])
const view = { locale: 'en-US', timeZone: 'Asia/Shanghai', calendarNames: names }

const moved = {
  start: { value: '2026-10-26T11:00:00+08:00[Asia/Shanghai]', type: 'zoned' as const, timeZone: 'Asia/Shanghai' },
  end: { value: '2026-10-26T11:30:00+08:00[Asia/Shanghai]', type: 'zoned' as const, timeZone: 'Asia/Shanghai' },
}

const allDay = {
  start: { value: '2026-10-26', type: 'date' as const },
  end: { value: '2026-10-27', type: 'date' as const },
  allDay: true,
}

function field(key: string, mine: CalendarEventInput, theirs: CalendarEventDto) {
  const found = conflictFields(mine, theirs, view).find((entry) => entry.key === key)
  if (!found) throw new Error(`no conflict field ${key}`)
  return found
}

describe('conflictFields', () => {
  it('marks only the parts that actually differ', () => {
    const theirs = value({ title: 'Standup moved', ...moved })

    expect(field('title', inputOf(value()), theirs).differs).toBe(true)
    expect(field('time', inputOf(value()), theirs).differs).toBe(true)
    expect(field('description', inputOf(value()), theirs).differs).toBe(false)
    expect(field('location', inputOf(value()), theirs).differs).toBe(false)
    expect(field('calendars', inputOf(value()), theirs).differs).toBe(false)
  })

  it('names the calendars instead of printing their ids', () => {
    const theirs = value({ calendarIds: ['calendar-1', 'calendar-2'], calendarId: 'calendar-1' })
    const shown = field('calendars', inputOf(value()), theirs)
    expect(shown.theirs).toContain('Work')
    expect(shown.theirs).toContain('Personal')
    expect(shown.theirs).not.toContain('calendar-')
  })

  it('compares calendars as a set, not as an order', () => {
    const mine = inputOf(value({ calendarIds: ['calendar-2', 'calendar-1'], calendarId: 'calendar-2' }))
    const theirs = value({ calendarIds: ['calendar-1', 'calendar-2'], calendarId: 'calendar-1' })
    expect(field('calendars', mine, theirs).differs).toBe(false)
  })

  it('shows an all-day range without a clock and a timed range with both ends', () => {
    const shown = field('time', inputOf(value(allDay)), value())
    expect(shown.mine).not.toMatch(/\d[:：]\d\d/)
    expect(shown.theirs).toMatch(/9:00/)
    expect(shown.theirs).toMatch(/9:30/)
  })

  it('says what an absent value is instead of leaving the row blank', () => {
    const mine = inputOf(value({ conference: null, recurrenceRule: null, meta: {} }))
    const theirs = value({
      conference: { joinUrl: 'https://meet.example/join' },
      recurrenceRule: 'FREQ=WEEKLY',
    })
    expect(field('meeting', mine, theirs).mine).toBe(t('calendar.conflict.unset'))
    expect(field('recurrence', mine, theirs).mine).toBe(t('calendar.conflict.none'))
    expect(field('location', mine, theirs).mine).toBe(t('calendar.conflict.unset'))
    expect(field('categories', mine, theirs).mine).toBe(t('calendar.conflict.unset'))
    expect(field('meeting', mine, theirs).theirs).toBe('https://meet.example/join')
  })

  it('labels every part it offers a choice about', () => {
    const keys = conflictFields(inputOf(value()), value(), view).map((entry) => entry.key)
    expect(keys).toEqual([
      'title', 'time', 'recurrence', 'calendars', 'description', 'location', 'categories', 'meeting',
    ])
    for (const entry of conflictFields(inputOf(value()), value(), view)) {
      expect(entry.label.trim()).not.toBe('')
    }
  })
})

describe('mergeConflict', () => {
  it('starts from the server copy and swaps only the picked parts', () => {
    const theirs = value({ title: 'Standup moved', description: 'Server note', ...moved })
    const merged = mergeConflict(inputOf(value()), theirs, { title: 'mine', time: 'mine' })

    expect(merged.title).toBe('Standup')
    expect(merged.start).toEqual(value().start)
    expect(merged.end).toEqual(value().end)
    expect(merged.description).toBe('Server note')
    expect(merged.id).toBe('event-1')
  })

  it('takes only the chosen part out of the other side’s metadata', () => {
    const theirs = value({ meta: { location: 'Room 9', caldav: { href: '/c/1.ics' } } })
    const mine = inputOf(value({ meta: { location: 'Room 2' } }))

    expect(mergeConflict(mine, theirs, { location: 'mine' }).meta).toEqual({
      location: 'Room 2',
      caldav: { href: '/c/1.ics' },
    })
    expect(mergeConflict(mine, theirs, {}).meta).toEqual({
      location: 'Room 9',
      caldav: { href: '/c/1.ics' },
    })
  })

  it('keeps an all-day range all-day and a timed range timed', () => {
    const mine = inputOf(value(allDay))

    expect(mergeConflict(mine, value(), { time: 'mine' }).allDay).toBe(true)
    expect(mergeConflict(mine, value(), {}).allDay).toBe(false)
  })

  it('pairs the calendar list with a primary calendar that is in it', () => {
    const theirs = value({ calendarIds: ['calendar-1'], calendarId: 'calendar-1' })
    const mine = inputOf(value({ calendarIds: ['calendar-2'], calendarId: 'calendar-2' }))

    const merged = mergeConflict(mine, theirs, { calendars: 'mine' })
    expect(merged.calendarIds).toEqual(['calendar-2'])
    expect(merged.calendarId).toBe('calendar-2')
  })

  it('carries the meeting link and its metadata together', () => {
    const theirs = value({ conference: { joinUrl: 'https://meet.example/server' }, meta: { url: 'https://x.example' } })
    const mine = inputOf(value({ conference: { joinUrl: 'https://meet.example/mine' }, meta: { url: 'https://mine.example' } }))

    const merged = mergeConflict(mine, theirs, { meeting: 'mine' })
    expect(merged.conference?.joinUrl).toBe('https://meet.example/mine')
    expect(merged.meta?.url).toBe('https://mine.example')
  })

  it('does not offer a choice about a part that was never different', () => {
    const theirs = value({ title: 'Standup moved' })
    const mine = inputOf(value({ description: 'Mine only' }))

    expect(conflictFields(mine, theirs, view).filter((entry) => entry.differs).map((entry) => entry.key))
      .toEqual(['title', 'description'])
    expect(mergeConflict(mine, theirs, {}).description).toBe(value().description)
  })
})
