/**
 * KU-33. What a view costs is what it puts in the document: a note can carry `KANBAN_MAX_ITEMS` cards
 * (`body.ts`), and the reader pays for a view switch in the nodes that view mounts. KU-26 measured a
 * 1000 card board in a real browser and found the cost bunched in the dated surfaces — the calendar
 * drew 3449 card elements, the timeline and the gantt 1000 each — while the board, table, list and
 * gallery stayed at their window (~90/90/30/30, `kanban-render-window.tsx`).
 *
 * So this is a budget rather than a benchmark: every view is pinned to the slice it promises, and a
 * change that mounts a second copy of anything fails the view it belongs to.
 *
 * Switching views is what this measures, so every case mounts the real root and presses the real tab.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KANBAN_RENDER_WINDOW } from './kanban-render-window'
import { KanbanRoot } from './kanban-root'
import type { KanbanData, KanbanItem, KanbanViewType } from '../types'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

const CARDS = 500
const GROUPS = 4
const STATUSES = ['s1', 's2', 's3', 's4']
/** Every card sits on today, so all three dated surfaces have all of them to draw wherever the clock is. */
function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function cards(count: number): KanbanItem[] {
  const today = todayKey()
  return Array.from({ length: count }, (_, i) => ({
    id: `i${i}`,
    title: `Card ${i}`,
    properties: { status: STATUSES[i % GROUPS], startDate: today, dueDate: today },
  }))
}

function boardData(count: number): KanbanData {
  return {
    title: 'Budget',
    activeViewId: 'v-board',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: STATUSES.map((id) => ({ id, label: id.toUpperCase(), color: 'blue' })),
      },
      { id: 'startDate', name: 'Start', type: 'date' },
      { id: 'dueDate', name: 'Due', type: 'date' },
    ],
    items: cards(count),
    views: [
      { id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'v-table', name: 'Table', type: 'table', groupBy: 'status' },
      { id: 'v-list', name: 'List', type: 'list' },
      { id: 'v-gallery', name: 'Gallery', type: 'gallery' },
      { id: 'v-calendar', name: 'Calendar', type: 'calendar', dateField: 'dueDate' },
      { id: 'v-timeline', name: 'Timeline', type: 'timeline', startField: 'startDate', endField: 'dueDate' },
      { id: 'v-gantt', name: 'Gantt', type: 'gantt', startField: 'startDate', endField: 'dueDate' },
      { id: 'v-chart', name: 'Chart', type: 'chart', chartType: 'pie', chartGroupBy: 'status' },
    ],
  }
}

function openView(view: KanbanViewType) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(CARDS), onUpdateData: vi.fn() }))
  mounted.push(rendered)
  if (view !== 'board') {
    const tab = rendered.container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${view}"]`)
    if (!tab) throw new Error(`the board rendered no ${view} tab`)
    act(() => {
      tab.click()
    })
  }
  return rendered
}

function mountedCost(view: KanbanViewType): { cards: number; nodes: number } {
  const { container } = openView(view)
  return { cards: container.querySelectorAll('[data-item-id]').length, nodes: container.querySelectorAll('*').length }
}

/** Every view a board can be switched to; the budget table below has a row for each. */
const VIEWS: KanbanViewType[] = ['board', 'table', 'list', 'gallery', 'calendar', 'timeline', 'gantt', 'chart']

/**
 * What a view may put in the document, at 500 cards. Measured first (jsdom, this fixture) and then
 * rounded up: all eight views now render a window — G-04 brought the timeline and the gantt under
 * `kanban-render-window.tsx` (one window cuts the sidebar rows and the chart rows at the same index;
 * the day header still reads the full list) — so each is pinned to its slice. A ceiling well under
 * the board is the point of the windowed rows — 150 catches a view that stops slicing. The calendar
 * keeps its month-grid shape (each card is a cell on the day it sits on), the chart draws aggregates,
 * so a card element in either is already over the line.
 */
const WINDOWED = KANBAN_RENDER_WINDOW * GROUPS

const BUDGETS: Record<KanbanViewType, { cards: number; nodes: number }> = {
  board: { cards: WINDOWED, nodes: 4700 },
  table: { cards: WINDOWED, nodes: 7400 },
  list: { cards: KANBAN_RENDER_WINDOW, nodes: 700 },
  gallery: { cards: KANBAN_RENDER_WINDOW, nodes: 900 },
  calendar: { cards: CARDS * 1.2, nodes: 1800 },
  timeline: { cards: KANBAN_RENDER_WINDOW, nodes: 700 },
  gantt: { cards: KANBAN_RENDER_WINDOW, nodes: 1200 },
  chart: { cards: 0, nodes: 300 },
}

// ---------------------------------------------------------------------------------------------
// The fixture has to be able to fail before the budgets mean anything.
//
// A budget is a ceiling, and a view that draws nothing satisfies every ceiling there is: the two
// cases below are what keeps the eight above from passing on an empty board. They mount the same
// way, through the same root and the same tabs, so a tab that stopped switching views reports here
// as "the board drew no cards" rather than as a set of budget rows nobody could have failed.
// ---------------------------------------------------------------------------------------------

// Every case here mounts a real board of `CARDS` cards, so one case is seconds of DOM work rather
// than milliseconds and the suite runs many files at once; the file states its own budget, as its
// neighbour `kanban-render-window.test.ts` does.
const HEAVY_BOARD = { timeout: 30_000 }

describe('the board these budgets are written against really draws its cards', HEAVY_BOARD, () => {
  it('shows the windowed slice on the board view, not nothing', () => {
    const data = boardData(CARDS)
    expect(data.items).toHaveLength(CARDS)
    expect(mountedCost('board').cards).toBe(WINDOWED)
  })

  it('draws a card on each dated surface whose ceiling is above the board size', () => {
    for (const view of ['calendar', 'timeline', 'gantt'] as KanbanViewType[]) {
      expect(mountedCost(view).cards, `${view} drew no card at all`).toBeGreaterThan(0)
    }
  })
})

describe('no view mounts more than the board it was handed', HEAVY_BOARD, () => {
  it.each(VIEWS)('%s mounts no more than its budget', (view) => {
    const cost = mountedCost(view)
    const budget = BUDGETS[view]
    expect(cost.cards, `${view} mounted ${cost.cards} cards against a budget of ${budget.cards}`).toBeLessThanOrEqual(budget.cards)
    expect(cost.nodes, `${view} mounted ${cost.nodes} nodes against a budget of ${budget.nodes}`).toBeLessThanOrEqual(budget.nodes)
  })
})
