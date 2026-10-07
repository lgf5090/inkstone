/**
 * KU-22. A reader who has picked a batch and then drags one of the picked cards is moving the batch,
 * not the card under their finger: the pointer that picked the others is the same pointer, and the
 * drop names one place the whole set is going.
 *
 * What is asserted here is the routing rather than the writer: a drop made while the held card is part
 * of a selection of two or more goes to the batch writer (every picked card lands in the dropped cell,
 * the held one taking the place under the pointer, and the selection ends as it does in the batch bar's
 * own group change); a drop of a card that was never picked moves that card alone even while a batch
 * stands elsewhere; and a selection of one is a single move, because a batch of one is not a batch.
 *
 * The real board is driven through the real events — `dragstart` on a card, `drop` on a column or a
 * card — since what routes a drop is the handler React attaches, and the whole question is which of the
 * two writers a real event ends up at.
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

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function boards(): KanbanData {
  return {
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
    items: [
      { id: 'a', title: 'Card a', properties: { status: 'todo' } },
      { id: 'b', title: 'Card b', properties: { status: 'todo' } },
      { id: 'c', title: 'Card c', properties: { status: 'doing' } },
      { id: 'd', title: 'Card d', properties: { status: 'doing' } },
    ],
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
  }
}

function mountBoard() {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boards(), onUpdateData }))
  mounted.push(rendered)
  return { container: rendered.container, onUpdateData }
}

/** The document as the board last committed it, which is what the note would now carry. */
function committed(onUpdateData: ReturnType<typeof vi.fn>): KanbanData {
  const calls = onUpdateData.mock.calls
  expect(calls.length, 'the board committed nothing').toBeGreaterThan(0)
  return calls[calls.length - 1]![0] as KanbanData
}

function statusOf(data: KanbanData, itemId: string): unknown {
  return data.items.find((item) => item.id === itemId)?.properties.status
}

function orderOf(data: KanbanData): string[] {
  return data.items.map((item) => item.id)
}

function card(container: HTMLElement, itemId: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  if (!node) throw new Error(`the board draws no card ${itemId}`)
  return node
}

function column(container: HTMLElement, groupKey: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`div[data-kanban-group="${groupKey}"]`)
  if (!node) throw new Error(`the board draws no column ${groupKey}`)
  return node
}

function click(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The card's own checkbox, which is how a reader picks one card rather than a whole column of them. */
function tickCard(container: HTMLElement, itemId: string): void {
  const box = card(container, itemId).querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!box) throw new Error(`card ${itemId} offers no selection box`)
  click(box)
}

/** Picks a whole column through its own menu, which is the shortest way to a batch of two. */
function selectColumn(container: HTMLElement, groupKey: string): void {
  const trigger = column(container, groupKey).querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
  if (!trigger) throw new Error(`column ${groupKey} offers no menu`)
  click(trigger)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const box = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!box) throw new Error('the column menu offers no select-all control')
  click(box)
}

function pickedIds(container: HTMLElement): string[] {
  const picked = [...container.querySelectorAll<HTMLElement>('[data-item-id]')]
    .filter((node) => node.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)
    .map((node) => node.dataset.itemId!)
  return [...new Set(picked)].sort()
}

/**
 * A drag the way the browser delivers it: the payload travels through `dataTransfer`, so the fake box
 * stores what `dragstart` writes and hands it back to the drop, which is the path the real board reads.
 */
/**
 * jsdom lays nothing out, so every box is zero-sized and "which half of the card" has no answer. A card
 * the pointer is aimed at is given a real one, the way the panel suite gives its panels a rect.
 */
function giveRect(node: HTMLElement, top: number, height: number): void {
  node.getBoundingClientRect = () => ({ top, left: 0, width: 200, height, bottom: top + height, right: 200 } as DOMRect)
}

function dragEvent(type: string, box: Map<string, string>, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      setData: (format: string, value: string) => box.set(format, value),
      getData: (format: string) => box.get(format) ?? '',
      dropEffect: 'move',
      effectAllowed: 'move',
    },
  })
  Object.defineProperty(event, 'clientY', { value: clientY })
  return event
}

