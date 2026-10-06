import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import {
  addPropertyColumn,
  changePropertyColumnType,
  movePropertyColumn,
  removePropertyColumn,
  renamePropertyColumn,
  resizePropertyColumn,
} from './kanban-column-hooks'
import { KANBAN_COLUMN_MAX_WIDTH, KANBAN_COLUMN_MIN_WIDTH, kanbanColumnWidthPx } from '../column-width'
import type { KanbanData, KanbanProperty } from '../types'

beforeAll(async () => {
  await initI18n()
})

function column(id: string, name: string, type: KanbanProperty['type'], options?: KanbanProperty['options']): KanbanProperty {
  return { id, name, type, ...(options ? { options } : {}) }
}

const statusOptions = [
  { id: 'todo', label: 'To Do', color: 'gray' as const },
  { id: 'done', label: 'Done', color: 'green' as const },
]

function board(overrides: Partial<KanbanData> = {}): KanbanData {
  return {
    columns: [
      column('title', 'Title', 'title'),
      column('status', 'Status', 'select', statusOptions),
      column('spec', 'Spec', 'text'),
      column('review', 'Review', 'text'),
      column('files', 'Files', 'files'),
    ],
    items: [
      { id: 'i1', title: 'One', properties: { status: 'todo', review: 'High', spec: 'a.md', files: [] } },
      { id: 'i2', title: 'Two', properties: { status: 'done', review: 'Low', spec: 'b.md', files: [] } },
      { id: 'i3', title: 'Three', properties: { status: 'todo', review: 'High', spec: undefined } },
    ],
    views: [
      {
        id: 'v1',
        name: 'Table',
        type: 'table',
        groupBy: 'review',
        swimlaneBy: 'review',
        hiddenColumns: ['spec', 'review'],
        filters: [{ propertyId: 'review', operator: 'equals', value: 'High' }],
        sorts: [{ propertyId: 'review', direction: 'asc' }, { propertyId: 'spec', direction: 'desc' }],
      },
    ],
    ...overrides,
  }
}

function findColumn(data: KanbanData, id: string): KanbanProperty {
  const col = data.columns.find((c) => c.id === id)
  if (!col) throw new Error(`no column "${id}"`)
  return col
}

function valueOf(data: KanbanData, itemId: string, propertyId: string): unknown {
  const item = data.items.find((i) => i.id === itemId)
  if (!item) throw new Error(`no item "${itemId}"`)
  return item.properties[propertyId]
}

describe('addPropertyColumn', () => {
  it('appends a column with an id derived from the typed name', () => {
    const next = addPropertyColumn(board(), 'Release notes', 'text')
    expect(next.columns.at(-1)).toEqual({ id: 'release-notes', name: 'Release notes', type: 'text' })
  })

  it('keeps ids apart when the derived one is taken', () => {
    const once = addPropertyColumn(board(), 'Spec', 'text')
    const twice = addPropertyColumn(once, 'spec', 'text')
    expect(once.columns.at(-1)!.id).toBe('spec-2')
    expect(twice.columns.at(-1)!.id).toBe('spec-3')
  })

  // A name with no latin letters has nothing to slug, so the id falls back to the generated tail.
  // The name itself is written as escapes: a Han literal cannot sit in a test file (`i18n:check`).
  it('still gives a name it cannot slug a unique id', () => {
    const unsluggable = '\u89c4\u683c\u6587\u6863'
    const data = board()
    const once = addPropertyColumn(data, unsluggable, 'text')
    const twice = addPropertyColumn(once, unsluggable, 'text')
    expect(once.columns.at(-1)!.id).toMatch(/^col-/)
    expect(twice.columns.at(-1)!.id).toMatch(/^col-/)
    expect(twice.columns.at(-1)!.id).not.toBe(once.columns.at(-1)!.id)
    expect(once.columns.at(-1)!.name).toBe(unsluggable)
  })

  it('ignores a name with nothing in it', () => {
    const data = board()
    expect(addPropertyColumn(data, '   ', 'text')).toBe(data)
  })

  it('refuses to add a second title or a second attachments column', () => {
    const data = board()
    expect(addPropertyColumn(data, 'Headings', 'title')).toBe(data)
    expect(addPropertyColumn(data, 'Papers', 'files')).toBe(data)
  })
})

describe('renamePropertyColumn', () => {
  it('changes the name the reader sees without touching the id the values live under', () => {
    const next = renamePropertyColumn(board(), 'spec', 'Spec file')
    expect(findColumn(next, 'spec').name).toBe('Spec file')
    expect(valueOf(next, 'i1', 'spec')).toBe('a.md')
  })

  it('leaves the document alone for a blank name', () => {
    const data = board()
    expect(renamePropertyColumn(data, 'spec', '  ')).toBe(data)
  })

  it('cannot rename the title column out of the table', () => {
    const data = board()
    expect(renamePropertyColumn(data, 'title', 'Headline')).toBe(data)
    expect(renamePropertyColumn(data, 'files', 'Papers')).toBe(data)
  })

  it('ignores an id that is not on the board', () => {
    const data = board()
    expect(renamePropertyColumn(data, 'nope', 'Whatever')).toBe(data)
  })
})

