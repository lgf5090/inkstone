import { describe, expect, it } from 'vitest'
import {
  applyKanbanFilters,
  applyKanbanSorts,
  groupKanbanItems,
  kanbanFilterOperatorsForType,
  kanbanWipOver,
  normalizeKanbanWipLimit,
  searchKanbanItems,
  toggleKanbanColumnSort,
  toggleKanbanHiddenColumn,
} from './filter-sort'
import type { KanbanFilter, KanbanItem, KanbanProperty, KanbanPropertyType } from './types'

const items: KanbanItem[] = [
  {
    id: 'item-1',
    title: 'Setup Project',
    properties: {
      status: 'done',
      priority: 'high',
      assignee: 'Alice',
      progress: 100,
      tags: ['init', 'infra'],
    },
  },
  {
    id: 'item-2',
    title: 'Develop Feature A',
    properties: {
      status: 'in_progress',
      priority: 'medium',
      assignee: 'Bob',
      progress: 50,
      tags: ['feature'],
    },
  },
  {
    id: 'item-3',
    title: 'Write Documentation',
    properties: {
      status: 'todo',
      priority: 'low',
      assignee: '',
      progress: 0,
      tags: [],
    },
  },
  {
    id: 'item-4',
    title: 'Fix Bug in Parser',
    properties: {
      status: 'todo',
      priority: 'high',
      assignee: 'Alice',
      tags: ['bug'],
    },
  },
]

describe('applyKanbanFilters equality', () => {
  it('filters with equals and not_equals', () => {
    const eq = applyKanbanFilters(items, [
      { propertyId: 'status', operator: 'equals', value: 'todo' },
    ])
    expect(eq.map((i) => i.id)).toEqual(['item-3', 'item-4'])

    const notEq = applyKanbanFilters(items, [
      { propertyId: 'status', operator: 'not_equals', value: 'todo' },
    ])
    expect(notEq.map((i) => i.id)).toEqual(['item-1', 'item-2'])
  })

  it('filters array values with equals', () => {
    const res = applyKanbanFilters(items, [
      { propertyId: 'tags', operator: 'equals', value: 'bug' },
    ])
    expect(res.map((i) => i.id)).toEqual(['item-4'])
  })
})

describe('applyKanbanFilters text and presence', () => {
  it('filters with contains and not_contains on title', () => {
    const res = applyKanbanFilters(items, [
      { propertyId: 'title', operator: 'contains', value: 'Doc' },
    ])
    expect(res.map((i) => i.id)).toEqual(['item-3'])

    const notRes = applyKanbanFilters(items, [
      { propertyId: 'title', operator: 'not_contains', value: 'Doc' },
    ])
    expect(notRes).toHaveLength(3)
  })

  it('filters with is_empty and is_not_empty', () => {
    const empty = applyKanbanFilters(items, [
      { propertyId: 'assignee', operator: 'is_empty' },
    ])
    expect(empty.map((i) => i.id)).toEqual(['item-3'])

    const nonEmpty = applyKanbanFilters(items, [
      { propertyId: 'assignee', operator: 'is_not_empty' },
    ])
    expect(nonEmpty.map((i) => i.id)).toEqual(['item-1', 'item-2', 'item-4'])
  })

  it('combines multiple filters using AND', () => {
    const res = applyKanbanFilters(items, [
      { propertyId: 'status', operator: 'equals', value: 'todo' },
      { propertyId: 'priority', operator: 'equals', value: 'high' },
    ])
    expect(res.map((i) => i.id)).toEqual(['item-4'])
  })
})

