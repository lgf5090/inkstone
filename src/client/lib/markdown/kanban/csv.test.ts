import { describe, expect, it } from 'vitest'
import type { KanbanItem, KanbanProperty } from './types'
import { KANBAN_DESCRIPTION_MAX_CHARS } from './body'
import {
  KANBAN_CSV_MAX_BYTES,
  KANBAN_CSV_MAX_ROWS,
  importKanbanCsv,
  kanbanCsvColumns,
  kanbanCsvFilename,
  kanbanToCsv,
  parseKanbanCsv,
} from './csv'

const COLUMNS: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  { id: 'description', name: 'Description', type: 'text' },
  { id: 'status', name: 'Status', type: 'select', options: [
    { id: 'todo', label: 'To do', color: 'gray' },
    { id: 'doing', label: 'In progress', color: 'blue' },
  ] },
  { id: 'tags', name: 'Tags', type: 'multi-select', options: [
    { id: 'bug', label: 'Bug', color: 'red' },
    { id: 'ux', label: 'UX', color: 'green' },
  ] },
  { id: 'deadline', name: 'Deadline', type: 'date' },
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'blocked', name: 'Blocked', type: 'checkbox' },
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'files', name: 'Files', type: 'files' },
]

const HEADER = ['Title', 'Description', 'Status', 'Tags', 'Deadline', 'Points', 'Blocked', 'Owner']
const BOM = '\uFEFF'

/** The rows of an export, read back through the parser so a test never counts commas. */
const rowsOf = (csv: string) => parseKanbanCsv(csv)

function item(partial: Partial<KanbanItem> & { id: string }): KanbanItem {
  return { title: '', properties: {}, ...partial }
}

function mustImport(text: string, columns: KanbanProperty[] = COLUMNS, existingItems = 0) {
  const result = importKanbanCsv(text, columns, existingItems)
  if (!result.ok) throw new Error(`that file should import, got ${result.reason}`)
  return result
}

describe('the columns a board exports', () => {
  it('skips the title column, which leads every row, and the attachments', () => {
    expect(kanbanCsvColumns(COLUMNS).map((column) => column.id)).toEqual([
      'description',
      'status',
      'tags',
      'deadline',
      'points',
      'blocked',
      'owner',
    ])
  })

  it('keeps a document whose schema declares no title column at all', () => {
    const declared = COLUMNS.filter((column) => column.type !== 'title')
    expect(kanbanCsvColumns(declared).map((column) => column.id)).toEqual([
      'description',
      'status',
      'tags',
      'deadline',
      'points',
      'blocked',
      'owner',
    ])
  })
})

describe('exporting a board', () => {
  it('prints one header row and one row per card', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'First' }), item({ id: 'b', title: 'Second' })])
    expect(rowsOf(csv)).toEqual([
      HEADER,
      ['First', '', '', '', '', '', '', ''],
      ['Second', '', '', '', '', '', '', ''],
    ])
  })

  it('prints option labels rather than ids and joins several tags with a separator', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'T', properties: { status: 'doing', tags: ['bug', 'ux'] } })])
    expect(rowsOf(csv)[1]).toEqual(['T', '', 'In progress', 'Bug; UX', '', '', '', ''])
  })

  it('falls back to the stored value when a select holds something the column never declared', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'T', properties: { status: 'archived_elsewhere' } })])
    expect(rowsOf(csv)[1]).toEqual(['T', '', 'archived_elsewhere', '', '', '', '', ''])
  })

  it('writes the description from either field the detail dialog has used', () => {
    const csv = kanbanToCsv(COLUMNS, [
      item({ id: 'a', title: 'A', content: 'from content' }),
      item({ id: 'b', title: 'B', description: 'from description' }),
    ])
    expect(rowsOf(csv).slice(1).map((row) => row[1])).toEqual(['from content', 'from description'])
  })

  it('quotes a cell that carries a comma, a quote or a newline, doubling its quotes', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'Say "hi", now', content: 'line 1\nline 2' })])
    expect(csv).toBe(`${BOM}Title,Description,Status,Tags,Deadline,Points,Blocked,Owner\n"Say ""hi"", now","line 1\nline 2",,,,,,`)
    expect(rowsOf(csv)[1].slice(0, 2)).toEqual(['Say "hi", now', 'line 1\nline 2'])
  })

  it('prints checkboxes as true and false and leaves an untouched one blank', () => {
    const csv = kanbanToCsv(COLUMNS, [
      item({ id: 'a', title: 'A', properties: { blocked: true } }),
      item({ id: 'b', title: 'B', properties: { blocked: false } }),
      item({ id: 'c', title: 'C' }),
    ])
    expect(rowsOf(csv).slice(1).map((row) => row[6])).toEqual(['true', 'false', ''])
  })
})

