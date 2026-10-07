import { describe, expect, it } from 'vitest'
import { formatMarkdownTable, parseMarkdownTable, type ParsedTable } from '../../../lib/markdown/table-editor'
import { dropAtEdge, insertAtEdge } from './edits'

const SOURCE = [
  '| a | b | c |',
  '| :- | -: | :-: |',
  '| 1 | 2 | 3 |',
  '| 4 | 5 | 6 |',
]

function parsed(): ParsedTable {
  return parseMarkdownTable(SOURCE, 0)!
}

/** The cells of a rendered line, without the outer pipes. */
function cells(line: string): string[] {
  const parts = line.split('|')
  return parts.slice(1, -1).map((cell) => cell.trim())
}

function rendered(table: ParsedTable): string[][] {
  return formatMarkdownTable(table).map(cells)
}

describe('insertAtEdge', () => {
  const ORIGINAL = [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]

  for (const edge of [0, 1, 2, 3]) {
    it(`inserting a column at edge ${edge} grows the table by one and keeps every value`, () => {
      const rows = rendered(insertAtEdge(parsed(), 'column', edge))
      expect(rows).toHaveLength(4)
      expect(rows.map((row) => row.length)).toEqual([4, 4, 4, 4])
      // Row 1 is the delimiter row, whose new cell is dashes rather than nothing.
      const dataRows = [rows[0]!, rows[2]!, rows[3]!]
      expect(dataRows.map((row) => row.filter((cell) => cell !== ''))).toEqual(ORIGINAL)
    })
  }

  it('puts the new column where the edge was', () => {
    expect(rendered(insertAtEdge(parsed(), 'column', 1))[0]).toEqual(['a', '', 'b', 'c'])
    expect(rendered(insertAtEdge(parsed(), 'column', 1))[2]).toEqual(['1', '', '2', '3'])
  })

  it('moves the alignments with their columns instead of shifting them on its own', () => {
    expect(insertAtEdge(parsed(), 'column', 1).alignments).toEqual(['left', 'default', 'right', 'center'])
  })

  it('keeps the delimiter row a delimiter row', () => {
    const row = rendered(insertAtEdge(parsed(), 'column', 2))[1]
    expect(row.every((cell) => /^:?-+:?$/.test(cell))).toBe(true)
  })

  for (const edge of [0, 1, 2, 3, 4]) {
    it(`inserting a body row at edge ${edge} adds one row of empty cells`, () => {
      const rows = rendered(insertAtEdge(parsed(), 'row', edge))
      expect(rows).toHaveLength(5)
      expect(rows.every((row) => row.length === 3)).toBe(true)
    })
  }

  it('puts a new row below the header when the edge is the header own bottom', () => {
    const rows = rendered(insertAtEdge(parsed(), 'row', 1))
    expect(rows[0]).toEqual(['a', 'b', 'c'])
    expect(rows[2]).toEqual(['', '', ''])
    expect(rows[3]).toEqual(['1', '2', '3'])
  })

  it('never inserts between the header and its delimiter row', () => {
    const rows = rendered(insertAtEdge(parsed(), 'row', 0))
    expect(rows[0]).toEqual(['a', 'b', 'c'])
    expect(rows[1].every((cell) => /^:?-+:?$/.test(cell))).toBe(true)
    expect(rows[2]).toEqual(['', '', ''])
  })
})

describe('dropAtEdge', () => {
  it('moves a body row down to the edge it was dropped on', () => {
    const rows = rendered(dropAtEdge(parsed(), 'row', 1, 3))
    expect(rows.slice(2).map((row) => row[0])).toEqual(['4', '1'])
  })

  it('moves a body row up', () => {
    const rows = rendered(dropAtEdge(parsed(), 'row', 2, 1))
    expect(rows.slice(2).map((row) => row[0])).toEqual(['4', '1'])
  })

  it('leaves a row dropped onto its own edges alone', () => {
    expect(rendered(dropAtEdge(parsed(), 'row', 1, 1))).toEqual(rendered(parsed()))
    expect(rendered(dropAtEdge(parsed(), 'row', 1, 2))).toEqual(rendered(parsed()))
  })

  it('refuses to move the header row', () => {
    expect(rendered(dropAtEdge(parsed(), 'row', 0, 3))).toEqual(rendered(parsed()))
  })

  it('moves a column to the edge it was dropped on and carries its alignment', () => {
    // Edge 2 is the line between the second and third columns, so `a` lands between `b` and `c`.
    const next = dropAtEdge(parsed(), 'column', 0, 2)
    expect(rendered(next)[0]).toEqual(['b', 'a', 'c'])
    expect(next.alignments).toEqual(['right', 'left', 'center'])
  })

  it('keeps the delimiter row under the reordered columns', () => {
    const row = rendered(dropAtEdge(parsed(), 'column', 2, 0))[1]
    expect(row.every((cell) => /^:?-+:?$/.test(cell))).toBe(true)
  })
})
