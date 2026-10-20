/**
 * Reading and writing the subscription list as a spreadsheet.
 *
 * Export is a serialisation, not a report: the point is that a reader can open their own data in
 * something that is not this app, edit two hundred rows, and hand it back. That only works if the two
 * directions agree on the same column set, so the header row is derived from one list rather than typed
 * twice.
 *
 * Quoting follows RFC 4180 — a field containing a comma, a quote or a newline is wrapped in quotes and
 * its quotes doubled. Getting this wrong is invisible until the first note that happens to contain a
 * comma, at which point the import splits one column into two and the reader loses a category.
 */
import type { SubscriptionItem } from '@shared/subscriptions/model'

export const CSV_COLUMNS = [
  'name', 'customType', 'category', 'amount', 'currency',
  'startDate', 'expiryDate', 'periodValue', 'periodUnit', 'subscriptionMode',
  'useLunar', 'autoRenew', 'notes',
] as const

export type CsvColumn = (typeof CSV_COLUMNS)[number]

/** One parsed row: the columns it named, and nothing else. */
export type CsvRow = Partial<Record<CsvColumn, string>>

function escape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The byte-order mark Excel needs to read a UTF-8 file as UTF-8.
 *
 * Written on export and stripped on import: without it a plan named in Chinese opens as mojibake, and a
 * file that came out of Excel arrives with the mark glued to the first column name.
 */
export const CSV_BOM = '\uFEFF'

export function toCsv(items: readonly SubscriptionItem[]): string {
  const header = CSV_COLUMNS.join(',')
  const rows = items.map((item) => CSV_COLUMNS.map((column) => escape(csvValue(item, column))).join(','))
  return [header, ...rows].join('\r\n')
}

function csvValue(item: SubscriptionItem, column: CsvColumn): string {
  switch (column) {
    case 'name': return item.name
    case 'customType': return item.customType
    case 'category': return item.category
    // The plain number, not the formatted one: `¥1,234.00` would come back as three fields.
    case 'amount': return item.amount === null ? '' : String(item.amount)
    case 'currency': return item.currency
    case 'startDate': return item.startDate?.slice(0, 10) ?? ''
    case 'expiryDate': return item.expiryDate.slice(0, 10)
    case 'periodValue': return String(item.periodValue)
    case 'periodUnit': return item.periodUnit
    case 'subscriptionMode': return item.subscriptionMode
    case 'useLunar': return item.useLunar ? 'true' : 'false'
    case 'autoRenew': return item.autoRenew ? 'true' : 'false'
    case 'notes': return item.notes
  }
}

/**
 * A CSV's text, parsed.
 *
 * The header row names the columns rather than their position being assumed, so a reader who reorders
 * or drops a column in Excel still imports correctly and one who renames a column simply loses that
 * column — which is what they asked for, and better than shifting every value one slot left.
 */
export function parseCsv(text: string): CsvRow[] {
  // Excel writes a byte-order mark ahead of the first header name, and a column called `\uFEFFname`
  // matches no known column, so the whole first column used to vanish on import. Stripped once, here,
  // because it can only ever be the first character of the document.
  const source = text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // A character loop rather than a split or a regex: a comma inside quotes, a quote inside a quoted
  // field and a newline inside a quoted field all have to be told apart by what came before them.
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...body] = rows
  if (!header) return []
  const names = header.map((name) => name.trim())
  const known = CSV_COLUMNS as readonly string[]
  return body
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => {
      const out: CsvRow = {}
      names.forEach((name, position) => {
        if (known.includes(name)) out[name as CsvColumn] = cells[position]?.trim() ?? ''
      })
      return out
    })
}

/**
 * A parsed row as the shape the import endpoint wants.
 *
 * Booleans are the reader's problem to spell: anything that is not an obvious yes is a no, because a
 * column of blanks should not switch a hundred subscriptions onto auto-renew.
 */
export function rowToInput(row: CsvRow): Record<string, unknown> {
  return {
    name: row.name ?? '',
    customType: row.customType ?? '',
    category: row.category ?? '',
    amount: row.amount ? Number(row.amount) : null,
    currency: row.currency || 'CNY',
    startDate: row.startDate || null,
    expiryDate: row.expiryDate ?? '',
    periodValue: row.periodValue ? Number(row.periodValue) : 1,
    periodUnit: row.periodUnit || 'month',
    subscriptionMode: row.subscriptionMode || 'cycle',
    useLunar: isYes(row.useLunar),
    autoRenew: isYes(row.autoRenew),
    notes: row.notes ?? '',
  }
}

/**
 * What counts as "yes" in a boolean column.
 *
 * A spreadsheet's yes is whatever the reader or their spreadsheet software wrote, including the
 * affirmative of whatever language the file was made in — so this is input vocabulary, not interface
 * copy, and it must not come from the locale catalog: a file exported with the interface in English and
 * read back with it in Chinese still has to work.
 */
const CSV_YES_WORDS = ['true', '1', 'yes', 'y', '是']

function isYes(value: string | undefined): boolean {
  return CSV_YES_WORDS.includes((value ?? '').trim().toLocaleLowerCase())
}

/** A filename that says when the file was taken, so two exports do not overwrite each other silently. */
export function csvFilename(now = new Date()): string {
  return `subscriptions-${now.toISOString().slice(0, 10)}.csv`
}