describe('the cells a spreadsheet must not run', () => {
  it('marks a cell a spreadsheet would run as a formula, inside the quotes', () => {
    const csv = kanbanToCsv(COLUMNS, [
      item({ id: 'a', title: '=1+2' }),
      item({ id: 'b', title: '+cmd|calc' }),
      item({ id: 'c', title: '@SUM(A1)' }),
      item({ id: 'd', title: '-2+3+cmd|calc' }),
      item({ id: 'e', title: '\uFF1D1+2' }),
    ])
    expect(rowsOf(csv).slice(1).map((row) => row[0])).toEqual([
      '\t=1+2',
      '\t+cmd|calc',
      '\t@SUM(A1)',
      '\t-2+3+cmd|calc',
      '\t\uFF1D1+2',
    ])
    // The mark has to sit inside the quoted field, or Excel reads the quote as the cell's own text.
    expect(csv).toContain('"\t=1+2"')
  })

  it('leaves a negative number as a value rather than marking it as an expression', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'T', properties: { points: -5 } })])
    expect(rowsOf(csv)[1][5]).toBe('-5')
  })

  it('reads its own marked cells back as the text the board wrote', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: '=1+2', content: '=SUM(A1)' })])
    const imported = mustImport(csv)
    expect(imported.items[0]?.title).toBe('=1+2')
    expect(imported.items[0]?.content).toBe('=SUM(A1)')
  })
})

