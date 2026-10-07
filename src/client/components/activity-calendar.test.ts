import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { buildStripWeeks, buildYearHeatMeta, HEAT_PERCENTS, monthRangeToKeys, yearHeatLevel, ActivityCalendar } from './activity-calendar'
import type { ActivityCalendarProps } from './activity-calendar/props'
import { renderElement } from '../lib/test-render'

function stripOptions(overrides: Partial<Parameters<typeof buildStripWeeks>[1]> = {}): Parameters<typeof buildStripWeeks>[1] {
  return {
    range: { start: new Date(2026, 7, 31), end: new Date(2026, 8, 6) },
    weekStart: 1,
    todayKey: '2026-09-02',
    ...overrides,
  }
}

describe('buildStripWeeks', () => {
  it('builds a single aligned week when the range fits exactly', () => {
    const weeks = buildStripWeeks(new Map([
      ['2026-09-02', 3],
      ['2026-09-06', 1],
    ]), stripOptions())
    expect(weeks).toHaveLength(1)
    expect(weeks[0]!.map((cell) => cell.key)).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'])
    expect(weeks[0]![2]!.count).toBe(3)
    expect(weeks[0]![2]!.today).toBe(true)
    expect(weeks[0]![6]!.count).toBe(1)
  })

  it('aligns a mid-week range start backwards to the preceding week start', () => {
    const weeks = buildStripWeeks(new Map(), stripOptions({
      range: { start: new Date(2026, 8, 3), end: new Date(2026, 8, 8) },
    }))
    expect(weeks).toHaveLength(2)
    expect(weeks[0]![0]!.key).toBe('2026-08-31')
    expect(weeks[1]![0]!.key).toBe('2026-09-07')
  })

  it('scales heat levels against the busiest day in range', () => {
    const weeks = buildStripWeeks(new Map([
      ['2026-09-02', 3],
      ['2026-09-03', 2],
      ['2026-09-04', 1],
    ]), stripOptions())
    const [week] = weeks
    expect(week![2]!.level).toBe(4)
    expect(week![3]!.level).toBe(3)
    expect(week![4]!.level).toBe(1)
    expect(week![0]!.level).toBe(0)
  })

  it('defaults to the most recent 16 weeks when no range is given', () => {
    const weeks = buildStripWeeks(new Map(), {
      now: new Date(2026, 8, 2),
      weekStart: 1,
      todayKey: '2026-09-02',
    })
    expect(weeks).toHaveLength(16)
    expect(weeks[15]![0]!.key).toBe('2026-08-31')
    expect(weeks[15]![2]!.key).toBe('2026-09-02')
  })
})

