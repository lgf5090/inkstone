/**
 * KU-21c. The table drew rows in document order and nothing in the module could rearrange them —
 * the board drags cards between columns, but the table's own order was frozen. A row is draggable
 * now and its neighbours are the drop targets, so what is asserted here is the wiring rather than
 * the arithmetic (`dnd.test.ts` pins the step itself): a real dragstart on a row and a real drop on
 * another row of the same group reaches the board's writer once, with the pair swapped; a drop on a
 * row of *another* group is refused, because crossing groups is the board's move and writes the
 * group column, which a reorder must not; and `Shift`+arrow walks the focused row one step of its
 * group without the pointer.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
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

function row(id: string, status: string): KanbanItem {
  return { id, title: id.toUpperCase(), properties: { status } }
}

function boardData(): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'v-table',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'doing', label: 'Doing', color: 'blue' },
      ] },
    ],
    items: [row('a', 'todo'), row('b', 'todo'), row('c', 'doing'), row('d', 'doing')],
    views: [{ id: 'v-table', name: 'Table', type: 'table', groupBy: 'status' }],
  }
}

function openTable() {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(), onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-item-id="${id}"]`)
  if (!row) throw new Error(`the table drew no row for ${id}`)
  return row
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
function dragRowTo(source: HTMLElement, target: HTMLElement): void {
  const box = new Map<string, string>()
  act(() => {
    source.dispatchEvent(dragEvent('dragstart', box))
  })
  act(() => {
    target.dispatchEvent(dragEvent('dragover', box))
  })
  act(() => {
    target.dispatchEvent(dragEvent('drop', box))
  })
}

function writtenOrder(onUpdateData: Mock): string[] {
  const call = onUpdateData.mock.calls.at(-1)
  if (!call) throw new Error('the board wrote nothing')
  const data = call[0] as KanbanData
  return data.items.map((item) => item.id)
}

describe('a row dropped on a neighbour of its own group takes that place', () => {
  it('swaps down past the row it was dropped on', () => {
    const { container, onUpdateData } = openTable()
    dragRowTo(rowOf(container, 'a'), rowOf(container, 'b'))
    expect(onUpdateData).toHaveBeenCalledTimes(1)
    expect(writtenOrder(onUpdateData)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('swaps up the same way', () => {
    const { container, onUpdateData } = openTable()
    dragRowTo(rowOf(container, 'b'), rowOf(container, 'a'))
    expect(writtenOrder(onUpdateData)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('a drop on another group is refused', () => {
  it('leaves the document alone when the target row belongs to another group', () => {
    const { container, onUpdateData } = openTable()
    dragRowTo(rowOf(container, 'a'), rowOf(container, 'c'))
    expect(onUpdateData).not.toHaveBeenCalled()
  })
})

describe('the same move from the keyboard, one step per press', () => {
  it('steps a row down on Shift+ArrowDown and back on Shift+ArrowUp', () => {
    const { container, onUpdateData } = openTable()
    // The row that moved is a new element (the order changed), so each press is read off the row the
    // reader is now looking at — the same re-query a screen reader's focus would follow.
    act(() => {
      rowOf(container, 'a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
    })
    expect(writtenOrder(onUpdateData)).toEqual(['b', 'a', 'c', 'd'])
    act(() => {
      rowOf(container, 'a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }))
    })
    expect(writtenOrder(onUpdateData)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not step out of its group, and writes nothing', () => {
    const { container, onUpdateData } = openTable()
    act(() => {
      rowOf(container, 'a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }))
    })
    expect(onUpdateData).not.toHaveBeenCalled()
  })
})
