/**
 * The pipe table as an editable object: where the block the cursor sits in begins, which row and
 * column that cursor is on, and the row/column/alignment edits a menu asks for.
 *
 * Geometry stays on the table the caller passed in. Every edit below returns a table whose
 * `startLine`/`endLine` still describe the block *in the note*, because the caller replaces exactly
 * those lines with `formatMarkdownTable`'s output — an edit that moved its own bounds would make the
 * next edit in the same menu cut a different block out of the note.
 */

export type ColumnAlignment = 'left' | 'center' | 'right' | 'default'

export interface ParsedTable {
  /** 0-based line of the header row, matching the renderer's `data-line`. */
  startLine: number
  /** 0-based line of the last body row. */
  endLine: number
  headerRow: string[]
  alignments: ColumnAlignment[]
  rows: string[][]
  columnCount: number
  /** -1 while the cursor is on the header or the delimiter row. */
  cursorRowIndex: number
  cursorColIndex: number
}

interface SplitCellState {
  current: string
  isEscaped: boolean
}

export function splitTableRow(line: string): string[] {
  const cells: string[] = []
  const state: SplitCellState = { current: '', isEscaped: false }

  const trimmed = line.trim()
  let rest = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  if (rest.endsWith('|') && !rest.endsWith('\\|')) {
    rest = rest.slice(0, -1)
  }

  for (let i = 0; i < rest.length; i++) {
    splitCellChar(state, cells, rest[i]!)
  }
  cells.push(state.current.trim())
  return cells
}

function splitCellChar(state: SplitCellState, cells: string[], char: string): void {
  if (state.isEscaped) {
    state.current += char
    state.isEscaped = false
    return
  }
  if (char === '\\') {
    state.current += char
    state.isEscaped = true
    return
  }
  if (char === '|') {
    cells.push(state.current.trim())
    state.current = ''
    return
  }
  state.current += char
}

export function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line)
  if (cells.length === 0) return false
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
}

function parseCellAlignment(cell: string): ColumnAlignment {
  const trimmed = cell.trim()
  const leftColon = trimmed.startsWith(':')
  const rightColon = trimmed.endsWith(':')
  if (leftColon && rightColon) return 'center'
  if (rightColon) return 'right'
  if (leftColon) return 'left'
  return 'default'
}

function formatDelimiterCell(align: ColumnAlignment, width = 3): string {
  const fillWidth = Math.max(3, width)
  switch (align) {
    case 'center':
      return `:${'-'.repeat(Math.max(1, fillWidth - 2))}:`
    case 'right':
      return `${'-'.repeat(Math.max(2, fillWidth - 1))}:`
    case 'left':
      return `:${'-'.repeat(Math.max(2, fillWidth - 1))}`
    case 'default':
    default:
      return '-'.repeat(fillWidth)
  }
}

/**
 * The column a character offset falls in. A leading pipe opens no column: `| a | b |` puts offset 0
 * and offset 2 both in column 0, and only the pipe before `b` moves the cursor to column 1.
 */
export function findColumnIndexAtOffset(line: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, line.length))
  let col = 0
  let escaped = false
  for (let i = 0; i < clamped; i++) {
    const char = line[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '|' && line.slice(0, i).trim() !== '') col++
  }
  return col
}

function findTableBounds(lines: string[], targetLineIndex: number): { startLine: number; endLine: number } {
  let startLine = targetLineIndex
  while (startLine > 0 && (lines[startLine - 1] ?? '').includes('|') && (lines[startLine - 1] ?? '').trim().length > 0) {
    startLine--
  }
  let endLine = targetLineIndex
  while (endLine + 1 < lines.length && (lines[endLine + 1] ?? '').includes('|') && (lines[endLine + 1] ?? '').trim().length > 0) {
    endLine++
  }
  return { startLine, endLine }
}

function findDelimiterLine(lines: string[], startLine: number, endLine: number): number {
  for (let i = startLine + 1; i <= endLine; i++) {
    if (isDelimiterRow(lines[i] ?? '')) return i
  }
  return -1
}