describe('applyKanbanSorts', () => {
  it('sorts by title ascending and descending', () => {
    const asc = applyKanbanSorts(items, [{ propertyId: 'title', direction: 'asc' }])
    expect(asc[0]?.title).toBe('Develop Feature A')
    expect(asc.at(-1)?.title).toBe('Write Documentation')

    const desc = applyKanbanSorts(items, [{ propertyId: 'title', direction: 'desc' }])
    expect(desc[0]?.title).toBe('Write Documentation')
    expect(desc.at(-1)?.title).toBe('Develop Feature A')
  })

  it('sorts by numeric progress and handles undefined values', () => {
    const asc = applyKanbanSorts(items, [{ propertyId: 'progress', direction: 'asc' }])
    expect(asc[0]?.id).toBe('item-3')
    expect(asc[1]?.id).toBe('item-2')
    expect(asc[2]?.id).toBe('item-1')
    expect(asc[3]?.id).toBe('item-4')
  })
})

describe('toggleKanbanColumnSort', () => {
  it('makes an unsorted column the ascending rule', () => {
    expect(toggleKanbanColumnSort([], 'priority')).toEqual([{ propertyId: 'priority', direction: 'asc' }])
  })

  it('flips ascending to descending and clears on the third click', () => {
    const asc = toggleKanbanColumnSort([], 'priority')
    const desc = toggleKanbanColumnSort(asc, 'priority')
    expect(desc).toEqual([{ propertyId: 'priority', direction: 'desc' }])
    expect(toggleKanbanColumnSort(desc, 'priority')).toEqual([])
  })

  it('replaces the multi-rule list the sort popover wrote with the clicked column', () => {
    const popover = [
      { propertyId: 'status', direction: 'asc' as const },
      { propertyId: 'dueDate', direction: 'desc' as const },
    ]
    expect(toggleKanbanColumnSort(popover, 'priority')).toEqual([{ propertyId: 'priority', direction: 'asc' }])
  })

  it('treats a view without any sort rule as unsorted', () => {
    expect(toggleKanbanColumnSort(undefined, 'priority')).toEqual([{ propertyId: 'priority', direction: 'asc' }])
  })
})

describe('toggleKanbanHiddenColumn', () => {
  it('hides a column a view never hid before', () => {
    expect(toggleKanbanHiddenColumn(undefined, 'priority')).toEqual(['priority'])
    expect(toggleKanbanHiddenColumn([], 'priority')).toEqual(['priority'])
  })

  it('restores a hidden column and leaves the other hidden ones alone', () => {
    const hidden = toggleKanbanHiddenColumn(['status'], 'priority')
    expect(hidden).toEqual(['status', 'priority'])
    expect(toggleKanbanHiddenColumn(hidden, 'priority')).toEqual(['status'])
  })
})

describe('searchKanbanItems', () => {
  it('searches across title and properties case-insensitively', () => {
    expect(searchKanbanItems(items, 'PROJECT').map((i) => i.id)).toEqual(['item-1'])
    expect(searchKanbanItems(items, 'alice').map((i) => i.id)).toEqual(['item-1', 'item-4'])
    expect(searchKanbanItems(items, 'infra').map((i) => i.id)).toEqual(['item-1'])
  })

  it('searches across item description and subtasks', () => {
    const richItems: KanbanItem[] = [
      {
        id: 't-1',
        title: 'Main Task',
        description: 'Deep architectural details here',
        properties: {},
      },
      {
        id: 't-2',
        title: 'Other Task',
        properties: {},
        subtasks: [
          { id: 'st-1', title: 'Subtask for authentication', completed: false },
          { id: 'st-2', title: 'Nested', description: 'Secret subtask info', completed: false },
        ],
      },
    ]

    expect(searchKanbanItems(richItems, 'architectural').map((i) => i.id)).toEqual(['t-1'])
    expect(searchKanbanItems(richItems, 'authentication').map((i) => i.id)).toEqual(['t-2'])
    expect(searchKanbanItems(richItems, 'Secret').map((i) => i.id)).toEqual(['t-2'])
  })

  it('returns all items when query is empty or spaces', () => {
    expect(searchKanbanItems(items, '')).toEqual(items)
    expect(searchKanbanItems(items, '   ')).toEqual(items)
  })
})

