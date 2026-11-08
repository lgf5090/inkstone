export const DEVELOPMENT_ICONS_CORE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_icons_collections (
    user_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'upload',
    license     TEXT NOT NULL DEFAULT '',
    homepage    TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_development_icons_collections_slug
     ON development_icons_collections(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_collections_order
     ON development_icons_collections(user_id, sort_order, name)`,

  `CREATE TABLE IF NOT EXISTS development_icons_assets (
    user_id       TEXT NOT NULL,
    id            TEXT NOT NULL,
    collection_id TEXT,
    name          TEXT NOT NULL,
    name_key      TEXT NOT NULL,
    format        TEXT NOT NULL,
    mime          TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    width         INTEGER,
    height        INTEGER,
    view_box      TEXT,
    sha256        TEXT NOT NULL,
    r2_key        TEXT NOT NULL,
    thumb_key     TEXT,
    keywords      TEXT NOT NULL DEFAULT '',
    color_mode    TEXT NOT NULL DEFAULT 'unknown',
    license       TEXT NOT NULL DEFAULT '',
    source_url    TEXT NOT NULL DEFAULT '',
    sanitized     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_development_icons_assets_hash
     ON development_icons_assets(user_id, format, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_assets_collection
     ON development_icons_assets(user_id, collection_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_assets_recent
     ON development_icons_assets(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_assets_updated
     ON development_icons_assets(user_id, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_assets_name
     ON development_icons_assets(user_id, name_key, id)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_assets_format
     ON development_icons_assets(user_id, format, created_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS development_icons_tags (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    parent_id  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_development_icons_tags_name
     ON development_icons_tags(user_id, parent_id, name_key)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_tags_parent
     ON development_icons_tags(user_id, parent_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS development_icons_tag_links (
    user_id    TEXT NOT NULL,
    asset_id   TEXT NOT NULL,
    tag_id     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, asset_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_tag_links_tag
     ON development_icons_tag_links(user_id, tag_id, asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_tag_links_asset
     ON development_icons_tag_links(user_id, asset_id)`,

  `CREATE TABLE IF NOT EXISTS development_icons_user_state (
    user_id      TEXT NOT NULL,
    asset_id     TEXT NOT NULL,
    favorited    INTEGER NOT NULL DEFAULT 0,
    pinned       INTEGER NOT NULL DEFAULT 0,
    pinned_at    INTEGER,
    use_count    INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, asset_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_state_fav
     ON development_icons_user_state(user_id, favorited, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_state_pin
     ON development_icons_user_state(user_id, pinned, pinned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_state_used
     ON development_icons_user_state(user_id, last_used_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_icons_usage_daily (
    user_id    TEXT NOT NULL,
    day        TEXT NOT NULL,
    asset_id   TEXT NOT NULL,
    action     TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day, asset_id, action)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_usage_day
     ON development_icons_usage_daily(user_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_usage_asset
     ON development_icons_usage_daily(user_id, asset_id, day)`,

  `CREATE TABLE IF NOT EXISTS development_icons_imports (
    user_id         TEXT NOT NULL,
    id              TEXT NOT NULL,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL,
    prefix          TEXT NOT NULL DEFAULT '',
    total_items     INTEGER NOT NULL DEFAULT 0,
    processed_items INTEGER NOT NULL DEFAULT 0,
    failed_items    INTEGER NOT NULL DEFAULT 0,
    skipped_items   INTEGER NOT NULL DEFAULT 0,
    bytes_total     INTEGER NOT NULL DEFAULT 0,
    error           TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_imports_recent
     ON development_icons_imports(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_icons_import_items (
    user_id    TEXT NOT NULL,
    import_id  TEXT NOT NULL,
    item_key   TEXT NOT NULL,
    filename   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL,
    asset_id   TEXT,
    error      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, import_id, item_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_import_items_status
     ON development_icons_import_items(user_id, import_id, status)`,

  `CREATE TABLE IF NOT EXISTS development_icons_exports (
    user_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    format      TEXT NOT NULL,
    filename    TEXT NOT NULL,
    r2_key      TEXT NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    asset_count INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,
    error       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_exports_recent
     ON development_icons_exports(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_exports_expiry
     ON development_icons_exports(user_id, expires_at)`,

  `CREATE TABLE IF NOT EXISTS development_icons_jobs (
    user_id          TEXT NOT NULL,
    id               TEXT NOT NULL,
    kind             TEXT NOT NULL,
    status           TEXT NOT NULL,
    execution        TEXT NOT NULL DEFAULT 'browser',
    options_json     TEXT NOT NULL DEFAULT '{}',
    total_items      INTEGER NOT NULL DEFAULT 0,
    processed_items  INTEGER NOT NULL DEFAULT 0,
    failed_items     INTEGER NOT NULL DEFAULT 0,
    output_prefix    TEXT NOT NULL DEFAULT '',
    manifest_key     TEXT NOT NULL DEFAULT '',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error            TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    started_at       INTEGER,
    finished_at      INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_jobs_recent
     ON development_icons_jobs(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_jobs_status
     ON development_icons_jobs(status, updated_at)`,

  `CREATE TABLE IF NOT EXISTS development_icons_job_items (
    user_id      TEXT NOT NULL,
    job_id       TEXT NOT NULL,
    asset_id     TEXT NOT NULL,
    status       TEXT NOT NULL,
    outputs_json TEXT NOT NULL DEFAULT '{}',
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, job_id, asset_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_job_items_status
     ON development_icons_job_items(user_id, job_id, status)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS development_icons_fts USING fts5(
    name,
    slug,
    keywords,
    collection_name,
    user_id UNINDEXED,
    tokenize = 'trigram'
  )`,
  `CREATE TRIGGER IF NOT EXISTS development_icons_fts_ai AFTER INSERT ON development_icons_assets BEGIN
    INSERT INTO development_icons_fts(rowid, name, slug, keywords, collection_name, user_id)
    VALUES (
      new.rowid,
      new.name,
      new.name_key,
      new.keywords,
      COALESCE((SELECT name FROM development_icons_collections WHERE user_id = new.user_id AND id = new.collection_id), ''),
      new.user_id
    );
  END`,
  `CREATE TRIGGER IF NOT EXISTS development_icons_fts_au AFTER UPDATE OF name, name_key, keywords, collection_id, user_id ON development_icons_assets BEGIN
    DELETE FROM development_icons_fts WHERE rowid = old.rowid;
    INSERT INTO development_icons_fts(rowid, name, slug, keywords, collection_name, user_id)
    VALUES (
      new.rowid,
      new.name,
      new.name_key,
      new.keywords,
      COALESCE((SELECT name FROM development_icons_collections WHERE user_id = new.user_id AND id = new.collection_id), ''),
      new.user_id
    );
  END`,
  `CREATE TRIGGER IF NOT EXISTS development_icons_fts_ad AFTER DELETE ON development_icons_assets BEGIN
    DELETE FROM development_icons_fts WHERE rowid = old.rowid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS development_icons_collections_fts_au AFTER UPDATE OF name ON development_icons_collections BEGIN
    DELETE FROM development_icons_fts
    WHERE rowid IN (
      SELECT rowid FROM development_icons_assets
      WHERE user_id = old.user_id AND collection_id = old.id
    );
    INSERT INTO development_icons_fts(rowid, name, slug, keywords, collection_name, user_id)
    SELECT
      a.rowid,
      a.name,
      a.name_key,
      a.keywords,
      new.name,
      a.user_id
    FROM development_icons_assets a
    WHERE a.user_id = old.user_id AND a.collection_id = old.id;
  END`,
]

export const DEVELOPMENT_ICONS_SETTINGS_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_icons_settings (
    user_id             TEXT PRIMARY KEY,
    quota_bytes         INTEGER NOT NULL,
    max_svg_bytes       INTEGER NOT NULL,
    max_raster_bytes    INTEGER NOT NULL,
    max_dimension       INTEGER NOT NULL,
    batch_limit         INTEGER NOT NULL,
    zip_limit_bytes     INTEGER NOT NULL,
    zip_limit_entries   INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS development_icons_limits (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    hard_quota_bytes       INTEGER NOT NULL,
    hard_max_svg_bytes     INTEGER NOT NULL,
    hard_max_raster_bytes  INTEGER NOT NULL,
    hard_max_dimension     INTEGER NOT NULL,
    hard_batch_limit       INTEGER NOT NULL,
    hard_zip_limit_bytes   INTEGER NOT NULL,
    hard_zip_limit_entries INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  )`,
]

export const DEVELOPMENT_ICONS_OUTPUTS_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_icons_job_outputs (
    user_id    TEXT NOT NULL,
    job_id     TEXT NOT NULL,
    asset_id   TEXT NOT NULL,
    name       TEXT NOT NULL,
    r2_key     TEXT NOT NULL,
    bytes      INTEGER NOT NULL DEFAULT 0,
    sha256     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, job_id, asset_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_icons_job_outputs_job
     ON development_icons_job_outputs(user_id, job_id)`,
]

export const DEVELOPMENT_ICONS_JOB_EXECUTION_STATEMENTS: readonly string[] = [
  `ALTER TABLE development_icons_jobs ADD COLUMN execution TEXT NOT NULL DEFAULT 'browser'`,
]

export const DEVELOPMENT_ICONS_REQUIRED_TABLES: readonly string[] = [
  'development_icons_collections',
  'development_icons_assets',
  'development_icons_tags',
  'development_icons_tag_links',
  'development_icons_user_state',
  'development_icons_usage_daily',
  'development_icons_imports',
  'development_icons_import_items',
  'development_icons_exports',
  'development_icons_jobs',
  'development_icons_job_items',
  'development_icons_job_outputs',
  'development_icons_settings',
  'development_icons_limits',
]

export const DEVELOPMENT_ICONS_REQUIRED_INDEXES: readonly string[] = [
  'idx_development_icons_collections_slug',
  'idx_development_icons_collections_order',
  'idx_development_icons_assets_hash',
  'idx_development_icons_assets_collection',
  'idx_development_icons_assets_recent',
  'idx_development_icons_assets_updated',
  'idx_development_icons_assets_name',
  'idx_development_icons_assets_format',
  'idx_development_icons_tags_name',
  'idx_development_icons_tags_parent',
  'idx_development_icons_tag_links_tag',
  'idx_development_icons_tag_links_asset',
  'idx_development_icons_state_fav',
  'idx_development_icons_state_pin',
  'idx_development_icons_state_used',
  'idx_development_icons_usage_day',
  'idx_development_icons_usage_asset',
  'idx_development_icons_imports_recent',
  'idx_development_icons_import_items_status',
  'idx_development_icons_exports_recent',
  'idx_development_icons_exports_expiry',
  'idx_development_icons_jobs_recent',
  'idx_development_icons_jobs_status',
  'idx_development_icons_job_items_status',
  'idx_development_icons_job_outputs_job',
]

export const DEVELOPMENT_ICONS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_icons_collections: ['user_id', 'id', 'name', 'slug', 'description', 'source', 'license', 'homepage', 'sort_order', 'created_at', 'updated_at'],
  development_icons_assets: ['user_id', 'id', 'collection_id', 'name', 'name_key', 'format', 'mime', 'bytes', 'width', 'height', 'view_box', 'sha256', 'r2_key', 'thumb_key', 'keywords', 'color_mode', 'license', 'source_url', 'sanitized', 'created_at', 'updated_at'],
  development_icons_tags: ['user_id', 'id', 'name', 'name_key', 'color', 'parent_id', 'sort_order', 'created_at', 'updated_at'],
  development_icons_tag_links: ['user_id', 'asset_id', 'tag_id', 'created_at'],
  development_icons_user_state: ['user_id', 'asset_id', 'favorited', 'pinned', 'pinned_at', 'use_count', 'last_used_at', 'updated_at'],
  development_icons_usage_daily: ['user_id', 'day', 'asset_id', 'action', 'count', 'updated_at'],
  development_icons_imports: ['user_id', 'id', 'kind', 'status', 'prefix', 'total_items', 'processed_items', 'failed_items', 'skipped_items', 'bytes_total', 'error', 'created_at', 'updated_at', 'finished_at'],
  development_icons_import_items: ['user_id', 'import_id', 'item_key', 'filename', 'status', 'asset_id', 'error', 'created_at', 'updated_at'],
  development_icons_exports: ['user_id', 'id', 'format', 'filename', 'r2_key', 'bytes', 'asset_count', 'status', 'error', 'created_at', 'expires_at'],
  development_icons_jobs: ['user_id', 'id', 'kind', 'status', 'execution', 'options_json', 'total_items', 'processed_items', 'failed_items', 'output_prefix', 'manifest_key', 'cancel_requested', 'error', 'created_at', 'updated_at', 'started_at', 'finished_at'],
  development_icons_job_items: ['user_id', 'job_id', 'asset_id', 'status', 'outputs_json', 'attempts', 'error', 'updated_at'],
  development_icons_job_outputs: ['user_id', 'job_id', 'asset_id', 'name', 'r2_key', 'bytes', 'sha256', 'created_at'],
  development_icons_settings: ['user_id', 'quota_bytes', 'max_svg_bytes', 'max_raster_bytes', 'max_dimension', 'batch_limit', 'zip_limit_bytes', 'zip_limit_entries', 'updated_at'],
  development_icons_limits: ['id', 'hard_quota_bytes', 'hard_max_svg_bytes', 'hard_max_raster_bytes', 'hard_max_dimension', 'hard_batch_limit', 'hard_zip_limit_bytes', 'hard_zip_limit_entries', 'updated_at'],
}
