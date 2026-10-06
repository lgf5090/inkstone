/**
 * CSV is how a board travels to and from a spreadsheet, so this layer has to answer two questions
 * nothing else in the module answers: how a stored value prints into one cell, and how the text a
 * spreadsheet wrote back becomes a stored value again.
 *
 * Two fields are named rather than declared, because a card keeps them outside `properties`: the
 * title, which leads every row, and the description, which the column with the id `description`
 * carries (the same three-way read the gallery excerpt uses). Everything else is the document's own
 * schema, so a board with no `Status` column exports no `Status` header either.
 */
import { KANBAN_DESCRIPTION_MAX_CHARS, KANBAN_MAX_ITEMS } from './body'
import { kanbanDayKey } from './date-fields'
import { createKanbanId } from './id'
import { kanbanPersonName } from './person'
import type { KanbanItem, KanbanOption, KanbanProperty } from './types'

/**
 * More rows than this is the wrong file; importing it would bury the board the reader is on. It is the
 * same number the fence itself refuses past (`KANBAN_MAX_ITEMS` — the two doors into a board agree on
 * what "too big" means), and the import is refused against the room the board has left rather than
 * against the file alone: a file that fits in a spreadsheet but not on this board would otherwise
 * write a board the fence then refuses to read.
 */
export const KANBAN_CSV_MAX_ROWS = KANBAN_MAX_ITEMS

/**
 * How big a CSV file may be before it is refused unread. Reading happens on the main thread, and a
 * file many times this size freezes the tab for the parse alone — a pre-flight the chooser can run
 * against `file.size` before a single byte is read. Expressed in characters for the text that has
 * already been read (a char is at least a byte), so the door and the parser agree on one number.
 */
export const KANBAN_CSV_MAX_BYTES = 2 * 1024 * 1024

const TITLE_HEADER = 'Title'
const DESCRIPTION_COLUMN_ID = 'description'
const TAG_SEPARATOR = ';'
const OPTION_FALLBACK_COLOR = 'gray'
const TRUTHY_CELLS = new Set(['true', 'yes', '1', 'x', 'on'])
const FALSY_CELLS = new Set(['false', 'no', '0', 'off'])
/** What a filesystem refuses in a name, plus the control characters a path may not hold. */
const FILENAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001F]/g
/** Without it a spreadsheet reads the bytes as its local codepage, so any non-ASCII board arrives as mojibake. */
const UTF8_BOM = '\uFEFF'
/**
 * A cell a spreadsheet would run instead of showing: the ASCII formula leads, the full-width twins a
 * CJK locale reads the same way, and any `-` that opens something longer than a number (a negative
 * value is a value — `-5` must stay print-able as `-5`).
 */
const FORMULA_LEAD = /^(?:[=+@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]|-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$))/
/**
 * Wrapping the cell in quotes does not stop that run, and an apostrophe is dropped again when Excel
 * saves the file: the mark a spreadsheet cannot undo is a tab inside the quoted field. This board's
 * own importer trims it back off, so a board that re-reads its export gets the text it wrote.
 */
const FORMULA_MARK = '\t'

const trimmed = (value: string | undefined) => (value ?? '').trim()
const headerKey = (value: string | undefined) => trimmed(value).toLowerCase()

export function kanbanCsvColumns(columns: KanbanProperty[]): KanbanProperty[] {
  return columns.filter((column) => column.type !== 'title' && column.id !== 'title' && column.type !== 'files')
}

/** The card's own text, read the way the surfaces that print it already read it. */
function kanbanItemDescription(item: KanbanItem): string {
  const stored = item.properties[DESCRIPTION_COLUMN_ID]
  return item.content || item.description || (typeof stored === 'string' ? stored : '')
}

function optionLabel(column: KanbanProperty, value: string): string {
  const option = column.options?.find((candidate) => candidate.id === value || candidate.label === value)
  return option?.label ?? value
}

function csvCellText(column: KanbanProperty, item: KanbanItem): string {
  const raw = column.id === DESCRIPTION_COLUMN_ID ? kanbanItemDescription(item) : item.properties[column.id]
  if (raw === undefined || raw === null || raw === '') return ''
  switch (column.type) {
    case 'select':
      return optionLabel(column, String(raw))
    case 'multi-select':
      return (Array.isArray(raw) ? raw : [raw]).map((tag) => optionLabel(column, String(tag))).join(`${TAG_SEPARATOR} `)
    case 'checkbox':
      return typeof raw === 'boolean' ? String(raw) : ''
    case 'date':
      return kanbanDayKey(raw)
    case 'person':
      return kanbanPersonName(raw)
    default:
      return String(raw)
  }
}

