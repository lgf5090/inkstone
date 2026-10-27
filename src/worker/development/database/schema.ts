export const DEVELOPMENT_DATABASE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_database_connections (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    d1_account_id TEXT NOT NULL DEFAULT '',
    d1_database_id TEXT NOT NULL DEFAULT '',
    d1_database_name TEXT NOT NULL DEFAULT '',
    turso_url TEXT NOT NULL DEFAULT '',
    secret_ciphertext TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_database_connections_user_sort
     ON development_database_connections(user_id, is_pinned DESC, is_favorite DESC, sort ASC, id)`,

  `CREATE TABLE IF NOT EXISTS development_database_saved_queries (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sql TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_database_saved_queries_user_connection
     ON development_database_saved_queries(user_id, connection_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_database_query_history (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    query TEXT NOT NULL,
    executed_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_database_query_history_user_connection
     ON development_database_query_history(user_id, connection_id, executed_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_database_settings (
    user_id TEXT NOT NULL,
    history_limit INTEGER NOT NULL DEFAULT 30,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS development_database_exports (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_database_exports_user_created
     ON development_database_exports(user_id, created_at DESC)`,
]

export const DEVELOPMENT_DATABASE_REQUIRED_TABLES: readonly string[] = [
  'development_database_connections',
  'development_database_saved_queries',
  'development_database_query_history',
  'development_database_settings',
  'development_database_exports',
]

export const DEVELOPMENT_DATABASE_REQUIRED_INDEXES: readonly string[] = [
  'idx_development_database_connections_user_sort',
  'idx_development_database_saved_queries_user_connection',
  'idx_development_database_query_history_user_connection',
  'idx_development_database_exports_user_created',
]

export const DEVELOPMENT_DATABASE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_database_connections: [
    'user_id',
    'id',
    'name',
    'type',
    'd1_account_id',
    'd1_database_id',
    'd1_database_name',
    'turso_url',
    'secret_ciphertext',
    'sort',
    'is_favorite',
    'is_pinned',
    'created_at',
    'updated_at',
  ],
  development_database_saved_queries: [
    'user_id',
    'id',
    'connection_id',
    'name',
    'sql',
    'namespace',
    'created_at',
    'updated_at',
  ],
  development_database_query_history: [
    'user_id',
    'id',
    'connection_id',
    'query',
    'executed_at',
    'duration_ms',
    'error',
    'created_at',
  ],
  development_database_settings: ['user_id', 'history_limit', 'created_at', 'updated_at'],
  development_database_exports: [
    'user_id',
    'id',
    'filename',
    'format',
    'r2_key',
    'size',
    'created_at',
  ],
}
