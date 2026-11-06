/**
 * Parses the import formats the Short Links tool itself can export: header-based CSV, the
 * `[slug] -> url (label)` TXT shape, and bare URL lines from other tools.
 */

export interface ShortlinkImportItem {
  url: string
  slug?: string
  label?: string
}

export interface ShortlinkImportIssue {
  line: number
  reason: 'invalid_url' | 'missing_url'
  raw: string
}

export interface ShortlinkImportParseResult {
  items: ShortlinkImportItem[]
  issues: ShortlinkImportIssue[]
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

/** A quoted CSV cell exists in exported labels; splitting on every comma breaks them. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (char === '\n') {
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  row.push(cell.trim())
  rows.push(row)
  return rows
}

function columnIndex(header: string[], names: string[]): number {
  for (const name of names) {
    const index = header.findIndex((cell) => cell.toLowerCase() === name)
    if (index >= 0) return index
  }
  return -1
}

function parseCsv(content: string): ShortlinkImportParseResult {
  const rows = parseCsvRows(content)
  const items: ShortlinkImportItem[] = []
  const issues: ShortlinkImportIssue[] = []
  const first = rows[0] ?? []
  const hasHeader = first.some((cell) => cell.toLowerCase() === 'url')

  let urlAt = 0
  let slugAt = 1
  let labelAt = 2
  if (hasHeader) {
    urlAt = columnIndex(first, ['url'])
    slugAt = columnIndex(first, ['primary_slug', 'custom_slug', 'slug'])
    labelAt = columnIndex(first, ['label'])
  }

  for (let index = hasHeader ? 1 : 0; index < rows.length; index++) {
    const cells = rows[index]
    if (cells.length === 1 && !cells[0]) continue
    const raw = cells.join(',')
    const url = cells[urlAt] ?? ''
    if (!isHttpUrl(url)) {
      issues.push({ line: index + 1, reason: url ? 'invalid_url' : 'missing_url', raw })
      continue
    }
    items.push({
      url,
      slug: slugAt >= 0 ? cells[slugAt] || undefined : undefined,
      label: labelAt >= 0 ? cells[labelAt] || undefined : undefined,
    })
  }
  return { items, issues }
}

function parseTxt(content: string): ShortlinkImportParseResult {
  const items: ShortlinkImportItem[] = []
  const issues: ShortlinkImportIssue[] = []
  const lines = content.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim()
    if (!raw) continue

    const own = /^(?:\[Protected\]\s*)?\[([^\]]+)\]\s*->\s*(\S.*?)(?:\s+\((.*)\))?$/.exec(raw)
    if (own) {
      if (!isHttpUrl(own[2])) {
        issues.push({ line: index + 1, reason: 'invalid_url', raw })
        continue
      }
      items.push({ slug: own[1].trim(), url: own[2].trim(), label: own[3]?.trim() || undefined })
      continue
    }

    if (isHttpUrl(raw)) {
      items.push({ url: raw })
      continue
    }

    issues.push({ line: index + 1, reason: raw.includes('://') ? 'invalid_url' : 'missing_url', raw })
  }
  return { items, issues }
}

export function parseShortlinkImport(
  content: string,
  format: 'csv' | 'txt',
): ShortlinkImportParseResult {
  const text = content.replace(/\uFEFF/g, '').trim()
  if (!text) return { items: [], issues: [] }
  return format === 'csv' ? parseCsv(text) : parseTxt(text)
}
