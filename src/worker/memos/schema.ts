export const MEMOS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memos_spaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    space_id TEXT,
    parent_id TEXT,
    content TEXT NOT NULL DEFAULT '',
    content_search TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private','protected','public')),
    state TEXT NOT NULL DEFAULT 'normal'
      CHECK (state IN ('normal','archived')),
    pinned INTEGER NOT NULL DEFAULT 0,
    has_link INTEGER NOT NULL DEFAULT 0,
    has_code INTEGER NOT NULL DEFAULT 0,
    has_task_list INTEGER NOT NULL DEFAULT 0,
    has_incomplete_tasks INTEGER NOT NULL DEFAULT 0,
    has_location INTEGER NOT NULL DEFAULT 0,
    location_placeholder TEXT,
    latitude REAL,
    longitude REAL,
    rev INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_tags (
    memo_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (memo_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS memos_relations (
    memo_id TEXT NOT NULL,
    related_memo_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (memo_id, related_memo_id)
  )`,

  `CREATE TABLE IF NOT EXISTS memos_reactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    memo_id TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, memo_id, type)
  )`,

  `CREATE TABLE IF NOT EXISTS memos_attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    memo_id TEXT,
    folder_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage TEXT NOT NULL CHECK (storage IN ('r2','kv')),
    storage_key TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    thumbnail_key TEXT,
    media_metadata TEXT,
    motion_group_id TEXT,
    motion_role TEXT,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    memo_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS memos_views (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    filter TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_preferences (
    user_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS memos_webhooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_link_metadata (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    memo_id TEXT,
    at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS memos_import_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_memos_user_created
    ON memos_items(user_id, state, pinned DESC, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_user_updated
    ON memos_items(user_id, state, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_user_space
    ON memos_items(user_id, space_id, state, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_parent
    ON memos_items(parent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_public
    ON memos_items(visibility, state, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_tags_tag
    ON memos_tags(tag, memo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_attachments_user
    ON memos_attachments(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_attachments_memo
    ON memos_attachments(memo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_attachments_motion
    ON memos_attachments(motion_group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_reactions_memo
    ON memos_reactions(memo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_shares_memo
    ON memos_shares(memo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_tokens_user
    ON memos_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_webhooks_user
    ON memos_webhooks(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_changes_user
    ON memos_changes(user_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_memos_import_sessions_user
    ON memos_import_sessions(user_id, expires_at)`,
]

export const MEMOS_REQUIRED_TABLES: readonly string[] = [
  'memos_items',
  'memos_spaces',
  'memos_tags',
  'memos_relations',
  'memos_reactions',
  'memos_attachments',
  'memos_shares',
  'memos_views',
  'memos_preferences',
  'memos_tokens',
  'memos_webhooks',
  'memos_link_metadata',
  'memos_changes',
  'memos_import_sessions',
]

export const MEMOS_REQUIRED_INDEXES: readonly string[] = [
  'idx_memos_user_created',
  'idx_memos_user_updated',
  'idx_memos_user_space',
  'idx_memos_parent',
  'idx_memos_public',
  'idx_memos_tags_tag',
  'idx_memos_attachments_user',
  'idx_memos_attachments_memo',
  'idx_memos_attachments_motion',
  'idx_memos_reactions_memo',
  'idx_memos_shares_memo',
  'idx_memos_tokens_user',
  'idx_memos_webhooks_user',
  'idx_memos_changes_user',
  'idx_memos_import_sessions_user',
]

export const MEMOS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  memos_spaces: ['id', 'user_id', 'title', 'description', 'icon', 'created_at', 'updated_at'],
  memos_items: [
    'id', 'user_id', 'space_id', 'parent_id', 'content', 'content_search', 'title', 'snippet',
    'visibility', 'state', 'pinned', 'has_link', 'has_code', 'has_task_list', 'has_incomplete_tasks',
    'has_location', 'location_placeholder', 'latitude', 'longitude', 'rev', 'created_at', 'updated_at',
  ],
  memos_tags: ['memo_id', 'tag'],
  memos_relations: ['memo_id', 'related_memo_id', 'created_at'],
  memos_reactions: ['id', 'user_id', 'memo_id', 'type', 'created_at'],
  memos_attachments: [
    'id', 'user_id', 'memo_id', 'folder_id', 'filename', 'mime', 'size', 'storage', 'storage_key', 'width',
    'height', 'thumbnail_key', 'media_metadata', 'motion_group_id', 'motion_role', 'is_starred', 'is_pinned',
    'tags', 'created_at', 'updated_at',
  ],
  memos_shares: ['id', 'user_id', 'memo_id', 'token_hash', 'expires_at', 'created_at', 'revoked_at'],
  memos_views: ['id', 'user_id', 'title', 'filter', 'icon', 'created_at', 'updated_at'],
  memos_preferences: ['user_id', 'json', 'updated_at'],
  memos_tokens: ['id', 'user_id', 'token_hash', 'prefix', 'description', 'expires_at', 'created_at', 'last_used_at'],
  memos_webhooks: ['id', 'user_id', 'title', 'url', 'secret_ciphertext', 'created_at', 'updated_at'],
  memos_link_metadata: ['url_hash', 'url', 'title', 'description', 'image', 'fetched_at'],
  memos_changes: ['seq', 'user_id', 'kind', 'memo_id', 'at'],
  memos_import_sessions: ['id', 'user_id', 'filename', 'total_size', 'received', 'storage_key', 'created_at', 'expires_at'],
}