describe('changePropertyColumnType into the select family', () => {
  it('derives options from the values a text column already holds', () => {
    const next = changePropertyColumnType(board(), 'review', 'select')
    const col = findColumn(next, 'review')
    expect(col.type).toBe('select')
    expect(col.options?.map((o) => [o.label, o.id])).toEqual([['High', 'high'], ['Low', 'low']])
    expect(valueOf(next, 'i1', 'review')).toBe('high')
    expect(valueOf(next, 'i3', 'review')).toBe('high')
  })

  // Two values that slug apart cannot collide: a second 'High ' would otherwise overwrite the first
  // option and leave items pointing at a label they never had.
  it('keeps distinct values that slug to the same id apart', () => {
    const data = board({
      items: [
        { id: 'i1', title: 'One', properties: { review: 'High' } },
        { id: 'i2', title: 'Two', properties: { review: ' HIGH' } },
      ],
    })
    const col = findColumn(changePropertyColumnType(data, 'review', 'select'), 'review')
    expect(col.options?.map((o) => [o.label, o.id])).toEqual([['High', 'high'], [' HIGH', 'high-2']])
  })

  it('wraps single values when a select becomes a multi-select', () => {
    const next = changePropertyColumnType(board(), 'status', 'multi-select')
    expect(findColumn(next, 'status').type).toBe('multi-select')
    expect(valueOf(next, 'i1', 'status')).toEqual(['todo'])
  })

  // A value the option list never offered would have nowhere to point once it became an option id,
  // so entering the select family adds what is missing instead of only remapping what is there.
  it('adds options for the values a column did not already list', () => {
    const data = board({
      columns: [column('status', 'Status', 'select', statusOptions)],
      items: [
        { id: 'i1', title: 'One', properties: { status: 'todo' } },
        { id: 'i2', title: 'Two', properties: { status: 'blocked' } },
      ],
    })
    const next = changePropertyColumnType(data, 'status', 'multi-select')
    expect(findColumn(next, 'status').options?.map((o) => o.id)).toEqual(['todo', 'done', 'blocked'])
    expect(valueOf(next, 'i1', 'status')).toEqual(['todo'])
    expect(valueOf(next, 'i2', 'status')).toEqual(['blocked'])
  })
})

describe('changePropertyColumnType out of the select family', () => {
  it('collapses to the first value when a multi-select becomes a select', () => {
    const data = board({
      columns: [column('labels', 'Labels', 'multi-select', [{ id: 'feat', label: 'Feat', color: 'blue' }])],
      items: [{ id: 'i1', title: 'One', properties: { labels: ['feat', 'other'] } }],
    })
    const next = changePropertyColumnType(data, 'labels', 'select')
    expect(valueOf(next, 'i1', 'labels')).toBe('feat')
    expect(findColumn(next, 'labels').options?.map((o) => o.id)).toEqual(['feat', 'other'])
  })

  it('writes the labels an option id stood for back into the values when leaving the select family', () => {
    const next = changePropertyColumnType(board(), 'status', 'text')
    expect(findColumn(next, 'status').type).toBe('text')
    expect(findColumn(next, 'status').options).toBeUndefined()
    expect(valueOf(next, 'i1', 'status')).toBe('To Do')
    expect(valueOf(next, 'i2', 'status')).toBe('Done')
  })
})

describe('changePropertyColumnType between the other types', () => {
  it('reads a number out of a text value and leaves one that is not a number alone', () => {
    const data = board({
      columns: [column('points', 'Points', 'text'), column('spare', 'Spare', 'text')],
      items: [
        { id: 'i1', title: 'One', properties: { points: '42', spare: 'later' } },
        { id: 'i2', title: 'Two', properties: { points: '' } },
      ],
    })
    const next = changePropertyColumnType(data, 'points', 'number')
    expect(valueOf(next, 'i1', 'points')).toBe(42)
    expect(valueOf(next, 'i1', 'spare')).toBe('later')
    expect(valueOf(next, 'i2', 'points')).toBe('')
  })

  it('refuses to retype the title or the attachments column', () => {
    const data = board()
    expect(changePropertyColumnType(data, 'title', 'text')).toBe(data)
    expect(changePropertyColumnType(data, 'files', 'text')).toBe(data)
  })

  it('leaves the document alone when the type is already the one asked for', () => {
    const data = board()
    expect(changePropertyColumnType(data, 'status', 'select')).toBe(data)
  })
})

