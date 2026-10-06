/**
 * A card draws the columns its view asks it to, and a view outlives the columns it names — the schema
 * editor can delete a column, or turn it into another kind, under a board that still lists it. These
 * pin the three rules the card relies on: the list is the reader's order, an id the board no longer
 * has is dropped rather than guessed at, and a value is printed the way its kind reads (an option by
 * its label, a day in the reader's own format, a person by name) or not at all when the card has
 * nothing to say about that column.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import {
  kanbanCardFieldOptions,
  kanbanCardFields,
  readKanbanCardField,
  readKanbanCardFields,
  toggleKanbanCardField,
} from './card-fields'
import type { KanbanItem, KanbanProperty, KanbanView } from './types'

beforeAll(async () => {
  await initI18n()
})

const columns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'status', name: 'Status', type: 'select', options: [{ id: 'doing', label: 'In Progress', color: 'blue' }] },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: [
      { id: 'api', label: 'API', color: 'green' },
      { id: 'ui', label: 'UI', color: 'purple' },
    ],
  },
  { id: 'estimate', name: 'Estimate', type: 'number' },
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'shipped', name: 'Shipped', type: 'checkbox' },
  { id: 'dueDate', name: 'Due', type: 'date' },
]

function view(patch: Partial<KanbanView> = {}): KanbanView {
  return { id: 'v1', name: 'Board', type: 'board', groupBy: 'status', ...patch }
}

function item(patch: Partial<KanbanItem> = {}): KanbanItem {
  return { id: 'i1', title: 'Card', properties: {}, ...patch }
}

describe('a view carries the fields its cards print', () => {
  it('keeps the order the reader picked them in', () => {
    expect(toggleKanbanCardField(['estimate'], 'owner')).toEqual(['estimate', 'owner'])
  })

  it('takes a field away again', () => {
    expect(toggleKanbanCardField(['estimate', 'owner'], 'estimate')).toEqual(['owner'])
  })

  it('starts from nothing, so an untouched view prints what it always did', () => {
    expect(toggleKanbanCardField(undefined, 'estimate')).toEqual(['estimate'])
    expect(kanbanCardFields(view(), columns)).toEqual([])
  })

  it('drops a field the board no longer has, rather than asking a card to print it', () => {
    expect(kanbanCardFields(view({ cardFields: ['estimate', 'deleted', 'owner'] }), columns)).toEqual([
      'estimate',
      'owner',
    ])
  })
})

describe('the panel offers the columns that carry a value', () => {
  it('lists every column but the title, which is the card’s own heading', () => {
    expect(kanbanCardFieldOptions(columns).map((column) => column.id)).toEqual([
      'status',
      'tags',
      'estimate',
      'owner',
      'shipped',
      'dueDate',
    ])
  })
})

describe('a value reads the way its kind reads', () => {
  it('prints an option by its label rather than its stored id', () => {
    expect(readKanbanCardField(item({ properties: { status: 'doing' } }), columns[1]!)).toEqual({
      id: 'status',
      label: 'Status',
      value: 'In Progress',
    })
  })

  it('joins several values the way the table cell printing the same list does', () => {
    expect(readKanbanCardField(item({ properties: { tags: ['api', 'ui'] } }), columns[2]!)!.value).toBe('API, UI')
  })

  it('labels a value the same way in either language, since a column name is board content', () => {
    expect(readKanbanCardField(item({ properties: { estimate: 3 } }), columns[3]!)!.label).toBe('Estimate')
    expect(readKanbanCardField(item({ properties: { status: 'doing' } }), columns[1]!)!.value).toBe('In Progress')
  })

  it('prints a number as written, including a zero', () => {
    expect(readKanbanCardField(item({ properties: { estimate: 0 } }), columns[3]!)).toEqual({
      id: 'estimate',
      label: 'Estimate',
      value: '0',
    })
  })
})

describe('a value a card has nothing to say about is left off it', () => {
  it('names a person rather than their initials', () => {
    expect(readKanbanCardField(item({ properties: { owner: 'Ada Lovelace' } }), columns[4]!)).toEqual({
      id: 'owner',
      label: 'Owner',
      value: 'Ada Lovelace',
    })
  })

  it('says a flag by itself, and says nothing at all when it is unset', () => {
    expect(readKanbanCardField(item({ properties: { shipped: true } }), columns[5]!)).toEqual({
      id: 'shipped',
      label: 'Shipped',
      value: '',
    })
    expect(readKanbanCardField(item({ properties: { shipped: false } }), columns[5]!)).toBeNull()
    expect(readKanbanCardField(item(), columns[5]!)).toBeNull()
  })

  it('prints a day in the reader’s own format, and keeps a timestamp’s day', () => {
    expect(readKanbanCardField(item({ properties: { dueDate: '2026-09-23' } }), columns[6]!)!.value).toMatch(/23/)
    expect(
      readKanbanCardField(item({ properties: { dueDate: '2026-09-23T10:00:00Z' } }), columns[6]!)!.value,
    ).toBe(readKanbanCardField(item({ properties: { dueDate: '2026-09-23' } }), columns[6]!)!.value)
  })

  it('prints nothing for an empty, missing or unprintable value', () => {
    expect(readKanbanCardField(item({ properties: { estimate: '' } }), columns[3]!)).toBeNull()
    expect(readKanbanCardField(item(), columns[3]!)).toBeNull()
    expect(readKanbanCardField(item({ properties: { estimate: { weird: true } } }), columns[3]!)).toBeNull()
  })
})

describe('a url field prints as the link it names, through the fence’s own whitelist', () => {
  const linkColumn: KanbanProperty = { id: 'spec', name: 'Spec', type: 'url' }

  it('hands the card the href beside the text when the value is a safe link', () => {
    const field = readKanbanCardField(item({ properties: { spec: 'https://spec.example.test/1' } }), linkColumn)
    expect(field).toEqual({
      id: 'spec',
      label: 'Spec',
      value: 'https://spec.example.test/1',
      href: 'https://spec.example.test/1',
    })
  })

  it('keeps a value the whitelist refuses as plain text, never as a link', () => {
    const field = readKanbanCardField(item({ properties: { spec: 'javascript:alert(1)' } }), linkColumn)
    expect(field).toEqual({ id: 'spec', label: 'Spec', value: 'javascript:alert(1)' })
    expect(field?.href).toBeUndefined()
  })

  it('says nothing about an empty url cell', () => {
    expect(readKanbanCardField(item({ properties: { spec: '   ' } }), linkColumn)).toBeNull()
    expect(readKanbanCardField(item(), linkColumn)).toBeNull()
  })
})

describe('one item’s fields, in the view’s order', () => {
  it('reads them in the order the view asks and skips what the card cannot say', () => {
    const fields = readKanbanCardFields(
      item({ properties: { owner: 'Ada', estimate: 3 } }),
      ['estimate', 'shipped', 'owner'],
      columns,
    )
    expect(fields).toEqual([{ id: 'estimate', label: 'Estimate', value: '3' }, { id: 'owner', label: 'Owner', value: 'Ada' }])
  })
})
