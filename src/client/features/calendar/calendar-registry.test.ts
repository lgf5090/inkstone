import { describe, expect, it, vi } from 'vitest'
import type { CalendarType, ICalendarApp } from '@dayflow/react'
import type { CalendarDto } from '@shared/calendar/model'
import {
  applyCalendarOrder,
  calendarCreateInput,
  calendarNeedsUpdate,
  calendarPatch,
} from './calendar-registry'

function calendar(overrides: Partial<CalendarType> = {}): CalendarType {
  return {
    id: 'cal-1',
    name: 'Home',
    colors: { lineColor: '#112233', eventColor: '#112233', eventSelectedColor: '#112233', textColor: '#112233' },
    darkColors: { lineColor: '#445566', eventColor: '#445566', eventSelectedColor: '#445566', textColor: '#445566' },
    icon: null,
    isDefault: true,
    isVisible: true,
    readOnly: false,
    source: 'local',
    ...overrides,
  } as CalendarType
}

function dto(): CalendarDto {
  return {
    id: 'cal-1',
    name: 'Home',
    color: '#112233',
    darkColor: '#445566',
    icon: null,
    isDefault: true,
    isVisible: true,
    readOnly: false,
    rev: 4,
  } as CalendarDto
}

describe('calendar registry assembly', () => {
  it('builds no patch for an equivalent calendar', () => {
    expect(calendarPatch(dto(), calendar())).toEqual({})
    expect(calendarNeedsUpdate(calendar(), calendar())).toBe(false)
  })

  it('collects only changed fields and carries the dark line color with a color change', () => {
    const changed = calendar({
      name: 'Work',
      colors: { lineColor: '#abcdef', eventColor: '#abcdef', eventSelectedColor: '#abcdef', textColor: '#abcdef' },
      darkColors: { lineColor: '#fedcba', eventColor: '#fedcba', eventSelectedColor: '#fedcba', textColor: '#fedcba' },
      readOnly: true,
      isVisible: false,
      isDefault: false,
    })
    expect(calendarPatch(dto(), changed)).toEqual({
      name: 'Work',
      color: '#abcdef',
      darkColor: '#fedcba',
      readOnly: true,
      isVisible: false,
      isDefault: false,
    })
    expect(calendarNeedsUpdate(calendar(), changed)).toBe(true)
  })

  it('maps a DayFlow calendar into the server create contract', () => {
    expect(calendarCreateInput(calendar({ isVisible: false, readOnly: true }))).toEqual({
      id: 'cal-1',
      name: 'Home',
      color: '#112233',
      darkColor: '#445566',
      isDefault: true,
      isVisible: false,
      readOnly: true,
      source: 'local',
    })
  })

  it('performs the required moves and ignores absent ids', () => {
    let ids = ['cal-1', 'cal-2', 'cal-3']
    const reorderCalendars = vi.fn((from: number, to: number) => {
      const [moved] = ids.splice(from, 1)
      if (moved) ids.splice(to, 0, moved)
    })
    const app = {
      getCalendars: () => ids.map(id => ({ id })),
      reorderCalendars,
    } as unknown as ICalendarApp

    applyCalendarOrder(app, ['cal-3', 'cal-2', 'cal-1', 'missing'])
    expect(ids).toEqual(['cal-3', 'cal-2', 'cal-1'])
    expect(reorderCalendars).toHaveBeenCalledTimes(2)
    expect(reorderCalendars).toHaveBeenNthCalledWith(1, 2, 0)
    expect(reorderCalendars).toHaveBeenNthCalledWith(2, 2, 1)

    reorderCalendars.mockClear()
    applyCalendarOrder(app, ['cal-3', 'cal-2', 'cal-1'])
    expect(reorderCalendars).not.toHaveBeenCalled()
  })
})
