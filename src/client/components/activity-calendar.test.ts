import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { buildStripWeeks, buildYearHeatMeta, HEAT_PERCENTS, monthRangeToKeys, yearHeatLevel, DAY_NOTE_LIMIT, ActivityCalendar } from './activity-calendar'
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
  it('walks the weekday columns once the strip has focus, and returns to the card', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const first = container.querySelector('[data-month-card="8"] [data-weekday="0"]') as HTMLButtonElement
    expect(first.getAttribute('tabindex')).toBe('0')
    expect(container.querySelector('[data-month-card="3"] [data-weekday="0"]')!.getAttribute('tabindex')).toBe('-1')
    const card = container.querySelector('[data-month="8"]') as HTMLElement
    act(() => { card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); })
    expect(document.activeElement?.getAttribute('data-month')).toBe('7')
    const april = container.querySelector('[data-month-card="3"] [data-weekday="0"]') as HTMLButtonElement
    april.focus()
    key(april, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-weekday')).toBe('1')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-weekday')).toBe('2')
    expect(document.activeElement?.closest('[data-month-card]')?.getAttribute('data-month-card')).toBe('3')
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-month')).toBe('3')
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
      // Switching the view is not a jump: the flash belongs to the nonce, not to the mount.
      expect(captured).toHaveLength(1)
      act(() => { (container.querySelector('[aria-label*="sidebar.calendar_expand_week"]') as HTMLButtonElement).click(); })
      expect(captured).toHaveLength(2)
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

// C-05. The week panel used to render every note of every day it had ever shown and
// never unmount them, so the DOM under a collapsed panel grew with the busiest day of
// the vault rather than with what the reader can actually see.
describe('week panel note lists', () => {
  const DAY = '2026-09-02'
  const many = (count: number) => Array.from({ length: count }, (_, i) => ({
    id: `note-${i}`,
    title: `Note ${i}`,
    updatedAt: new Date(2026, 8, 2, 12).getTime() - i,
  }))

  function renderWeeks(count: number) {
    const selected: string[] = []
    const rendered = renderElement(createElement(ActivityCalendar, calendarProps({
      view: 'weeks',
      counts: new Map([[DAY, count]]),
      notesByDay: new Map([[DAY, many(count)]]),
      onDaySelect: (key) => { selected.push(key) },
    })))
    return { container: rendered.container, unmount: rendered.unmount, selected }
  }

  const noteRows = (root: HTMLElement) => [...root.querySelectorAll('button')].filter((b) => /^Note \d+$/.test(b.textContent?.trim() ?? ''))
  const weekColumn = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('[aria-label*="sidebar.calendar_expand_week"]')].at(-1)!
  const weekNotesToggle = (root: HTMLElement) => root.querySelector('[aria-label*="sidebar.calendar_week_notes"]') as HTMLButtonElement
  const dayToggle = (root: HTMLElement) => root.querySelector('[aria-label="sidebar.calendar_expand_day"]') as HTMLButtonElement
  const showAllRow = (root: HTMLElement) => root.querySelector('[aria-label^="sidebar.calendar_show_day_all"]')

  it('caps the week note list and hands the rest to the day filter', () => {
    const { container, selected, unmount } = renderWeeks(DAY_NOTE_LIMIT + 12)
    act(() => { weekColumn(container).click() })
    act(() => { weekNotesToggle(container).click() })
    expect(noteRows(container)).toHaveLength(DAY_NOTE_LIMIT)
    const row = showAllRow(container)
    expect(row).not.toBeNull()
    act(() => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(selected).toEqual([DAY])
    unmount()
  })

  it('caps the per-day row list the same way', () => {
    const { container, selected, unmount } = renderWeeks(DAY_NOTE_LIMIT + 7)
    act(() => { weekColumn(container).click() })
    act(() => { dayToggle(container).click() })
    expect(noteRows(container)).toHaveLength(DAY_NOTE_LIMIT)
    act(() => { showAllRow(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(selected).toEqual([DAY])
    unmount()
  })

  it('lists every note and offers no way out while the day fits under the cap', () => {
    const { container, unmount } = renderWeeks(5)
    act(() => { weekColumn(container).click() })
    act(() => { weekNotesToggle(container).click() })
    expect(noteRows(container)).toHaveLength(5)
    expect(showAllRow(container)).toBeNull()
    unmount()
  })

  it('drops a collapsed panel out of the DOM once its closing animation has run', () => {
    vi.useFakeTimers()
    try {
      const { container, unmount } = renderWeeks(5)
      act(() => { weekColumn(container).click() })
      act(() => { weekNotesToggle(container).click() })
      expect(noteRows(container)).toHaveLength(5)
      act(() => { weekColumn(container).click() })
      expect(weekNotesToggle(container)).not.toBeNull()
      act(() => { vi.advanceTimersByTime(100) })
      expect(weekNotesToggle(container)).not.toBeNull()
      act(() => { vi.advanceTimersByTime(400) })
      expect(showAllRow(container)).toBeNull()
      expect(weekNotesToggle(container)).toBeNull()
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })
})

interface Spy {
  ranges: string[][]
  cursors: { year: number; month: number }[]
  clicks: string[]
  selects: string[]
}

function spy(): Spy {
  return { ranges: [], cursors: [], clicks: [], selects: [] }
}

function interactive(props: Spy, overrides: Partial<ActivityCalendarProps> = {}) {
  let setView = (_view: 'month' | 'weeks' | 'year') => {}
  function Harness() {
    const [view, change] = useState<'month' | 'weeks' | 'year'>(overrides.view ?? 'month')
    const [cursor, setCursor] = useState(overrides.cursor ?? { year: 2026, month: 8 })
    setView = change
    return createElement('div', { style: { width: 260 } }, createElement(ActivityCalendar, calendarProps({
      ...overrides,
      view,
      cursor,
      onViewChange: (next) => { setView(next); overrides.onViewChange?.(next) },
      onRangeSelect: (start, end) => { props.ranges.push([start, end]) },
      onCursorChange: (next) => { props.cursors.push(next); setCursor(next) },
      onDayClick: (key) => { props.clicks.push(key) },
      onDaySelect: (key) => { props.selects.push(key) },
    })))
  }
  const rendered = renderElement(createElement(Harness))
  return { ...rendered, setView: (next: 'month' | 'weeks' | 'year') => act(() => { setView(next) }) }
}

const key = (element: Element, name: string, init: KeyboardEventInit = {}) => act(() => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }))
})
const pointer = (element: Element, type: string, init: MouseEventInit = {}) => act(() => {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
})
// React synthesizes onMouseEnter from a mouseover whose relatedTarget sits outside the element;
// a relatedTarget inside the grid is the pointer moving between two cells, which only the
// bubbling mouseover sees.
const hover = (element: Element, from: Element = document.body) => pointer(element, 'mouseover', { relatedTarget: from })

