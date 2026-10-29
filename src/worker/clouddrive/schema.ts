/**
 * CloudDrive's D1 tables. Every table is new, so the statements ride in `SCHEMA_STATEMENTS`:
 * a fresh database creates them with everything else, and an existing database gets them from
 * `TABLE_SCHEMA_STATEMENTS` on the next boot. No numbered migration is needed until a column has
 * to be added to a table that already exists in the ledger.
 */
export const CLOUDDRIVE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS CloudDrive_storages (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    credentials TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'enabled',
    is_default INTEGER NOT NULL DEFAULT 0,
    api_key_visible INTEGER NOT NULL DEFAULT 0,
    read_quota INTEGER NOT NULL DEFAULT 0,
    default_path TEXT NOT NULL DEFAULT '/',
    last_used_at INTEGER,
    last_test_at INTEGER,
    last_test_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_storages_user
     ON CloudDrive_storages(user_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clouddrive_storages_default
     ON CloudDrive_storages(user_id) WHERE is_default = 1`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_mounts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mount_path TEXT NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 0,
    cache_ttl INTEGER NOT NULL DEFAULT 300,
    web_proxy INTEGER NOT NULL DEFAULT 0,
    webdav_policy TEXT NOT NULL DEFAULT 'native_proxy',
    sign_expires INTEGER,
    weight INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, mount_path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_mounts_user
     ON CloudDrive_mounts(user_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_files (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mount_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_folded TEXT NOT NULL,
    name_initials TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    checksum TEXT,
    storage_kind TEXT NOT NULL DEFAULT 'r2',
    storage_key TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    color TEXT NOT NULL DEFAULT '',
    starred_at INTEGER,
    last_viewed_at INTEGER,
    deleted_at INTEGER,
    trash_batch TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clouddrive_files_path
     ON CloudDrive_files(user_id, mount_id, path) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_clouddrive_files_sibling
     ON CloudDrive_files(user_id, mount_id, parent_id, name_folded) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_list
     ON CloudDrive_files(user_id, mount_id, parent_id, kind, name_folded)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_search
     ON CloudDrive_files(user_id, name_folded)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_initials
     ON CloudDrive_files(user_id, name_initials)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_recent
     ON CloudDrive_files(user_id, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_viewed
     ON CloudDrive_files(user_id, last_viewed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_star
     ON CloudDrive_files(user_id, starred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_trash
     ON CloudDrive_files(user_id, deleted_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_category
     ON CloudDrive_files(user_id, category, uploaded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_files_storage_key
     ON CloudDrive_files(storage_key)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_file_tags (
    user_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    tag_folded TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, file_id, tag_folded)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_file_tags_tag
     ON CloudDrive_file_tags(user_id, tag_folded, file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_file_tags_file
     ON CloudDrive_file_tags(user_id, file_id)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_shares (
    slug TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    file_id TEXT,
    mount_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER,
    mime TEXT,
    password_hash TEXT,
    expires_at INTEGER,
    max_views INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    max_downloads INTEGER,
    downloads INTEGER NOT NULL DEFAULT 0,
    allow_download INTEGER NOT NULL DEFAULT 1,
    allow_list INTEGER NOT NULL DEFAULT 1,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER,
    revoked_at INTEGER,
    PRIMARY KEY (user_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_shares_user
     ON CloudDrive_shares(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_shares_target
     ON CloudDrive_shares(user_id, file_id)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_share_sessions (
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_share_sessions_slug
     ON CloudDrive_share_sessions(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_share_sessions_expiry
     ON CloudDrive_share_sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_share_visits (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT,
    bytes INTEGER,
    ip_hash TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_share_visits_slug
     ON CloudDrive_share_visits(slug, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_share_visits_at
     ON CloudDrive_share_visits(at)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_upload_sessions (
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    mount_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    name_folded TEXT NOT NULL,
    mime TEXT NOT NULL,
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    strategy TEXT NOT NULL,
    part_size INTEGER NOT NULL DEFAULT 0,
    total_parts INTEGER NOT NULL DEFAULT 0,
    provider_upload_id TEXT,
    storage_key TEXT,
    parts_uploaded INTEGER NOT NULL DEFAULT 0,
    bytes_uploaded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_upload_user
     ON CloudDrive_upload_sessions(user_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_upload_expiry
     ON CloudDrive_upload_sessions(status, expires_at)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_upload_parts (
    session_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    etag TEXT,
    size INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, part_number)
  )`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_tasks (
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    payload TEXT NOT NULL DEFAULT '{}',
    progress TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_tasks_user
     ON CloudDrive_tasks(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_tasks_queue
     ON CloudDrive_tasks(status, created_at)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_api_keys (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'read',
    path_prefix TEXT NOT NULL DEFAULT '/',
    expires_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clouddrive_keys_user
     ON CloudDrive_api_keys(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS CloudDrive_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]

export const CLOUDDRIVE_REQUIRED_TABLES = [
  'CloudDrive_storages',
  'CloudDrive_mounts',
  'CloudDrive_files',
  'CloudDrive_file_tags',
  'CloudDrive_shares',
  'CloudDrive_share_sessions',
  'CloudDrive_share_visits',
  'CloudDrive_upload_sessions',
  'CloudDrive_upload_parts',
  'CloudDrive_tasks',
  'CloudDrive_api_keys',
  'CloudDrive_settings',
] as const

export const CLOUDDRIVE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  CloudDrive_storages: [
    'user_id', 'id', 'name', 'type', 'config', 'credentials', 'status', 'is_default',
    'api_key_visible', 'read_quota', 'default_path', 'last_used_at', 'last_test_at',
    'last_test_status', 'created_at', 'updated_at',
  ],
  CloudDrive_mounts: [
    'user_id', 'id', 'storage_id', 'name', 'mount_path', 'read_only', 'cache_ttl',
    'web_proxy', 'webdav_policy', 'sign_expires', 'weight', 'sort_order', 'enabled',
    'created_at', 'updated_at',
  ],
  CloudDrive_files: [
    'id', 'user_id', 'mount_id', 'parent_id', 'kind', 'name', 'name_folded', 'name_initials',
    'path', 'category', 'mime', 'size', 'etag', 'checksum', 'storage_kind', 'storage_key',
    'metadata', 'color', 'starred_at', 'last_viewed_at', 'deleted_at', 'trash_batch',
    'created_at', 'updated_at', 'uploaded_at', 'modified_at',
  ],
  CloudDrive_file_tags: ['user_id', 'file_id', 'tag', 'tag_folded', 'color', 'created_at'],
  CloudDrive_shares: [
    'slug', 'user_id', 'target_kind', 'file_id', 'mount_id', 'path', 'name', 'size', 'mime',
    'password_hash', 'expires_at', 'max_views', 'views', 'max_downloads', 'downloads',
    'allow_download', 'allow_list', 'is_enabled', 'created_at', 'last_accessed_at', 'revoked_at',
  ],
  CloudDrive_share_sessions: ['id', 'user_id', 'slug', 'password_hash', 'expires_at', 'created_at'],
  CloudDrive_share_visits: ['id', 'user_id', 'slug', 'kind', 'path', 'bytes', 'ip_hash', 'at'],
  CloudDrive_upload_sessions: [
    'id', 'user_id', 'mount_id', 'parent_id', 'path', 'name', 'name_folded', 'mime',
    'category', 'size', 'strategy', 'part_size', 'total_parts', 'provider_upload_id',
    'storage_key', 'parts_uploaded', 'bytes_uploaded', 'status', 'error', 'created_at',
    'updated_at', 'expires_at',
  ],
  CloudDrive_upload_parts: ['session_id', 'part_number', 'etag', 'size', 'uploaded_at'],
  CloudDrive_tasks: [
    'id', 'user_id', 'type', 'status', 'payload', 'progress', 'error', 'locked_until',
    'created_at', 'started_at', 'finished_at', 'updated_at',
  ],
  CloudDrive_api_keys: [
    'id', 'user_id', 'name', 'token_hash', 'token_prefix', 'scopes', 'path_prefix',
    'expires_at', 'last_used_at', 'created_at', 'revoked_at',
  ],
  CloudDrive_settings: ['user_id', 'key', 'value', 'updated_at'],
}

export const CLOUDDRIVE_REQUIRED_INDEXES = [
  'idx_clouddrive_storages_user',
  'idx_clouddrive_storages_default',
  'idx_clouddrive_mounts_user',
  'idx_clouddrive_files_path',
  'idx_clouddrive_files_sibling',
  'idx_clouddrive_files_list',
  'idx_clouddrive_files_search',
  'idx_clouddrive_files_initials',
  'idx_clouddrive_files_recent',
  'idx_clouddrive_files_viewed',
  'idx_clouddrive_files_star',
  'idx_clouddrive_files_trash',
  'idx_clouddrive_files_category',
  'idx_clouddrive_files_storage_key',
  'idx_clouddrive_file_tags_tag',
  'idx_clouddrive_file_tags_file',
  'idx_clouddrive_shares_user',
  'idx_clouddrive_shares_target',
  'idx_clouddrive_share_sessions_slug',
  'idx_clouddrive_share_sessions_expiry',
  'idx_clouddrive_share_visits_slug',
  'idx_clouddrive_share_visits_at',
  'idx_clouddrive_upload_user',
  'idx_clouddrive_upload_expiry',
  'idx_clouddrive_tasks_user',
  'idx_clouddrive_tasks_queue',
  'idx_clouddrive_keys_user',
] as const
