import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { ActivityCalendar } from './activity-calendar'
import type { ActivityCalendarProps } from './activity-calendar/props'
import { DEFAULT_DISPLAY_VIEW } from './activity-calendar/props'
import type { CalendarDisplayView } from '../lib/calendar-display-prefs'
import { renderElement } from '../lib/test-render'
import { monthTotalsOf, streaksOf, yearProgress } from '../lib/calendar-stats'

// What the calendar must paint under each day number, spelled the way a reader reads it.
const ALMANAC_WORDS = {
  day21: '廿一',
  monthEight: '八月',
  fifteen: '十五',
  midAutumn: '中秋节',
  midAutumnCell: '中秋',
  fullDay21: '七月廿一',
  fullDay25: '八月十五',
}

const ALMANAC_CELL_KEYS = ['2026-09-02', '2026-09-11', '2026-09-25'] as const

function display(overrides: Partial<CalendarDisplayView> = {}): CalendarDisplayView {
  return { ...DEFAULT_DISPLAY_VIEW, ...overrides }
}

function calendarProps(overrides: Partial<ActivityCalendarProps> = {}): ActivityCalendarProps {
  return {
    counts: new Map(),
    locale: 'en-US',
    weekStart: 1,
    today: new Date(2026, 8, 2),
    view: 'month',
    onViewChange: () => {},
    cursor: { year: 2026, month: 8 },
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

function render(overrides: Partial<ActivityCalendarProps> = {}) {
  return renderElement(createElement(ActivityCalendar, calendarProps(overrides)))
}

/**
 * The almanac is a separate chunk now, so a label assertion has to let it arrive first. Polling
 * rather than a fixed sleep keeps the suite honest on a loaded machine and on an idle one.
 */
async function settleAlmanac(container: HTMLElement) {
  for (let i = 0; i < 60; i++) {
    if (container.querySelector('[data-day-key] span[aria-hidden="true"]'))
      return
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5) }) })
  }
}