describe('groupKanbanItems', () => {
  const statusColumn: KanbanProperty = {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray' },
      { id: 'in_progress', label: 'In Progress', color: 'blue' },
      { id: 'done', label: 'Done', color: 'green' },
    ],
  }

  it('groups items by their status property', () => {
    const groups = groupKanbanItems(items, 'status', statusColumn)
    expect(groups).toHaveLength(3)

    const todo = groups.find((g) => g.groupKey === 'todo')
    expect(todo?.items.map((i) => i.id)).toEqual(['item-3', 'item-4'])
    const prog = groups.find((g) => g.groupKey === 'in_progress')
    expect(prog?.items.map((i) => i.id)).toEqual(['item-2'])
    const done = groups.find((g) => g.groupKey === 'done')
    expect(done?.items.map((i) => i.id)).toEqual(['item-1'])
  })

  it('adds No Status group when items have missing or unknown status', () => {
    const orphan: KanbanItem = { id: 'item-orphan', title: 'No status item', properties: {} }
    const groups = groupKanbanItems([...items, orphan], 'status', statusColumn)
    const noStatus = groups.find((g) => g.groupKey === '__none__')
    expect(noStatus).toBeDefined()
    expect(noStatus?.items.map((i) => i.id)).toEqual(['item-orphan'])
  })

  it('matches a group by option label when the item stores the label not the id', () => {
    const labelValued: KanbanItem = { id: 'item-label', title: 'Labelled', properties: { status: 'In Progress' } }
    const junkValued: KanbanItem = { id: 'item-junk', title: 'Junk', properties: { status: 'NotAnOption' } }
    const groups = groupKanbanItems([labelValued, junkValued], 'status', statusColumn)
    expect(groups.find((g) => g.groupKey === 'in_progress')?.items.map((i) => i.id)).toEqual(['item-label'])
    expect(groups.find((g) => g.groupKey === '__none__')?.items.map((i) => i.id)).toEqual(['item-junk'])
  })
})

// F-03. Until now the only questions a filter could ask of a column were text questions, so a
// number column could not say "more than 50" and a date column could not say "before the 15th" or
// "already missed". Comparison is decided per operator against the value the property holds, and
// the clock arrives through the context so the overdue probes never depend on when they run.
const TODAY = new Date(2026, 2, 15)

const ALL_TYPES: KanbanPropertyType[] = [
  'title', 'select', 'multi-select', 'date', 'text', 'number', 'checkbox', 'person', 'files', 'url',
]

const typedColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'story', name: 'Story points', type: 'number' },
  { id: 'deadline', name: 'Deadline', type: 'date' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'todo', label: 'To Do', color: 'gray' }, { id: 'done', label: 'Done', color: 'green' }],
  },
]

const valuedItems: KanbanItem[] = [
  { id: 'v-1', title: 'Big', properties: { story: 100, deadline: '2026-03-01', status: 'todo' } },
  { id: 'v-2', title: 'Half', properties: { story: 50, deadline: '2026-03-10T12:00:00Z', status: 'done' } },
  { id: 'v-3', title: 'Small', properties: { story: 5, deadline: '2026-04-02', status: 'todo' } },
  { id: 'v-4', title: 'Unknown', properties: { story: 'n/a', status: 'todo' } },
]

function matching(filter: KanbanFilter): string[] {
  return applyKanbanFilters(valuedItems, [filter], { columns: typedColumns, now: TODAY }).map((i) => i.id)
}

describe('applyKanbanFilters numeric comparison', () => {
  it('keeps the cards on the asked side of a threshold', () => {
    expect(matching({ propertyId: 'story', operator: 'greater_than', value: '50' })).toEqual(['v-1'])
    expect(matching({ propertyId: 'story', operator: 'less_than', value: '50' })).toEqual(['v-3'])
    expect(matching({ propertyId: 'story', operator: 'greater_or_equal', value: '50' })).toEqual(['v-1', 'v-2'])
    expect(matching({ propertyId: 'story', operator: 'less_or_equal', value: '50' })).toEqual(['v-2', 'v-3'])
  })

  it('matches nothing while the threshold is not a number', () => {
    expect(matching({ propertyId: 'story', operator: 'greater_than', value: '' })).toEqual([])
    expect(matching({ propertyId: 'story', operator: 'greater_than', value: 'abc' })).toEqual([])
  })

  it('leaves a value that is not a number out of a comparison', () => {
    expect(matching({ propertyId: 'story', operator: 'less_than', value: '1000' })).toEqual(['v-1', 'v-2', 'v-3'])
    expect(matching({ propertyId: 'story', operator: 'is_empty' })).toEqual(['v-4'])
  })
})