export function parseMarkdownTable(lines: string[], targetLineIndex: number, characterOffset = 0): ParsedTable | null {
  if (targetLineIndex < 0 || targetLineIndex >= lines.length) return null
  const currentLine = lines[targetLineIndex] ?? ''
  if (!currentLine.includes('|')) return null

  const bounds = findTableBounds(lines, targetLineIndex)
  const delimiterLineIndex = findDelimiterLine(lines, bounds.startLine, bounds.endLine)
  if (delimiterLineIndex === -1) return null

  const headerLineIndex = delimiterLineIndex - 1
  if (headerLineIndex < bounds.startLine) return null

  const rawHeaders = splitTableRow(lines[headerLineIndex] ?? '')
  const rawDelimiters = splitTableRow(lines[delimiterLineIndex] ?? '')

  let columnCount = Math.max(rawHeaders.length, rawDelimiters.length, 1)
  const rows: string[][] = []
  for (let i = delimiterLineIndex + 1; i <= bounds.endLine; i++) {
    const rawRow = splitTableRow(lines[i] ?? '')
    columnCount = Math.max(columnCount, rawRow.length)
    rows.push(rawRow)
  }

  const headerRow: string[] = []
  const alignments: ColumnAlignment[] = []
  for (let c = 0; c < columnCount; c++) {
    headerRow.push(rawHeaders[c] ?? '')
    alignments.push(rawDelimiters[c] ? parseCellAlignment(rawDelimiters[c]!) : 'default')
  }

  let cursorRowIndex = -1
  if (targetLineIndex > delimiterLineIndex) {
    cursorRowIndex = targetLineIndex - delimiterLineIndex - 1
  }

  return {
    startLine: headerLineIndex,
    endLine: bounds.endLine,
    headerRow,
    alignments,
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, c) => row[c] ?? '')),
    columnCount,
    cursorRowIndex,
    cursorColIndex: Math.min(columnCount - 1, Math.max(0, findColumnIndexAtOffset(currentLine, characterOffset))),
  }
}

export function formatMarkdownTable(table: ParsedTable): string[] {
  const colWidths = new Array<number>(table.columnCount).fill(3)
  for (let c = 0; c < table.columnCount; c++) {
    colWidths[c] = Math.max(colWidths[c]!, (table.headerRow[c] ?? '').length)
    for (const row of table.rows) {
      colWidths[c] = Math.max(colWidths[c]!, (row[c] ?? '').length)
    }
  }

  const render = (cells: (index: number) => string) =>
    `|${Array.from({ length: table.columnCount }, (_, c) => ` ${cells(c).padEnd(colWidths[c]!)} `).join('|')}|`

  return [
    render((c) => table.headerRow[c] ?? ''),
    render((c) => formatDelimiterCell(table.alignments[c] ?? 'default', colWidths[c]!)),
    ...table.rows.map((row) => render((c) => row[c] ?? '')),
  ]
}

export function insertTableRow(table: ParsedTable, rowIndex: number, position: 'above' | 'below'): ParsedTable {
  const empty = new Array<string>(table.columnCount).fill('')
  const rows = table.rows.map((row) => [...row])

  if (rowIndex < 0) {
    if (position === 'above') {
      return { ...table, headerRow: empty, rows: [[...table.headerRow], ...rows], cursorRowIndex: 0 }
    }
    return { ...table, rows: [empty, ...rows], cursorRowIndex: 0 }
  }

  const insertIndex = position === 'above' ? rowIndex : rowIndex + 1
  rows.splice(insertIndex, 0, empty)
  return { ...table, rows, cursorRowIndex: insertIndex }
}

