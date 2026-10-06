import { describe, expect, it } from 'vitest'
import {
  parseKanbanDragData,
  reorderKanbanColumns,
  reorderKanbanItems,
  stepKanbanRowInGroup,
} from './dnd'
import type { KanbanItem, KanbanProperty } from './types'

/**
 * KU-21c. The table's rows stand in document order, so a reorder is a step of that order inside the
 * row's own group. The cases pin the shape the view's writer is handed: the walk crosses rows of
 * other groups to find the row's own neighbour, stops short at the group's edge, and leaves the list
 * untouched when there is nothing to move.
 */
describe('stepping a table row inside its group (KU-21c, pure layer)', () => {
  const item = (id: string, status: string): KanbanItem => ({ id, title: id, properties: { status } })
  const rows = [item('a', 'todo'), item('x', 'doing'), item('b', 'todo'), item('y', 'doing'), item('c', 'todo')]
  const ids = (items: KanbanItem[]): string[] => items.map((i) => i.id)

  it('moves down to the next row of its own group, stepping over other groups', () => {
    expect(ids(stepKanbanRowInGroup(rows, 'a', 'status', 1))).toEqual(['x', 'b', 'a', 'y', 'c'])
  })

  it('moves up to the previous row of its own group', () => {
    expect(ids(stepKanbanRowInGroup(rows, 'b', 'status', -1))).toEqual(['b', 'a', 'x', 'y', 'c'])
  })

  it('does not cross the group edge at either end', () => {
    expect(stepKanbanRowInGroup(rows, 'c', 'status', 1)).toBe(rows)
    expect(stepKanbanRowInGroup(rows, 'a', 'status', -1)).toBe(rows)
  })

  it('leaves an unknown row, and the list, alone', () => {
    expect(stepKanbanRowInGroup(rows, 'nope', 'status', 1)).toBe(rows)
  })

  it('treats ungrouped rows as one group of their own', () => {
    const loose = [item('a', 'todo'), item('b', 'todo'), item('x', 'doing')]
    expect(ids(stepKanbanRowInGroup(loose, 'a', 'status', 1))).toEqual(['b', 'a', 'x'])
  })
})

describe('parseKanbanDragData', () => {
  it('parses valid json card payload', () => {
    const mockDataTransfer = {
      getData: (format: string) =>
        format === 'application/json'
          ? JSON.stringify({ type: 'card', itemId: 'item-1', sourceGroupKey: 'todo' })
          : '',
    } as unknown as DataTransfer

    const result = parseKanbanDragData(mockDataTransfer)
    expect(result).toEqual({ type: 'card', itemId: 'item-1', sourceGroupKey: 'todo' })
  })

  it('parses valid json column payload', () => {
    const mockDataTransfer = {
      getData: (format: string) =>
        format === 'application/json'
          ? JSON.stringify({ type: 'column', groupKey: 'in_progress' })
          : '',
    } as unknown as DataTransfer

    const result = parseKanbanDragData(mockDataTransfer)
    expect(result).toEqual({ type: 'column', groupKey: 'in_progress' })
  })

  it('falls back to text/plain when json is not available or invalid', () => {
    const mockDataTransfer = {
      getData: (format: string) => (format === 'text/plain' ? 'item-99' : '{bad json'),
    } as unknown as DataTransfer

    const result = parseKanbanDragData(mockDataTransfer)
    expect(result).toEqual({ type: 'card', itemId: 'item-99', sourceGroupKey: '' })
  })
})

describe('reorderKanbanItems', () => {
  const sampleItems: KanbanItem[] = [
    { id: '1', title: 'Task 1', properties: { status: 'todo' } },
    { id: '2', title: 'Task 2', properties: { status: 'todo' } },
    { id: '3', title: 'Task 3', properties: { status: 'todo' } },
    { id: '4', title: 'Task 4', properties: { status: 'done' } },
  ]

  it('moves an item before a pivot within the same column', () => {
    const reordered = reorderKanbanItems(sampleItems, '3', 'status', 'todo', { itemId: '1', position: 'before' })
    expect(reordered.map((i) => i.id)).toEqual(['3', '1', '2', '4'])
  })

  it('moves an item to another column without a pivot (appends)', () => {
    const reordered = reorderKanbanItems(sampleItems, '1', 'status', 'done')
    const doneItems = reordered.filter((i) => i.properties.status === 'done')
    expect(doneItems.map((i) => i.id)).toEqual(['4', '1'])
  })

  it('moves an item to another column before a pivot', () => {
    const reordered = reorderKanbanItems(sampleItems, '1', 'status', 'done', { itemId: '4', position: 'before' })
    const doneItems = reordered.filter((i) => i.properties.status === 'done')
    expect(doneItems.map((i) => i.id)).toEqual(['1', '4'])
  })

  it('anchors on the pivot id when hidden items shift filtered positions', () => {
    // A filter hides item '1', so the visible column is [2, 3]. Dropping '4'
    // above '3' must land between 2 and 3, not at the column start.
    const reordered = reorderKanbanItems(sampleItems, '4', 'status', 'todo', { itemId: '3', position: 'before' })
    expect(reordered.map((i) => i.id)).toEqual(['1', '2', '4', '3'])
  })
})

describe('reorderKanbanItems pivot placement', () => {
  const sampleItems: KanbanItem[] = [
    { id: '1', title: 'Task 1', properties: { status: 'todo' } },
    { id: '2', title: 'Task 2', properties: { status: 'todo' } },
    { id: '3', title: 'Task 3', properties: { status: 'todo' } },
    { id: '4', title: 'Task 4', properties: { status: 'done' } },
  ]

  it('drops after the pivot when the pointer is on its lower half', () => {
    const reordered = reorderKanbanItems(sampleItems, '4', 'status', 'todo', { itemId: '2', position: 'after' })
    expect(reordered.map((i) => i.id)).toEqual(['1', '2', '4', '3'])
  })

  it('is a no-op when the pivot is the dragged card itself', () => {
    const reordered = reorderKanbanItems(sampleItems, '2', 'status', 'todo', { itemId: '2', position: 'before' })
    expect(reordered).toEqual(sampleItems)
  })

  it('moves an item to __none__ column', () => {
    const reordered = reorderKanbanItems(sampleItems, '1', 'status', '__none__')
    const item = reordered.find((i) => i.id === '1')
    expect(item?.properties.status).toBeUndefined()
  })

  it('returns original items if item id is not found', () => {
    const result = reorderKanbanItems(sampleItems, 'non-existent', 'status', 'done')
    expect(result).toEqual(sampleItems)
  })
})

describe('reorderKanbanColumns', () => {
  const sampleColumns: KanbanProperty[] = [
    {
      id: 'status',
      name: 'Status',
      type: 'select',
      options: [
        { id: 'todo', label: 'To Do', color: 'gray' },
        { id: 'in_progress', label: 'In Progress', color: 'blue' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  ]

  it('reorders options within the specified column', () => {
    const updated = reorderKanbanColumns(sampleColumns, 'status', 'done', 'todo')
    const statusCol = updated.find((c) => c.id === 'status')
    expect(statusCol?.options?.map((o) => o.id)).toEqual(['done', 'todo', 'in_progress'])
  })

  it('returns untouched columns if column or options not found', () => {
    const updated = reorderKanbanColumns(sampleColumns, 'unknown', 'done', 'todo')
    expect(updated).toEqual(sampleColumns)
  })
})
