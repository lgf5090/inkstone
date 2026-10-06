/**
 * Moving a card between columns is the one board action whose result is nowhere but on screen: the
 * drop and the Shift+arrow chord both just re-render the columns, so a screen reader user hears
 * nothing at all and cannot tell which group the card landed in (review #29, K2-03e5). The board
 * therefore carries a polite live region, and both move paths — keyboard and pointer — report
 * through it. These cases pin the three behaviours that make it usable rather than noisy: the
 * region exists before the first move (a live region added at the moment of the change is often not
 * announced), a move that changes the group speaks the item and its new column, and a reorder
 * inside one column stays silent.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const data: KanbanData = {
  columns: [
    { id: 'title', name: 'Title', type: 'title' },
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'In Progress', color: 'blue' },
      ],
    },
  ],
  items: [
    { id: 'a', title: 'Design spec', properties: { status: 'todo' } },
    { id: 'b', title: 'Empty ticket', properties: { status: 'doing' } },
  ],
  views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
} as KanbanData

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard() {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData: vi.fn() }))
  mounted.push(rendered)
  return rendered
}

/**
 * Read by the board's own marker rather than by `role="status"`: the board is not the only thing in
 * here that speaks — a column's title field leaves its own message behind, and the header has a
 * save-status region besides, so the one this reads has to say which it is.
 */
function liveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[data-kanban-board] [data-kanban-move-announcement]')
  expect(region, 'the board renders no polite live region for card moves').not.toBeNull()
  return region!
}

function movedMessage(title: string, group: string): string {
  return t('preview.kanban_moved_to_group', { title, group })
}

function cardOf(itemId: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  expect(card, `card ${itemId} is not in the document`).not.toBeNull()
  return card!
}

/** The chord is pressed on a real control inside the card, which is where keyboard focus lives. */
function pressShiftArrowRight(itemId: string, direction: 'ArrowRight' | 'ArrowLeft' = 'ArrowRight'): void {
  const origin = cardOf(itemId).querySelector<HTMLElement>('button') ?? cardOf(itemId)
  origin.focus()
  act(() => {
    origin.dispatchEvent(new KeyboardEvent('keydown', { key: direction, shiftKey: true, bubbles: true, cancelable: true }))
  })
}

/** What the browser hands the drop handler after a drag started on a card of this board. */
function dropCard(fromId: string, ontoId: string): void {
  const payload = JSON.stringify({ type: 'card', itemId: fromId, sourceGroupKey: 'todo' })
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      getData: (format: string) => (format === 'application/json' ? payload : fromId),
      setData: () => {},
      dropEffect: 'move',
      effectAllowed: 'move',
    },
  })
  const target = cardOf(ontoId)
  act(() => {
    target.dispatchEvent(event)
  })
}

describe('a card move is announced to screen readers', () => {
  it('keeps the live region mounted and empty before anything moves', () => {
    const { container } = mountBoard()
    expect(liveRegion(container).textContent).toBe('')
  })

  it('names the item and its new column after the keyboard move', () => {
    const { container } = mountBoard()
    pressShiftArrowRight('a')
    expect(liveRegion(container).textContent).toBe(movedMessage('Design spec', 'In Progress'))
  })

  it('names the destination column after a pointer drop onto another column', () => {
    const { container } = mountBoard()
    dropCard('a', 'b')
    expect(liveRegion(container).textContent).toBe(movedMessage('Design spec', 'In Progress'))
  })

  it('stays silent when the drop only reorders within the same column', () => {
    const { container } = mountBoard()
    dropCard('a', 'a')
    expect(liveRegion(container).textContent).toBe('')
  })

  it('stays silent when the keyboard move has nowhere to go', () => {
    const { container } = mountBoard()
    pressShiftArrowRight('a', 'ArrowLeft')
    expect(liveRegion(container).textContent).toBe('')
  })
})

describe('what the move chord itself covers', () => {
  it('leaves a bare arrow to whatever the card holds, since Shift is what asks for a move', () => {
    const { container } = mountBoard()
    const origin = cardOf('a').querySelector<HTMLElement>('button') ?? cardOf('a')
    origin.focus()
    act(() => {
      origin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(liveRegion(container).textContent).toBe('')
  })

  it('leaves Shift+Arrow inside a field to the field, where it selects text', () => {
    const { container } = mountBoard()
    const field = document.createElement('input')
    cardOf('a').append(field)
    field.focus()
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(liveRegion(container).textContent).toBe('')
  })
})