function escapeCsvCell(value: string): string {
  const text = FORMULA_LEAD.test(value) ? `${FORMULA_MARK}${value}` : value
  return /[",\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function kanbanToCsv(columns: KanbanProperty[], items: KanbanItem[]): string {
  const exported = kanbanCsvColumns(columns)
  const lines = [[TITLE_HEADER, ...exported.map((column) => column.name)].map(escapeCsvCell).join(',')]
  for (const item of items) {
    lines.push([item.title, ...exported.map((column) => csvCellText(column, item))].map(escapeCsvCell).join(','))
  }
  return `${UTF8_BOM}${lines.join('\n')}`
}

export function kanbanCsvFilename(title: string): string {
  const safe = title.replace(FILENAME_UNSAFE, '').trim()
  return `${safe || 'board'}.csv`
}

/** Read from just past a cell's opening quote to the quote that closes it, or to the end. */
function readQuotedCell(body: string, from: number): { cell: string; next: number } {
  let cell = ''
  let index = from
  while (index < body.length) {
    if (body[index] !== '"') {
      cell += body[index]
      index += 1
      continue
    }
    if (body[index + 1] === '"') {
      cell += '"'
      index += 2
      continue
    }
    return { cell, next: index + 1 }
  }
  return { cell, next: index }
}

export function parseKanbanCsv(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let cellStarted = false
  const endRow = () => {
    rows.push([...row, cell])
    row = []
    cell = ''
    cellStarted = false
  }

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    // Only a quote at the start of a cell opens one; anywhere else it is the cell's own text.
    if (char === '"' && !cellStarted) {
      const quoted = readQuotedCell(body, index + 1)
      cell = quoted.cell
      cellStarted = true
      index = quoted.next - 1
      continue
    }
    switch (char) {
      case ',':
        row.push(cell)
        cell = ''
        cellStarted = false
        break
      case '\n':
        endRow()
        break
      case '\r':
        if (body[index + 1] === '\n') index += 1
        endRow()
        break
      default:
        cell += char
        cellStarted = true
    }
  }
  if (cellStarted || row.length > 0) endRow()
  return rows
}

export interface KanbanCsvImport {
  items: KanbanItem[]
  /** The document's columns, extended with whatever groups the file named for the first time. */
  columns: KanbanProperty[]
  newOptions: number
  skippedRows: number
  ignoredHeaders: string[]
  ignoredCells: number
}

export type KanbanCsvOutcome =
  | ({ ok: true } & KanbanCsvImport)
  | { ok: false; reason: 'empty' | 'no_title' | 'too_many' | 'no_room' | 'too_large' }

function freeOptionId(label: string, pool: KanbanOption[]): string {
  const slug = label.toLowerCase().replace(/\s+/g, '_')
  const taken = new Set(pool.map((option) => option.id))
  if (!taken.has(slug)) return slug
  let suffix = 2
  while (taken.has(`${slug}_${suffix}`)) suffix += 1
  return `${slug}_${suffix}`
}

/** A group the file mentions but the column never declared gets an option, so an imported card is
 *  not filed nowhere; the id follows the same slug rule the tag picker uses. */
function optionIdFor(column: KanbanProperty, label: string, fresh: Map<string, KanbanOption[]>): string | undefined {
  const wanted = trimmed(label)
  if (!wanted) return undefined
  const pool = [...(column.options ?? []), ...(fresh.get(column.id) ?? [])]
  const existing = pool.find((option) => option.id === wanted || option.id === wanted.toLowerCase() || option.label.toLowerCase() === headerKey(wanted))
  if (existing) return existing.id
  const created: KanbanOption = { id: freeOptionId(wanted, pool), label: wanted, color: OPTION_FALLBACK_COLOR }
  fresh.set(column.id, [...(fresh.get(column.id) ?? []), created])
  return created.id
}

function withNewOptions(columns: KanbanProperty[], fresh: Map<string, KanbanOption[]>): KanbanProperty[] {
  if (fresh.size === 0) return columns
  return columns.map((column) => {
    const added = fresh.get(column.id)
    return added ? { ...column, options: [...(column.options ?? []), ...added] } : column
  })
}

