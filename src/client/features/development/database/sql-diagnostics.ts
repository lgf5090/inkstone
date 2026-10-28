export interface DiagnosticSchema {
  tables: Array<{ name: string; columns: Array<{ name: string }> }>
  views: Array<{ name: string }>
}

export type SqlDiagnostic =
  | { kind: 'missing_table'; name: string }
  | { kind: 'unknown_column'; table: string; column: string }

const RESERVED = new Set([
  'where', 'join', 'on', 'group', 'order', 'limit', 'offset', 'union', 'left', 'right', 'inner', 'outer',
  'cross', 'natural', 'using', 'as', 'select', 'set', 'values', 'returning', 'window', 'having',
])

function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

export function diagnoseSql(sql: string, schema: DiagnosticSchema): SqlDiagnostic[] {
  const text = stripLiterals(sql)
  const known = new Map<string, Set<string>>()
  for (const table of schema.tables) known.set(table.name.toLowerCase(), new Set(table.columns.map((column) => column.name.toLowerCase())))
  for (const view of schema.views) if (!known.has(view.name.toLowerCase())) known.set(view.name.toLowerCase(), new Set())
  for (const builtin of ['sqlite_master', 'sqlite_schema', 'sqlite_temp_master']) known.set(builtin, new Set(['type', 'name', 'tbl_name', 'rootpage', 'sql']))

  const ctes = new Set<string>()
  for (const match of text.matchAll(/\bwith\s+(?:recursive\s+)?([A-Za-z_][\w$]*)\s+as\b/gi)) ctes.add(match[1]!.toLowerCase())
  for (const match of text.matchAll(/,\s*([A-Za-z_][\w$]*)\s+as\s*\(/gi)) ctes.add(match[1]!.toLowerCase())

  const aliasToTable = new Map<string, string>()
  const diagnostics: SqlDiagnostic[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(/\b(?:from|join)\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    const name = raw.toLowerCase()
    let alias = (match[5] ?? '').toLowerCase()
    if (alias && RESERVED.has(alias)) alias = ''
    if (!name || name === 'select' || name === 'values') continue
    if (ctes.has(name) || RESERVED.has(name)) {
      if (alias) aliasToTable.set(alias, '')
      continue
    }
    if (!known.has(name)) {
      const key = `missing:${name}`
      if (!seen.has(key)) {
        seen.add(key)
        diagnostics.push({ kind: 'missing_table', name: raw })
      }
      continue
    }
    aliasToTable.set(name, name)
    if (alias) aliasToTable.set(alias, name)
  }

  for (const match of text.matchAll(/\b([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\b/g)) {
    const left = match[1]!.toLowerCase()
    const right = match[2]!
    if (left === 'new' || left === 'old') continue
    if (left === 'main' || left === 'temp') continue
    const table = aliasToTable.get(left)
    if (!table) continue
    const columns = known.get(table)
    if (!columns || columns.has(right.toLowerCase())) continue
    const key = `column:${table}.${right.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push({ kind: 'unknown_column', table, column: right })
  }

  return diagnostics.slice(0, 5)
}