export function deleteTableRow(table: ParsedTable, rowIndex: number): ParsedTable {
  if (rowIndex < 0) {
    if (table.rows.length === 0) return table
    const [newHeader, ...remainingRows] = table.rows
    return { ...table, headerRow: newHeader ?? table.headerRow, rows: remainingRows, cursorRowIndex: -1 }
  }
  const rows = table.rows.filter((_, idx) => idx !== rowIndex)
  return { ...table, rows, cursorRowIndex: Math.min(rowIndex, rows.length - 1) }
}

export function duplicateTableRow(table: ParsedTable, rowIndex: number): ParsedTable {
  if (rowIndex < 0 || rowIndex >= table.rows.length) return table
  const rows = [...table.rows]
  rows.splice(rowIndex + 1, 0, [...table.rows[rowIndex]!])
  return { ...table, rows, cursorRowIndex: rowIndex + 1 }
}

export function insertTableColumn(table: ParsedTable, colIndex: number, position: 'left' | 'right'): ParsedTable {
  const insertIndex = position === 'left' ? colIndex : colIndex + 1
  const headerRow = [...table.headerRow]
  headerRow.splice(insertIndex, 0, '')

  const alignments = [...table.alignments]
  alignments.splice(insertIndex, 0, 'default')

  const rows = table.rows.map((row) => {
    const updated = [...row]
    updated.splice(insertIndex, 0, '')
    return updated
  })

  return { ...table, headerRow, alignments, rows, columnCount: table.columnCount + 1, cursorColIndex: insertIndex }
}

export function deleteTableColumn(table: ParsedTable, colIndex: number): ParsedTable {
  if (table.columnCount <= 1) return table
  const columnCount = table.columnCount - 1
  const drop = <T,>(cells: T[]) => cells.filter((_, idx) => idx !== colIndex)
  return {
    ...table,
    headerRow: drop(table.headerRow),
    alignments: drop(table.alignments),
    rows: table.rows.map(drop),
    columnCount,
    cursorColIndex: Math.min(colIndex, columnCount - 1),
  }
}

export function setColumnAlignment(table: ParsedTable, colIndex: number, align: ColumnAlignment): ParsedTable {
  if (colIndex < 0 || colIndex >= table.columnCount) return table
  const alignments = [...table.alignments]
  alignments[colIndex] = align
  return { ...table, alignments }
}

/**
 * Make a cell's text safe to drop between two pipes. A pipe the author already escaped is left
 * alone: escaping it a second time would end the cell early, because `splitTableRow` reads `\\` as
 * a literal backslash and the `|` after it as a separator.
 */
export function escapeTableCell(text: string): string {
  let out = ''
  let escaped = false
  for (const char of text) {
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\') {
      out += char
      escaped = true
      continue
    }
    out += char === '|' ? '\\|' : char
  }
  return out
}