describe('buildStripWeeks notes, selection and month ranges', () => {
  it('resolves diary ids, per-day note lists, and the selected day', () => {
    const notes = new Map([
      ['2026-09-02', [
        { id: 'n1', title: 'Note 1' },
        { id: 'n2', title: 'Note 2' },
      ]],
    ])
    const weeks = buildStripWeeks(new Map([['2026-09-02', 2]]), stripOptions({
      selectedRange: { start: '2026-09-02', end: '2026-09-04' },
      getDiaryId: (key) => (key === '2026-09-02' ? 'd9' : null),
      notesByDay: notes,
    }))
    expect(weeks[0]![2]!.diaryId).toBe('d9')
    expect(weeks[0]![2]!.selected).toBe(true)
    expect(weeks[0]![3]!.selected).toBe(true)
    expect(weeks[0]![4]!.selected).toBe(true)
    expect(weeks[0]![5]!.selected).toBe(false)
    expect(weeks[0]![2]!.notes.map((item) => item.id)).toEqual(['n1', 'n2'])
  })

  it('turns an inclusive month range into day keys covering whole months', () => {
    expect(monthRangeToKeys(2026, 8, 8)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(monthRangeToKeys(2026, 7, 8)).toEqual({ start: '2026-08-01', end: '2026-09-30' })
    expect(monthRangeToKeys(2026, 0, 11)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(monthRangeToKeys(2026, 11, 11)).toEqual({ start: '2026-12-01', end: '2026-12-31' })
  })

  it('normalizes reversed month ranges and leap-year February', () => {
    expect(monthRangeToKeys(2024, 11, 0)).toEqual({ start: '2024-01-01', end: '2024-12-31' })
    expect(monthRangeToKeys(2024, 1, 1)).toEqual({ start: '2024-02-01', end: '2024-02-29' })
  })
})

describe('buildYearHeatMeta and yearHeatLevel', () => {
  it('scales a day by the busiest month total, shared by the year view and the settings preview', () => {
    const burst = new Map([['2026-09-03', 12]])
    const burstMeta = buildYearHeatMeta(burst, 2026)
    expect(burstMeta.totals[8]).toBe(12)
    expect(burstMeta.yearMax).toBe(12)
    expect(yearHeatLevel(burst, burstMeta.yearMax, '2026-09-03')).toBe(4)
    // The same month total spread over thirty days keeps every one of them on the lightest level.
    const steady = new Map(Array.from({ length: 30 }, (_, day) => [`2026-09-${String(day + 1).padStart(2, '0')}`, 1]))
    const steadyMeta = buildYearHeatMeta(steady, 2026)
    expect(steadyMeta.yearMax).toBe(30)
    expect([...new Set([...steady.keys()].map((key) => yearHeatLevel(steady, steadyMeta.yearMax, key)))].sort()).toEqual([1])
    expect(yearHeatLevel(steady, steadyMeta.yearMax, '2026-01-01')).toBe(0)
  })
})

// jsdom has no layout engine, so these guards assert the anti-wrap CSS contract
// (whitespace-nowrap + truncate) instead of pixel measurement.
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

function renderCalendar(): { container: HTMLElement; unmount: () => void } {
  function Harness() {
    const [view, setView] = useState<'month' | 'weeks' | 'year'>('month')
    return createElement('div', { style: { width: 196 } }, createElement(ActivityCalendar, calendarProps({ view, onViewChange: setView })))
  }
  return renderElement(createElement(Harness))
}

function viewToggle(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label="sidebar.calendar_view"] button')]
}

describe('view toggle wrapping contract', () => {
  it('keeps the toggle buttons single-line inside the 196px sidebar budget', () => {
    const { container } = renderCalendar()
    const group = container.querySelector('[aria-label="sidebar.calendar_view"]')
    expect(group).not.toBeNull()
    expect(group!.classList.contains('overflow-hidden')).toBe(true)
    const buttons = viewToggle(container)
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.classList.contains('whitespace-nowrap')).toBe(true)
      expect(button.classList.contains('min-w-0')).toBe(true)
      expect(button.textContent).not.toContain('\n')
      expect(button.querySelector('span.truncate')).not.toBeNull()
    }
    container.remove()
  })

  it('renders the year grid with a weekday strip, clickable columns, and the measured column count', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const grid = container.querySelector('[aria-label="sidebar.calendar_year_grid_aria"]')
    expect(grid).not.toBeNull()
    expect(grid!.classList.contains('grid-cols-3')).toBe(true)
    const cards = [...grid!.querySelectorAll('[data-month-card]')]
    expect(cards).toHaveLength(12)
    for (const card of cards) {
      const weekdayColumns = [...card.querySelectorAll('button[aria-label^="sidebar.calendar_year_weekday"]')]
      // One seven-column row of clickable weekday labels above the heat cells.
      expect(weekdayColumns).toHaveLength(7)
      expect(card.querySelector('[data-month]')!.classList.contains('grid-cols-7')).toBe(true)
    }
    unmount()
  })

  it('moves the year focus by the measured column count (ArrowUp/Down)', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const september = container.querySelector('[data-month="8"]')
    expect(september).not.toBeNull();
    (september as HTMLElement).focus()
    act(() => { september!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-month')).toBe('11')
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-month')).toBe('8')
    unmount()
  })
})

