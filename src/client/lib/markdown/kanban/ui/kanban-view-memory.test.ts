/**
 * KU-25. What a view remembers about how the reader last left it — folded columns, folded table
 * groups, the time scale, and how far the board was scrolled sideways.
 *
 * All four used to live in the view's own `useState`, and a view's node dies when the reader looks at
 * a different view: a folded column came back unfolded, and because React reuses the component
 * instance when two views of the same type follow one another, one board's folds were even carried
 * over onto the next board. The scale and the scroll had the same problem with no state at all.
 *
 * What is asserted here is therefore threefold: that each of the four survives a detour through
 * another view, that a fold belongs to the view it was made on rather than to the board, and — the
 * decision this item actually had to make — that none of it is written into the fence, because every
 * view write rewrites the whole note and none of these four is the board's shape. Reopening the board
 * starts clean, which is the price of that decision and is pinned below too.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { TIMELINE_ZOOM_DAY_WIDTH } from '../timeline-helpers'
import type { KanbanData, KanbanItem, KanbanView } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
  // jsdom lays nothing out, so an element has nowhere to keep a scroll offset and every pick-up of
  // what the board remembered would read back as zero. One store behind the property for the file is
  // what makes "came back where it was scrolled to" observable at all.
  const offsets = new WeakMap<Element, number>()
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      offsets.set(this, value)
    },
  })
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

const VIEWS: KanbanView[] = [
  { id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' },
  { id: 'v-second', name: 'Second board', type: 'board', groupBy: 'status' },
  { id: 'v-table', name: 'Table', type: 'table', groupBy: 'status' },
  { id: 'v-timeline', name: 'Timeline', type: 'timeline' },
  { id: 'v-gantt', name: 'Gantt', type: 'gantt' },
]

function dayKey(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

const ITEMS: KanbanItem[] = [
  { id: 'a', title: 'First card', properties: { status: 'todo', startDate: dayKey(-2), endDate: dayKey(2) } },
  { id: 'b', title: 'Second card', properties: { status: 'doing', startDate: dayKey(-1), endDate: dayKey(3) } },
]

function boardData(activeViewId: string): KanbanData {
  return {
    title: 'Memory board',
    activeViewId,
    views: VIEWS,
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'todo', label: 'To Do', color: 'gray' },
          { id: 'doing', label: 'Doing', color: 'blue' },
        ],
      },
    ],
    items: ITEMS,
  }
}

function mount(activeViewId = 'v-board') {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(activeViewId), onUpdateData }))
  mounted.push(rendered)
  return { container: rendered.container, onUpdateData }
}

/** Switches views the way the reader does: the tab strip the header draws, by its own name. */
function switchTo(container: HTMLElement, name: string): void {
  const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (element) => element.textContent?.trim() === name,
  )
  if (!tab) throw new Error(`the view strip offers no ${name}`)
  act(() => {
    tab.click()
  })
}

/** The strip a folded column narrows into: the only button that carries the group's own key. */
function foldedColumn(container: HTMLElement, groupKey: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`button[data-kanban-group="${groupKey}"]`)
}

/** The column's menu is where folding lives; the menu itself renders into a portal on `document`. */
function foldColumn(container: HTMLElement, groupKey: string): void {
  const column = container.querySelector<HTMLElement>(`div[data-kanban-group="${groupKey}"]`)
  const trigger = column?.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error(`column ${groupKey} draws no menu`)
  act(() => {
    trigger.click()
  })
  const row = [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === t('preview.kanban_collapse_column'),
  )
  if (!row) throw new Error('the column menu offers no fold')
  act(() => {
    row.click()
  })
}

/** The table's own fold control: the arrow in the group's header row. */
function foldTableGroup(container: HTMLElement): void {
  const toggle = container.querySelector<HTMLElement>('[role="row"] button[aria-expanded]')
  if (!toggle) throw new Error('the table group draws no fold control')
  act(() => {
    toggle.click()
  })
}

function tableGroupExpanded(container: HTMLElement): string | null {
  return container.querySelector('[role="row"] button[aria-expanded]')?.getAttribute('aria-expanded') ?? null
}

/** The scale control's selected option, read from the button the reader sees pressed. */
function selectedZoom(container: HTMLElement): string {
  const option = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (button) => button.getAttribute('aria-checked') === 'true',
  )
  return option?.textContent ?? ''
}

function zoomOption(container: HTMLElement, label: string): HTMLElement {
  const option = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (button) => button.textContent === label,
  )
  if (!option) throw new Error(`the scale control offers no ${label}`)
  return option
}

/** The first grid cell's width is what the chosen scale looks like on screen. */
function gridDayWidth(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('[data-timeline-day]')?.style.width ?? ''
}

function boardScroller(container: HTMLElement): HTMLElement {
  const board = container.querySelector<HTMLElement>('[data-kanban-board]')
  if (!board) throw new Error('the board draws no scroller')
  return board
}

