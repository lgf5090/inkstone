import { insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, type ParsedTable } from '../../../lib/markdown/table-editor'
import { bodyRowIndex, dropIndex } from './geometry'

/**
 * The two edits a boundary can ask for, as a function of the parsed table and the edge index.
 *
 * These live apart from the pointer code because they are where a wrong number becomes a wrong note:
 * an insert that forgets `columnCount` truncates the table by a column, and a drop that counts the
 * header row twice moves the row above the one the reader grabbed. Both are asserted here, in plain
 * data, rather than only through a rendered table.
 */
export function insertAtEdge(parsed: ParsedTable, axis: 'column' | 'row', edge: number): ParsedTable {
  if (axis === 'row') return insertTableRow(parsed, bodyRowIndex(edge, parsed.rows.length), 'above')
  return insertTableColumn(parsed, Math.max(0, Math.min(edge, parsed.columnCount)), 'left')
}

/** Move a row or column to an edge. `from` is the index the handle reports, where row `0` is the header. */
export function dropAtEdge(parsed: ParsedTable, kind: 'column' | 'row', from: number, edge: number): ParsedTable {
  if (kind === 'row') {
    // The header row is what the delimiter row belongs to; moving it would change which line of the
    // note is the header, so it is not draggable.
    if (from <= 0) return parsed
    const bodyFrom = from - 1
    return moveTableRow(parsed, bodyFrom, dropIndex(bodyRowIndex(edge, parsed.rows.length), bodyFrom))
  }
  return moveTableColumn(parsed, from, dropIndex(edge, from))
}
