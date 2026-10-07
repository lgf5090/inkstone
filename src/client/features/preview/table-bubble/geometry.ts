/**
 * The arithmetic behind the table's floating handles: where each column and row sits inside the
 * table, which edge a pointer is closest to, and where a dragged row belongs once it is dropped.
 *
 * Everything here works in table-relative numbers — the caller subtracts the table's own viewport
 * position before asking, and adds it back when it paints. That keeps the one part of the feature
 * that can be off by one free of `getBoundingClientRect`, and therefore free of a layout engine: a
 * handle that lands on the wrong column is a wrong write to the note, not just a wrong pixel.
 */

/** The part of a `DOMRect` this module needs. */
export interface Box {
  top: number
  left: number
  right: number
  bottom: number
}

export interface TableShape {
  /** The table's own box, in viewport coordinates. */
  table: Box
  /** Each column's centre, measured from the table's left edge. */
  columnCenters: number[]
  /** Each row's centre, measured from the table's top edge. */
  rowCenters: number[]
  /** The `n + 1` column edges, from the table's left edge; index `i` sits before column `i`. */
  columnEdges: number[]
  /** The `n + 1` row edges, from the table's top edge; index `i` sits before row `i`. */
  rowEdges: number[]
  /** Each column's own box, so a highlight can cover it. */
  columns: Box[]
  /** Each row's own box. */
  rows: Box[]
}

function offset(value: number, origin: number): number {
  return Math.round(value - origin)
}

/**
 * Read a table's geometry. `headerCells` are the cells of the row the columns are measured on and
 * `bodyRows` every `<tr>` the rows are measured on, both as viewport rectangles; the table's own box
 * is the reference frame the results are reported in.
 */
export function measureTable(table: Box, headerCells: Box[], bodyRows: Box[]): TableShape {
  const columns = headerCells.map((cell) => ({
    top: table.top,
    left: cell.left,
    right: cell.right,
    bottom: table.bottom,
  }))
  const rows = bodyRows.map((row) => ({
    top: row.top,
    left: table.left,
    right: table.right,
    bottom: row.bottom,
  }))
  return {
    table,
    columns,
    rows,
    columnCenters: columns.map((column) => offset((column.left + column.right) / 2, table.left)),
    rowCenters: rows.map((row) => offset((row.top + row.bottom) / 2, table.top)),
    columnEdges: edges(columns.map((column) => [column.left, column.right]), table.left),
    rowEdges: edges(rows.map((row) => [row.top, row.bottom]), table.top),
  }
}

function edges(spans: Array<[number, number]>, origin: number): number[] {
  if (spans.length === 0) return []
  const out = [offset(spans[0]![0], origin)]
  for (let i = 1; i < spans.length; i++) out.push(offset(spans[i]![0], origin))
  out.push(offset(spans[spans.length - 1]![1], origin))
  return out
}

/**
 * The edge index within `threshold` of the pointer, or null when it is nowhere near one. Ties go to
 * the nearer edge; a pointer exactly between two takes the earlier one, which keeps a wide first
 * column reachable instead of always resolving to its neighbour.
 */
export function nearestEdge(positions: number[], at: number, threshold: number): number | null {
  let best: number | null = null
  let bestDistance = threshold + 1
  for (let i = 0; i < positions.length; i++) {
    const distance = Math.abs(positions[i]! - at)
    if (distance <= threshold && distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/**
 * Where a row or column lands when it is dropped onto an edge. An edge *after* the item's own slot
 * shifts down by one, because the item is lifted out of the list before it is put back.
 */
export function dropIndex(edge: number, from: number): number {
  return edge > from ? edge - 1 : edge
}

/**
 * The edge a pointer is aiming at, with hysteresis.
 *
 * The insert marker a pointer summons is drawn *outside* the table, at its bottom or right edge, so
 * the pointer has to cross the boundary to reach it. Requiring the pointer to stay within the
 * acquire distance would un-draw the very button it is travelling to — the marker would vanish under
 * the cursor. Once offered, an edge is therefore held until the pointer gets `release` away from it,
 * which is also what makes the line stop flickering between two close edges on a narrow column.
 */
export function trackedEdge(positions: number[], at: number, acquire: number, release: number, previous: number | null): number | null {
  const near = nearestEdge(positions, at, acquire)
  if (near !== null) return near
  if (previous === null || positions[previous] === undefined) return null
  return Math.abs(positions[previous]! - at) <= release ? previous : null
}

/**
 * Which slot a pointer falls in, given that slot's edges: `0` for the first slot, and `edges.length - 1`
 * for anything past the last one. Used to tint the row or column the pointer is over.
 */
export function slotAt(edges: number[], at: number): number {
  for (let i = 1; i < edges.length; i++) {
    if (at < edges[i]!) return i - 1
  }
  return Math.max(0, edges.length - 2)
}

/**
 * The body-row index a DOM row edge names. The rendered table counts the header as row `0`, while the
 * note's body rows are counted from the line below the delimiter — so every edge is one further down
 * than the index it inserts at. Both the insert marker and a dropped row go through here, because an
 * off-by-one between the two would put a new row in the wrong place depending on how it was asked for.
 */
export function bodyRowIndex(edge: number, bodyRowCount: number): number {
  return Math.max(0, Math.min(edge - 1, bodyRowCount))
}

/**
 * Whether the cached geometry still describes the table. A handle's position is the table's own box
 * plus an offset measured inside it, so scrolling — which moves the box without changing any offset —
 * is not a reason to re-read every cell. A row or column appearing, or the table changing size, is.
 */
export function geometryIsStale(cached: TableShape, table: Box, rowCount: number, columnCount: number): boolean {
  if (cached.columns.length !== columnCount || cached.rows.length !== rowCount) return true
  return cached.table.right - cached.table.left !== table.right - table.left
    || cached.table.bottom - cached.table.top !== table.bottom - table.top
}
