import type { ExportFormat } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'

export interface DelimitedOptions {
  delimiter?: string
  lineTerminator?: string
  encloser?: string
  nullText?: string
  includeHeader?: boolean
  bom?: boolean
}

const DEFAULT_ENCLOSER = '"'
const DEFAULT_LINE_TERMINATOR = '\n'

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cellText(value: unknown, nullText: string): string {
  if (value === null || value === undefined) return nullText
  if (value instanceof Uint8Array) return `X'${hex(value)}'`
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  return String(value)
}

function quoteCell(
  text: string,
  delimiter: string,
  lineTerminator: string,
  encloser: string,
): string {
  const needsQuotes =
    text.includes(delimiter)
    || text.includes(encloser)
    || text.includes('\n')
    || text.includes('\r')
    || text.includes(lineTerminator)
    || text !== text.trim()
  if (!needsQuotes) return text
  return `${encloser}${text.split(encloser).join(`${encloser}${encloser}`)}${encloser}`
}

export function toDelimited(
  columns: string[],
  rows: unknown[][],
  options: DelimitedOptions = {},
): string {
  const delimiter = options.delimiter ?? ','
  const lineTerminator = options.lineTerminator ?? DEFAULT_LINE_TERMINATOR
  const encloser = options.encloser ?? DEFAULT_ENCLOSER
  const nullText = options.nullText ?? ''
  const includeHeader = options.includeHeader ?? true
  if (!delimiter) throw new Error('A delimiter is required.')
  if (encloser.length !== 1) throw new Error('The encloser must be one character.')
  if (!lineTerminator) throw new Error('A line terminator is required.')

  const render = (value: unknown): string =>
    quoteCell(cellText(value, nullText), delimiter, lineTerminator, encloser)

  const lines: string[] = []
  if (includeHeader) lines.push(columns.map(render).join(delimiter))
  for (const row of rows) {
    lines.push(columns.map((_, index) => render(row[index])).join(delimiter))
  }
  return `${options.bom ? '\uFEFF' : ''}${lines.join(lineTerminator)}`
}

export function projectColumns(
  columns: string[],
  rows: unknown[][],
  hidden: ReadonlySet<number>,
): { columns: string[]; rows: unknown[][] } {
  if (hidden.size === 0) return { columns, rows }
  const indexes = columns.map((_, index) => index).filter((index) => !hidden.has(index))
  return {
    columns: indexes.map((index) => columns[index]!),
    rows: rows.map((row) => indexes.map((index) => row[index])),
  }
}

export function toCsv(
  columns: string[],
  rows: unknown[][],
  options: Omit<DelimitedOptions, 'delimiter'> = {},
): string {
  return toDelimited(columns, rows, {
    lineTerminator: '\r\n',
    ...options,
    delimiter: ',',
    bom: options.bom ?? true,
  })
}

function jsonCell(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'bigint') {
    const numeric = Number(value)
    return Number.isSafeInteger(numeric) ? numeric : value.toString()
  }
  if (value instanceof Uint8Array) return `X'${hex(value)}'`
  return value
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((row) => {
      const object: Record<string, unknown> = {}
      columns.forEach((column, index) => {
        object[column] = jsonCell(row[index])
      })
      return object
    }),
    null,
    2,
  )
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) return `X'${hex(value)}'`
  if (typeof value === 'object') return quoteString(JSON.stringify(value) ?? '')
  return quoteString(String(value))
}

export function toInsertSql(table: string, columns: string[], rows: unknown[][]): string {
  if (!table || columns.length === 0 || rows.length === 0) return ''
  const columnList = columns.map(quoteIdent).join(', ')
  return rows
    .map((row) => {
      const values = columns.map((_, index) => sqlLiteral(row[index])).join(', ')
      return `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${values});`
    })
    .join('\n')
}

export function toMarkdown(columns: string[], rows: unknown[][]): string {
  const escape = (value: unknown) => cellText(value, '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [`| ${columns.map(escape).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    lines.push(`| ${columns.map((_, index) => escape(row[index])).join(' | ')} |`)
  }
  return lines.join('\n')
}

export function toSchemaSql(model: {
  tables: { sql: string }[]
  indexes: { sql: string | null }[]
  views: { sql: string }[]
  triggers: { sql: string }[]
}): string {
  const statements = [
    ...model.tables.map((entry) => entry.sql),
    ...model.indexes.map((entry) => entry.sql ?? ''),
    ...model.views.map((entry) => entry.sql),
    ...model.triggers.map((entry) => entry.sql),
  ]
    .map((sql) => sql.trim().replace(/;+$/, ''))
    .filter((sql) => sql.length > 0)
  return statements.length ? `${statements.join(';\n\n')};\n` : ''
}

export function exportMimeType(format: ExportFormat): string {
  switch (format) {
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'sql':
      return 'application/sql'
    default:
      return 'text/plain'
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') throw new Error('Downloads require a browser environment.')
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: `${mime};charset=utf-8` }))
}