describe('applyKanbanFilters date comparison', () => {
  it('splits the column on the asked day and reads a stored time as that same day', () => {
    expect(matching({ propertyId: 'deadline', operator: 'before', value: '2026-03-10' })).toEqual(['v-1'])
    expect(matching({ propertyId: 'deadline', operator: 'before', value: '2026-03-11' })).toEqual(['v-1', 'v-2'])
    expect(matching({ propertyId: 'deadline', operator: 'after', value: '2026-03-10' })).toEqual(['v-3'])
  })

  it('matches a day however the card wrote it', () => {
    expect(matching({ propertyId: 'deadline', operator: 'equals', value: '2026-03-10' })).toEqual(['v-2'])
  })

  it('names the cards whose own day has passed, not the finished one', () => {
    expect(matching({ propertyId: 'deadline', operator: 'is_overdue' })).toEqual(['v-1'])
  })

  it('refuses to compare a day it cannot read', () => {
    const written: KanbanItem[] = [{ id: 'w', title: 'W', properties: { deadline: 'next week' } }]
    const ask = (operator: KanbanFilter['operator']) =>
      applyKanbanFilters(written, [{ propertyId: 'deadline', operator, value: '2026-03-10' }],
        { columns: typedColumns, now: TODAY }).map((i) => i.id)
    expect(ask('before')).toEqual([])
    expect(ask('after')).toEqual([])
    expect(ask('equals')).toEqual([])
  })
})

describe('applyKanbanFilters on a choice column', () => {
  // The value picker writes option ids, but a board imported from another tool may hold the label
  // in the cell, which is the same ambiguity groupKanbanItems already resolves both ways.
  it('matches a choice by its id or by the label written where the id belongs', () => {
    expect(matching({ propertyId: 'status', operator: 'equals', value: 'todo' })).toEqual(['v-1', 'v-3', 'v-4'])
    expect(matching({ propertyId: 'status', operator: 'equals', value: 'Done' })).toEqual(['v-2'])
    expect(matching({ propertyId: 'status', operator: 'not_equals', value: 'To Do' })).toEqual(['v-2'])
  })
})

describe('kanbanFilterOperatorsForType', () => {
  it('gives a number column comparison and withholds text search', () => {
    const ops = kanbanFilterOperatorsForType('number')
    expect(ops).toEqual(expect.arrayContaining(['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal']))
    expect(ops).not.toContain('contains')
  })

  it('offers the missed-day question to a date column alone', () => {
    expect(kanbanFilterOperatorsForType('date')).toContain('is_overdue')
    for (const type of ALL_TYPES.filter((each) => each !== 'date'))
      expect(kanbanFilterOperatorsForType(type), `${type} offers is_overdue`).not.toContain('is_overdue')
  })

  it('offers presence to every type, because any column can be left blank', () => {
    for (const type of ALL_TYPES) {
      expect(kanbanFilterOperatorsForType(type), `${type} cannot ask about blank`).toContain('is_empty')
      expect(kanbanFilterOperatorsForType(type), `${type} cannot ask about filled`).toContain('is_not_empty')
    }
  })

  it('names first the operator a freshly added rule starts with', () => {
    expect(kanbanFilterOperatorsForType('text')[0]).toBe('contains')
    expect(kanbanFilterOperatorsForType('date')[0]).toBe('is_not_empty')
  })
})

