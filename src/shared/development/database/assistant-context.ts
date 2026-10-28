export interface DatabaseAssistantTable {
  name: string
  columns: Array<{ name: string; type: string }>
}

export interface DatabaseAssistantContext {
  /** Absent for a local SQLite file, which only exists in the browser. */
  connectionId?: string
  connectionName: string
  connectionType: 'sqlite' | 'd1' | 'turso'
  activeTable?: string
  sql?: string
  tables: DatabaseAssistantTable[]
  views?: string[]
}

export const MAX_DATABASE_CONTEXT_TABLES = 40
export const MAX_DATABASE_CONTEXT_COLUMNS = 30
export const MAX_DATABASE_CONTEXT_SQL = 4000
