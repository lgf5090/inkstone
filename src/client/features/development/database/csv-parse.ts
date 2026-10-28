export interface ParsedCsv {
  headers: string[]
  rows: string[][]
  delimiter: string
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ]
  counts.sort((left, right) => right[1] - left[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

export function parseCsv(text: string, options: { delimiter?: string; hasHeader?: boolean } = {}): ParsedCsv {
  const source = text.replace(/^\uFEFF/, '')
  const delimiter = options.delimiter || detectDelimiter(source)
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field === '') {
      quoted = true
      continue
    }
    if (character === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index++
      row.push(field)
      field = ''
      if (row.some((value) => value !== '')) records.push(row)
      row = []
      continue
    }
    field += character
  }
  row.push(field)
  if (row.some((value) => value !== '')) records.push(row)

  const hasHeader = options.hasHeader ?? true
  const headers = hasHeader ? (records.shift() ?? []) : (records[0] ?? []).map((_, index) => `column_${index + 1}`)
  return { headers, rows: records, delimiter }
}

export function inferColumnType(values: string[]): 'INTEGER' | 'REAL' | 'TEXT' {
  const present = values.filter((value) => value !== '').slice(0, 200)
  if (present.length === 0) return 'TEXT'
  if (present.every((value) => /^[+-]?\d+$/.test(value.trim()))) return 'INTEGER'
  if (present.every((value) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()))) return 'REAL'
  return 'TEXT'
}
