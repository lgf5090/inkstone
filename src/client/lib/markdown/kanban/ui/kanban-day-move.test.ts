/**
 * KU-21b. The calendar drew a bar per card and the bar answered one press — it opened the card. A
 * board's dates could be changed from this view only by opening the detail dialog, scrolling to the
 * date field and picking a day, which is the shape every other drag in this module replaced (KU-21a
 * did it for the two time views). Now the bar is draggable and the cells are the drop targets, so
 * what is asserted here is the wiring rather than the arithmetic: a real dragstart on a bar and a
 * real drop on another day cell reaches the board's writer once, with the patch the pure layer names
 * (`calendar-helpers.test.ts` pins that); the keyboard gets the same move one day at a time; and a
 * drop made with no bar in flight writes nothing, because a cell that can receive a drop from
 * anywhere must not invent a card to move.
 */
import { act, createElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanItem } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
  // The calendar opens on the month `new Date()` is in, so a fixture written in September stopped
  // drawing its bar the day the clock rolled into October. Only `Date` is faked: the drag and drop
  // path itself uses real timers, and freezing those would change what these cases exercise.
  vi.useFakeTimers({ now: new Date('2026-09-15T12:00:00Z'), toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

const CARD: KanbanItem = {
  id: 'i1',
  title: 'Ship it',
  properties: { status: 's1', startDate: '2026-09-10', dueDate: '2026-09-14' },
}

function boardData(): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'v-cal',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 's1', label: 'To Do', color: 'blue' }] },
      { id: 'startDate', name: 'Start', type: 'date' },
      { id: 'dueDate', name: 'Due', type: 'date' },
    ],
    items: [{ ...CARD }],
    views: [{ id: 'v-cal', name: 'Calendar', type: 'calendar', dateField: 'startDate' }],
  }
}

/** September 2026 opens on a Tuesday with the 10th in its second week; any cell of the grid is reachable. */
function openCalendar() {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(), onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function barOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>('[data-item-id="i1"]')
  if (!bar) throw new Error('the calendar drew no bar for the card')
  return bar
}

function cellOf(container: HTMLElement, day: string): HTMLElement {
  const cells = [...container.querySelectorAll<HTMLElement>('[data-kanban-day-cell]')]
  const cell = cells.find((node) => node.dataset.kanbanDayCell === day)
  if (!cell) throw new Error(`the calendar drew no cell for ${day}`)
  return cell
}

function dragEvent(type: string, box: Map<string, string>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      setData: (format: string, value: string) => box.set(format, value),
      getData: (format: string) => box.get(format) ?? '',
      dropEffect: 'move',
      effectAllowed: 'move',
    },
  })
  return event
}

/** A drag the way the browser delivers it: the payload travels through `dataTransfer`. */
function dragBarTo(bar: HTMLElement, target: HTMLElement): void {
  const box = new Map<string, string>()
  act(() => {
    bar.dispatchEvent(dragEvent('dragstart', box))
  })
  act(() => {
    target.dispatchEvent(dragEvent('dragover', box))
  })
  act(() => {
    target.dispatchEvent(dragEvent('drop', box))
  })
}

function writtenCard(onUpdateData: Mock): KanbanItem {
  const call = onUpdateData.mock.calls.at(-1)
  if (!call) throw new Error('the board wrote nothing')
  const data = call[0] as KanbanData
  return data.items.find((item) => item.id === 'i1')!
}

describe('a bar dropped on another day moves the card there', () => {
  it('writes the drawn start column and keeps the bar span, in one commit', () => {
    const { container, onUpdateData } = openCalendar()
    dragBarTo(barOf(container), cellOf(container, '2026-09-17'))
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    const card = writtenCard(onUpdateData)
    expect(card.properties.startDate).toBe('2026-09-17')
    expect(card.properties.dueDate).toBe('2026-09-21')
  })

  it('moves a day earlier when the drop lands on the cell before', () => {
    const { container, onUpdateData } = openCalendar()
    dragBarTo(barOf(container), cellOf(container, '2026-09-09'))
    const card = writtenCard(onUpdateData)
    expect(card.properties.startDate).toBe('2026-09-09')
    expect(card.properties.dueDate).toBe('2026-09-13')
  })

  it('announces where the card went, in a region that was already in the document', () => {
    const { container } = openCalendar()
    const status = container.querySelector('[data-kanban-day-status]')
    expect(status?.getAttribute('role'), 'the region is there before it has anything to say').toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toBe('')
    dragBarTo(barOf(container), cellOf(container, '2026-09-17'))
    expect(container.querySelector('[data-kanban-day-status]')?.textContent).toContain(CARD.title)
  })
})

describe('a drop with no bar in flight writes nothing', () => {
  it('leaves the document alone when the drop carries no card', () => {
    const { container, onUpdateData } = openCalendar()
    dragBarTo(barOf(container), cellOf(container, '2026-09-17'))
    const writes = onUpdateData.mock.calls.length
    // The in-flight bar was cleared by the drop; a second drop on the same cell is a stray.
    act(() => {
      cellOf(container, '2026-09-17').dispatchEvent(dragEvent('drop', new Map()))
    })
    expect(onUpdateData).toHaveBeenCalledTimes(writes)
  })
})

describe('the same move from the keyboard, one day per press', () => {
  it('steps a day later on Shift+ArrowRight and back on Shift+ArrowLeft', () => {
    const { container, onUpdateData } = openCalendar()
    // The bar that moved is a new element (its column changed), so each press is read off the bar the
    // reader is now looking at — the same re-query a screen reader's focus would follow.
    act(() => {
      barOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    })
    expect(writtenCard(onUpdateData).properties.startDate).toBe('2026-09-11')
    expect(writtenCard(onUpdateData).properties.dueDate).toBe('2026-09-15')
    act(() => {
      barOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
    })
    expect(writtenCard(onUpdateData).properties.startDate).toBe('2026-09-10')
  })

  it('leaves the document alone for a press without Shift', () => {
    const { container, onUpdateData } = openCalendar()
    act(() => {
      barOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onUpdateData).not.toHaveBeenCalled()
  })
})
