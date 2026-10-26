import { Temporal } from 'temporal-polyfill'
import { describe, expect, it, vi } from 'vitest'
import type { Event, ICalendarApp } from '@dayflow/react'
import { CalendarEditHistory } from './history'

function event(id: string, title: string): Event {
  return {
    id,
    title,
    start: Temporal.ZonedDateTime.from('2026-10-26T09:00:00+00:00[UTC]'),
    end: Temporal.ZonedDateTime.from('2026-10-26T10:00:00+00:00[UTC]'),
    allDay: false,
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
    meta: {},
  }
}

describe('calendar edit history', () => {
  it('undoes the entry a toast names rather than whatever was recorded last', () => {
    const applyEventsChanges = vi.fn()
    const app = { applyEventsChanges } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    history.record({ id: 'a', before: event('a', 'A before'), after: event('a', 'A after') })
    history.record({ id: 'b', before: event('b', 'B before'), after: event('b', 'B after') })

    expect(history.undo(app, 'a')).toBe(true)

    expect(applyEventsChanges).toHaveBeenCalledTimes(1)
    expect(applyEventsChanges.mock.calls[0]?.[0]).toMatchObject({
      update: [{ id: 'a', updates: { title: 'A before' } }],
    })
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(true)
  })

  it('falls back to the newest entry when no id is named', () => {
    const applyEventsChanges = vi.fn()
    const app = { applyEventsChanges } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    history.record({ id: 'a', before: event('a', 'A before'), after: event('a', 'A after') })
    history.record({ id: 'b', before: event('b', 'B before'), after: event('b', 'B after') })

    expect(history.undo(app)).toBe(true)
    expect(applyEventsChanges.mock.calls[0]?.[0]).toMatchObject({
      update: [{ id: 'b', updates: { title: 'B before' } }],
    })
  })
})
