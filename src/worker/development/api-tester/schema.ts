export const DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_apitester_workspaces (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_apitester_workspaces_user_sort
     ON development_apitester_workspaces(user_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS development_apitester_state (
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    data TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, workspace_id)
  )`,

  `CREATE TABLE IF NOT EXISTS development_apitester_history (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_apitester_history_user_ws_ts
     ON development_apitester_history(user_id, workspace_id, ts DESC)`,

  `CREATE TABLE IF NOT EXISTS development_apitester_files (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_apitester_files_user_created
     ON development_apitester_files(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_apitester_files_expires
     ON development_apitester_files(expires_at)`,

  `CREATE TABLE IF NOT EXISTS development_apitester_ws_tickets (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_apitester_ws_tickets_expires
     ON development_apitester_ws_tickets(expires_at)`,
]

export const DEVELOPMENT_APITESTER_REQUIRED_TABLES: readonly string[] = [
  'development_apitester_workspaces',
  'development_apitester_state',
  'development_apitester_history',
  'development_apitester_files',
  'development_apitester_ws_tickets',
]

export const DEVELOPMENT_APITESTER_REQUIRED_INDEXES: readonly string[] = [
  'idx_development_apitester_workspaces_user_sort',
  'idx_development_apitester_history_user_ws_ts',
  'idx_development_apitester_files_user_created',
  'idx_development_apitester_files_expires',
  'idx_development_apitester_ws_tickets_expires',
]

export const DEVELOPMENT_APITESTER_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_apitester_workspaces: [
    'user_id',
    'id',
    'name',
    'color',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  development_apitester_state: ['user_id', 'workspace_id', 'data', 'rev', 'updated_at'],
  development_apitester_history: ['id', 'user_id', 'workspace_id', 'data', 'ts'],
  development_apitester_files: [
    'id',
    'user_id',
    'kind',
    'name',
    'content_type',
    'size',
    'r2_key',
    'created_at',
    'expires_at',
  ],
  development_apitester_ws_tickets: ['id', 'user_id', 'data', 'expires_at'],
}