describe('year view heat tiles', () => {
  it('tints only the days that have notes and draws every other day of the month as bare paper', () => {
    const { container, unmount } = renderElement(createElement(ActivityCalendar, calendarProps({
      view: 'year',
      counts: new Map([['2026-09-03', 1]]),
    })))
    const tiles = [...container.querySelectorAll<HTMLElement>('[data-month="8"] > span')]
    const tinted = tiles.filter((tile) => tile.style.backgroundColor.startsWith('color-mix'))
    const quiet = tiles.filter((tile) => tile.style.backgroundColor === 'var(--bg-surface)')
    // One note is the whole year's busiest day, so it lands on the darkest level AA allows, and it
    // mixes into the same paper the quiet tiles show, so the ramp is one object at four saturations.
    expect(tinted).toHaveLength(1)
    expect(tinted[0]!.style.backgroundColor).toBe(`color-mix(in oklab, var(--accent) ${HEAT_PERCENTS[4]}%, var(--bg-surface))`)
    expect(quiet.length + tinted.length).toBe(new Date(2026, 9, 0).getDate())
    // Neighbouring months' days draw nothing at all, so the paper run is what carries the month's shape.
    expect(tiles.length).toBeGreaterThan(quiet.length + tinted.length)
    for (const tile of tiles.filter((t) => !tinted.includes(t) && !quiet.includes(t))) expect(tile.style.backgroundColor).toBe('transparent')
    unmount()
  })
})

describe('year view keyboard and weekday behavior', () => {
  it('walks the focused card\'s weekday columns with arrows and returns to the card', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const september = container.querySelector('[data-month="8"]') as HTMLElement
    september.focus()
    act(() => { september.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-weekday')).toBe('0')
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-weekday')).toBe('2')
    expect(document.activeElement?.closest('[data-month-card]')?.getAttribute('data-month-card')).toBe('8')
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-month')).toBe('8')
    unmount()
  })

  it('respects a fixed columns preference over the measured width', () => {
    const { container, unmount } = renderElement(createElement('div', { style: { width: 196 } }, createElement(ActivityCalendar, calendarProps({ view: 'year', columnsPreference: '4' }))))
    const grid = container.querySelector('[aria-label="sidebar.calendar_year_grid_aria"]')
    expect(grid!.classList.contains('grid-cols-4')).toBe(true)
    unmount()
  })

  it('filters the week of the first tapped weekday and jumps to that month', () => {
    const ranges: string[][] = []
    const cursors: { year: number; month: number }[] = []
    const views: string[] = []
    function Harness() {
      const [view, setView] = useState<'month' | 'weeks' | 'year'>('year')
      return createElement('div', null, createElement(ActivityCalendar, calendarProps({
        view,
        onViewChange: (next) => { views.push(next); setView(next); },
        onCursorChange: (next) => { cursors.push(next); },
        onRangeSelect: (start, end) => { ranges.push([start, end]); },
      })))
    }
    const { container, unmount } = renderElement(createElement(Harness))
    // 2026-09 has the first Monday on the 7th: column 0 (Mon) filters 09-07..09-13.
    const monday = container.querySelector('[data-month-card="8"] button[aria-label^="sidebar.calendar_year_weekday"]')
    expect(monday).not.toBeNull()
    act(() => { (monday as HTMLButtonElement).click(); })
    expect(ranges).toEqual([['2026-09-07', '2026-09-13']])
    expect(cursors).toEqual([{ year: 2026, month: 8 }])
    expect(views).toEqual(['month'])
    unmount()
  })
})

function captureAnimations(): { captured: Array<{ duration?: number; keyframes: Keyframe[] }>; restore: () => void } {
  const captured: Array<{ duration?: number; keyframes: Keyframe[] }> = []
  const original = Element.prototype.animate
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    captured.push({ keyframes: [...keyframes], duration: typeof options?.duration === 'number' ? options.duration : undefined })
    return { cancel: () => {}, finished: Promise.resolve(), play: () => {}, pause: () => {} } as unknown as Animation
  }
  return { captured, restore: () => { Element.prototype.animate = original; } }
}

describe('jump flash transition', () => {
  it('fades the month grid in with an accent ring when an external jump arrives', () => {
    const { captured, restore } = captureAnimations()
    try {
      let bumpFlash = () => {}
      function Harness() {
        const [flash, setFlash] = useState(0)
        bumpFlash = () => setFlash((value) => value + 1)
        return createElement('div', null, createElement(ActivityCalendar, calendarProps({ view: 'month', jumpFlash: flash })))
      }
      const { unmount } = renderElement(createElement(Harness))
      expect(captured).toHaveLength(0)
      act(() => { bumpFlash(); })
      expect(captured).toHaveLength(1)
      expect(captured[0]!.duration).toBe(1100)
      expect(captured[0]!.keyframes[0]!.boxShadow).toContain('var(--accent)')
      expect(captured[0]!.keyframes[1]!.boxShadow).toContain('rgba(0, 0, 0, 0)')
      unmount()
    }
    finally {
      restore()
    }
  })
})