describe('the file a board hands over', () => {
  it('exports nothing but the header when the board has no cards', () => {
    expect(kanbanToCsv(COLUMNS, [])).toBe(`${BOM}${HEADER.join(',')}`)
  })

  it('leads with the byte order mark Excel needs to read anything but ASCII', () => {
    const csv = kanbanToCsv(COLUMNS, [item({ id: 'a', title: 'Café' })])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    // The mark belongs to the file, not to the row: the board reads its own file back without it.
    expect(rowsOf(csv)[0]).toEqual(HEADER)
    expect(rowsOf(csv)[1][0]).toBe('Café')
  })

  it('names the file after the board with the characters a filesystem refuses removed', () => {
    expect(kanbanCsvFilename('Q3 Roadmap')).toBe('Q3 Roadmap.csv')
    expect(kanbanCsvFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij.csv')
    expect(kanbanCsvFilename('   ')).toBe('board.csv')
  })
})

describe('reading a csv file', () => {
  it('splits on unquoted commas only, and un doubles the quotes', () => {
    expect(parseKanbanCsv('a,"b,c","say ""hi""",d')).toEqual([['a', 'b,c', 'say "hi"', 'd']])
  })

  it('keeps a quoted newline inside the cell it belongs to', () => {
    expect(parseKanbanCsv('Title,Description\n"Two","lines\nhere"')).toEqual([
      ['Title', 'Description'],
      ['Two', 'lines\nhere'],
    ])
  })

  it('accepts the CRLF endings and the byte order mark a spreadsheet writes', () => {
    expect(parseKanbanCsv('﻿Title,Status\r\nA,todo\r\nB,doing')).toEqual([
      ['Title', 'Status'],
      ['A', 'todo'],
      ['B', 'doing'],
    ])
  })

  it('treats a trailing newline as the end of the last row, not as an empty one', () => {
    expect(parseKanbanCsv('Title\nA\n')).toEqual([['Title'], ['A']])
    expect(parseKanbanCsv('Title\nA')).toEqual([['Title'], ['A']])
  })

  it('keeps a cell that is quoted but empty as empty rather than dropping it', () => {
    expect(parseKanbanCsv('Title,Status\nA,""')).toEqual([['Title', 'Status'], ['A', '']])
  })

  it('keeps a quote that arrives after the cell began as the text of that cell', () => {
    expect(parseKanbanCsv('Title,Status\nab"cd,e""f')).toEqual([['Title', 'Status'], ['ab"cd', 'e""f']])
  })
})

describe('importing cards from a csv file', () => {
  it('maps each header onto the column that declares that name, whatever order the file uses', () => {
    const result = mustImport('Status,Title,Points\ndoing,B,7')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe('B')
    expect(result.items[0].properties.status).toBe('doing')
    expect(result.items[0].properties.points).toBe(7)
  })

  it('matches an option by label as well as by id, without caring about case or padding', () => {
    expect(mustImport('Title, Status\nA, In progress ').items[0].properties.status).toBe('doing')
    expect(mustImport('Title,Status\nA,TODO').items[0].properties.status).toBe('todo')
  })

  it('declares the group a file mentions for the first time, so the card is not filed nowhere', () => {
    const result = mustImport('Title,Status\nA,Waiting\nB,Waiting\nC,Reviewing')
    expect(result.newOptions).toBe(2)
    const status = result.columns.find((column) => column.id === 'status')
    expect(status?.options?.map((option) => option.id)).toEqual(['todo', 'doing', 'waiting', 'reviewing'])
    expect(status?.options?.at(-1)?.color).toBe('gray')
    expect(result.items.map((card) => card.properties.status)).toEqual(['waiting', 'waiting', 'reviewing'])
    expect(COLUMNS.find((column) => column.id === 'status')?.options).toHaveLength(2)
  })

  it('steps aside when the id it would coin is already taken by another label', () => {
    const crowded: KanbanProperty[] = [
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'a_b', label: 'Ay B', color: 'gray' }] },
    ]
    const result = mustImport('Title,Status\nA,B C\nB,A B', crowded)
    expect(result.columns[0]?.options?.map((option) => option.id)).toEqual(['a_b', 'b_c', 'a_b_2'])
    expect(result.items.map((card) => card.properties.status)).toEqual(['b_c', 'a_b_2'])
  })

  it('leaves the schema object it was given untouched when nothing new was declared', () => {
    const result = mustImport('Title,Status\nA,To do')
    expect(result.columns).toBe(COLUMNS)
    expect(result.newOptions).toBe(0)
  })

  it('refuses a file that is too large to parse without freezing the tab', () => {
    const oversized = 'Title\nx\n' + 'a'.repeat(KANBAN_CSV_MAX_BYTES + 1)
    expect(importKanbanCsv(oversized, COLUMNS)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('clamps the description cell to the same bound the editor enforces', () => {
    const giant = 'a'.repeat(KANBAN_DESCRIPTION_MAX_CHARS + 100)
    const result = mustImport(`Title,Description\nA,${giant}`)
    expect(result.items[0].content).toHaveLength(KANBAN_DESCRIPTION_MAX_CHARS)
  })
})

describe('reading each kind of cell back', () => {
  it('splits a multi select on the separator the export uses', () => {
    expect(mustImport('Title,Tags\nA,"Bug; UX"').items[0].properties.tags).toEqual(['bug', 'ux'])
  })

  it('reads checkbox cells whatever spelling the sheet used and treats a blank as no value at all', () => {
    const result = mustImport('Title,Blocked\nA,true\nB,YES\nC,1\nD,x\nE,no\nF,')
    expect(result.items.map((card) => card.properties.blocked)).toEqual([true, true, true, true, false, undefined])
    expect('blocked' in result.items[5].properties).toBe(false)
  })

  it('normalizes a date written with a time and refuses one it cannot place on a calendar', () => {
    const result = mustImport('Title,Deadline\nA,2026-03-10T12:00:00Z\nB,not a date\nC,3/10/2026')
    expect(result.items[0].properties.deadline).toBe('2026-03-10')
    expect('deadline' in result.items[1].properties).toBe(false)
    expect('deadline' in result.items[2].properties).toBe(false)
    expect(result.ignoredCells).toBe(2)
  })

  it('writes the description onto the field the detail dialog reads first', () => {
    const result = mustImport('Title,Description\nA,"multi\nline"')
    expect(result.items[0].content).toBe('multi\nline')
    expect(result.items[0].description).toBeUndefined()
  })

  it('keeps a person name as written', () => {
    expect(mustImport('Title,Owner\nA,Ada').items[0].properties.owner).toBe('Ada')
  })
})

describe('what a file carries beyond the board', () => {
  it('skips a row with no title rather than adding a nameless card', () => {
    const result = mustImport('Title,Status\n,todo\n  ,doing\nA,todo')
    expect(result.items).toHaveLength(1)
    expect(result.skippedRows).toBe(2)
  })

  it('reports a header the board has no column for instead of inventing one', () => {
    const result = mustImport('Title,Nostalgia\nA,7')
    expect(result.ignoredHeaders).toEqual(['Nostalgia'])
    expect(result.columns).toBe(COLUMNS)
  })

  it('gives every imported card its own id and leaves it unarchived', () => {
    const result = mustImport('Title\nA\nA\nB')
    const ids = result.items.map((card) => card.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.items.every((card) => card.archived === undefined)).toBe(true)
  })
})

describe('refusing a file the board cannot read', () => {
  it('refuses a file with no Title column, which no card can be rebuilt from', () => {
    expect(importKanbanCsv('Status,Points\ntodo,3', COLUMNS)).toEqual({ ok: false, reason: 'no_title' })
  })

  it('refuses an empty file and one that is only a header', () => {
    expect(importKanbanCsv('   ', COLUMNS)).toEqual({ ok: false, reason: 'empty' })
    expect(importKanbanCsv('Title,Status', COLUMNS)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses a file over the row cap rather than importing the first thousand', () => {
    const rows = ['Title']
    for (let index = 0; index <= KANBAN_CSV_MAX_ROWS; index += 1) rows.push(`C${index}`)
    expect(importKanbanCsv(rows.join('\n'), COLUMNS)).toEqual({ ok: false, reason: 'too_many' })
  })

  it('reads a file sitting exactly on the row cap', () => {
    const rows = ['Title']
    for (let index = 0; index < KANBAN_CSV_MAX_ROWS; index += 1) rows.push(`C${index}`)
    expect(mustImport(rows.join('\n')).items).toHaveLength(KANBAN_CSV_MAX_ROWS)
  })
})

/**
 * The room a board has left, which is the fence's own ceiling seen from the import door: a file that
 * fits in a spreadsheet but not on this board would write a board the fence then refuses to read, so
 * the import is refused instead — and refused on what it would really add, not on its row count.
 */
describe('importing into the room a board has left', () => {
  const oneRow = 'Title\nFresh'

  it('reads a file that exactly fills the last seats', () => {
    expect(mustImport(oneRow, COLUMNS, KANBAN_CSV_MAX_ROWS - 1).items).toHaveLength(1)
  })

  it('refuses the file that would sit one card past the ceiling', () => {
    expect(importKanbanCsv(oneRow, COLUMNS, KANBAN_CSV_MAX_ROWS)).toEqual({ ok: false, reason: 'no_room' })
  })

  it('refuses it for a board that is already full, whatever the file holds', () => {
    expect(importKanbanCsv('Title\nA\nB', COLUMNS, KANBAN_CSV_MAX_ROWS)).toEqual({ ok: false, reason: 'no_room' })
  })

  it('judges by what the file would really add: a row with no title does not take a seat', () => {
    const withSkipped = 'Title,Points\nFresh,3\n,4'
    const filledToOneShort = mustImport(withSkipped, COLUMNS, KANBAN_CSV_MAX_ROWS - 1)
    expect(filledToOneShort.items).toHaveLength(1)
    expect(filledToOneShort.skippedRows).toBe(1)
  })

  it('leaves a board with no cards told about the file alone', () => {
    // The third argument is the board's own count: absent, the door behaves as it always has.
    expect(mustImport(oneRow).items).toHaveLength(1)
  })
})

describe('a board that travels out and back', () => {
  it('imports a board it just exported, cells and all', () => {
    const source = [
      item({ id: 'a', title: 'Quote, "and" a comma', content: 'first line\nsecond', properties: { status: 'doing', tags: ['bug'], points: 3, blocked: true, deadline: '2026-03-10', owner: 'Ada' } }),
      item({ id: 'b', title: 'Plain', properties: { status: 'todo' } }),
    ]
    const result = mustImport(kanbanToCsv(COLUMNS, source))
    expect(result.items.map((card) => card.title)).toEqual(['Quote, "and" a comma', 'Plain'])
    expect(result.items.map((card) => card.content)).toEqual(['first line\nsecond', undefined])
    expect(result.items.map((card) => card.properties)).toEqual(source.map((card) => card.properties))
    expect(result.skippedRows).toBe(0)
    expect(result.ignoredCells).toBe(0)
    expect(result.ignoredHeaders).toEqual([])
    expect(result.newOptions).toBe(0)
    expect(result.columns).toBe(COLUMNS)
  })
})
