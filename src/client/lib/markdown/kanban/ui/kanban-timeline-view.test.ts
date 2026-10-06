import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { TIMELINE_ZOOM_DAY_WIDTH } from '../timeline-helpers'
import { KanbanTimelineView } from './kanban-timeline-view'
import type { KanbanData, KanbanItem } from '../types'

beforeAll(async () => {
  await initI18n()
})

const MS_PER_DAY = 86400000

function dayKey(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, '0')}`
}

function renderTimeline(items: KanbanItem[]) {
  installTestGlobals()
  const data: KanbanData = { views: [], columns: [], items }
  const onOpenDetail = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(KanbanTimelineView, {
      data,
      view: undefined,
      onOpenDetail,
      onAddItem: vi.fn(),
      onReschedule: vi.fn(),
    }))
  })
  return { container, root, onOpenDetail }
}

function gridCells(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-timeline-day]')]
}

function barOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-item-id="${id}"]`)
}

function zoomOption(container: HTMLElement, label: string): HTMLButtonElement {
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((button) => button.textContent === label)
  expect(option, `the scale control offers no ${label}`).toBeDefined()
  return option!
}

describe('the timeline grid holds the cards the board actually dates', () => {
  it('draws a card months away inside the grid instead of past its last column', () => {
    const far = { id: 'far', title: 'Far out', properties: { startDate: dayKey(60), dueDate: dayKey(70) } }
    const { container, root } = renderTimeline([far])
    const bar = barOf(container, 'far')
    expect(bar, 'a card 60 days out has no bar at all').not.toBeNull()
    const left = Number.parseFloat(bar!.style.left)
    const width = Number.parseFloat(bar!.style.width)
    const gridWidth = gridCells(container).length * TIMELINE_ZOOM_DAY_WIDTH.day
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left + width, 'the bar reaches past the grid the reader can see').toBeLessThanOrEqual(gridWidth)
    // Not merely clamped into view: the window itself reached the card, so the bar is whole.
    expect(bar!.className).not.toContain('rounded-r-none')
    expect(bar!.className).not.toContain('rounded-l-none')
    act(() => root.unmount())
    container.remove()
  })

  it('opens on the window that holds today', () => {
    const { container, root } = renderTimeline([{ id: 'past', title: 'Last year', properties: { dueDate: dayKey(-300) } }])
    const today = gridCells(container).find((cell) => cell.dataset.timelineDay === dayKey(0))
    expect(today, 'today has no column in the window').toBeDefined()
    act(() => root.unmount())
    container.remove()
  })

  it('lists a card with no day beside the grid rather than drawing it on today', () => {
    const dated = { id: 'dated', title: 'Dated', properties: { dueDate: dayKey(2) } }
    const undated = { id: 'undated', title: 'No day at all', properties: {} }
    const { container, root, onOpenDetail } = renderTimeline([dated, undated])
    expect(barOf(container, 'dated')).not.toBeNull()
    expect(barOf(container, 'undated'), 'a card with no day was drawn on the grid').toBeNull()
    const list = container.querySelector<HTMLElement>('[data-kanban-timeline-undated]')!
    expect(list.textContent).toContain('No day at all')
    expect(list.textContent).toContain(t('preview.kanban_timeline_undated', { count: 1 }))
    act(() => {
      [...list.querySelectorAll('button')].find((button) => button.textContent?.includes('No day at all'))!.click()
    })
    expect(onOpenDetail).toHaveBeenCalledWith(undated)
    act(() => root.unmount())
    container.remove()
  })
})

describe('the timeline scale and the way back to today', () => {
  it('redraws the columns at the width each scale asks for, labelling fewer of them', () => {
    const span = { id: 'span', title: 'Span', properties: { startDate: dayKey(-20), dueDate: dayKey(20) } }
    const { container, root } = renderTimeline([span])
    const dayCells = gridCells(container)
    expect(dayCells[0]!.style.width).toBe(`${TIMELINE_ZOOM_DAY_WIDTH.day}px`)
    expect(dayCells.every((cell) => cell.textContent !== '')).toBe(true)

    act(() => zoomOption(container, t('preview.kanban_zoom_week')).click())
    const weekCells = gridCells(container)
    expect(weekCells.length).toBe(dayCells.length)
    expect(weekCells[0]!.style.width).toBe(`${TIMELINE_ZOOM_DAY_WIDTH.week}px`)
    expect(weekCells.filter((cell) => cell.textContent !== '').length).toBeLessThan(weekCells.length)

    act(() => zoomOption(container, t('preview.kanban_zoom_month')).click())
    expect(gridCells(container)[0]!.style.width).toBe(`${TIMELINE_ZOOM_DAY_WIDTH.month}px`)
    act(() => root.unmount())
    container.remove()
  })

})

describe('the today control and the window that had to be cut', () => {
  it('scrolls the grid to today when the reader asks for it', () => {
    const span = { id: 'span', title: 'Span', properties: { startDate: dayKey(-40), dueDate: dayKey(40) } }
    const { container, root } = renderTimeline([span])
    const grid = container.querySelector<HTMLElement>('[data-kanban-timeline-grid]')!
    let scrolled = 0
    Object.defineProperty(grid, 'scrollLeft', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 480 })

    act(() => container.querySelector<HTMLButtonElement>('[data-kanban-timeline-today]')!.click())
    const todayIndex = gridCells(container).findIndex((cell) => cell.dataset.timelineDay === dayKey(0))
    expect(todayIndex).toBeGreaterThan(0)
    expect(scrolled).toBe(todayIndex * TIMELINE_ZOOM_DAY_WIDTH.day - 240)
    act(() => root.unmount())
    container.remove()
  })

  it('says so when the board spans more days than the grid will draw', () => {
    const far = { id: 'far', title: 'Years apart', properties: { startDate: '2015-01-01', dueDate: '2035-01-01' } }
    const { container, root } = renderTimeline([far])
    const notice = container.querySelector<HTMLElement>('[data-kanban-timeline-clipped]')!
    expect(notice, 'a board spanning twenty years was drawn without comment').not.toBeNull()
    expect(notice.textContent).toContain('400')
    act(() => root.unmount())
    container.remove()
  })

  it('reports how many days a card may sit outside the window', () => {
    const twoCards = [
      { id: 'a', title: 'A', properties: { dueDate: dayKey(-1) } },
      { id: 'b', title: 'B', properties: { dueDate: dayKey(1) } },
    ]
    const { container, root } = renderTimeline(twoCards)
    expect(container.querySelector('[data-kanban-timeline-clipped]')).toBeNull()
    expect(Math.abs(new Date(dayKey(1)).getTime() - new Date(dayKey(0)).getTime())).toBe(MS_PER_DAY)
    act(() => root.unmount())
    container.remove()
  })
})
