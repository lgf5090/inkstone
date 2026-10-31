/**
 * D1 schema statements and invariants for the Short Links tool (`tools_shortlinks_*`).
 */

export const TOOLS_SHORTLINKS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_shortlinks_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    label TEXT,
    password_hash TEXT DEFAULT NULL,
    is_password_protected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    created_via TEXT DEFAULT 'app',
    created_by TEXT DEFAULT 'user'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_links_user 
    ON tools_shortlinks_links(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_links_url 
    ON tools_shortlinks_links(user_id, url)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_slugs (
    slug TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL,
    link_id INTEGER NOT NULL REFERENCES tools_shortlinks_links(id) ON DELETE CASCADE,
    is_custom INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_slugs_user 
    ON tools_shortlinks_slugs(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_slugs_link 
    ON tools_shortlinks_slugs(user_id, link_id)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    slug TEXT NOT NULL REFERENCES tools_shortlinks_slugs(slug) ON DELETE CASCADE,
    clicked_at INTEGER NOT NULL,
    referrer TEXT,
    referrer_host TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    device_type TEXT,
    os TEXT,
    browser TEXT,
    language TEXT,
    link_mode TEXT DEFAULT 'link',
    channel TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    user_agent TEXT,
    is_bot INTEGER DEFAULT 0,
    visitor_fp TEXT,
    is_self_referrer INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_user_time 
    ON tools_shortlinks_clicks(user_id, clicked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_link_time 
    ON tools_shortlinks_clicks(user_id, link_id, clicked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_slug_time 
    ON tools_shortlinks_clicks(user_id, slug, clicked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_country 
    ON tools_shortlinks_clicks(user_id, country)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_refhost 
    ON tools_shortlinks_clicks(user_id, referrer_host)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_clicks_device 
    ON tools_shortlinks_clicks(user_id, device_type)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    accent TEXT NOT NULL DEFAULT 'orange' CHECK (accent IN ('orange','red','green','blue','purple')),
    archived_at INTEGER,
    created_via TEXT DEFAULT 'app',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_bundles_user 
    ON tools_shortlinks_bundles(user_id, archived_at, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_bundle_links (
    user_id TEXT NOT NULL,
    bundle_id INTEGER NOT NULL REFERENCES tools_shortlinks_bundles(id) ON DELETE CASCADE,
    link_id INTEGER NOT NULL REFERENCES tools_shortlinks_links(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, bundle_id, link_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_bundle_links_link 
    ON tools_shortlinks_bundle_links(user_id, link_id)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_settings (
    user_id TEXT NOT NULL PRIMARY KEY,
    slug_default_length INTEGER NOT NULL DEFAULT 6,
    default_range TEXT NOT NULL DEFAULT '30d',
    filter_bots INTEGER NOT NULL DEFAULT 1,
    filter_self_referrers INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_password_attempts (
    bucket TEXT NOT NULL PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL DEFAULT 'read,write',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_api_keys_user 
    ON tools_shortlinks_api_keys(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_api_keys_hash 
    ON tools_shortlinks_api_keys(key_hash)`,

  `CREATE TABLE IF NOT EXISTS tools_shortlinks_backups (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_shortlinks_backups_user 
    ON tools_shortlinks_backups(user_id, created_at DESC)`,
]

export const TOOLS_SHORTLINKS_REQUIRED_TABLES: readonly string[] = [
  'tools_shortlinks_links',
  'tools_shortlinks_slugs',
  'tools_shortlinks_clicks',
  'tools_shortlinks_bundles',
  'tools_shortlinks_bundle_links',
  'tools_shortlinks_settings',
  'tools_shortlinks_password_attempts',
  'tools_shortlinks_api_keys',
  'tools_shortlinks_backups',
]

export const TOOLS_SHORTLINKS_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_shortlinks_links_user',
  'idx_tools_shortlinks_links_url',
  'idx_tools_shortlinks_slugs_user',
  'idx_tools_shortlinks_slugs_link',
  'idx_tools_shortlinks_clicks_user_time',
  'idx_tools_shortlinks_clicks_link_time',
  'idx_tools_shortlinks_clicks_slug_time',
  'idx_tools_shortlinks_clicks_country',
  'idx_tools_shortlinks_clicks_refhost',
  'idx_tools_shortlinks_clicks_device',
  'idx_tools_shortlinks_bundles_user',
  'idx_tools_shortlinks_bundle_links_link',
  'idx_tools_shortlinks_api_keys_user',
  'idx_tools_shortlinks_api_keys_hash',
  'idx_tools_shortlinks_backups_user',
]

export const TOOLS_SHORTLINKS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_shortlinks_links: [
    'id',
    'user_id',
    'url',
    'label',
    'password_hash',
    'is_password_protected',
    'created_at',
    'expires_at',
    'created_via',
    'created_by',
  ],
  tools_shortlinks_slugs: [
    'slug',
    'user_id',
    'link_id',
    'is_custom',
    'is_primary',
    'created_at',
    'disabled_at',
  ],
  tools_shortlinks_clicks: [
    'id',
    'user_id',
    'link_id',
    'slug',
    'clicked_at',
    'country',
    'device_type',
    'os',
    'browser',
  ],
  tools_shortlinks_bundles: [
    'id',
    'user_id',
    'name',
    'accent',
    'created_at',
    'updated_at',
  ],
  tools_shortlinks_bundle_links: [
    'user_id',
    'bundle_id',
    'link_id',
    'added_at',
  ],
  tools_shortlinks_settings: [
    'user_id',
    'slug_default_length',
    'default_range',
    'filter_bots',
    'filter_self_referrers',
    'updated_at',
  ],
  tools_shortlinks_api_keys: [
    'id',
    'user_id',
    'title',
    'key_prefix',
    'key_hash',
    'scope',
    'created_at',
  ],
  tools_shortlinks_backups: [
    'user_id',
    'id',
    'filename',
    'r2_key',
    'size',
    'created_at',
  ],
}