function dragAndDrop(source: HTMLElement, target: HTMLElement, clientY = 0): void {
  const box = new Map<string, string>()
  act(() => {
    source.dispatchEvent(dragEvent('dragstart', box, clientY))
  })
  // One commit per event, as a real drag gets: the hover names the drop target, and the drop reads it
  // from the state that hover left behind. Dispatched in one batch, the drop would see no target.
  act(() => {
    target.dispatchEvent(dragEvent('dragover', box, clientY))
  })
  act(() => {
    target.dispatchEvent(dragEvent('drop', box, clientY))
  })
}

function moveAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-kanban-move-announcement]')?.textContent?.trim() ?? ''
}

describe('a drop made with a batch behind it', () => {
  it('moves every picked card into the column it was dropped on', () => {
    const { container, onUpdateData } = mountBoard()
    selectColumn(container, 'todo')
    expect(pickedIds(container)).toEqual(['a', 'b'])

    dragAndDrop(card(container, 'a'), column(container, 'doing'))

    const data = committed(onUpdateData)
    expect(statusOf(data, 'a')).toBe('doing')
    expect(statusOf(data, 'b')).toBe('doing')
    expect(data.items.filter((item) => item.properties.status === 'todo')).toHaveLength(0)
  })

  it('puts the held card where the pointer was, and the rest of the batch beside it', () => {
    const { container, onUpdateData } = mountBoard()
    selectColumn(container, 'todo')

    // Dropped on the lower half of a card of the target column: that half is the place the held card
    // takes, and the rest of the batch follows into the same column rather than guessing a place each.
    const target = card(container, 'c')
    giveRect(target, 100, 40)
    dragAndDrop(card(container, 'a'), target, 130)

    const data = committed(onUpdateData)
    const order = orderOf(data)
    expect(order.indexOf('a'), 'the held card is not next to the card it was dropped on').toBe(order.indexOf('c') + 1)
    expect(statusOf(data, 'b'), 'the rest of the batch stayed behind').toBe('doing')
    expect(order.indexOf('b'), 'the rest of the batch is not beside the card it followed').toBeGreaterThan(
      order.indexOf('a'),
    )
  })

  it('ends the selection, as the batch bar\'s own group change does', () => {
    const { container } = mountBoard()
    selectColumn(container, 'todo')

    dragAndDrop(card(container, 'a'), column(container, 'doing'))

    expect(pickedIds(container)).toEqual([])
  })
})

describe('what a batch drop says out loud', () => {
  it('says how many cards went where', () => {
    const { container } = mountBoard()
    selectColumn(container, 'todo')

    dragAndDrop(card(container, 'a'), column(container, 'doing'))

    expect(moveAnnouncement(container)).toBe(t('preview.kanban_batch_moved', { count: 2, group: 'Doing' }))
  })
})

describe('a drop of one card', () => {
  it('moves only the card the reader held when it was not one of the picked ones', () => {
    const { container, onUpdateData } = mountBoard()
    selectColumn(container, 'doing')

    dragAndDrop(card(container, 'a'), column(container, 'doing'))

    const data = committed(onUpdateData)
    expect(statusOf(data, 'a')).toBe('doing')
    // The batch is untouched, and still picked: the pointer moved a card that had nothing to do with it.
    expect(statusOf(data, 'c')).toBe('doing')
    expect(statusOf(data, 'd')).toBe('doing')
    expect(pickedIds(container)).toEqual(['c', 'd'])
  })

  it('moves alone when it is the only picked card, and keeps the single-move wording', () => {
    const { container, onUpdateData } = mountBoard()
    tickCard(container, 'b')

    dragAndDrop(card(container, 'b'), column(container, 'doing'))

    const data = committed(onUpdateData)
    expect(statusOf(data, 'b')).toBe('doing')
    expect(statusOf(data, 'a')).toBe('todo')
    expect(moveAnnouncement(container)).toBe(t('preview.kanban_moved_to_group', { title: 'Card b', group: 'Doing' }))
  })
})
