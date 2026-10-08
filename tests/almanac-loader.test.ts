import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { almanacApi, requestAlmanac, useAlmanac } from '../src/client/lib/lunar/almanac-loader'
import { ActivityCalendar } from '../src/client/components/activity-calendar'
import { DEFAULT_DISPLAY_VIEW } from '../src/client/components/activity-calendar/props'
import type { ActivityCalendarProps } from '../src/client/components/activity-calendar/props'
import { renderElement } from '../src/client/lib/test-render'

// Han here is almanac output, so it is spelled out in the same vocabulary the calendar prints.
const ALMANAC_LOADER_FIXTURES = {
  todayLong: '丙午年八月廿八',
  todayCell: '廿八',
  todayMonthAndDay: '八月廿八',
}

// This file owns the loader's module-level state: vitest gives every file a fresh registry, so the
// "not loaded yet" assertions here cannot be polluted by another suite warming the chunk.
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5) }) })
    if (almanacApi() !== null)
      return
  }
}

function calendarProps(overrides: Partial<ActivityCalendarProps> = {}): ActivityCalendarProps {
  return {
    counts: new Map(),
    locale: 'en-US',
    weekStart: 1,
    today: new Date(2026, 9, 8),
    view: 'month',
    onViewChange: () => {},
    cursor: { year: 2026, month: 9 },
    onCursorChange: () => {},
    onDayClick: () => {},
    onDaySelect: () => {},
    onRangeSelect: () => {},
    onGapDayClick: () => {},
    onNoteClick: () => {},
    getDiaryId: () => null,
    ...overrides,
  }
}

describe('almanac loader', () => {
  it('never starts the download while both almanac switches are off', async () => {
    const off = renderElement(createElement(ActivityCalendar, calendarProps({
      display: { ...DEFAULT_DISPLAY_VIEW, lunar: false, festivals: false, todayCard: true },
    })))
    await settle()
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(almanacApi()).toBeNull()
    expect(off.container.querySelectorAll('[data-day-key]').length).toBeGreaterThan(0)
    expect(off.container.querySelector('[data-calendar-today-card]')?.textContent).not.toContain(ALMANAC_LOADER_FIXTURES.todayMonthAndDay)
    off.unmount()
    off.container.remove()
  })

  it('has nothing loaded before anything asks, and loads it once asked', async () => {
    expect(almanacApi()).toBeNull()
    requestAlmanac()
    await settle()
    const api = almanacApi()
    expect(api).not.toBeNull()
    expect(api!.almanacOf(new Date(2026, 9, 8))?.long).toBe(ALMANAC_LOADER_FIXTURES.todayLong)
    requestAlmanac()
    expect(almanacApi()).toBe(api)
  })

  it('leaves the first frame bare and fills it when the chunk lands', async () => {
    vi.resetModules()
    const loader = await import('../src/client/lib/lunar/almanac-loader')
    expect(loader.almanacApi()).toBeNull()
    const { ActivityCalendar: FreshCalendar } = await import('../src/client/components/activity-calendar')
    const { DEFAULT_DISPLAY_VIEW: bare } = await import('../src/client/components/activity-calendar/props')
    const rendered = renderElement(createElement(FreshCalendar, calendarProps({ display: { ...bare, lunar: true } })))
    expect(rendered.container.querySelector('[data-day-key="2026-10-08"] span[aria-hidden="true"]')).toBeNull()
    for (let i = 0; i < 40; i++) {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5) }) })
      if (loader.almanacApi() !== null)
        break
    }
    expect(loader.almanacApi()).not.toBeNull()
    expect(rendered.container.querySelector('[data-day-key="2026-10-08"] span[aria-hidden="true"]')?.textContent).toBe(ALMANAC_LOADER_FIXTURES.todayCell)
    rendered.unmount()
    rendered.container.remove()
  })
})

describe('useAlmanac', () => {
  it('answers null for a reader who switched the almanac off', () => {
    let seen: unknown = 'unset'
    function Probe() {
      seen = useAlmanac(false)
      return null
    }
    const rendered = renderElement(createElement(Probe))
    expect(seen).toBeNull()
    rendered.unmount()
    rendered.container.remove()
  })
})
