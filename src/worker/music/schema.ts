/**
 * The music library's tables, declared where the boot can find them.
 *
 * Tables that no older shape ever occupied are created here rather than numbered into the migration
 * ledger: every boot re-runs these statements, so a database built by a branch that spent the same
 * number for other work still gets the shape. Columns added to a table already deployed are the
 * exception and belong in `SCHEMA_MIGRATIONS` with their own version.
 *
 * Every table that holds one account's rows leads its primary key with `user_id`. `music_cleanup` is
 * the deliberate exception: its key is the R2 object key, which already embeds the owner, and the
 * queue is a list of objects rather than a list of an account's records.
 */

export const MUSIC_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS music_track (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'song',
    title TEXT NOT NULL,
    artists TEXT NOT NULL DEFAULT '[]',
    album TEXT NOT NULL DEFAULT '',
    album_id TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    cover_key TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT '',
    bitrate INTEGER,
    size INTEGER,
    sha256 TEXT NOT NULL DEFAULT '',
    r2_key TEXT,
    source TEXT NOT NULL DEFAULT '',
    source_quality TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, provider, provider_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_track_provider ON music_track(user_id, provider, provider_id)`,
  `CREATE INDEX IF NOT EXISTS idx_music_track_sha ON music_track(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_music_track_size ON music_track(user_id, size)`,

  `CREATE TABLE IF NOT EXISTS music_playlist (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'local',
    provider_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'manual',
    sort_order INTEGER NOT NULL DEFAULT 0,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_playlist_user
    ON music_playlist(user_id, sort_order, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_music_playlist_pinned
    ON music_playlist(user_id, pinned_at DESC)`,

  `CREATE TABLE IF NOT EXISTS music_playlist_item (
    user_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, playlist_id, track_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_playlist_item_order
    ON music_playlist_item(user_id, playlist_id, position)`,

  `CREATE TABLE IF NOT EXISTS music_favorite (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    pinned_at INTEGER,
    PRIMARY KEY (user_id, track_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_favorite_recent
    ON music_favorite(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_music_favorite_pinned
    ON music_favorite(user_id, pinned_at DESC)`,

  `CREATE TABLE IF NOT EXISTS music_history (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    duration_played INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    context_type TEXT NOT NULL DEFAULT '',
    context_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_history_recent
    ON music_history(user_id, played_at DESC)`,

  `CREATE TABLE IF NOT EXISTS music_recent (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cover_url TEXT NOT NULL DEFAULT '',
    last_played_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, kind, provider_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_recent_time
    ON music_recent(user_id, last_played_at DESC)`,

  `CREATE TABLE IF NOT EXISTS music_download (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    size INTEGER,
    r2_key TEXT,
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, track_id, quality, format)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_download_queue
    ON music_download(user_id, status, created_at)`,

  `CREATE TABLE IF NOT EXISTS music_object (
    user_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    track_id TEXT,
    format TEXT NOT NULL,
    quality TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, r2_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_object_sha ON music_object(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_music_object_track ON music_object(user_id, track_id)`,

  `CREATE TABLE IF NOT EXISTS music_upload (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading',
    r2_key TEXT,
    track_id TEXT,
    cover_key TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    upload_id TEXT,
    parts_json TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_upload_status
    ON music_upload(user_id, status, created_at)`,

  `CREATE TABLE IF NOT EXISTS music_lyric (
    user_id TEXT NOT NULL,
    track_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'netease',
    lrc TEXT NOT NULL DEFAULT '',
    tlyric TEXT NOT NULL DEFAULT '',
    yrc TEXT NOT NULL DEFAULT '',
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  )`,

  `CREATE TABLE IF NOT EXISTS music_lyric_ai (
    user_id TEXT NOT NULL,
    track_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'translation',
    lang TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key, kind, lang)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_lyric_ai_track
    ON music_lyric_ai(user_id, track_key)`,

  `CREATE TABLE IF NOT EXISTS music_account (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'netease',
    account_id TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    cookie_ciphertext TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'connected',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider)
  )`,

  `CREATE TABLE IF NOT EXISTS music_mount (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'alist',
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    root_path TEXT NOT NULL DEFAULT '/',
    secret TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_mount_user
    ON music_mount(user_id, created_at, id)`,

  `CREATE TABLE IF NOT EXISTS music_setting (
    user_id TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS music_source_override (
    user_id TEXT NOT NULL,
    track_key TEXT NOT NULL,
    source TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_key)
  )`,

  `CREATE TABLE IF NOT EXISTS music_subscription (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cover_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, kind, provider_id)
  )`,

  `CREATE TABLE IF NOT EXISTS music_cleanup (
    object_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (object_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_music_cleanup_created ON music_cleanup(created_at)`,
]

export const MUSIC_REQUIRED_TABLES: readonly string[] = [
  'music_track',
  'music_playlist',
  'music_playlist_item',
  'music_favorite',
  'music_history',
  'music_recent',
  'music_download',
  'music_object',
  'music_upload',
  'music_lyric',
  'music_lyric_ai',
  'music_account',
  'music_mount',
  'music_setting',
  'music_source_override',
  'music_subscription',
  'music_cleanup',
]

export const MUSIC_REQUIRED_INDEXES: readonly string[] = [
  'idx_music_track_provider',
  'idx_music_track_sha',
  'idx_music_track_size',
  'idx_music_playlist_user',
  'idx_music_playlist_pinned',
  'idx_music_playlist_item_order',
  'idx_music_favorite_recent',
  'idx_music_favorite_pinned',
  'idx_music_history_recent',
  'idx_music_recent_time',
  'idx_music_download_queue',
  'idx_music_object_sha',
  'idx_music_object_track',
  'idx_music_upload_status',
  'idx_music_lyric_ai_track',
  'idx_music_mount_user',
  'idx_music_cleanup_created',
]

export const MUSIC_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  music_track: [
    'user_id', 'id', 'provider', 'provider_id', 'kind', 'title', 'artists', 'album', 'album_id',
    'cover_url', 'cover_key', 'duration_ms', 'format', 'bitrate', 'size', 'sha256', 'r2_key',
    'source', 'source_quality', 'created_at', 'updated_at',
  ],
  music_playlist: [
    'user_id', 'id', 'name', 'description', 'cover_url', 'provider', 'provider_id', 'kind',
    'sort_order', 'pinned_at', 'created_at', 'updated_at',
  ],
  music_playlist_item: ['user_id', 'playlist_id', 'track_id', 'position', 'added_at'],
  music_favorite: ['user_id', 'track_id', 'created_at', 'pinned_at'],
  music_history: [
    'user_id', 'id', 'track_id', 'played_at', 'duration_played', 'completed', 'context_type',
    'context_id',
  ],
  music_recent: [
    'user_id', 'id', 'kind', 'provider_id', 'name', 'cover_url', 'last_played_at', 'play_count',
  ],
  music_download: [
    'user_id', 'id', 'track_id', 'quality', 'format', 'status', 'progress', 'size', 'r2_key',
    'error', 'attempts', 'created_at', 'updated_at', 'completed_at',
  ],
  music_object: ['user_id', 'r2_key', 'track_id', 'format', 'quality', 'size', 'sha256', 'created_at'],
  music_upload: [
    'user_id', 'id', 'filename', 'mime', 'size', 'format', 'status', 'r2_key', 'track_id',
    'cover_key', 'metadata_json', 'upload_id', 'parts_json', 'error', 'created_at', 'updated_at',
  ],
  music_lyric: ['user_id', 'track_key', 'source', 'lrc', 'tlyric', 'yrc', 'fetched_at'],
  music_lyric_ai: [
    'user_id', 'track_key', 'kind', 'lang', 'source_hash', 'payload', 'model', 'created_at',
    'updated_at',
  ],
  music_account: [
    'user_id', 'provider', 'account_id', 'nickname', 'avatar_url', 'cookie_ciphertext', 'status',
    'updated_at',
  ],
  music_mount: [
    'user_id', 'id', 'kind', 'name', 'base_url', 'root_path', 'secret', 'status', 'created_at',
    'updated_at',
  ],
  music_setting: ['user_id', 'settings', 'updated_at'],
  music_source_override: ['user_id', 'track_key', 'source', 'config', 'updated_at'],
  music_subscription: ['user_id', 'id', 'kind', 'provider_id', 'name', 'cover_url', 'created_at'],
  music_cleanup: ['object_key', 'user_id', 'created_at'],
}