function cellValue(column: KanbanProperty, cell: string, fresh: Map<string, KanbanOption[]>): { value?: unknown; ignored?: boolean } {
  const text = trimmed(cell)
  if (!text) return { ignored: false }
  switch (column.type) {
    case 'select': {
      const id = optionIdFor(column, text, fresh)
      return id ? { value: id } : { ignored: true }
    }
    case 'multi-select': {
      const ids = text.split(TAG_SEPARATOR).map((part) => optionIdFor(column, part, fresh)).filter((id): id is string => Boolean(id))
      return ids.length ? { value: [...new Set(ids)] } : { ignored: true }
    }
    case 'checkbox': {
      const flag = text.toLowerCase()
      if (TRUTHY_CELLS.has(flag)) return { value: true }
      if (FALSY_CELLS.has(flag)) return { value: false }
      return { ignored: true }
    }
    case 'date': {
      const key = kanbanDayKey(text)
      return key ? { value: key } : { ignored: true }
    }
    case 'number': {
      const amount = Number(text)
      return Number.isFinite(amount) ? { value: amount } : { ignored: true }
    }
    default:
      return { value: text }
  }
}

function mapHeaders(header: string[], titleIndex: number, columns: KanbanProperty[]) {
  const mappings: { column: KanbanProperty; index: number }[] = []
  const claimed = new Set<number>([titleIndex])
  for (const column of kanbanCsvColumns(columns)) {
    const index = header.findIndex((name, at) => !claimed.has(at) && at !== titleIndex && headerKey(name) === headerKey(column.name))
    if (index < 0) continue
    claimed.add(index)
    mappings.push({ column, index })
  }
  const ignoredHeaders = header.filter((name, at) => !claimed.has(at) && trimmed(name)).map((name) => trimmed(name))
  return { mappings, ignoredHeaders }
}

function importedItem(row: string[], titleIndex: number, mappings: { column: KanbanProperty; index: number }[], fresh: Map<string, KanbanOption[]>) {
  const title = trimmed(row[titleIndex])
  if (!title) return { item: undefined, ignoredCells: 0 }
  const item: KanbanItem = { id: createKanbanId(), title, properties: {} }
  let ignoredCells = 0
  for (const { column, index } of mappings) {
    const { value, ignored } = cellValue(column, row[index] ?? '', fresh)
    if (ignored) {
      ignoredCells += 1
      continue
    }
    if (value === undefined) continue
    // The description is the card's own body, not a stored value, so it travels outside `properties`,
    // clamped to the same ceiling the editor enforces: the import must not be the door a giant cell
    // walks through to balloon the fence.
    if (column.id === DESCRIPTION_COLUMN_ID) item.content = String(value).slice(0, KANBAN_DESCRIPTION_MAX_CHARS)
    else item.properties[column.id] = value
  }
  return { item, ignoredCells }
}

/**
 * `existingItems` is every card the fence already holds — archived ones included, because the ceiling
 * counts what the fence carries rather than what this door is handed.
 */
export function importKanbanCsv(text: string, columns: KanbanProperty[], existingItems = 0): KanbanCsvOutcome {
  if (!text.trim()) return { ok: false, reason: 'empty' }
  if (text.length > KANBAN_CSV_MAX_BYTES) return { ok: false, reason: 'too_large' }
  const [header, ...body] = parseKanbanCsv(text)
  if (!body.length) return { ok: false, reason: 'empty' }
  if (body.length > KANBAN_CSV_MAX_ROWS) return { ok: false, reason: 'too_many' }
  const titleIndex = header.findIndex((name) => headerKey(name) === 'title')
  if (titleIndex < 0) return { ok: false, reason: 'no_title' }
  const { mappings, ignoredHeaders } = mapHeaders(header, titleIndex, columns)
  const fresh = new Map<string, KanbanOption[]>()
  const items: KanbanItem[] = []
  let skippedRows = 0
  let ignoredCells = 0
  for (const row of body) {
    const imported = importedItem(row, titleIndex, mappings, fresh)
    if (imported.item) items.push(imported.item)
    else skippedRows += 1
    ignoredCells += imported.ignoredCells
  }
  // Counted after the rows were read, so a file whose unreadable rows are skipped is judged by what it
  // would really add: a board with one seat left still takes a file of two rows when one of them is
  // refused for its own reasons.
  if (items.length + existingItems > KANBAN_MAX_ITEMS) return { ok: false, reason: 'no_room' }
  const newOptions = [...fresh.values()].reduce((total, added) => total + added.length, 0)
  return { ok: true, items, columns: withNewOptions(columns, fresh), newOptions, skippedRows, ignoredHeaders, ignoredCells }
}