describe('year view card traversal', () => {
  it('walks from card to card with the left and right arrows', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const october = container.querySelector('[data-month="9"]') as HTMLElement
    october.focus()
    key(october, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-month')).toBe('10')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-month')).toBe('11')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-month')).toBe('11')
    key(document.activeElement!, 'ArrowLeft')
    expect(document.activeElement?.getAttribute('data-month')).toBe('10')
    unmount()
  })

  it('leaves the focused card’s weekday strip in the tab order', () => {
    const { container, unmount } = renderCalendar()
    act(() => { viewToggle(container)[2]!.click(); })
    const focused = container.querySelector('[data-month][tabIndex="0"]')?.closest('[data-month-card]')
    expect(focused).not.toBeNull()
    for (const button of focused!.querySelectorAll('[data-weekday]')) expect(button.getAttribute('tabindex')).toBe('0')
    const other = container.querySelector('[data-month-card="2"]')!
    for (const button of other.querySelectorAll('[data-weekday]')) expect(button.getAttribute('tabindex')).toBe('-1')
    unmount()
  })
})

describe('the drag state machine', () => {
  it('ignores a drag that starts on anything but the primary button', () => {
    const props = spy()
    const { container, unmount } = interactive(props)
    const from = container.querySelector('[data-day-key="2026-09-10"]')!
    pointer(from, 'mousedown', { button: 1 })
    hover(container.querySelector('[data-day-key="2026-09-12"]')!, container.querySelector('[data-day-key="2026-09-10"]')!)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(props.ranges).toEqual([])
    unmount()
  })

  it('drops a pending drag when the window loses focus', () => {
    const props = spy()
    const { container, unmount } = interactive(props)
    pointer(container.querySelector('[data-day-key="2026-09-10"]')!, 'mousedown', { button: 0 })
    hover(container.querySelector('[data-day-key="2026-09-20"]')!, container.querySelector('[data-day-key="2026-09-10"]')!)
    act(() => { window.dispatchEvent(new Event('blur')) })
    hover(container.querySelector('[data-day-key="2026-09-25"]')!, container.querySelector('[data-day-key="2026-09-20"]')!)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(props.ranges).toEqual([])
    unmount()
  })

  it('still commits a plain primary-button drag', () => {
    const props = spy()
    const { container, unmount } = interactive(props)
    pointer(container.querySelector('[data-day-key="2026-09-10"]')!, 'mousedown', { button: 0 })
    hover(container.querySelector('[data-day-key="2026-09-12"]')!, container.querySelector('[data-day-key="2026-09-10"]')!)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(props.ranges).toEqual([['2026-09-10', '2026-09-12']])
    unmount()
  })
})

describe('neighbouring-month cells', () => {
  it('stay out of a drag', () => {
    const props = spy()
    const { container, unmount } = interactive(props)
    pointer(container.querySelector('[data-day-key="2026-09-30"]')!, 'mousedown', { button: 0 })
    hover(container.querySelector('[data-day-key="2026-10-01"]')!, container.querySelector('[data-day-key="2026-09-30"]')!)
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    expect(props.ranges).toEqual([])
    unmount()
  })

  it('are marked as gap days and move the cursor to their own month when clicked', () => {
    const props = spy()
    const { container, unmount } = interactive(props)
    const gap = container.querySelector('[data-day-key="2026-10-01"]') as HTMLElement
    expect(gap.getAttribute('data-day-gap')).toBe('')
    pointer(gap, 'click')
    expect(props.clicks).toEqual(['2026-10-01'])
    expect(props.cursors).toContainEqual({ year: 2026, month: 9 })
    unmount()
  })
})

