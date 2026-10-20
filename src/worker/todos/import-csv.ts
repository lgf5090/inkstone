/**
 * The CSV half of the to-do importer.
 *
 * Plain RFC 4180 records in, typed rows out. The one rule the whole module is built around is that a
 * bad row loses only itself: a title that is missing or a date that cannot be read becomes an entry in
 * `errors` with the source line, and every other row is still returned to the caller. Only a file that
 * has no title column at all — where there is nothing to import — is refused as a whole.
 *
 * Quoting is handled here rather than by splitting on commas because a note may hold one, and a line
 * break inside a quoted cell is common in a task export. A file may start with a UTF-8 BOM and use
 * CRLF, LF or a lone CR; all three read the same.
 */

import { parseLocalTime } from '@shared/assistant-time'
import { normalizeTagNames, type TaskPriority } from '@shared/todos/model'

/** The most task rows one import may carry. */
export const MAX_TODO_CSV_ROWS = 5000

/** The most bytes one import may carry, before any multipart framing is counted. */
export const MAX_TODO_CSV_BYTES = 2 * 1024 * 1024

/** The title ceiling the task table and the task editor share. */
export const MAX_TODO_TITLE_CHARS = 300

/** A file-level problem: no title column, or nothing at all. A row-level problem is an `errors` entry. */
export class TodoCsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TodoCsvError'
  }
}

/** One row that can be written as a task. */
export interface TodoCsvRow {
  /** The physical line the record starts on, counting the header as line 1. */
  line: number
  title: string
  notes: string
  dueAt: number | null
  priority: TaskPriority
  listName: string | null
  tags: string[]
  /**
   * `true` when the row says the task is finished, `false` when its `completed` column says so, and
   * `null` when the file has no such column — an import of open tasks must not reopen what it does
   * not mention.
   */
  completed: boolean | null
}

/** One row that could not be read, kept beside the rows that could. */
export interface TodoCsvRowError {
  line: number
  reason: string
}

export interface TodoCsvParseResult {
  rows: TodoCsvRow[]
  errors: TodoCsvRowError[]
}

type Column = 'title' | 'notes' | 'due' | 'priority' | 'list' | 'tags' | 'completed'

/** The header spellings the importer understands. Unknown columns are ignored. */
const COLUMN_NAMES: Record<string, Column> = {
  title: 'title',
  notes: 'notes',
  description: 'notes',
  due: 'due',
  priority: 'priority',
  list: 'list',
  tags: 'tags',
  completed: 'completed',
}

/** What each priority spelling means; anything else keeps the app's default. */
const PRIORITIES: Record<string, TaskPriority> = {
  urgent: 'urgent',
  high: 'high',
  medium: 'medium',
  low: 'low',
  p1: 'urgent',
  p2: 'high',
  p3: 'medium',
  p4: 'low',
  '1': 'urgent',
  '2': 'high',
  '3': 'medium',
  '4': 'low',
}

/** The words a `completed` cell may use for "yes"; every other value is "no". */
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'done', 'completed', 'x'])

interface CsvRecord {
  line: number
  fields: string[]
}

/**
 * Splits the text into records and cells.
 *
 * The line counter follows physical newlines, including the ones inside a quoted cell, so an error
 * points at the line a reader sees in their editor rather than at a record index.
 */
function readRecords(text: string): { records: CsvRecord[]; errors: TodoCsvRowError[] } {
  const records: CsvRecord[] = []
  const errors: TodoCsvRowError[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let recordLine = 1
  let index = 0

  const endRecord = (): void => {
    const complete = [...fields, field]
    // A blank line, or a line of bare commas, names no task and is not worth an error.
    if (complete.some((value) => value !== '')) records.push({ line: recordLine, fields: complete })
    fields = []
    field = ''
    quoted = false
    recordLine = line
  }

  while (index < text.length) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      if (char === '\r' || char === '\n') {
        if (char === '\r' && text[index + 1] === '\n') index += 1
        field += '\n'
        line += 1
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      fields.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      index += 1
      line += 1
      endRecord()
      continue
    }
    field += char
    index += 1
  }
  if (quoted) errors.push({ line: recordLine, reason: 'unterminated quoted field' })
  else endRecord()
  return { records, errors }
}

function readPriority(value: string): TaskPriority {
  return PRIORITIES[value.trim().toLowerCase()] ?? 'medium'
}

/**
 * Reads one CSV file into importable rows.
 *
 * `timeZone` is the account's own, because a due date in the file is a wall-clock reading and not an
 * instant: a date with no time means the end of that local day, exactly as the task editor means it.
 */
export function parseTodoCsv(text: string, timeZone: string): TodoCsvParseResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const { records, errors } = readRecords(body)
  const header = records.shift()
  if (!header) throw new TodoCsvError('The CSV is empty.')

  const columns = new Map<Column, number>()
  header.fields.forEach((name, index) => {
    const column = COLUMN_NAMES[name.trim().toLowerCase()]
    if (column && !columns.has(column)) columns.set(column, index)
  })
  if (!columns.has('title')) throw new TodoCsvError('The CSV needs a title column.')

  const rows: TodoCsvRow[] = []
  for (const record of records) {
    const cell = (column: Column): string => {
      const index = columns.get(column)
      return index === undefined ? '' : record.fields[index] ?? ''
    }
    // Trimmed and cut to the same ceiling the store writes, so a re-import recognises the row it
    // created even when the file's title was longer than a task title may be.
    const title = cell('title').trim().slice(0, MAX_TODO_TITLE_CHARS)
    if (!title) {
      errors.push({ line: record.line, reason: 'title is required' })
      continue
    }
    const dueText = cell('due').trim()
    let dueAt: number | null = null
    if (dueText) {
      dueAt = parseLocalTime(dueText, timeZone)
      if (dueAt === null) {
        errors.push({ line: record.line, reason: `due date "${dueText}" is not a date this app can read` })
        continue
      }
    }
    rows.push({
      line: record.line,
      title,
      notes: cell('notes'),
      dueAt,
      priority: readPriority(cell('priority')),
      listName: cell('list').trim() || null,
      tags: normalizeTagNames(cell('tags').split(';')),
      completed: columns.has('completed') ? TRUTHY.has(cell('completed').trim().toLowerCase()) : null,
    })
  }
  errors.sort((left, right) => left.line - right.line)
  return { rows, errors }
}