/** {@link escapeTableCell} reversed, for showing a parsed cell to a person rather than to a parser. */
export function unescapeTableCell(source: string): string {
  let out = ''
  let escaped = false
  for (const char of source) {
    if (escaped) {
      out += char === '|' ? '|' : `\\${char}`
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    out += char
  }
  return out
}

const BR_TAG = /<br\s*\/?>/gi

/** A cell as it reads in the box: escapes undone, and the line breaks the author wrote as real lines. */
export function cellDisplayText(source: string): string {
  return unescapeTableCell(source).replace(BR_TAG, '\n')
}

/** The other half of {@link cellDisplayText}: a line the box wrapped becomes a break again. */
export function cellSourceText(display: string): string {
  return escapeTableCell(display.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>')
}

export function updateTableCell(table: ParsedTable, rowIndex: number, colIndex: number, newContent: string): ParsedTable {
  if (colIndex < 0 || colIndex >= table.columnCount) return table
  const safe = cellSourceText(newContent)
  if (rowIndex === -1) {
    const headerRow = [...table.headerRow]
    headerRow[colIndex] = safe
    return { ...table, headerRow }
  }
  if (rowIndex < 0 || rowIndex >= table.rows.length) return table
  const rows = table.rows.map((row, rIdx) => {
    if (rIdx !== rowIndex) return row
    const next = [...row]
    next[colIndex] = safe
    return next
  })
  return { ...table, rows }
}

export function clearTableCell(table: ParsedTable, rowIndex: number, colIndex: number): ParsedTable {
  return updateTableCell(table, rowIndex, colIndex, '')
}

export function clearTableRow(table: ParsedTable, rowIndex: number): ParsedTable {
  const empty = new Array<string>(table.columnCount).fill('')
  if (rowIndex === -1) return { ...table, headerRow: empty }
  if (rowIndex < 0 || rowIndex >= table.rows.length) return table
  return { ...table, rows: table.rows.map((row, rIdx) => (rIdx === rowIndex ? empty : row)) }
}

export function clearTableColumn(table: ParsedTable, colIndex: number): ParsedTable {
  if (colIndex < 0 || colIndex >= table.columnCount) return table
  return {
    ...table,
    headerRow: table.headerRow.map((cell, idx) => (idx === colIndex ? '' : cell)),
    rows: table.rows.map((row) => row.map((cell, idx) => (idx === colIndex ? '' : cell))),
  }
}

function moved<T>(cells: T[], from: number, to: number): T[] {
  const next = [...cells]
  const [taken] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, taken!)
  return next
}

/**
 * Reorder a body row. `to` is where the row should end up, counted in the list it is being taken out
 * of — so moving row 1 to `0` and moving row 0 to `1` are the two directions of one swap, and a drop
 * onto the row's own slot returns the table unchanged.
 */
export function moveTableRow(table: ParsedTable, from: number, to: number): ParsedTable {
  if (from < 0 || from >= table.rows.length) return table
  if (from === to) return table
  return { ...table, rows: moved(table.rows, from, to), cursorRowIndex: Math.max(0, Math.min(to, table.rows.length - 1)) }
}

/** Reorder a column, header, delimiter alignment and all. */
export function moveTableColumn(table: ParsedTable, from: number, to: number): ParsedTable {
  if (from < 0 || from >= table.columnCount) return table
  if (from === to) return table
  const perm = moved(Array.from({ length: table.columnCount }, (_, i) => i), from, to)
  const pick = <T, >(cells: T[]) => perm.map((source) => cells[source] ?? ('' as unknown as T))
  return {
    ...table,
    headerRow: pick(table.headerRow),
    alignments: pick(table.alignments),
    rows: table.rows.map(pick),
    cursorColIndex: Math.max(0, Math.min(to, table.columnCount - 1)),
  }
}

/**
 * Numbers sort as numbers and everything else as text, so a table of counts does not come back
 * 1, 10, 2. `numeric` covers the mixed case (`Q1`, `Q2`) that neither branch alone gets right.
 */
export function sortTableRowByColumn(table: ParsedTable, colIndex: number, direction: 'asc' | 'desc'): ParsedTable {
  if (colIndex < 0 || colIndex >= table.columnCount) return table
  const sign = direction === 'asc' ? 1 : -1
  const rows = [...table.rows].sort((rowA, rowB) => {
    const valA = (rowA[colIndex] ?? '').trim()
    const valB = (rowB[colIndex] ?? '').trim()
    const numA = Number(valA)
    const numB = Number(valB)
    if (valA !== '' && valB !== '' && !Number.isNaN(numA) && !Number.isNaN(numB)) {
      return (numA - numB) * sign
    }
    return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' }) * sign
  })
  return { ...table, rows }
}

export function tableToCsv(table: ParsedTable): string {
  const escape = (value: string) =>
    value.includes(',') || value.includes('"') || value.includes('\n') ? `"${value.replace(/"/g, '""')}"` : value
  return [table.headerRow, ...table.rows].map((row) => row.map(escape).join(',')).join('\n')
}

export function deleteEntireTableInText(content: string, sourceLine: number): string {
  const lines = content.split('\n')
  const table = parseMarkdownTable(lines, sourceLine)
  if (!table) return content
  lines.splice(table.startLine, table.endLine - table.startLine + 1)
  return lines.join('\n')
}
