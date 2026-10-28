export interface FormatSqlSuccess {
  ok: true
  sql: string
}

export interface FormatSqlFailure {
  ok: false
  error: string
}

export type FormatSqlResult = FormatSqlSuccess | FormatSqlFailure

export async function formatSql(sql: string): Promise<FormatSqlResult> {
  if (!sql.trim()) return { ok: true, sql }
  try {
    const { format } = await import('sql-formatter')
    return {
      ok: true,
      sql: format(sql, {
        language: 'sqlite',
        tabWidth: 2,
        keywordCase: 'upper',
      }),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
