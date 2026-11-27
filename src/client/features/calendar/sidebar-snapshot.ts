import type { CalendarType, Event, ICalendarApp } from '@dayflow/react'

export interface CalendarSidebarSnapshot {
  events: Event[]
  calendars: CalendarType[]
  date: number
  calendarSystem: ICalendarApp['state']['calendarSystem']
}

export function readCalendarSidebarSnapshot(app: ICalendarApp): CalendarSidebarSnapshot {
  return {
    events: app.getEvents(),
    calendars: app.getCalendars(),
    date: app.getCurrentDate().getTime(),
    calendarSystem: app.state.calendarSystem,
  }
}

export function sameCalendarSidebarSnapshot(left: CalendarSidebarSnapshot, right: CalendarSidebarSnapshot): boolean {
  return left.events === right.events
    && left.date === right.date
    && left.calendarSystem === right.calendarSystem
    && left.calendars.length === right.calendars.length
    && left.calendars.every((calendar, index) => calendar === right.calendars[index])
}
