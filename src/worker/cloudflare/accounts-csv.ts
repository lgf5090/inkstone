/**
 * Reading the CSV an account import is given.
 *
 * The file is the one thing on this screen a reader hands the server that is not a form field, so the
 * parsing is separated from the route that owns the database and the network: this module decides
 * what a row means, the route decides what to do with it.
 *
 * The header is matched case-insensitively because a file exported from another tool usually spells
 * `apiKey` while a hand-written one spells `apikey`; the values themselves are never normalised,
 * because an API key is opaque.
 */

export interface CsvAccountRow {
  /** Lower-cased; the caller dedupes on this spelling. */
  email: string
  apiKey: string
  password: string | null
  /** One-based line in the source file, so a result can point at the row that failed. */
  line: number
}

/** A file whose header cannot describe accounts at all. The route turns this into a 400. */
export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvFormatError'
  }
}

/** The import path is deliberately bounded: a reader pastes a list, not a database dump. */
export const MAX_CSV_BYTES = 1_048_576
export const MAX_CSV_ROWS = 500

export function parseAccountsCsv(text: string): CsvAccountRow[] {
  const records = parseRecords(stripBom(text))
  if (records.length === 0) throw new CsvFormatError('The CSV file is empty')
  const header = records[0]!
  const columns = new Map<string, number>()
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase()
    if (key && !columns.has(key)) columns.set(key, index)
  })
  const emailIndex = columns.get('email')
  const apiKeyIndex = columns.get('apikey') ?? columns.get('api_key')
  if (emailIndex === undefined || apiKeyIndex === undefined) {
    throw new CsvFormatError('The CSV header must include email and apiKey (password is optional)')
  }
  const passwordIndex = columns.get('password')
  const rows: CsvAccountRow[] = []
  for (let index = 1; index < records.length; index++) {
    const cells = records[index]!
    rows.push({
      email: (cells[emailIndex] ?? '').trim().toLowerCase(),
      apiKey: (cells[apiKeyIndex] ?? '').trim(),
      password: passwordIndex === undefined ? null : (cells[passwordIndex] ?? '').trim() || null,
      line: index + 1,
    })
  }
  return rows
}

/**
 * `lauren.bailey2701@example.com` becomes `bailey2701`: the reference module's rule, kept because a
 * reader's existing imports are named that way. A local part with no dot is already the name.
 */
export function accountNameFromEmail(email: string): string {
  const at = email.lastIndexOf('@')
  const local = (at > 0 ? email.slice(0, at) : email).trim()
  const dot = local.lastIndexOf('.')
  const name = dot >= 0 && dot < local.length - 1 ? local.slice(dot + 1) : local
  return name || email
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * RFC 4180 records: quoted fields may contain commas, newlines and doubled quotes.
 *
 * A quote in the middle of an unquoted field is kept as a character rather than opening a quoted
 * section, which is what a spreadsheet writes when a value contains a stray quote.
 */
function parseRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    records.push(record)
    record = []
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
      field += char
      index += 1
      continue
    }
    if (char === '"' && field.length === 0) {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      pushField()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      pushRecord()
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field.length > 0 || record.length > 0) pushRecord()
  return records.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}