function scrollBoardTo(container: HTMLElement, offset: number): void {
  const board = boardScroller(container)
  board.scrollLeft = offset
  act(() => {
    board.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

describe('a folded column', () => {
  it('is still folded after a look at another view', () => {
    const { container } = mount()
    foldColumn(container, 'todo')
    expect(foldedColumn(container, 'todo'), 'the fold never happened').not.toBeNull()

    switchTo(container, 'Table')
    switchTo(container, 'Board')
    expect(foldedColumn(container, 'todo'), 'the fold was thrown away with the view').not.toBeNull()
  })

  it('belongs to the view it was made on rather than to the board', () => {
    const { container } = mount()
    foldColumn(container, 'todo')

    switchTo(container, 'Second board')
    expect(foldedColumn(container, 'todo'), "one board's fold was carried onto the next").toBeNull()

    switchTo(container, 'Board')
    expect(foldedColumn(container, 'todo')).not.toBeNull()
  })
})

describe('a folded table group', () => {
  it('is still folded after a look at another view', () => {
    const { container } = mount('v-table')
    foldTableGroup(container)
    expect(tableGroupExpanded(container)).toBe('false')

    switchTo(container, 'Board')
    switchTo(container, 'Table')
    expect(tableGroupExpanded(container), 'the fold was thrown away with the view').toBe('false')
  })
})

describe('the time scale', () => {
  it('is still the reader\'s after a detour through another view', () => {
    const { container } = mount('v-timeline')
    act(() => {
      zoomOption(container, t('preview.kanban_zoom_week')).click()
    })
    expect(selectedZoom(container)).toBe(t('preview.kanban_zoom_week'))

    switchTo(container, 'Board')
    switchTo(container, 'Timeline')
    expect(selectedZoom(container), 'the scale fell back to a day').toBe(t('preview.kanban_zoom_week'))
    expect(gridDayWidth(container)).toBe(`${TIMELINE_ZOOM_DAY_WIDTH.week}px`)
  })

  it('is remembered per view, so the Gantt is not read at the timeline\'s scale', () => {
    const { container } = mount('v-timeline')
    act(() => {
      zoomOption(container, t('preview.kanban_zoom_month')).click()
    })

    switchTo(container, 'Gantt')
    expect(selectedZoom(container), "one view's scale was imposed on another").toBe(t('preview.kanban_zoom_day'))

    switchTo(container, 'Timeline')
    expect(selectedZoom(container)).toBe(t('preview.kanban_zoom_month'))
  })
})

describe('the board comes back where it was scrolled to', () => {
  it('picks the offset up again after a look at another view', () => {
    const { container } = mount()
    scrollBoardTo(container, 240)

    switchTo(container, 'Table')
    switchTo(container, 'Board')
    expect(boardScroller(container).scrollLeft, 'the board opened at its left edge again').toBe(240)
  })

  it('is not re-applied when the reader folds a column', () => {
    const { container } = mount()
    scrollBoardTo(container, 240)
    // Where the board stands can move without the memory hearing about it — the browser clamps the
    // offset when content gets narrower, and a programmatic scroll of its own does the same — so the
    // restore belongs to the mount alone. Keyed on the memory, it would run again on every fold and
    // pull the reader back to the last offset the memory was told about.
    boardScroller(container).scrollLeft = 400
    foldColumn(container, 'todo')
    expect(boardScroller(container).scrollLeft, 'a fold dragged the board back').toBe(400)
  })
})

describe('none of it is the document\'s business', () => {
  // Each gesture is made on a board that was mounted on the view it belongs to, and no tab is pressed
  // in between: which view is on screen *is* written to the fence (KU-16), so a switch would be a
  // write of its own and this would stop being a test about the gestures.
  it('writes nothing back for a fold or a scroll', () => {
    const { container, onUpdateData } = mount()
    expect(onUpdateData, 'the board writes as soon as it is mounted').not.toHaveBeenCalled()

    foldColumn(container, 'todo')
    scrollBoardTo(container, 120)
    expect(onUpdateData, 'a reading gesture rewrote the note').not.toHaveBeenCalled()
  })

  it('writes nothing back for a scale change', () => {
    const { container, onUpdateData } = mount('v-timeline')
    act(() => {
      zoomOption(container, t('preview.kanban_zoom_month')).click()
    })
    expect(onUpdateData, 'the scale was written into the fence').not.toHaveBeenCalled()
  })

  it('opens clean when the board is mounted again', () => {
    const first = mount()
    foldColumn(first.container, 'todo')
    expect(foldedColumn(first.container, 'todo')).not.toBeNull()
    mounted.pop()!.unmount()
    document.body.replaceChildren()

    const second = mount()
    expect(foldedColumn(second.container, 'todo'), 'a fold outlived the board that made it').toBeNull()
  })
})
