import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { initI18n, t } from '../../../i18n'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'
import { KanbanCalendarView } from './kanban-calendar-view'
import { KanbanGanttView } from './kanban-gantt-view'
import { KanbanTimelineView } from './kanban-timeline-view'

/**
 * SH-110's shape, asked of the mounted views rather than of their source: a row, a bar and a day cell
 * are controls a keyboard can reach, and the rows open the detail when they are activated. In the
 * gantt and timeline views the row and the bar are one control with nothing inside them, so they are
 * real buttons — the browser's own Enter and Space activation is then what opens the detail, and
 * `scripts/e2e-visual.mjs` presses Enter on one to read that. The calendar's day cell is a container
 * of two controls (the number and the hover `+`), which is the shape the board's card has: as a cell
 * header that opened the day from a click handler it was both unreachable without a pointer and a
 * click target holding a button of its own.
 */
beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  await initI18n()
})

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function mount(element: ReturnType<typeof createElement>): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(element)
  })
}

const pad = (value: number) => String(value).padStart(2, '0')
function dateKey(offset: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const todayKey = dateKey(0)
const todayNumber = new Date().getDate()

const item: KanbanItem = {
  id: 'row-1',
  title: 'Row one',
  properties: { status: 'todo', startDate: todayKey, dueDate: dateKey(2), progress: 50 },
}

const columns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
]

function data(): KanbanData {
  return {
    title: 'Board',
    columns,
    views: [{ id: 'view-board', name: '', type: 'board', groupBy: 'status' }],
    items: [item],
  }
}

/** The buttons that carry a row's or a bar's own text — the two places this item is drawn. */
function itemControls(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.includes(item.title))
}

describe('the gantt view draws its rows and bars as real controls (SH-110)', () => {
  it('draws both as buttons a keyboard can reach', () => {
    mount(createElement(KanbanGanttView, { data: data(), onOpenDetail: vi.fn(), onAddItem: vi.fn(), onUpdateProgress: vi.fn(), onReschedule: vi.fn() }))
    const controls = itemControls()
    expect(controls.length).toBe(2)
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON')
      expect(control.getAttribute('type')).toBe('button')
      expect(control.tabIndex).toBe(0)
    }
    expect(document.querySelector('[data-item-id="row-1"]')?.tagName).toBe('BUTTON')
    expect(document.querySelectorAll('[role="button"]').length).toBe(0)
  })

  it('opens the detail from either of them', () => {
    const onOpenDetail = vi.fn()
    mount(createElement(KanbanGanttView, { data: data(), onOpenDetail, onAddItem: vi.fn(), onUpdateProgress: vi.fn(), onReschedule: vi.fn() }))
    for (const control of itemControls()) {
      act(() => control.click())
      expect(onOpenDetail).toHaveBeenCalledWith(item)
    }
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
  })

  // What Enter does with a focused button is the browser's own activation, and jsdom does not run it:
  // this asserts the part that can be asserted here (the row takes focus, which the `div` it used to
  // be could not) and `scripts/e2e-visual.mjs` presses Enter on a real one and reads the detail that
  // opens.
  it('takes focus, and it is the browser that activates it', () => {
    mount(createElement(KanbanGanttView, { data: data(), onOpenDetail: vi.fn(), onAddItem: vi.fn(), onUpdateProgress: vi.fn(), onReschedule: vi.fn() }))
    const row = itemControls().find((control) => control.textContent?.includes('%'))
    expect(row, 'the gantt draws a row for the item').toBeTruthy()
    row?.focus()
    expect(document.activeElement).toBe(row)
    expect(row?.tagName).toBe('BUTTON')
  })
})

describe('the timeline view draws its rows and bars as real controls (SH-110)', () => {
  it('draws both as buttons a keyboard can reach', () => {
    mount(createElement(KanbanTimelineView, { data: data(), onOpenDetail: vi.fn(), onAddItem: vi.fn(), onReschedule: vi.fn() }))
    const controls = itemControls()
    expect(controls.length).toBe(2)
    for (const control of controls) expect(control.tagName).toBe('BUTTON')
    expect(document.querySelector('[data-item-id="row-1"]')?.tagName).toBe('BUTTON')
    expect(document.querySelectorAll('[role="button"]').length).toBe(0)
  })

  it('opens the detail from either of them', () => {
    const onOpenDetail = vi.fn()
    mount(createElement(KanbanTimelineView, { data: data(), onOpenDetail, onAddItem: vi.fn(), onReschedule: vi.fn() }))
    for (const control of itemControls()) {
      act(() => control.click())
      expect(onOpenDetail).toHaveBeenCalledWith(item)
    }
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
  })
})

describe('the calendar day cell is a container whose number adds to that day (SH-110)', () => {
  it('names the day it adds to, on a control that is a button', () => {
    mount(createElement(KanbanCalendarView, { data: data(), onOpenDetail: vi.fn(), onAddItem: vi.fn() }))
    const label = t('preview.kanban_new_item_on_value0', { value0: todayNumber })
    const day = todayCell()
    expect(day, `a control named ${label} is drawn`).toBeTruthy()
    expect(day?.getAttribute('aria-label')).toBe(label)
    expect(day?.tagName).toBe('BUTTON')
    expect(day?.textContent).toBe(String(todayNumber))
    expect(document.querySelectorAll('[role="button"]').length).toBe(0)
  })

  it('adds an item on the day whose number is pressed', () => {
    const onAddItem = vi.fn()
    mount(createElement(KanbanCalendarView, { data: data(), onOpenDetail: vi.fn(), onAddItem }))
    const day = todayCell()
    act(() => day?.click())
    // The view hands the day over as the defaults for the new item, keyed by the view's own date
    // field (the root writes them onto the item it creates), not as a bare date string.
    expect(onAddItem).toHaveBeenCalledWith({ startDate: todayKey })
  })

  /**
   * The day number button of today's cell. It is addressed by the day it stands for: a month grid
   * starts in the last days of the previous month, so its number (e.g. the 30th) can appear twice and
   * the accessible name — which is only the number — cannot tell the two cells apart.
   */
  function todayCell(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`[data-day="${todayKey}"]`)
  }
})
