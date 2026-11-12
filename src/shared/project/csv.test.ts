import { describe, expect, it } from 'vitest'
import type { ProjectBoardBundle } from './model'
import { emptyProjectViewFields } from './model'
import { projectBoardToCsv } from './csv'

// A minimal RFC4180 reader, test-only, so the export is verified by parsing it back rather than by
// asserting on the producer's own string shape.
function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1 } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && source[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1 }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 10, updateAt: 20, deleteAt: 0 }

function fixture(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'B', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [
      { id: 'p1', name: 'Notes, "quoted"', type: 'text', options: [] },
      { id: 'p2', name: 'Hours', type: 'number', options: [] },
      { id: 'p3', name: 'Tags', type: 'multiSelect', options: [] },
      { id: 'p4', name: 'Due', type: 'date', options: [] },
    ],
    views: [{ id: 'v1', boardId: 'b1', title: 'V', viewType: 'calendar', fields: emptyProjectViewFields(), position: 0, ...stamps }],
    cards: [{
      id: 'c1', boardId: 'b1', parentId: '', title: 'Title, "x"', icon: '', isTemplate: false, contentOrder: [],
      values: { p1: '#hash #second 中文', p2: '3.5', p3: '["a","b"]', p4: '{"from":1000}' }, ...stamps,
    }],
    contents: [], comments: [], members: [], people: {}, role: 'admin', cursor: 20,
  }
}

describe('CSV export', () => {
  it('round-trips commas, quotes, multiple hashes, Chinese and multi-values cell for cell', () => {
    const rows = parseCsv(projectBoardToCsv(fixture()))
    expect(rows[0]).toEqual(['Name', 'Notes, "quoted"', 'Hours', 'Tags', 'Due'])
    expect(rows[1]).toEqual(['Title, "x"', '#hash #second 中文', '3.5', 'a|b', '{"from":1000}'])
  })

  it('starts with a UTF-8 BOM and uses CRLF row endings', () => {
    const csv = projectBoardToCsv(fixture())
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.slice(1).split('\r\n').length).toBe(3)
  })

  it('filters to visible properties in board order and appends the calendar date', () => {
    const rows = parseCsv(projectBoardToCsv(fixture(), { visiblePropertyIds: ['p3', 'p1'], viewType: 'calendar', dateDisplayPropertyId: 'p4' }))
    expect(rows[0]).toEqual(['Name', 'Notes, "quoted"', 'Tags', 'Due'])
    expect(rows[1]).toEqual(['Title, "x"', '#hash #second 中文', 'a|b', '{"from":1000}'])
  })

  it('exports the server-stamped author and time columns from the card, not the value bag', () => {
    const bundle = fixture()
    bundle.properties = [
      { id: 'cb', name: 'Created by', type: 'createdBy', options: [] },
      { id: 'ct', name: 'Created time', type: 'createdTime', options: [] },
    ]
    const rows = parseCsv(projectBoardToCsv(bundle))
    expect(rows[1]).toEqual(['Title, "x"', 'u1', '10'])
  })
})