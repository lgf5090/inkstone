export const SCHEMA_PROMPT_BUDGET_CHARS = 12_000

export interface SchemaPromptTable {
  name: string
  columns: Array<{ name: string; type: string }>
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentions(table: SchemaPromptTable, sql: string): boolean {
  if (!sql) return false
  return new RegExp(`\\b${escapeForRegExp(table.name)}\\b`, 'i').test(sql)
}

export function schemaLine(table: SchemaPromptTable): string {
  return `- ${table.name}(${table.columns.map((column) => `${column.name} ${column.type}`).join(', ')})`
}

export function buildSchemaPrompt(
  tables: SchemaPromptTable[],
  currentSql = '',
  budget = SCHEMA_PROMPT_BUDGET_CHARS,
): { text: string; omitted: number } {
  const ordered = [...tables].sort((left, right) => {
    const leftRank = mentions(left, currentSql) ? 0 : 1
    const rightRank = mentions(right, currentSql) ? 0 : 1
    return leftRank - rightRank
  })
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const table of ordered) {
    const line = schemaLine(table)
    if (used + line.length + 1 > budget) {
      omitted += 1
      continue
    }
    used += line.length + 1
    lines.push(line)
  }
  return { text: lines.join('\n'), omitted }
}
