import { describe, expect, it } from 'vitest'
import { calendarRouteHref, readCalendarRouteState } from './view-state'

describe('calendar route state', () => {
  it('reads a valid view and local date, and ignores malformed values', () => {
    const state = readCalendarRouteState('?view=year&date=2027-06-15')
    expect(state.view).toBe('year')
    expect(state.date && [state.date.getFullYear(), state.date.getMonth() + 1, state.date.getDate()])
      .toEqual([2027, 6, 15])

    expect(readCalendarRouteState('?view=timeline&date=2027-02-31')).toEqual({ view: null, date: null })
  })

  it('writes the route without dropping other query parameters', () => {
    expect(calendarRouteHref(
      'https://notes.example.com/calendar?calendarConnect=done&x=1#today',
      'month',
      new Date(2026, 9, 26),
    )).toBe('/calendar?calendarConnect=done&x=1&view=month&date=2026-10-26#today')
  })
})
