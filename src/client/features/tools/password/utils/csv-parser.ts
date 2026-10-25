/**
 * CSV parser and serializer for Password Manager credentials.
 * Compliant with RFC 4180: handles commas, escaped double quotes (""), and multiline content.
 */

export interface ParsedCsvAccount {
  title: string
  username: string
  password: string
  link: string
  remark: string
}

/**
 * Escapes a single field according to RFC 4180 CSV standard.
 */
export function escapeCSVField(val: string | null | undefined): string {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Low-level RFC 4180 compliant CSV tokenizer and row parser.
 */
export function parseCSVRows(text: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"'
          i += 2
          continue
        } else {
          inQuotes = false
          i++
          continue
        }
      } else {
        currentField += char
        i++
        continue
      }
    } else {
      if (char === '"') {
        inQuotes = true
        i++
        continue
      } else if (char === ',') {
        currentRow.push(currentField)
        currentField = ''
        i++
        continue
      } else if (char === '\r') {
        if (i + 1 < text.length && text[i + 1] === '\n') {
          i++
        }
        currentRow.push(currentField)
        rows.push(currentRow)
        currentRow = []
        currentField = ''
        i++
        continue
      } else if (char === '\n') {
        currentRow.push(currentField)
        rows.push(currentRow)
        currentRow = []
        currentField = ''
        i++
        continue
      } else {
        currentField += char
        i++
        continue
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField)
    rows.push(currentRow)
  }

  // Filter out trailing completely empty rows
  return rows.filter((r) => r.some((cell) => cell.length > 0))
}

const PASSWORD_CSV_HEADERS = {
  TITLE: new Set(['title', 'name', '标题', '名称']),
  USERNAME: new Set(['username', 'user', 'account', '用户名', '账号']),
  PASSWORD: new Set(['password', 'pass', 'pwd', '密码']),
  LINK: new Set(['link', 'url', 'website', '网址', '链接']),
  REMARK: new Set(['remark', 'note', 'notes', 'comments', 'desc', 'description', '备注', '说明']),
}

/**
 * Parses raw CSV text into an array of account objects.
 * Automatically detects whether the first line is a header.
 */
export function parseCSV(text: string): ParsedCsvAccount[] {
  if (!text || !text.trim()) {
    return []
  }

  const rows = parseCSVRows(text)
  if (rows.length === 0) {
    return []
  }

  const firstRow = rows[0]
  let isHeader = false
  let titleIdx = 0
  let usernameIdx = 1
  let passwordIdx = 2
  let linkIdx = 3
  let remarkIdx = 4

  // Check if first row has recognizable column headers
  for (let c = 0; c < firstRow.length; c++) {
    const rawVal = firstRow[c].trim().toLowerCase()
    if (
      PASSWORD_CSV_HEADERS.TITLE.has(rawVal) ||
      PASSWORD_CSV_HEADERS.USERNAME.has(rawVal) ||
      PASSWORD_CSV_HEADERS.PASSWORD.has(rawVal) ||
      PASSWORD_CSV_HEADERS.LINK.has(rawVal) ||
      PASSWORD_CSV_HEADERS.REMARK.has(rawVal)
    ) {
      isHeader = true
      break
    }
  }

  let dataRows = rows
  if (isHeader) {
    titleIdx = -1
    usernameIdx = -1
    passwordIdx = -1
    linkIdx = -1
    remarkIdx = -1

    firstRow.forEach((col, idx) => {
      const lower = col.trim().toLowerCase()
      if (PASSWORD_CSV_HEADERS.TITLE.has(lower) && titleIdx === -1) titleIdx = idx
      else if (PASSWORD_CSV_HEADERS.USERNAME.has(lower) && usernameIdx === -1) usernameIdx = idx
      else if (PASSWORD_CSV_HEADERS.PASSWORD.has(lower) && passwordIdx === -1) passwordIdx = idx
      else if (PASSWORD_CSV_HEADERS.LINK.has(lower) && linkIdx === -1) linkIdx = idx
      else if (PASSWORD_CSV_HEADERS.REMARK.has(lower) && remarkIdx === -1) remarkIdx = idx
    })

    // Fall back to default column order for unmapped headers
    if (titleIdx === -1) titleIdx = 0
    if (usernameIdx === -1) usernameIdx = 1
    if (passwordIdx === -1) passwordIdx = 2
    if (linkIdx === -1) linkIdx = 3
    if (remarkIdx === -1) remarkIdx = 4

    dataRows = rows.slice(1)
  }

  return dataRows.map((row) => ({
    title: (titleIdx >= 0 && titleIdx < row.length ? row[titleIdx] : '').trim(),
    username: (usernameIdx >= 0 && usernameIdx < row.length ? row[usernameIdx] : '').trim(),
    password: passwordIdx >= 0 && passwordIdx < row.length ? row[passwordIdx] : '',
    link: (linkIdx >= 0 && linkIdx < row.length ? row[linkIdx] : '').trim(),
    remark: remarkIdx >= 0 && remarkIdx < row.length ? row[remarkIdx] : '',
  }))
}

/**
 * Converts an array of accounts to standard RFC 4180 CSV string with header.
 */
export function toCSV(
  accounts: Array<{
    title: string
    username: string
    password: string
    link: string
    remark: string
  }>
): string {
  const header = 'title,username,password,link,remark'
  const rows = accounts.map((acc) =>
    [
      escapeCSVField(acc.title),
      escapeCSVField(acc.username),
      escapeCSVField(acc.password),
      escapeCSVField(acc.link),
      escapeCSVField(acc.remark),
    ].join(',')
  )

  return [header, ...rows].join('\n')
}