describe('removePropertyColumn', () => {
  it('drops the column and clears the values it held', () => {
    const next = removePropertyColumn(board(), 'spec')
    expect(next.columns.some((c) => c.id === 'spec')).toBe(false)
    expect(valueOf(next, 'i1', 'spec')).toBeUndefined()
  })

  it('clears every view setting that pointed at it', () => {
    const next = removePropertyColumn(board(), 'review')
    const view = next.views[0]!
    expect(view.groupBy).toBeUndefined()
    expect(view.swimlaneBy).toBeUndefined()
    expect(view.filters).toEqual([])
    expect(view.sorts).toEqual([{ propertyId: 'spec', direction: 'desc' }])
    expect(view.hiddenColumns).toEqual(['spec'])
  })

  it('leaves the settings that pointed elsewhere alone', () => {
    const next = removePropertyColumn(board(), 'spec')
    const view = next.views[0]!
    expect(view.groupBy).toBe('review')
    expect(view.swimlaneBy).toBe('review')
    expect(view.filters).toEqual([{ propertyId: 'review', operator: 'equals', value: 'High' }])
    expect(view.sorts).toEqual([{ propertyId: 'review', direction: 'asc' }])
    expect(view.hiddenColumns).toEqual(['review'])
  })

  it('keeps the title and the attachments column, which the table renders either way', () => {
    const data = board()
    expect(removePropertyColumn(data, 'title')).toBe(data)
    expect(removePropertyColumn(data, 'files')).toBe(data)
  })
})

describe('movePropertyColumn', () => {
  it('moves a column one step later through the list', () => {
    const next = movePropertyColumn(board(), 'spec', 1)
    expect(next.columns.map((c) => c.id)).toEqual(['title', 'status', 'review', 'spec', 'files'])
  })

  it('moves a column one step earlier', () => {
    const next = movePropertyColumn(board(), 'review', -1)
    expect(next.columns.map((c) => c.id)).toEqual(['title', 'status', 'review', 'spec', 'files'])
  })

  it('does nothing past either end of the list', () => {
    const data = board()
    expect(movePropertyColumn(data, 'title', -1)).toBe(data)
    expect(movePropertyColumn(data, 'files', 1)).toBe(data)
  })

  it('ignores an id that is not on the board', () => {
    const data = board()
    expect(movePropertyColumn(data, 'nope', 1)).toBe(data)
  })
})

function widthOf(data: KanbanData, id: string): unknown {
  return findColumn(data, id).width
}

// The width a column is drawn with has to live in the document, so the writer that owns the
// document is where its rules are checked: clamping, clearing, and not spending an undo step on a
// column that already has the width.
describe('resizePropertyColumn', () => {
  it('stores the width the reader dragged to', () => {
    expect(widthOf(resizePropertyColumn(board(), 'spec', 240), 'spec')).toBe(240)
  })

  it('keeps every other column as it was', () => {
    const next = resizePropertyColumn(board(), 'spec', 240)
    expect(next.columns.find((c) => c.id === 'status')).toEqual(findColumn(board(), 'status'))
  })

  it('refuses to draw narrower than the narrowest column or wider than the fence', () => {
    expect(widthOf(resizePropertyColumn(board(), 'spec', 1), 'spec')).toBe(KANBAN_COLUMN_MIN_WIDTH)
    expect(widthOf(resizePropertyColumn(board(), 'spec', 99999), 'spec')).toBe(KANBAN_COLUMN_MAX_WIDTH)
  })

  it('rounds a width that lands between pixels', () => {
    expect(widthOf(resizePropertyColumn(board(), 'spec', 239.6), 'spec')).toBe(240)
  })

  it('clears the width back to the type default', () => {
    const sized = resizePropertyColumn(board(), 'spec', 240)
    const cleared = resizePropertyColumn(sized, 'spec', undefined)
    expect(widthOf(cleared, 'spec')).toBeUndefined()
    expect(Object.keys(findColumn(cleared, 'spec'))).not.toContain('width')
  })

  it('writes nothing when the column already has that width', () => {
    const sized = resizePropertyColumn(board(), 'spec', 240)
    expect(resizePropertyColumn(sized, 'spec', 240)).toBe(sized)
    const unsized = board()
    expect(resizePropertyColumn(unsized, 'spec', undefined)).toBe(unsized)
  })

  // A hand-written or imported fence can carry anything under `width`; a value the table cannot draw
  // is dropped rather than trusted, so it reads as the type default instead of a broken layout.
  it('drops a stored width it cannot read as a number', () => {
    const data = board()
    const authored = { ...data, columns: data.columns.map((c) => (c.id === 'spec' ? { ...c, width: 'wide' } : c)) } as KanbanData
    expect(kanbanColumnWidthPx(findColumn(authored, 'spec'))).toBeUndefined()
    expect(widthOf(resizePropertyColumn(authored, 'spec', 240), 'spec')).toBe(240)
  })

})

// Sizing is about the column the reader sees, not the kind of value in it: retyping must not quietly
// throw the width away, and a width aimed at no column at all must not reach any of them.
describe('a width only the column it belongs to carries', () => {
  it('ignores an id that is not on the board', () => {
    const data = board()
    expect(resizePropertyColumn(data, 'nope', 240)).toBe(data)
  })

  it('keeps the width through a retype', () => {
    const sized = resizePropertyColumn(board(), 'spec', 240)
    expect(widthOf(changePropertyColumnType(sized, 'spec', 'number'), 'spec')).toBe(240)
  })
})

