export const IMGBED_FTS_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS imgbed_files_fts USING fts5(
     file_name, file_id, tags, tokenize='trigram'
   )`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_files_fts_ai AFTER INSERT ON imgbed_files BEGIN
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     VALUES (new.rowid, new.file_name, new.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = new.id), ''));
   END`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_files_fts_au AFTER UPDATE OF file_name, id ON imgbed_files BEGIN
     DELETE FROM imgbed_files_fts WHERE rowid = new.rowid;
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     VALUES (new.rowid, new.file_name, new.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = new.id), ''));
   END`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_files_fts_ad AFTER DELETE ON imgbed_files BEGIN
     DELETE FROM imgbed_files_fts WHERE rowid = old.rowid;
   END`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_file_tags_fts_ai AFTER INSERT ON imgbed_file_tags BEGIN
     DELETE FROM imgbed_files_fts WHERE rowid = (SELECT rowid FROM imgbed_files WHERE id = new.file_id);
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     SELECT f.rowid, f.file_name, f.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = f.id), '')
     FROM imgbed_files f WHERE f.id = new.file_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_file_tags_fts_ad AFTER DELETE ON imgbed_file_tags BEGIN
     DELETE FROM imgbed_files_fts WHERE rowid = (SELECT rowid FROM imgbed_files WHERE id = old.file_id);
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     SELECT f.rowid, f.file_name, f.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = f.id), '')
     FROM imgbed_files f WHERE f.id = old.file_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS imgbed_file_tags_fts_au AFTER UPDATE OF file_id, tag ON imgbed_file_tags BEGIN
     DELETE FROM imgbed_files_fts WHERE rowid = (SELECT rowid FROM imgbed_files WHERE id = old.file_id);
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     SELECT f.rowid, f.file_name, f.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = f.id), '')
     FROM imgbed_files f WHERE f.id = old.file_id;
     DELETE FROM imgbed_files_fts WHERE rowid = (SELECT rowid FROM imgbed_files WHERE id = new.file_id);
     INSERT INTO imgbed_files_fts(rowid, file_name, file_id, tags)
     SELECT f.rowid, f.file_name, f.id, COALESCE((SELECT group_concat(tag, ' ') FROM imgbed_file_tags WHERE file_id = f.id), '')
     FROM imgbed_files f WHERE f.id = new.file_id;
   END`,
]

export const IMGBED_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS imgbed_files (
    id TEXT PRIMARY KEY,
    object_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    upload_ip TEXT,
    upload_address TEXT,
    list_type TEXT NOT NULL DEFAULT 'None',
    label TEXT NOT NULL DEFAULT 'None',
    directory TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'upload',
    external_link TEXT,
    channel TEXT NOT NULL DEFAULT 'CloudflareR2',
    channel_name TEXT NOT NULL DEFAULT 'R2',
    is_chunked INTEGER NOT NULL DEFAULT 0,
    parts TEXT,
    uploader_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_created
     ON imgbed_files(created_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_dir
     ON imgbed_files(directory, created_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_type
     ON imgbed_files(file_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_access
     ON imgbed_files(list_type, label, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_ip
     ON imgbed_files(upload_ip, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_channel
     ON imgbed_files(channel, channel_name, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_favorite
     ON imgbed_files(favorite, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_files_pinned
     ON imgbed_files(pinned, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS imgbed_channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    credentials_ciphertext TEXT NOT NULL DEFAULT '',
    credentials_hint TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    fixed INTEGER NOT NULL DEFAULT 0,
    quota_enabled INTEGER NOT NULL DEFAULT 0,
    quota_limit_gb REAL,
    quota_threshold INTEGER NOT NULL DEFAULT 95,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (type, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_channels_type
     ON imgbed_channels(type, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS imgbed_file_tags (
    file_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, tag)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_file_tags_tag
     ON imgbed_file_tags(tag, file_id)`,

  ...IMGBED_FTS_STATEMENTS,

  `CREATE TABLE IF NOT EXISTS imgbed_upload_parts (
    session_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    part_number INTEGER,
    etag TEXT,
    file_id TEXT,
    message_id TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, part_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_upload_parts_session
     ON imgbed_upload_parts(session_id)`,

  `CREATE TABLE IF NOT EXISTS imgbed_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS imgbed_api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER,
    auto_delete INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_tokens_creator
     ON imgbed_api_tokens(created_by, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS imgbed_blocked_ips (
    ip TEXT PRIMARY KEY,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS imgbed_upload_sessions (
    id TEXT PRIMARY KEY,
    actor_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    name_type TEXT NOT NULL DEFAULT 'default',
    channel TEXT NOT NULL DEFAULT 'cfr2',
    channel_name TEXT NOT NULL DEFAULT '',
    total_parts INTEGER NOT NULL,
    part_size INTEGER NOT NULL,
    remote_upload_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'uploading',
    file_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_imgbed_sessions_expiry
     ON imgbed_upload_sessions(expires_at)`,
]

export const IMGBED_REQUIRED_TABLES = [
  'imgbed_files',
  'imgbed_channels',
  'imgbed_file_tags',
  'imgbed_settings',
  'imgbed_api_tokens',
  'imgbed_blocked_ips',
  'imgbed_upload_sessions',
  'imgbed_upload_parts',
] as const

const FILES_COLUMNS = [
  'id', 'object_key', 'file_name', 'file_type', 'file_size_bytes', 'width', 'height',
  'upload_ip', 'upload_address', 'list_type', 'label', 'directory', 'source', 'external_link',
  'channel', 'channel_name', 'is_chunked', 'parts', 'uploader_id', 'favorite', 'pinned', 'created_at', 'updated_at',
]
const CHANNEL_COLUMNS = [
  'id', 'type', 'name', 'config', 'credentials_ciphertext', 'credentials_hint', 'enabled',
  'fixed', 'quota_enabled', 'quota_limit_gb', 'quota_threshold', 'position', 'created_at', 'updated_at',
]

export const IMGBED_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  imgbed_files: FILES_COLUMNS,
  imgbed_channels: CHANNEL_COLUMNS,
  imgbed_file_tags: ['file_id', 'tag', 'created_at'],
  imgbed_settings: ['key', 'value', 'updated_at'],
  imgbed_api_tokens: [
    'id', 'name', 'token_hash', 'token_prefix', 'scopes', 'expires_at', 'auto_delete',
    'created_by', 'created_at', 'last_used_at', 'revoked_at',
  ],
  imgbed_blocked_ips: ['ip', 'note', 'created_at'],
  imgbed_upload_sessions: [
    'id', 'actor_key', 'file_name', 'file_type', 'folder', 'name_type', 'channel', 'channel_name',
    'total_parts', 'part_size', 'remote_upload_id', 'object_key', 'parts', 'status', 'file_id',
    'created_at', 'expires_at',
  ],
  imgbed_upload_parts: ['session_id', 'part_index', 'part_number', 'etag', 'file_id', 'message_id', 'size', 'created_at'],
}

export const IMGBED_REQUIRED_INDEXES = [
  'idx_imgbed_files_created',
  'idx_imgbed_files_dir',
  'idx_imgbed_files_type',
  'idx_imgbed_files_access',
  'idx_imgbed_files_ip',
  'idx_imgbed_files_channel',
  'idx_imgbed_files_favorite',
  'idx_imgbed_files_pinned',
  'idx_imgbed_channels_type',
  'idx_imgbed_file_tags_tag',
  'idx_imgbed_tokens_creator',
  'idx_imgbed_sessions_expiry',
  'idx_imgbed_upload_parts_session',
] as const
