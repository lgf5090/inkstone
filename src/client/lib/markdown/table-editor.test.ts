import { describe, expect, it } from 'vitest'
import {
  clearTableCell,
  deleteEntireTableInText,
  deleteTableColumn,
  deleteTableRow,
  duplicateTableRow,
  findColumnIndexAtOffset,
  formatMarkdownTable,
  insertTableColumn,
  insertTableRow,
  isDelimiterRow,
  parseMarkdownTable,
  setColumnAlignment,
  sortTableRowByColumn,
  splitTableRow,
  tableToCsv,
  updateTableCell,
  type ParsedTable,
} from './table-editor'

function table(source: string, line = 0, offset = 0): ParsedTable | null {
  return parseMarkdownTable(source.split('\n'), line, offset)
}

const SIMPLE = [
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '| 3 | 4 |',
].join('\n')

describe('splitTableRow', () => {
  it('drops the outer pipes and trims each cell', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b'])
  })

  it('keeps an escaped pipe inside its cell', () => {
    expect(splitTableRow('| a\\|b | c |')).toEqual(['a\\|b', 'c'])
  })

  it('reads a trailing backslash-pipe as content, so the row is simply unclosed', () => {
    expect(splitTableRow('| a | b\\|')).toEqual(['a', 'b\\|'])
  })
})

describe('isDelimiterRow', () => {
  it('accepts every alignment spelling', () => {
    expect(isDelimiterRow('| :--- | ---: | :---: | --- |')).toBe(true)
  })

  it('rejects a header row and a body row', () => {
    expect(isDelimiterRow('| a | b |')).toBe(false)
    expect(isDelimiterRow('| 1 | - |')).toBe(false)
  })
})

describe('findColumnIndexAtOffset', () => {
  it('counts the separating pipe as belonging to the column it closes', () => {
    const line = '| aaa | bbb |'
    expect(findColumnIndexAtOffset(line, 0)).toBe(0)
    expect(findColumnIndexAtOffset(line, 6)).toBe(0)
    expect(findColumnIndexAtOffset(line, 7)).toBe(1)
  })

  it('does not open a column at an escaped pipe', () => {
    expect(findColumnIndexAtOffset('| a\\|b | c |', 5)).toBe(0)
    expect(findColumnIndexAtOffset('| a\\|b | c |', 8)).toBe(1)
  })
})

describe('parseMarkdownTable', () => {
  it('reads the header, the alignments and the body rows', () => {
    const parsed = table('| a | b |\n|:---|---:|\n| 1 | 2 |')!
    expect(parsed.headerRow).toEqual(['a', 'b'])
    expect(parsed.alignments).toEqual(['left', 'right'])
    expect(parsed.rows).toEqual([['1', '2']])
  })

  it('places the cursor on the body row it was asked about, and on none for the header', () => {
    expect(table(SIMPLE, 3)!.cursorRowIndex).toBe(1)
    expect(table(SIMPLE, 0)!.cursorRowIndex).toBe(-1)
    expect(table(SIMPLE, 1)!.cursorRowIndex).toBe(-1)
  })

  it('pads a short row out to the widest one', () => {
    const parsed = table('| a | b | c |\n| --- | --- | --- |\n| 1 |')!
    expect(parsed.columnCount).toBe(3)
    expect(parsed.rows).toEqual([['1', '', '']])
  })

  it('returns null for a line that is not part of a table', () => {
    expect(table('no pipes here')).toBeNull()
    expect(table('| a | b |')).toBeNull()
  })

  it('keeps the block bounds so the caller can splice the same lines back', () => {
    const parsed = table(`intro\n${SIMPLE}\noutro`, 3)!
    expect(parsed.startLine).toBe(1)
    expect(parsed.endLine).toBe(4)
  })

  it('reads a table written without outer pipes', () => {
    const parsed = table('a | b\n--- | ---\n1 | 2')!
    expect(parsed.headerRow).toEqual(['a', 'b'])
    expect(parsed.rows).toEqual([['1', '2']])
  })
})

describe('formatMarkdownTable', () => {
  it('pads every column to at least its own widest cell, three at minimum', () => {
    const lines = formatMarkdownTable(table('| long | b |\n| --- | --- |\n| 1 | 2 |')!)
    expect(lines).toEqual(['| long | b   |', '| ---- | --- |', '| 1    | 2   |'])
  })

  it('round-trips a table it just parsed', () => {
    const parsed = table(SIMPLE)!
    expect(table(formatMarkdownTable(parsed).join('\n'))).toEqual(parsed)
  })

  it('writes the alignment markers back inside the padded width', () => {
    const lines = formatMarkdownTable(setColumnAlignment(table(SIMPLE)!, 0, 'center'))
    expect(lines[1]).toBe('| :-: | --- |')
  })
})