describe('the flash belongs to the jump, not the view', () => {
  it('does not replay when only the view changes', () => {
    const { captured, restore } = captureAnimations()
    try {
      const props = spy()
      const { container, unmount, setView } = interactive(props, { jumpFlash: 1 })
      expect(captured).toHaveLength(1)
      setView('weeks')
      // The switch has to be observable, or "no new animation" proves nothing.
      expect(container.querySelector('[data-day-key]')).toBeNull()
      expect(container.querySelector('[aria-label*="sidebar.calendar_expand_week"]')).not.toBeNull()
      expect(captured).toHaveLength(1)
      setView('month')
      expect(container.querySelector('[data-day-key]')).not.toBeNull()
      expect(captured).toHaveLength(1)
      unmount()
    }
    finally {
      restore()
    }
  })
})

describe('escape and the week expansions', () => {
  const expandedWeekButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]')]

  it('forgets the week expansions once that view is gone', () => {
    const props = spy()
    const { container, setView, unmount } = interactive(props, { view: 'weeks' })
    expect(expandedWeekButtons(container)).toHaveLength(0)
    act(() => { container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click() })
    expect(expandedWeekButtons(container).length).toBeGreaterThan(0)
    setView('month')
    setView('weeks')
    expect(expandedWeekButtons(container)).toHaveLength(0)
    unmount()
  })

  it('closes one rung per press and only claims the key when it did', () => {
    const props = spy()
    const { container, unmount } = interactive(props, {
      view: 'weeks',
      counts: new Map([['2026-09-02', 1]]),
      notesByDay: new Map([['2026-09-02', [{ id: 'n1', title: 'Note 1', updatedAt: new Date(2026, 8, 2, 12).getTime() }]]]),
    })
    const weeks = [...container.querySelectorAll<HTMLButtonElement>('[aria-label*="sidebar.calendar_expand_week"]')]
    act(() => { weeks[weeks.length - 1]!.click() })
    act(() => { container.querySelector<HTMLButtonElement>('[aria-label*="sidebar.calendar_expand_day"]')!.click() })
    act(() => { container.querySelector<HTMLButtonElement>('[aria-label*="sidebar.calendar_week_notes"]')!.click() })
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => { container.querySelector('button')!.dispatchEvent(event) })
      return event.defaultPrevented
    }
    expect(press()).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label*="sidebar.calendar_expand_day"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(press()).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label*="sidebar.calendar_week_notes"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(press()).toBe(true)
    expect([...container.querySelectorAll('button[aria-expanded="true"]')]).toHaveLength(0)
    expect(press()).toBe(false)
    unmount()
  })

  it('does not swallow Escape when it had nothing left to close', () => {
    const props = spy()
    const { container, setView, unmount } = interactive(props, { view: 'weeks' })
    act(() => { container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click() })
    setView('month')
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { container.querySelector('button')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    unmount()
  })
})

describe('the year range by keyboard', () => {
  it('anchors on the first Space and commits on the second', () => {
    const props = spy()
    const { container, unmount } = interactive(props, { view: 'year' })
    const april = container.querySelector('[data-month="3"]') as HTMLElement
    april.focus()
    key(april, ' ')
    expect(container.textContent).toContain('sidebar.calendar_year_range_hint_value0')
    const july = container.querySelector('[data-month="6"]') as HTMLElement
    july.focus()
    key(july, ' ')
    expect(props.ranges).toEqual([['2026-04-01', '2026-07-31']])
    expect(container.textContent).not.toContain('sidebar.calendar_year_range_hint_value0')
    unmount()
  })
})

describe('focus after a jump', () => {
  it('lands on the day it jumped to instead of the body', () => {
    const props = spy()
    const { container, unmount } = interactive(props, {
      view: 'weeks',
      counts: new Map([['2026-09-02', 1]]),
      notesByDay: new Map([['2026-09-02', [{ id: 'n1', title: 'Note 1', updatedAt: new Date(2026, 8, 2, 12).getTime() }]]]),
    })
    const weeks = [...container.querySelectorAll<HTMLButtonElement>('[aria-label*="sidebar.calendar_expand_week"]')]
    expect(weeks.length).toBeGreaterThan(0)
    act(() => { weeks[weeks.length - 1]!.click() })
    // The jump row lives inside the "this week's notes" block, which C-05 now unmounts
    // while closed, so the case has to open it the way a reader would.
    act(() => { (container.querySelector('[aria-label*="sidebar.calendar_week_notes"]') as HTMLButtonElement).click() })
    const jump = container.querySelector<HTMLButtonElement>('[aria-label*="sidebar.calendar_jump_to_day"]')
    expect(jump).not.toBeNull()
    act(() => { jump!.click() })
    const target = document.activeElement?.getAttribute('data-day-key')
    expect(target).toBe('2026-09-02')
    expect(props.selects).toContain('2026-09-02')
    unmount()
  })
})
