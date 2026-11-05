/**
 * D1 statements and invariants for the network panel (`tools_NetworkPanel_*`).
 *
 * Three tables, one job each: `settings` is one row per reader and the panel's defaults, `nodes`
 * remembers addresses the reader added, and `runs` is the ledger the history screen counts. No bytes
 * are stored anywhere — a run is a measurement, not a download — so this tool needs no R2 bucket.
 */

export const TOOLS_NETWORK_PANEL_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_NetworkPanel_settings (
    user_id TEXT PRIMARY KEY,
    threads INTEGER NOT NULL DEFAULT 8,
    auto_start INTEGER NOT NULL DEFAULT 0,
    background INTEGER NOT NULL DEFAULT 0,
    show_chart INTEGER NOT NULL DEFAULT 1,
    save_history INTEGER NOT NULL DEFAULT 1,
    auto_refresh_info INTEGER NOT NULL DEFAULT 1,
    max_data_bytes INTEGER NOT NULL DEFAULT 0,
    max_speed_bps INTEGER NOT NULL DEFAULT 0,
    node_id TEXT NOT NULL DEFAULT 'builtin',
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tools_NetworkPanel_nodes (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_NetworkPanel_nodes_user
     ON tools_NetworkPanel_nodes(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_NetworkPanel_runs (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    node_label TEXT NOT NULL,
    node_url TEXT NOT NULL,
    bytes_used INTEGER NOT NULL DEFAULT 0,
    avg_speed_bps REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    threads INTEGER NOT NULL DEFAULT 1,
    stop_reason TEXT NOT NULL CHECK (stop_reason IN ('manual','data_cap','hidden','failed')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_NetworkPanel_runs_user_time
     ON tools_NetworkPanel_runs(user_id, created_at DESC, id DESC)`,
]

export const TOOLS_NETWORK_PANEL_REQUIRED_TABLES: readonly string[] = [
  'tools_NetworkPanel_settings',
  'tools_NetworkPanel_nodes',
  'tools_NetworkPanel_runs',
]

export const TOOLS_NETWORK_PANEL_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_NetworkPanel_nodes_user',
  'idx_tools_NetworkPanel_runs_user_time',
]

export const TOOLS_NETWORK_PANEL_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_NetworkPanel_settings: [
    'user_id',
    'threads',
    'auto_start',
    'background',
    'show_chart',
    'save_history',
    'auto_refresh_info',
    'max_data_bytes',
    'max_speed_bps',
    'node_id',
    'updated_at',
  ],
  tools_NetworkPanel_nodes: ['user_id', 'id', 'label', 'url', 'created_at'],
  tools_NetworkPanel_runs: [
    'id',
    'user_id',
    'node_label',
    'node_url',
    'bytes_used',
    'avg_speed_bps',
    'duration_ms',
    'threads',
    'stop_reason',
    'created_at',
  ],
}
