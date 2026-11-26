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
    history.finishReplay('a')

    expect(applyEventsChanges).toHaveBeenCalledTimes(1)
    expect(applyEventsChanges.mock.calls[0]?.[0]).toMatchObject({
      update: [{ id: 'a', updates: { title: 'A before' } }],
    })
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(true)
  })

  it('moves a redone entry back onto the undo stack', () => {
    const applyEventsChanges = vi.fn()
    const app = { applyEventsChanges } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    history.record({ id: 'a', before: event('a', 'A before'), after: event('a', 'A after') })
    expect(history.undo(app)).toBe(true)
    history.finishReplay('a')
    expect(history.redo(app)).toBe(true)
    history.finishReplay('a')
    expect(applyEventsChanges).toHaveBeenLastCalledWith(
      { update: [{ id: 'a', updates: expect.objectContaining({ title: 'A after' }) }] },
      false,
      'local',
    )
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it('keeps a hidden series rule through undo and redo', () => {
    const applyEventsChanges = vi.fn()
    const app = { applyEventsChanges } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    const before = { ...event('a', 'A before'), meta: { exdates: ['2026-10-27'], seriesRule: 'FREQ=DAILY;COUNT=8' } }
    const after = { ...event('a', 'A after'), meta: { exdates: ['2026-10-28'], seriesRule: 'FREQ=DAILY;COUNT=8' } }
    history.record({ id: 'a', before, after })

    history.undo(app)
    history.finishReplay('a')
    history.redo(app)
    history.finishReplay('a')

    expect(applyEventsChanges.mock.calls[0]?.[0]).toMatchObject({
      update: [{ id: 'a', updates: { meta: { exdates: ['2026-10-27'], seriesRule: 'FREQ=DAILY;COUNT=8' } } }],
    })
    expect(applyEventsChanges.mock.calls[1]?.[0]).toMatchObject({
      update: [{ id: 'a', updates: { meta: { exdates: ['2026-10-28'], seriesRule: 'FREQ=DAILY;COUNT=8' } } }],
    })
  })

  it('does not let the write queue turn a replay into a fresh entry', () => {
    const app = { applyEventsChanges: vi.fn() } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    const before = event('a', 'A before')
    const after = event('a', 'A after')
    history.record({ id: 'a', before, after })
    history.undo(app)
    // The persistence queue reports the replay after the synchronous call has returned.
    history.record({ id: 'a', before: after, after: before })
    expect(history.canRedo).toBe(true)
    expect(history.redo(app)).toBe(true)
    history.finishReplay('a')
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it('restores the original stack when a replay fails', () => {
    const app = { applyEventsChanges: vi.fn() } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    history.record({ id: 'a', before: event('a', 'A before'), after: event('a', 'A after') })
    expect(history.undo(app)).toBe(true)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    history.failReplay('a')
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    expect(history.undo(app)).toBe(true)
  })

  it('publishes replay settlement so controls can refresh after a refusal', () => {
    const app = { applyEventsChanges: vi.fn() } as unknown as ICalendarApp
    const history = new CalendarEditHistory()
    const listener = vi.fn()
    const unsubscribe = history.subscribe(listener)
    history.record({ id: 'a', before: event('a', 'A before'), after: event('a', 'A after') })
    listener.mockClear()

    history.undo(app)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(history.canUndo).toBe(false)
    history.failReplay('a')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(history.canUndo).toBe(true)

    unsubscribe()
    history.undo(app)
    expect(listener).toHaveBeenCalledTimes(2)
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
