/**
 * D1 schema statements and invariants for the compare tool (`tools_compare_*`).
 *
 * Three tables, each with one job: `assets` names the bytes in R2, `projects` remembers a comparison
 * the reader saved, and `runs` is the ledger the statistics read. A saved project points at its two
 * assets by id rather than holding a copy, so deleting a project can release the bytes and saving the
 * same file twice costs one object.
 */

export const TOOLS_COMPARE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_compare_assets (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','file','dir','image','binary')),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    encoding TEXT,
    sha256 TEXT,
    r2_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_compare_assets_user
     ON tools_compare_assets(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_compare_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','file','dir','image','binary')),
    left_label TEXT,
    right_label TEXT,
    options_json TEXT NOT NULL DEFAULT '{}',
    summary_json TEXT NOT NULL DEFAULT '{}',
    left_asset_id TEXT,
    right_asset_id TEXT,
    share_slug TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_opened_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_compare_projects_user
     ON tools_compare_projects(user_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_compare_projects_share
     ON tools_compare_projects(share_slug) WHERE share_slug IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS tools_compare_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text','file','dir','image','binary')),
    mode TEXT NOT NULL,
    left_name TEXT,
    right_name TEXT,
    left_ext TEXT,
    right_ext TEXT,
    added_lines INTEGER NOT NULL DEFAULT 0,
    removed_lines INTEGER NOT NULL DEFAULT 0,
    changed_blocks INTEGER NOT NULL DEFAULT 0,
    identical INTEGER NOT NULL DEFAULT 0,
    left_bytes INTEGER NOT NULL DEFAULT 0,
    right_bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_compare_runs_user_time
     ON tools_compare_runs(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_compare_runs_user_kind
     ON tools_compare_runs(user_id, kind, created_at DESC)`,
]

export const TOOLS_COMPARE_REQUIRED_TABLES: readonly string[] = [
  'tools_compare_assets',
  'tools_compare_projects',
  'tools_compare_runs',
]

export const TOOLS_COMPARE_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_compare_assets_user',
  'idx_tools_compare_projects_user',
  'idx_tools_compare_projects_share',
  'idx_tools_compare_runs_user_time',
  'idx_tools_compare_runs_user_kind',
]

export const TOOLS_COMPARE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_compare_assets: ['id', 'user_id', 'kind', 'filename', 'mime', 'size', 'sha256', 'r2_key', 'created_at'],
  tools_compare_projects: ['id', 'user_id', 'name', 'kind', 'options_json', 'summary_json', 'left_asset_id', 'right_asset_id', 'share_slug', 'created_at', 'updated_at'],
  tools_compare_runs: ['id', 'user_id', 'kind', 'mode', 'added_lines', 'removed_lines', 'changed_blocks', 'identical', 'created_at'],
}
