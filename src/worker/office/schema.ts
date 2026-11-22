/**
 * The office app's tables, declared where the boot can find them.
 *
 * Every table is new, so the statements are re-run idempotently on every boot instead of spending a
 * migration number: a database built by a parallel branch that used the same number still converges.
 * Columns added to a deployed table later belong in `SCHEMA_MIGRATIONS`.
 */

export const OFFICE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS office_file (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('sheets', 'docs', 'slides', 'bases', 'boards', 'pdfs')),
    title TEXT NOT NULL,
    folder_id TEXT,
    snapshot_key TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    last_opened_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_updated ON office_file(user_id, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_type ON office_file(user_id, type, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_folder ON office_file(user_id, folder_id, deleted_at, position, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_starred ON office_file(user_id, is_starred, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_pinned ON office_file(user_id, is_pinned DESC, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_user_recent ON office_file(user_id, last_opened_at DESC)`,

  `CREATE TABLE IF NOT EXISTS office_folder (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_office_folder_user ON office_folder(user_id, parent_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_office_folder_unique_sibling ON office_folder(user_id, IFNULL(parent_id, ''), lower(name)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS office_tag (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_office_tag_unique ON office_tag(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_office_tag_name_nocase ON office_tag(user_id, name COLLATE NOCASE)`,

  `CREATE TABLE IF NOT EXISTS office_file_tag (
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (user_id, file_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_tag_tag ON office_file_tag(user_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS office_file_version (
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, file_id, rev)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_office_file_version_recent ON office_file_version(user_id, file_id, rev DESC)`,

  `CREATE TABLE IF NOT EXISTS office_asset (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_office_asset_recent ON office_asset(user_id, last_used_at DESC)`,
]

export const OFFICE_REQUIRED_TABLES = [
  'office_file',
  'office_folder',
  'office_tag',
  'office_file_tag',
  'office_file_version',
  'office_asset',
] as const

export const OFFICE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  office_file: [
    'user_id', 'id', 'type', 'title', 'folder_id', 'snapshot_key', 'rev', 'size', 'content_hash',
    'is_pinned', 'is_starred', 'position', 'last_opened_at', 'created_at', 'updated_at', 'deleted_at',
  ],
  office_folder: ['user_id', 'id', 'parent_id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at', 'deleted_at'],
  office_tag: ['user_id', 'id', 'name', 'color', 'is_pinned', 'created_at'],
  office_file_tag: ['user_id', 'file_id', 'tag_id'],
  office_file_version: ['user_id', 'file_id', 'rev', 'object_key', 'size', 'content_hash', 'created_at'],
  office_asset: ['user_id', 'id', 'name', 'mime', 'size', 'object_key', 'created_at', 'last_used_at'],
}

export const OFFICE_REQUIRED_INDEXES = [
  'idx_office_file_user_updated',
  'idx_office_file_user_type',
  'idx_office_file_user_folder',
  'idx_office_file_user_starred',
  'idx_office_file_user_pinned',
  'idx_office_file_user_recent',
  'idx_office_folder_user',
  'idx_office_folder_unique_sibling',
  'idx_office_tag_unique',
  'idx_office_tag_name_nocase',
  'idx_office_file_tag_tag',
  'idx_office_file_version_recent',
  'idx_office_asset_recent',
] as const