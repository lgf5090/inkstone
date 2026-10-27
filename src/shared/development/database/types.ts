export const DATABASE_CONNECTION_TYPES = ['d1', 'turso'] as const
export type DatabaseConnectionType = (typeof DATABASE_CONNECTION_TYPES)[number]

export const HISTORY_LIMIT_MIN = 5
export const HISTORY_LIMIT_MAX = 500
export const HISTORY_LIMIT_DEFAULT = 30
export const MAX_SAVED_QUERIES = 200
export const MAX_CONNECTIONS = 200
export const MAX_SQL_LENGTH = 500_000
export const MAX_SAVED_SQL_LENGTH = 100_000
export const MAX_HISTORY_SQL_LENGTH = 5_000
export const MAX_QUERY_ROWS = 2_000
export const MAX_QUERY_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_ROWS = 200
export const MAX_TOOL_CELL_CHARS = 500
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000
export const EXPORT_FORMATS = ['txt', 'csv', 'json', 'sql'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const MAX_AI_MESSAGES = 20
export const MAX_AI_MESSAGE_CHARS = 20_000
export const MAX_AI_OUTPUT_TOKENS = 2_048

export interface DatabaseConnectionView {
  id: string
  name: string
  type: DatabaseConnectionType
  d1AccountId: string
  d1DatabaseId: string
  d1DatabaseName: string
  tursoUrl: string
  hasSecret: boolean
  sort: number
  isFavorite: boolean
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

export interface DatabaseConnectionInput {
  name: string
  type: DatabaseConnectionType
  d1AccountId?: string
  d1DatabaseId?: string
  d1DatabaseName?: string
  tursoUrl?: string
  secret?: string
}

export interface DatabaseConnectionPatch {
  name?: string
  d1AccountId?: string
  d1DatabaseId?: string
  d1DatabaseName?: string
  tursoUrl?: string
  secret?: string
}

export const INKSTONE_BLOB_KEY = '__inkstone_blob__'

export interface InkstoneBlob {
  [INKSTONE_BLOB_KEY]: string
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowsAffected?: number
  durationMs: number
  meta?: Record<string, unknown>
  truncated?: boolean
}

export interface QueryStatement {
  sql: string
  params?: unknown[]
}

export interface SavedQuery {
  id: string
  connectionId: string
  name: string
  sql: string
  namespace: string
  updatedAt: number
}

export interface QueryHistoryEntry {
  id: string
  connectionId: string
  query: string
  executedAt: number
  durationMs: number
  error: string | null
}

export interface DatabaseSettings {
  historyLimit: number
}

export interface D1DatabaseInfo {
  uuid: string
  name: string
}

export interface DatabaseExportFile {
  id: string
  filename: string
  format: ExportFormat
  size: number
  url: string
  createdAt: number
}

export type DatabaseErrorKind =
  | 'syntax'
  | 'no_table'
  | 'no_column'
  | 'unique'
  | 'foreign_key'
  | 'not_null'
  | 'check'
  | 'constraint'
  | 'type_mismatch'
  | 'busy'
  | 'readonly'
  | 'rate_limit'
  | 'timeout'
  | 'permission'
  | 'confirmation_required'
  | 'unknown'

export interface RawSchemaObject {
  type: 'table' | 'view' | 'index' | 'trigger' | string
  name: string
  tbl_name: string
  sql: string | null
}

export interface ParsedColumn {
  name: string
  type: string
  notNull: boolean
  pk: boolean
  pkPosition: number
  default: string | null
  unique: boolean
  references?: { table: string; column?: string }
  check?: string | null
  collate?: string | null
  generated?: string | null
  autoIncrement: boolean
}

export interface ParsedTable {
  name: string
  sql: string
  columns: ParsedColumn[]
  tableConstraints: string[]
  withoutRowid: boolean
  strict: boolean
}

export interface TableIndexInfo {
  name: string
  unique: boolean
  columns: string[]
  origin: string
  sql: string | null
}

export interface TableFkInfo {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  onUpdate: string
  onDelete: string
  match: string
}

export interface SchemaModel {
  tables: ParsedTable[]
  views: { name: string; sql: string }[]
  triggers: { name: string; sql: string }[]
  indexes: TableIndexInfo[]
}

export interface TableSortRule {
  column: string
  dir: 'ASC' | 'DESC'
}

export interface TableDataOptions {
  limit: number
  offset: number
  sort?: TableSortRule[]
  whereSql?: string
  whereParams?: unknown[]
}

export const DATABASE_AI_TOOL_NAMES = [
  'list_connections',
  'list_tables',
  'search_tables',
  'get_table_schema',
  'get_table_ddl',
  'list_indexes',
  'get_table_foreign_keys',
  'preview_table',
  'get_table_row_count',
  'run_query',
  'explain_query',
] as const

export type DatabaseAiToolName = (typeof DATABASE_AI_TOOL_NAMES)[number]
