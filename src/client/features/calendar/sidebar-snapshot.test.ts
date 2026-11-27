import { describe, expect, it } from 'vitest'
import type { CalendarType, Event, ICalendarApp } from '@dayflow/react'
import { readCalendarSidebarSnapshot, sameCalendarSidebarSnapshot, type CalendarSidebarSnapshot } from './sidebar-snapshot'

const event = { id: 'event-1' } as Event
const calendar = { id: 'calendar-1' } as CalendarType

function snapshot(overrides: Partial<CalendarSidebarSnapshot> = {}): CalendarSidebarSnapshot {
  return {
    events: [event],
    calendars: [calendar],
    date: 100,
    calendarSystem: 'gregorian',
    ...overrides,
  }
}

describe('calendar sidebar snapshots', () => {
  it('ignores selection, hover and other notifications that leave its data untouched', () => {
    const events = [event]
    const calendars = [calendar]
    const app = {
      getEvents: () => events,
      getCalendars: () => calendars,
      getCurrentDate: () => new Date(100),
      state: { calendarSystem: 'gregory', selectedEventId: 'event-1', highlightedEventId: null },
    } as unknown as ICalendarApp
    const before = readCalendarSidebarSnapshot(app)
    app.state.selectedEventId = null
    app.state.highlightedEventId = 'event-1'
    const after = readCalendarSidebarSnapshot(app)
    expect(sameCalendarSidebarSnapshot(before, after)).toBe(true)
  })

  it('refreshes for event edits, calendar replacement or reorder, date and calendar-system changes', () => {
    const before = snapshot()
    expect(sameCalendarSidebarSnapshot(before, snapshot({ events: [{ ...event }] }))).toBe(false)
    expect(sameCalendarSidebarSnapshot(before, snapshot({ calendars: [{ ...calendar }] }))).toBe(false)
    expect(sameCalendarSidebarSnapshot(before, snapshot({ calendars: [] }))).toBe(false)
    expect(sameCalendarSidebarSnapshot(before, snapshot({ date: 101 }))).toBe(false)
    expect(sameCalendarSidebarSnapshot(before, snapshot({ calendarSystem: 'jalali' }))).toBe(false)
  })
})