describe('row edits', () => {
  it('inserts below the cursor and keeps the block bounds', () => {
    const parsed = table(SIMPLE, 2)!
    const next = insertTableRow(parsed, parsed.cursorRowIndex, 'below')
    expect(next.rows).toEqual([['1', '2'], ['', ''], ['3', '4']])
    expect(next.startLine).toBe(parsed.startLine)
    expect(next.endLine).toBe(parsed.endLine)
  })

  it('inserting above the header pushes the header down into the body', () => {
    const parsed = table(SIMPLE, 0)!
    const next = insertTableRow(parsed, -1, 'above')
    expect(next.headerRow).toEqual(['', ''])
    expect(next.rows[0]).toEqual(['a', 'b'])
  })

  it('duplicates the row under the cursor', () => {
    const parsed = table(SIMPLE, 3)!
    expect(duplicateTableRow(parsed, parsed.cursorRowIndex).rows).toEqual([['1', '2'], ['3', '4'], ['3', '4']])
  })

  it('leaves the table alone when asked to duplicate a row that is not there', () => {
    const parsed = table(SIMPLE)!
    expect(duplicateTableRow(parsed, -1)).toBe(parsed)
    expect(duplicateTableRow(parsed, 9)).toBe(parsed)
  })

  it('promotes the first body row when the header is deleted', () => {
    const next = deleteTableRow(table(SIMPLE)!, -1)
    expect(next.headerRow).toEqual(['1', '2'])
    expect(next.rows).toEqual([['3', '4']])
  })

  it('clamps the cursor back onto the last row when the bottom one goes', () => {
    const parsed = table(SIMPLE, 3)!
    const next = deleteTableRow(parsed, parsed.cursorRowIndex)
    expect(next.rows).toEqual([['1', '2']])
    expect(next.cursorRowIndex).toBe(0)
  })
})

describe('column edits', () => {
  it('inserts to the left and keeps every row the same width', () => {
    const parsed = table(SIMPLE, 2)!
    const next = insertTableColumn(parsed, 1, 'left')
    expect(next.columnCount).toBe(3)
    expect(next.rows).toEqual([['1', '', '2'], ['3', '', '4']])
    expect(next.alignments).toEqual(['default', 'default', 'default'])
  })

  it('drops the column under the cursor', () => {
    const next = deleteTableColumn(table(SIMPLE)!, 0)
    expect(next.headerRow).toEqual(['b'])
    expect(next.rows).toEqual([['2'], ['4']])
  })

  it('refuses to delete the only column', () => {
    const parsed = table('| a |\n| --- |\n| 1 |')!
    expect(deleteTableColumn(parsed, 0)).toBe(parsed)
  })
})

describe('cell edits', () => {
  it('clears one cell without touching its neighbours', () => {
    const parsed = table(SIMPLE, 2)!
    expect(clearTableCell(parsed, 0, 1).rows).toEqual([['1', ''], ['3', '4']])
  })

  it('re-escapes a pipe written into a cell', () => {
    expect(updateTableCell(table(SIMPLE)!, 0, 0, 'x|y').rows[0][0]).toBe('x\\|y')
  })

  it('ignores an out-of-range cell rather than corrupting a row', () => {
    const parsed = table(SIMPLE)!
    expect(updateTableCell(parsed, 0, 9, 'x')).toBe(parsed)
    expect(updateTableCell(parsed, 9, 0, 'x')).toBe(parsed)
  })
})

describe('sortTableRowByColumn', () => {
  it('sorts numeric cells as numbers', () => {
    const parsed = table('| n |\n| --- |\n| 10 |\n| 2 |\n| 1 |')!
    expect(sortTableRowByColumn(parsed, 0, 'asc').rows).toEqual([['1'], ['2'], ['10']])
  })

  it('puts blanks last under an ascending sort of mixed text', () => {
    const parsed = table('| n |\n| --- |\n| b |\n|  |\n| a |')!
    expect(sortTableRowByColumn(parsed, 0, 'asc').rows).toEqual([[''], ['a'], ['b']])
  })

  it('reverses for descending', () => {
    const parsed = table('| n |\n| --- |\n| 1 |\n| 2 |')!
    expect(sortTableRowByColumn(parsed, 0, 'desc').rows).toEqual([['2'], ['1']])
  })
})

describe('tableToCsv', () => {
  it('quotes only what needs quoting', () => {
    expect(tableToCsv(table('| a | b |\n| --- | --- |\n| x,y | he said "hi" |')!))
      .toBe('a,b\n"x,y","he said ""hi"""')
  })
})

describe('deleteEntireTableInText', () => {
  it('removes the block and leaves the surrounding lines', () => {
    expect(deleteEntireTableInText(`intro\n${SIMPLE}\noutro`, 1)).toBe('intro\noutro')
  })

  it('returns the note untouched when the line holds no table', () => {
    expect(deleteEntireTableInText('just a line', 0)).toBe('just a line')
  })
})
