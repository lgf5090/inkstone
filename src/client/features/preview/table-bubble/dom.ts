import { measureTable, type Box, type TableShape } from './geometry'

/**
 * Containers whose tables belong to somebody else's source.
 *
 * An embedded note, a markdown example's preview and a kanban card body are each rendered from their
 * own text, so the `data-line` inside them counts lines of *that* document. Editing one through this
 * note's source would rewrite the wrong file — which is the same reason the kanban renderer refuses
 * them.
 */
export const FOREIGN_TABLE_HOSTS = '.note-embed-body, .markdown-example-preview, [data-kanban], [data-mindmap], [data-chart]'

export interface TableCellAddress {
  /** `-1` is the header row; `0` and up are the body rows, matching `ParsedTable.cursorRowIndex`. */
  rowIndex: number
  colIndex: number
}

function toBox(rect: DOMRect): Box {
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
}

export function tableElementOf(wrap: HTMLElement): HTMLTableElement | null {
  return wrap.querySelector('table')
}

/**
 * The `.table-wrap` this pointer is over, when it is one this note can edit.
 *
 * `data-line` is what makes a table addressable: it is the header line in the note, and every write
 * below resolves against it. A table with no line is either a nested render or a hand-written HTML
 * table, and neither has a place in this note's text to write back to.
 */
export function findEditableTable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const wrap = target.closest<HTMLElement>('.table-wrap')
  if (!wrap) return null
  if (wrap.dataset.line === undefined) return null
  if (wrap.closest(FOREIGN_TABLE_HOSTS)) return null
  return tableElementOf(wrap) ? wrap : null
}

export function sourceLineOf(wrap: HTMLElement): number {
  const line = Number(wrap.dataset.line)
  return Number.isInteger(line) && line >= 0 ? line : -1
}

/** The table's own box. Cheap enough to re-read on every scroll frame. */
export function readTableBox(wrap: HTMLElement): Box | null {
  const table = tableElementOf(wrap)
  return table ? toBox(table.getBoundingClientRect()) : null
}

/** Every cell of the table, in viewport coordinates, with the row it belongs to. */
export function readShape(wrap: HTMLElement): TableShape | null {
  const table = tableElementOf(wrap)
  if (!table || table.rows.length === 0) return null
  const rows = [...table.rows].map((row) => toBox(row.getBoundingClientRect()))
  const cells = [...table.rows[0]!.cells].map((cell) => toBox(cell.getBoundingClientRect()))
  if (rows.length === 0 || cells.length === 0) return null
  return measureTable(toBox(table.getBoundingClientRect()), cells, rows)
}

/** How many rows and columns the DOM is showing, which is what a parsed table has to agree with. */
export function domShapeOf(wrap: HTMLElement): { rows: number, columns: number } | null {
  const table = tableElementOf(wrap)
  if (!table || table.rows.length === 0) return null
  return { rows: table.rows.length, columns: table.rows[0]!.cells.length }
}

/**
 * Whether the block the parser read is the block being looked at.
 *
 * The two count differently on purpose: the note holds a header line, a delimiter line and N body
 * lines, while the rendered table holds a header row and N body rows. So `N + 1` rows on screen is
 * the agreement, and anything else means the parser walked past the block — a table glued to a line
 * of prose that happens to contain a pipe, most often. Rewriting that would take the prose with it,
 * so the bubble stays away.
 */
export function domAgreesWithParser(parsed: { rows: unknown[] }, counts: { rows: number, columns: number } | null): boolean {
  if (!counts) return false
  return parsed.rows.length + 1 === counts.rows
}

/** Where a `<td>` sits, in the same coordinates `parseMarkdownTable` reports. */
export function addressOfCell(cell: Element): TableCellAddress | null {
  const row = cell.closest('tr')
  const table = cell.closest('table')
  if (!row || !table) return null
  const domRow = [...table.rows].indexOf(row)
  const colIndex = [...row.cells].indexOf(cell as HTMLTableCellElement)
  if (domRow < 0 || colIndex < 0) return null
  return { rowIndex: domRow === 0 ? -1 : domRow - 1, colIndex }
}