describe('internal jump flash', () => {
  it('flashes the same accent ring for gap-day follows and week clicks', () => {
    const { captured, restore } = captureAnimations()
    try {
      function Harness() {
        const [view, setView] = useState<'month' | 'weeks' | 'year'>('month')
        return createElement('div', null, createElement(ActivityCalendar, calendarProps({
          range: { start: new Date(2026, 6, 1), end: new Date(2026, 7, 31) },
          selectedRange: { start: '2026-07-01', end: '2026-07-31' },
          latestEditKey: '2026-08-05',
          view,
          onViewChange: setView,
        })))
      }
      const { container, unmount } = renderElement(createElement(Harness))
      const banner = container.querySelector('[aria-label*="sidebar.calendar_gap_banner"]')
      expect(banner).not.toBeNull()
      act(() => { banner!.dispatchEvent(new MouseEvent('click', { bubbles: true })); })
      expect(captured).toHaveLength(1)
      expect(captured[0]!.duration).toBe(1100)
      act(() => { viewToggle(container)[1]!.click(); })
      act(() => { (container.querySelector('[aria-label*="sidebar.calendar_expand_week"]') as HTMLButtonElement).click(); })
      expect(captured.length).toBeGreaterThan(2)
      unmount()
    }
    finally {
      restore()
    }
  })
})

// The root width used to be stored as the raw fractional `contentRect.width`, and the
// navigation panel animates its width over `--dur-slow` (AppShell.tsx:141), so one
// deliberate width change delivered roughly twenty distinct state updates and twenty
// whole-grid renders. `getDiaryId` is called once per day cell during the month grid's
// render, so counting its calls counts renders — the only way this is visible in jsdom,
// because a wasted render mutates no DOM.
describe('the measured root width', () => {
  const observed: { callback: ResizeObserverCallback; element: Element }[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    observed.length = 0
  })

  function installObserverSpy() {
    vi.stubGlobal('ResizeObserver', class SpyObserver {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }

      observe(element: Element) {
        observed.push({ callback: this.callback, element })
      }

      unobserve() {}
      disconnect() {}
    })
  }

  function tickWidth(width: number) {
    act(() => {
      for (const entry of observed)
        entry.callback([{ contentRect: { width } } as ResizeObserverEntry], null as unknown as ResizeObserver)
    })
  }

  function renderWidthProbe() {
    const counts = { renders: 0 }
    const rendered = renderElement(createElement('div', null, createElement(ActivityCalendar, calendarProps({
      view: 'month',
      columnsPreference: 'auto',
      getDiaryId: () => {
        counts.renders++
        return null
      },
    }))))
    return { counts, container: rendered.container, unmount: rendered.unmount }
  }

  it('re-renders nothing for width ticks that keep the same column bucket', () => {
    installObserverSpy()
    const { counts, unmount } = renderWidthProbe()
    expect(observed.length).toBe(1)
    tickWidth(320)
    const afterCrossing = counts.renders
    expect(afterCrossing).toBeGreaterThan(0)
    tickWidth(320.5)
    tickWidth(321.25)
    tickWidth(322)
    expect(counts.renders).toBe(afterCrossing)
    unmount()
  })

  it('still follows a width that crosses the column threshold', () => {
    installObserverSpy()
    const year = renderElement(createElement('div', null, createElement(ActivityCalendar, calendarProps({ view: 'year', columnsPreference: 'auto' }))))
    const grid = () => year.container.querySelector('[aria-label="sidebar.calendar_year_grid_aria"]')
    tickWidth(240)
    expect(grid()!.className).toContain('grid-cols-3')
    tickWidth(420)
    expect(grid()!.className).toContain('grid-cols-4')
    year.unmount()
  })

  it('does not observe the root at all when a fixed column count is preferred', () => {
    installObserverSpy()
    const { unmount } = renderWidthProbe()
    expect(observed.length).toBe(1)
    unmount()
    observed.length = 0
    const fixed = renderElement(createElement('div', null, createElement(ActivityCalendar, calendarProps({ view: 'month', columnsPreference: '4' }))))
    expect(observed.length).toBe(0)
    expect(fixed.container.querySelector('[aria-label="sidebar.calendar_view"]')).toBeTruthy()
    fixed.unmount()
  })
})
