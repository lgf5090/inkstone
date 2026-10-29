/**
 * The YouTube app's D1 tables. Every library row is scoped to one account; the quota ledger is
 * instance-wide because the API key it accounts for belongs to the deployment, not to a reader.
 *
 * All of these are new tables, so they ride in `SCHEMA_STATEMENTS` and need no numbered migration.
 */
export const YOUTUBE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS youtube_tags (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_tags_user_parent
     ON youtube_tags(user_id, parent_id)`,

  `CREATE TABLE IF NOT EXISTS youtube_videos (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    tag_ids TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_videos_user_pinned
     ON youtube_videos(user_id, pinned, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_videos_user_fav
     ON youtube_videos(user_id, favorited, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_videos_user_channel
     ON youtube_videos(user_id, channel_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS youtube_channels (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    tag_ids TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_channels_user_pinned
     ON youtube_channels(user_id, pinned, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS youtube_playlists (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    tag_ids TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    favorited INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_playlists_user_pinned
     ON youtube_playlists(user_id, pinned, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_playlists_user_fav
     ON youtube_playlists(user_id, favorited, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS youtube_settings (
    id TEXT PRIMARY KEY CHECK (id = 'instance'),
    api_key_ciphertext TEXT NOT NULL DEFAULT '',
    region_code TEXT NOT NULL DEFAULT '',
    daily_quota INTEGER,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS youtube_quota_usage (
    date TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, endpoint)
  )`,
]

export const YOUTUBE_REQUIRED_TABLES = [
  'youtube_tags',
  'youtube_videos',
  'youtube_channels',
  'youtube_playlists',
  'youtube_quota_usage',
  'youtube_settings',
] as const

export const YOUTUBE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  youtube_tags: ['user_id', 'id', 'name', 'color', 'parent_id', 'sort_order', 'pinned', 'created_at'],
  youtube_videos: [
    'user_id', 'id', 'title', 'thumbnail_url', 'channel_id', 'channel_title',
    'data_json', 'tag_ids', 'pinned', 'favorited', 'notes', 'created_at', 'updated_at',
  ],
  youtube_channels: ['user_id', 'id', 'data_json', 'tag_ids', 'pinned', 'sort_order', 'notes', 'created_at', 'updated_at'],
  youtube_playlists: [
    'user_id', 'id', 'data_json', 'tag_ids', 'pinned', 'favorited', 'sort_order', 'notes', 'created_at', 'updated_at',
  ],
  youtube_quota_usage: ['date', 'endpoint', 'units', 'count'],
  youtube_settings: ['id', 'api_key_ciphertext', 'region_code', 'daily_quota', 'updated_at'],
}

export const YOUTUBE_REQUIRED_INDEXES = [
  'idx_youtube_tags_user_parent',
  'idx_youtube_videos_user_pinned',
  'idx_youtube_videos_user_fav',
  'idx_youtube_videos_user_channel',
  'idx_youtube_channels_user_pinned',
  'idx_youtube_playlists_user_pinned',
  'idx_youtube_playlists_user_fav',
] as const
