/**
 * The hand-written notebook's tables, declared where every boot can find them.
 *
 * Every new table is `CREATE TABLE IF NOT EXISTS`, so no migration number is spent: an existing
 * database converges through the table/index statements the boot already replays. Columns added to
 * these tables later are the exception and belong in SCHEMA_MIGRATIONS with their own version.
 */

export const INKNOTE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS inknote_subjects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_subjects_order
    ON inknote_subjects(user_id, position, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_notebooks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cover_color TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_notebooks_order
    ON inknote_notebooks(user_id, subject_id, position, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_notes (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    notebook_id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    paper_style TEXT NOT NULL,
    paper_color TEXT NOT NULL,
    paper_spacing TEXT NOT NULL DEFAULT 'normal',
    page_width INTEGER NOT NULL,
    page_height INTEGER NOT NULL,
    content_width INTEGER NOT NULL,
    content_height INTEGER NOT NULL,
    color_tag TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    content_bytes INTEGER NOT NULL DEFAULT 0,
    cover_asset_id TEXT,
    rev INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_notes_notebook
    ON inknote_notes(user_id, notebook_id, deleted_at, pinned DESC, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_notes_recent
    ON inknote_notes(user_id, deleted_at, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_notes_trash
    ON inknote_notes(user_id, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_notes_title
    ON inknote_notes(user_id, title_key)`,

  `CREATE TABLE IF NOT EXISTS inknote_pages (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    search_text TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_pages_note
    ON inknote_pages(user_id, note_id, position, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_assets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    note_id TEXT,
    page_id TEXT,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    object_key TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    storage TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_assets_note
    ON inknote_assets(user_id, note_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_assets_page
    ON inknote_assets(user_id, page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_assets_sha
    ON inknote_assets(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_assets_created
    ON inknote_assets(user_id, created_at, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_recordings (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    audio_asset_id TEXT NOT NULL,
    timeline_key TEXT NOT NULL,
    peaks TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_recordings_note
    ON inknote_recordings(user_id, note_id, created_at, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_templates (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    paper_style TEXT NOT NULL,
    paper_color TEXT NOT NULL,
    paper_spacing TEXT NOT NULL DEFAULT 'normal',
    bg_asset_id TEXT,
    texts TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL DEFAULT '',
    sub TEXT NOT NULL DEFAULT '',
    title_size INTEGER NOT NULL DEFAULT 32,
    sub_size INTEGER NOT NULL DEFAULT 15,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_templates_created
    ON inknote_templates(user_id, created_at, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_settings (
    user_id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS inknote_snapshots (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    note_count INTEGER NOT NULL,
    size INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_snapshots_recent
    ON inknote_snapshots(user_id, created_at DESC, id)`,

  `CREATE TABLE IF NOT EXISTS inknote_cleanup (
    user_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    storage TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, object_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inknote_cleanup_created
    ON inknote_cleanup(user_id, created_at)`,
]

export const INKNOTE_REQUIRED_TABLES = [
  'inknote_subjects',
  'inknote_notebooks',
  'inknote_notes',
  'inknote_pages',
  'inknote_assets',
  'inknote_recordings',
  'inknote_templates',
  'inknote_settings',
  'inknote_snapshots',
  'inknote_cleanup',
] as const

export const INKNOTE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  inknote_subjects: ['user_id', 'id', 'name', 'position', 'created_at', 'updated_at'],
  inknote_notebooks: ['user_id', 'id', 'subject_id', 'name', 'cover_color', 'emoji', 'position', 'created_at', 'updated_at'],
  inknote_notes: ['user_id', 'id', 'notebook_id', 'title', 'title_key', 'paper_style', 'paper_color', 'paper_spacing', 'page_width', 'page_height', 'content_width', 'content_height', 'color_tag', 'pinned', 'page_count', 'content_bytes', 'cover_asset_id', 'rev', 'created_at', 'updated_at', 'deleted_at'],
  inknote_pages: ['user_id', 'id', 'note_id', 'position', 'content', 'search_text', 'rev', 'created_at', 'updated_at'],
  inknote_assets: ['user_id', 'id', 'note_id', 'page_id', 'kind', 'filename', 'mime', 'size', 'sha256', 'object_key', 'width', 'height', 'storage', 'created_at'],
  inknote_recordings: ['user_id', 'id', 'note_id', 'title', 'duration_ms', 'audio_asset_id', 'timeline_key', 'peaks', 'created_at'],
  inknote_templates: ['user_id', 'id', 'name', 'paper_style', 'paper_color', 'paper_spacing', 'bg_asset_id', 'texts', 'title', 'sub', 'title_size', 'sub_size', 'created_at', 'updated_at'],
  inknote_settings: ['user_id', 'config', 'updated_at'],
  inknote_snapshots: ['user_id', 'id', 'label', 'note_count', 'size', 'object_key', 'created_at'],
  inknote_cleanup: ['user_id', 'object_key', 'storage', 'created_at'],
}

export const INKNOTE_REQUIRED_INDEXES = [
  'idx_inknote_subjects_order',
  'idx_inknote_notebooks_order',
  'idx_inknote_notes_notebook',
  'idx_inknote_notes_recent',
  'idx_inknote_notes_trash',
  'idx_inknote_notes_title',
  'idx_inknote_pages_note',
  'idx_inknote_assets_note',
  'idx_inknote_assets_page',
  'idx_inknote_assets_sha',
  'idx_inknote_assets_created',
  'idx_inknote_recordings_note',
  'idx_inknote_templates_created',
  'idx_inknote_snapshots_recent',
  'idx_inknote_cleanup_created',
] as const
