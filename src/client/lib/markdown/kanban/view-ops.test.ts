/**
 * The tab strip used to be read-only: a board could switch views but never gain, name, copy, order
 * or lose one, so whatever the fence listed was what the reader was stuck with. Those operations
 * live here as pure document edits, because the board history wraps every commit — an operation
 * that only returns the next document is undoable for free, and `activeViewId` naming a view that
 * still exists is the invariant each case below re-checks, since one dangling id makes the whole
 * board render its fallback view.
 */
import { describe, expect, it } from 'vitest'
import {
  addKanbanView,
  createKanbanView,
  duplicateKanbanView,
  kanbanPriorityColumn,
  kanbanStatusColumn,
  kanbanTagsColumn,
  moveKanbanView,
  removeKanbanView,
  renameKanbanView,
} from './view-ops'
import type { KanbanData, KanbanProperty, KanbanView, KanbanViewType } from './types'

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  { id: 'startDate', name: 'Start', type: 'date' },
  { id: 'endDate', name: 'End', type: 'date' },
  { id: 'progress', name: 'Progress', type: 'number' },
]

const boardView: KanbanView = { id: 'view-board', name: 'board', type: 'board', groupBy: 'status' }

/** A hand-written fence may name its columns anything; the resolvers still have to find the trio. */
const CUSTOM_COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'state', name: 'State', type: 'select', options: [{ id: 'open', label: 'Open', color: 'blue' }] },
  { id: 'rank', name: 'Rank', type: 'select', options: [{ id: 'high', label: 'High', color: 'red' }] },
  { id: 'labels', name: 'Labels', type: 'multi-select', options: [{ id: 'ui', label: 'UI', color: 'teal' }] },
]

describe('the status/priority/tags column resolvers', () => {
  it('answers the conventional ids before anything else', () => {
    expect(kanbanStatusColumn(COLUMNS)?.id).toBe('status')
    expect(kanbanStatusColumn(CUSTOM_COLUMNS)?.id).toBe('state')
  })

  it('falls back to the kind of column the field needs, skipping the column a sibling took', () => {
    expect(kanbanPriorityColumn(CUSTOM_COLUMNS)?.id).toBe('rank')
    expect(kanbanTagsColumn(CUSTOM_COLUMNS)?.id).toBe('labels')
  })

  it('never invents an id for a board that has no such column', () => {
    const bare: KanbanProperty[] = [{ id: 'title', name: 'Title', type: 'title' }]
    expect(kanbanStatusColumn(bare)).toBeUndefined()
    expect(kanbanPriorityColumn(bare)).toBeUndefined()
    expect(kanbanTagsColumn(bare)).toBeUndefined()
  })
})
const tableView: KanbanView = {
  id: 'view-table',
  name: 'table',
  type: 'table',
  filters: [{ propertyId: 'status', operator: 'is_empty' }],
  sorts: [{ propertyId: 'title', direction: 'asc' }],
  hiddenColumns: ['progress'],
  cardFields: ['status', 'progress'],
}

function board(views: KanbanView[] = [boardView, tableView], columns = COLUMNS): KanbanData {
  return { title: 'Gate', columns, items: [{ id: 'a', title: 'Ship', properties: { status: 'todo' } }], views, activeViewId: views[0]!.id }
}

function lastView(data: KanbanData): KanbanView {
  return data.views.at(-1)!
}

describe('createKanbanView', () => {
  it('gives a view of each kind the fields it needs to draw anything', () => {
    expect(createKanbanView('board', COLUMNS, []).groupBy).toBe('status')
    const chart = createKanbanView('chart', COLUMNS, [])
    expect(chart.chartType).toBe('bar')
    expect(chart.chartGroupBy).toBe('status')
    expect(createKanbanView('calendar', COLUMNS, []).dateField).toBe('startDate')
    const gantt = createKanbanView('gantt', COLUMNS, [])
    expect(gantt.startField).toBe('startDate')
    expect(gantt.endField).toBe('endDate')
    expect(gantt.progressField).toBe('progress')
    expect(createKanbanView('table', COLUMNS, [])).toMatchObject({ type: 'table' })
  })

  it('reads the date fields off the columns the board actually has', () => {
    const columns: KanbanProperty[] = [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'due', name: 'Due', type: 'date' },
    ]
    expect(createKanbanView('calendar', columns, []).dateField).toBe('due')
    const gantt = createKanbanView('gantt', columns, [])
    expect(gantt.startField).toBe('due')
    // No second date column and no number column: the view asks a question it cannot answer rather
    // than inventing a property id the items will never carry.
    expect(gantt.endField).toBeUndefined()
    expect(gantt.progressField).toBeUndefined()
  })

  it('stores the type as the name so the label keeps translating', () => {
    const created = createKanbanView('gantt', COLUMNS, [])
    expect(created.name).toBe('gantt')
    expect(created.type).toBe('gantt')
  })

  it('numbers a second view of a kind so two tabs never read the same', () => {
    expect(createKanbanView('board', COLUMNS, [boardView]).name).toBe('board 2')
    expect(createKanbanView('board', COLUMNS, [boardView, { ...boardView, id: 'b2', name: 'board 2' }]).name).toBe('board 3')
  })

  it('ignores a name typed by hand when it happens to collide', () => {
    const named = { ...boardView, name: 'Board 2' }
    expect(createKanbanView('board', COLUMNS, [named]).name).toBe('board 3')
  })
})