function dayButton(container: HTMLElement, key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-day-key="${key}"]`)
}

function subLabel(container: HTMLElement, key: string): string {
  const cell = dayButton(container, key)
  if (!cell)
    return '<missing cell>'
  return [...cell.querySelectorAll('span')]
    .filter((span) => span.getAttribute('aria-hidden') === 'true')
    .map((span) => span.textContent ?? '')
    .join('|')
}

const GRID = '[aria-label="sidebar.calendar_month_grid_aria"]'

function weekCells(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[data-week-number]')) as HTMLButtonElement[]
}

describe('month grid almanac labels', () => {
  it('prints the lunar day under every number when the switch is on', async () => {
    const { container, unmount } = render({ display: display({ lunar: true }) })
    await settleAlmanac(container)
    expect(subLabel(container, '2026-09-02')).toContain(ALMANAC_WORDS.day21)
    expect(subLabel(container, '2026-09-11')).toContain(ALMANAC_WORDS.monthEight)
    expect(subLabel(container, '2026-09-25')).toContain(ALMANAC_WORDS.fifteen)
    unmount()
    container.remove()
  })

  it('prints nothing under the number when the switch is off', () => {
    const { container, unmount } = render({ display: display() })
    for (const key of ALMANAC_CELL_KEYS)
      expect(subLabel(container, key)).toBe('')
    unmount()
    container.remove()
  })

  it('replaces the lunar day with the festival name, and only when festivals are on', async () => {
    const { container, unmount } = render({ display: display({ lunar: true, festivals: true }) })
    await settleAlmanac(container)
    expect(subLabel(container, '2026-09-25')).toContain(ALMANAC_WORDS.midAutumnCell)
    expect(subLabel(container, '2026-09-25')).not.toContain(ALMANAC_WORDS.fifteen)
    // The tile is squeezed to two characters; the accessible name keeps the whole one.
    expect(dayButton(container, '2026-09-25')?.getAttribute('aria-label')).toContain(ALMANAC_WORDS.midAutumn)
    unmount()
    container.remove()

    const lunarOnly = render({ display: display({ lunar: true, festivals: false }) })
    await settleAlmanac(lunarOnly.container)
    expect(subLabel(lunarOnly.container, '2026-09-25')).toContain(ALMANAC_WORDS.fifteen)
    expect(subLabel(lunarOnly.container, '2026-09-25')).not.toContain(ALMANAC_WORDS.midAutumnCell)
    lunarOnly.unmount()
    lunarOnly.container.remove()
  })

  it('carries the whole almanac line into the cell text and the accessible name', async () => {
    const { container, unmount } = render({ display: display({ lunar: true }) })
    await settleAlmanac(container)
    expect(subLabel(container, '2026-09-02')).toContain(ALMANAC_WORDS.day21)
    expect(dayButton(container, '2026-09-02')?.getAttribute('aria-label')).toContain(ALMANAC_WORDS.fullDay21)
    unmount()
    container.remove()
  })

  it('leaves a padding day without an almanac label', async () => {
    const { container, unmount } = render({ display: display({ lunar: true }) })
    await settleAlmanac(container)
    expect(subLabel(container, '2026-08-31')).toBe('')
    unmount()
    container.remove()
  })
})

describe('month grid week column', () => {
  it('numbers the rows of a Monday grid by ISO', () => {
    const { container, unmount } = render({ display: display({ weekNumbers: true }), weekStart: 1 })
    expect(weekCells(container).map((cell) => cell.textContent)).toEqual(['36', '37', '38', '39', '40'])
    unmount()
    container.remove()
  })

  it('follows the grid that draws it: the same month numbers differently by opening day', () => {
    // 2027 opens on a Friday, so a Monday grid leads with 2026's last ISO week while a Sunday grid
    // calls the row holding January 1st week 1. The reference calendar printed one ISO number
    // beside either grid, which is the disagreement this pins out.
    const monday = render({ display: display({ weekNumbers: true }), weekStart: 1, today: new Date(2027, 0, 15), cursor: { year: 2027, month: 0 } })
    expect(weekCells(monday.container).map((cell) => cell.textContent)).toEqual(['53', '1', '2', '3', '4'])
    monday.unmount()
    monday.container.remove()

    const sunday = render({ display: display({ weekNumbers: true }), weekStart: 0, today: new Date(2027, 0, 15), cursor: { year: 2027, month: 0 } })
    expect(weekCells(sunday.container).map((cell) => cell.textContent)).toEqual(['1', '2', '3', '4', '5', '6'])
    sunday.unmount()
    sunday.container.remove()
  })

  it('adds no column when the switch is off', () => {
    const { container, unmount } = render({ display: display() })
    expect(weekCells(container)).toHaveLength(0)
    expect(container.querySelector(GRID)?.className).toContain('grid-cols-7')
    unmount()
    container.remove()
  })

  it('filters to the whole row when a week number is clicked', () => {
    const onRangeSelect = vi.fn()
    const { container, unmount } = render({ display: display({ weekNumbers: true }), onRangeSelect })
    weekCells(container)[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onRangeSelect).toHaveBeenCalledWith('2026-09-07', '2026-09-13')
    unmount()
    container.remove()
  })
})

describe('month grid surface switches', () => {
  it('gives a quiet weekend cell its own tile only when the shading is on', () => {
    const on = render({ display: display({ weekendTint: true }) })
    expect(dayButton(on.container, '2026-09-05')?.className).toContain('bg-[var(--bg-inset)]')
    on.unmount()
    on.container.remove()

    const off = render({ display: display({ weekendTint: false }) })
    expect(dayButton(off.container, '2026-09-05')?.className).not.toContain('bg-[var(--bg-inset)]')
    off.unmount()
    off.container.remove()
  })

  it('never shades a weekend that already carries heat', () => {
    const { container, unmount } = render({
      display: display({ weekendTint: true }),
      counts: new Map([['2026-09-05', 4]]),
    })
    expect(dayButton(container, '2026-09-05')?.className).not.toContain('bg-[var(--bg-inset)]')
    expect(dayButton(container, '2026-09-05')?.style.backgroundColor).toContain('color-mix')
    unmount()
    container.remove()
  })

  it('drops the padding days to blank tiles when the switch is off', () => {
    const kept = render({ display: display() })
    expect(dayButton(kept.container, '2026-08-31')).not.toBeNull()
    kept.unmount()
    kept.container.remove()

    const hidden = render({ display: display({ showAdjacentDays: false }) })
    expect(dayButton(hidden.container, '2026-08-31')).toBeNull()
    expect(dayButton(hidden.container, '2026-09-02')).not.toBeNull()
    hidden.unmount()
    hidden.container.remove()
  })
})

describe('today bar and stats', () => {
  const BAR = '[aria-label="sidebar.calendar_today_card_aria_value0"]'

  it('mounts the today bar only when the switch asks for it', async () => {
    const on = render({ display: display({ todayCard: true, lunar: true }) })
    await settleAlmanac(on.container)
    expect(on.container.querySelector(BAR)?.textContent).toContain(ALMANAC_WORDS.fullDay21)
    on.unmount()
    on.container.remove()

    const off = render({ display: display({ todayCard: false }) })
    expect(off.container.querySelector(BAR)).toBeNull()
    off.unmount()
    off.container.remove()
  })

  it('filters to today when the bar is clicked', () => {
    const onDaySelect = vi.fn()
    const { container, unmount } = render({ display: display({ todayCard: true }), onDaySelect })
    container.querySelector(BAR)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onDaySelect).toHaveBeenCalledWith('2026-09-02')
    unmount()
    container.remove()
  })

  it('shows the stats row in the month view only, and only when asked', () => {
    const on = render({ display: display({ streakStats: true }) })
    expect(on.container.querySelector('[data-calendar-stats]')).not.toBeNull()
    on.unmount()
    on.container.remove()

    const year = render({ display: display({ streakStats: true }), view: 'year' })
    expect(year.container.querySelector('[data-calendar-stats]')).toBeNull()
    year.unmount()
    year.container.remove()

    const hidden = render({ display: display({ streakStats: false }) })
    expect(hidden.container.querySelector('[data-calendar-stats]')).toBeNull()
    hidden.unmount()
    hidden.container.remove()
  })
})

describe('calendar stats', () => {
  const days = (list: string[]) => new Map(list.map((key) => [key, 1]))

  it('counts a run that ends yesterday without breaking it at midnight', () => {
    const counts = days(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(streaksOf(counts, '2026-09-04')).toEqual({ current: 3, best: 3, lastActiveKey: '2026-09-03' })
    expect(streaksOf(counts, '2026-09-05')).toMatchObject({ current: 0, best: 3 })
  })

  it('counts today when today already has a note', () => {
    expect(streaksOf(days(['2026-09-03', '2026-09-04']), '2026-09-04').current).toBe(2)
  })

  it('keeps the longest run from elsewhere in the vault', () => {
    const streak = streaksOf(days(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-09-04']), '2026-09-04')
    expect(streak.current).toBe(1)
    expect(streak.best).toBe(4)
  })

  it('reports nothing for an empty vault', () => {
    expect(streaksOf(new Map(), '2026-09-04')).toEqual({ current: 0, best: 0, lastActiveKey: null })
  })

  it('totals the cursor month and ignores days outside it', () => {
    const totals = monthTotalsOf(new Map([
      ['2026-08-31', 9],
      ['2026-09-02', 3],
      ['2026-09-03', 3],
      ['2026-10-01', 5],
    ]), 2026, 8)
    expect(totals.total).toBe(6)
    expect(totals.activeDays).toBe(2)
    expect(totals.busiestKey).toBe('2026-09-02')
    expect(totals.busiestCount).toBe(3)
    expect(totals.coverage).toBe(Math.round((2 * 100) / 30))
  })

  it('places today inside its year', () => {
    expect(yearProgress(new Date(2026, 0, 1))).toEqual({ day: 1, total: 365, remaining: 364 })
    expect(yearProgress(new Date(2026, 11, 31))).toEqual({ day: 365, total: 365, remaining: 0 })
    expect(yearProgress(new Date(2024, 11, 31))).toMatchObject({ day: 366, total: 366 })
  })
})
