/**
 * The subset of A1 notation the server needs to write a plan without a browser.
 *
 * Univer's own Facade parses ranges in the editor; a plan applied by the worker has no editor, so the
 * two forms our operations use — a single cell and a rectangle — are parsed here.
 */

export interface A1Rect {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

const CELL = /^([A-Za-z]{1,3})([0-9]{1,7})$/

function columnIndex(letters: string): number {
  let index = 0
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return index - 1
}

/** `B2` or `A1:C3`, 1-based in the notation and 0-based out. Null when the text is not a range. */
export function parseA1Range(range: string): A1Rect | null {
  const [left, right, ...rest] = range.trim().split(':')
  if (!left || rest.length > 0) return null
  const start = CELL.exec(left.trim())
  if (!start) return null
  const end = right ? CELL.exec(right.trim()) : start
  if (!end) return null
  const startRow = Number(start[2]) - 1
  const startCol = columnIndex(start[1]!)
  const endRow = Number(end[2]) - 1
  const endCol = columnIndex(end[1]!)
  return {
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  }
}

export function rangeCellCount(rect: A1Rect): number {
  return (rect.endRow - rect.startRow + 1) * (rect.endCol - rect.startCol + 1)
}