describe('addKanbanView', () => {
  it('appends the view and shows it', () => {
    const next = addKanbanView(board(), 'gantt')
    expect(next.views.map((v) => v.id)).toEqual([boardView.id, tableView.id, lastView(next).id])
    expect(lastView(next).type).toBe('gantt')
    expect(next.activeViewId).toBe(lastView(next).id)
  })

  it('gives every added view an id no other view carries', () => {
    const once = addKanbanView(addKanbanView(board(), 'list'), 'list')
    const ids = once.views.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('view-'))).toBe(true)
  })

  it('keeps the rest of the document as it was', () => {
    const data = board()
    const next = addKanbanView(data, 'chart')
    expect(next.title).toBe(data.title)
    expect(next.columns).toBe(data.columns)
    expect(next.items).toBe(data.items)
    expect(next.views.slice(0, 2)).toEqual([boardView, tableView])
  })
})

describe('duplicateKanbanView', () => {
  it('copies the whole view config next to its source and shows the copy', () => {
    const next = duplicateKanbanView(board(), tableView.id)
    const index = next.views.findIndex((v) => v.id === tableView.id) + 1
    const copy = next.views[index]!
    expect(copy.id).not.toBe(tableView.id)
    expect(copy.type).toBe('table')
    expect(copy.filters).toEqual(tableView.filters)
    expect(copy.sorts).toEqual(tableView.sorts)
    expect(copy.hiddenColumns).toEqual(tableView.hiddenColumns)
    // A copy is the same view twice, so the columns it prints on its cards come along — and it is a
    // copy rather than a second reader of one list, since taking a field off the copy must not take
    // it off its source.
    expect(copy.cardFields).toEqual(tableView.cardFields)
    expect(copy.cardFields).not.toBe(tableView.cardFields)
    expect(copy.name).toBe('table 2')
    expect(next.activeViewId).toBe(copy.id)
  })

  it('changes nothing when the view is already gone', () => {
    const data = board()
    expect(duplicateKanbanView(data, 'view-removed').views).toHaveLength(data.views.length)
  })
})

describe('renameKanbanView', () => {
  it('stores the name the reader typed', () => {
    const next = renameKanbanView(board(), tableView.id, '  Shipped items  ')
    expect(next.views[1]!.name).toBe('Shipped items')
    expect(next.views[0]!.name).toBe(boardView.name)
  })

  it('leaves the view named what it was when the box comes back blank', () => {
    const data = board()
    expect(renameKanbanView(data, tableView.id, '   ').views[1]!.name).toBe('table')
  })

  it('stores a name that still reads as the type verbatim, not lowercased', () => {
    const next = renameKanbanView(board(), tableView.id, 'Table')
    expect(next.views[1]!.name).toBe('Table')
  })
})

describe('removeKanbanView', () => {
  it('drops a view the board is not looking at', () => {
    const next = removeKanbanView(board(), tableView.id)
    expect(next.views.map((v) => v.id)).toEqual([boardView.id])
    expect(next.activeViewId).toBe(boardView.id)
  })

  it('shows the neighbour when the active view is the one removed', () => {
    const next = removeKanbanView(board(), boardView.id)
    expect(next.views.map((v) => v.id)).toEqual([tableView.id])
    expect(next.activeViewId).toBe(tableView.id)
  })

  it('shows the next view when the first tab goes', () => {
    const three = board([boardView, tableView, { id: 'view-list', name: 'list', type: 'list' }])
    const next = removeKanbanView(three, boardView.id)
    expect(next.activeViewId).toBe(tableView.id)
    expect(next.views.some((v) => v.id === boardView.id)).toBe(false)
  })

  it('keeps the last view, because a board with no view cannot render', () => {
    const only = board([boardView])
    expect(removeKanbanView(only, boardView.id).views).toHaveLength(1)
    expect(removeKanbanView(only, boardView.id).activeViewId).toBe(boardView.id)
  })

  it('never drops the cards with the view', () => {
    const data = board()
    expect(removeKanbanView(data, tableView.id).items).toHaveLength(data.items.length)
  })
})

describe('moveKanbanView', () => {
  const three = () => board([boardView, tableView, { id: 'view-list', name: 'list', type: 'list' }])

  it('swaps a tab with its neighbour and keeps what is shown', () => {
    const next = moveKanbanView(three(), tableView.id, -1)
    expect(next.views.map((v) => v.name)).toEqual(['table', 'board', 'list'])
    expect(next.activeViewId).toBe(boardView.id)
  })

  it('has nowhere to go at either end of the strip', () => {
    const data = three()
    expect(moveKanbanView(data, boardView.id, -1).views.map((v) => v.id)).toEqual(data.views.map((v) => v.id))
    expect(moveKanbanView(data, 'view-list', 1).views.map((v) => v.id)).toEqual(data.views.map((v) => v.id))
  })
})

describe('every view operation', () => {
  const types: KanbanViewType[] = ['board', 'table', 'calendar', 'timeline', 'gantt', 'list', 'gallery', 'chart']

  it('leaves the document it was handed untouched', () => {
    const data = board()
    const snapshot = JSON.stringify(data)
    for (const type of types) addKanbanView(data, type)
    duplicateKanbanView(data, tableView.id)
    renameKanbanView(data, tableView.id, 'x')
    removeKanbanView(data, tableView.id)
    moveKanbanView(data, tableView.id, -1)
    expect(JSON.stringify(data)).toBe(snapshot)
  })

  it('never leaves the shown view pointing at a view that no longer exists', () => {
    const data = board()
    for (const removed of data.views) {
      const next = removeKanbanView(data, removed.id)
      expect(next.views.some((v) => v.id === next.activeViewId)).toBe(true)
    }
  })
})