describe('applyKanbanSorts by the day a date column names', () => {
  const tieItems: KanbanItem[] = [
    { id: 't-full', title: 'Half', properties: { deadline: '2026-03-10T12:00:00Z' } },
    { id: 't-bare', title: 'Bare', properties: { deadline: '2026-03-10' } },
    { id: 't-early', title: 'Early', properties: { deadline: '2026-03-01' } },
    { id: 't-none', title: 'None', properties: {} },
  ]

  const byDeadline = (direction: 'asc' | 'desc') =>
    applyKanbanSorts(tieItems, [{ propertyId: 'deadline', direction }], { columns: typedColumns })

  it('orders by the day itself rather than by how it was spelled', () => {
    expect(byDeadline('asc').map((i) => i.id)).toEqual(['t-early', 't-full', 't-bare', 't-none'])
  })

  it('keeps a card with no readable day last whichever way the column is read', () => {
    expect(byDeadline('asc').at(-1)?.id).toBe('t-none')
    expect(byDeadline('desc').at(-1)?.id).toBe('t-none')
    expect(byDeadline('desc').map((i) => i.id)).toEqual(['t-full', 't-bare', 't-early', 't-none'])
  })

  it('lets the next rule decide between two spellings of the same day', () => {
    const ordered = applyKanbanSorts(tieItems, [
      { propertyId: 'deadline', direction: 'asc' },
      { propertyId: 'title', direction: 'asc' },
    ], { columns: typedColumns })
    expect(ordered.slice(1, 3).map((i) => i.title)).toEqual(['Bare', 'Half'])
  })

  it('still reads a column the schema never declared as text', () => {
    // Without the schema a timestamped day sorts after its own bare prefix, which is exactly how
    // the board spelled it — the day-key order above puts the two on the same rung instead.
    const ordered = applyKanbanSorts(tieItems, [{ propertyId: 'deadline', direction: 'asc' }])
    expect(ordered.map((i) => i.id)).toEqual(['t-early', 't-bare', 't-full', 't-none'])
  })
})

// F-09. A work-in-progress limit is a rule about a column of the board, and the only thing that makes
// it a rule rather than a decoration is that everything asking the question — the header pill, the
// collapsed strip, the move announcement — gets the same answer. The number arrives from a fence a
// reader may have written by hand, so it is validated on the way in, not trusted.
describe('the work-in-progress limit of a column', () => {
  const limitColumn = {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray', wipLimit: 2 },
      { id: 'in_progress', label: 'In Progress', color: 'blue' },
      { id: 'done', label: 'Done', color: 'green', wipLimit: 'three' },
    ],
  } as unknown as KanbanProperty

  function groupOf(groupKey: string) {
    return groupKanbanItems(items, 'status', limitColumn).find((g) => g.groupKey === groupKey)
  }

  it('carries the limit the option says onto the group that draws it', () => {
    expect(groupOf('todo')?.wipLimit).toBe(2)
  })

  it('leaves a column nobody limited unlimited', () => {
    expect(groupOf('in_progress')?.wipLimit).toBeUndefined()
  })

  it('refuses a stored limit it cannot read as a count of cards', () => {
    expect(groupOf('done')?.wipLimit).toBeUndefined()
  })

  it('says a column filled exactly to its limit is not yet over', () => {
    const todo = groupOf('todo')!
    expect(todo.items).toHaveLength(2)
    expect(kanbanWipOver(todo.items.length, todo.wipLimit)).toBe(0)
  })

  it('counts how far past the limit a column is', () => {
    expect(kanbanWipOver(5, 2)).toBe(3)
    expect(kanbanWipOver(1, 2)).toBe(0)
  })

  it('finds nothing over when no limit was set', () => {
    expect(kanbanWipOver(99, undefined)).toBe(0)
  })

  it('drops a limit that is not a whole positive count of cards', () => {
    for (const junk of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, true]) {
      expect(normalizeKanbanWipLimit(junk), `read back ${String(junk)}`).toBeUndefined()
    }
    expect(normalizeKanbanWipLimit(1)).toBe(1)
  })
})
