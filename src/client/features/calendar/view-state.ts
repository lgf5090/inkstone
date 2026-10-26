import { CALENDAR_VIEWS, type CalendarViewName } from '@shared/calendar/model'

export interface CalendarRouteState {
  view: CalendarViewName | null
  date: Date | null
}

function isView(value: string | null): value is CalendarViewName {
  return value !== null && (CALENDAR_VIEWS as readonly string[]).includes(value)
}

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null
}

export function readCalendarRouteState(search: string): CalendarRouteState {
  const params = new URLSearchParams(search)
  const view = params.get('view')
  return {
    view: isView(view) ? view : null,
    date: parseDate(params.get('date')),
  }
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Keep a calendar's view and day in the address bar without turning every edit into a history entry. */
export function calendarRouteHref(href: string, view: CalendarViewName, date: Date): string {
  const url = new URL(href)
  url.searchParams.set('view', view)
  url.searchParams.set('date', localDateKey(date))
  return `${url.pathname}${url.search}${url.hash}`
}