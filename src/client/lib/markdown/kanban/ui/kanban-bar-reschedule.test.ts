/**
 * KU-21a. The timeline and the gantt drew a bar per card, and the only thing a bar could do was open
 * the card: a board's dates could be changed from these two views only by opening the detail dialog,
 * scrolling to the date field and picking a day. Every other surface in the module can be worked on
 * where the work is visible, so these two can too — a bar dragged sideways moves its days, and
 * `Shift`+arrow does the same from the keyboard.
 *
 * What is asserted here is the gesture as the browser delivers it: press, move, release, and the
 * commit that follows. jsdom lays nothing out, so the pointer's travel is the `clientX` the events
 * carry and one day is the 48px the day scale is drawn at — the arithmetic under test (travel to
 * days, days to a patch of columns) is the pure layer's and is pinned in `timeline-helpers.test.ts`;
 * what these cases are for is the wiring: that the drag reaches the board's writer at all, that it
 * reaches it once, and that a press which dragged is not also the press that opens the card.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n } from '../../../i18n'
import { formatDateKey } from '../../../time'
import { installTestGlobals, renderElement } from '../../../test-render'
import { TIMELINE_DAY_WIDTH } from '../timeline-helpers'
import type { KanbanData, KanbanItem } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  document.body.replaceChildren()
})

const CARD: KanbanItem = {
  id: 'i1',
  title: 'Ship it',
  properties: { status: 's1', startDate: '2026-06-10', dueDate: '2026-06-14' },
}

function boardData(view: 'timeline' | 'gantt'): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'v-1',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 's1', label: 'To Do', color: 'blue' }] },
      { id: 'startDate', name: 'Start', type: 'date' },
      { id: 'dueDate', name: 'Due', type: 'date' },
    ],
    items: [{ ...CARD }],
    views: [{ id: 'v-1', name: 'Time', type: view, startField: 'startDate', endField: 'dueDate' }],
  }
}

function openTimeView(view: 'timeline' | 'gantt' = 'timeline') {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(view), onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function barOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>('[data-item-id="i1"]')
  if (!bar) throw new Error('the time view drew no bar for the card')
  return bar
}

function press(element: HTMLElement, type: string, x: number): void {
  act(() => {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x }))
  })
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The card's detail, wherever the dialog puts it: the modal is portalled out of this container. */
function dialog(): Element | null {
  return document.querySelector('[role="dialog"]')
}

/** A press that travels: down, move, up — the three events a pointer drag sends, in order. */
function drag(bar: HTMLElement, dx: number): void {
  press(bar, 'pointerdown', 100)
  press(bar, 'pointermove', 100 + dx)
  press(bar, 'pointerup', 100 + dx)
}

function writtenCard(onUpdateData: Mock): KanbanItem {
  const call = onUpdateData.mock.calls.at(-1)
  if (!call) throw new Error('the board wrote nothing')
  const data = call[0] as KanbanData
  return data.items.find((item) => item.id === 'i1')!
}

describe('a bar dragged sideways moves the days its card is drawn by', () => {
  it('moves both days by the days the pointer crossed, in one commit', () => {
    const { container, onUpdateData } = openTimeView()
    drag(barOf(container), TIMELINE_DAY_WIDTH * 2)
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    const card = writtenCard(onUpdateData)
    expect(card.properties.startDate).toBe('2026-06-12')
    expect(card.properties.dueDate).toBe('2026-06-16')
  })

  it('moves the card the other way when the pointer travels left', () => {
    const { container, onUpdateData } = openTimeView()
    drag(barOf(container), -TIMELINE_DAY_WIDTH)
    const card = writtenCard(onUpdateData)
    expect(card.properties.startDate).toBe('2026-06-09')
    expect(card.properties.dueDate).toBe('2026-06-13')
  })

  it('carries the bar under the pointer while the drag is in flight, and writes nothing yet', () => {
    const { container, onUpdateData } = openTimeView()
    const bar = barOf(container)
    press(bar, 'pointerdown', 100)
    press(bar, 'pointermove', 100 + TIMELINE_DAY_WIDTH)
    expect(bar.style.transform).toBe('translateX(48px)')
    expect(onUpdateData).not.toHaveBeenCalled()
    press(bar, 'pointerup', 100 + TIMELINE_DAY_WIDTH)
    expect(bar.style.transform).toBe('')
    expect(onUpdateData).toHaveBeenCalledTimes(1)
  })
})

describe('a press that did not travel is still a press that opens the card', () => {
  it('leaves the document alone when the pointer never moved', () => {
    const { container, onUpdateData } = openTimeView()
    press(barOf(container), 'pointerdown', 100)
    press(barOf(container), 'pointerup', 100)
    expect(onUpdateData).not.toHaveBeenCalled()
  })

  it('opens the detail from a plain press', () => {
    const { container } = openTimeView()
    click(barOf(container))
    expect(dialog(), 'a plain press opens the card').not.toBeNull()
  })

  it('does not open the detail for the click that ends a drag', () => {
    const { container } = openTimeView()
    const bar = barOf(container)
    drag(bar, TIMELINE_DAY_WIDTH * 2)
    // The browser sends a click after the release; the bar has moved, so this is the drag's tail rather
    // than the reader asking for the card.
    click(bar)
    expect(dialog()).toBeNull()
    // …and the same press with no drag behind it does open it, so this is the drag's suppression rather
    // than a card whose detail never opens in this fixture.
    click(bar)
    expect(dialog()).not.toBeNull()
  })
})

describe('the same move from the keyboard, which is the only way without a pointer', () => {
  it('moves a day later on Shift+ArrowRight and a day earlier on Shift+ArrowLeft', () => {
    const { container, onUpdateData } = openTimeView()
    const bar = barOf(container)
    act(() => {
      bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    })
    expect(writtenCard(onUpdateData).properties.dueDate).toBe('2026-06-15')
    act(() => {
      bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))
    })
    expect(writtenCard(onUpdateData).properties.dueDate).toBe('2026-06-14')
  })

  it('announces where the card went, in a region that was already in the document', () => {
    const { container, onUpdateData } = openTimeView()
    const status = container.querySelector('[data-kanban-bar-status]')
    expect(status?.getAttribute('role'), 'the region is there before it has anything to say').toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toBe('')
    drag(barOf(container), TIMELINE_DAY_WIDTH * 2)
    const card = writtenCard(onUpdateData)
    const announced = container.querySelector('[data-kanban-bar-status]')?.textContent ?? ''
    expect(announced).toContain(CARD.title)
    expect(announced).toContain(formatDateKey(String(card.properties.dueDate)))
  })
})

describe('the gantt draws the same bar with the same gesture', () => {
  it('moves the days from a gantt bar', () => {
    const { container, onUpdateData } = openTimeView('gantt')
    drag(barOf(container), TIMELINE_DAY_WIDTH)
    const card = writtenCard(onUpdateData)
    expect(card.properties.startDate).toBe('2026-06-11')
    expect(card.properties.dueDate).toBe('2026-06-15')
  })
})
