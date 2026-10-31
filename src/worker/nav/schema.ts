export const NAV_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS nav_categories (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'folder',
    parent_id TEXT,
    password_hash TEXT,
    use_default_password INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'normal',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_categories_user
     ON nav_categories(user_id, parent_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS nav_links (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    icon TEXT,
    description TEXT,
    category_id TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    pinned_order INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_links_user_cat
     ON nav_links(user_id, category_id, sort_order, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_nav_links_user_pin
     ON nav_links(user_id, pinned, pinned_order)`,
  `CREATE INDEX IF NOT EXISTS idx_nav_links_category
     ON nav_links(category_id)`,

  `CREATE TABLE IF NOT EXISTS nav_link_visits (
    user_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    last_visited_at INTEGER NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, link_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_visits_user_time
     ON nav_link_visits(user_id, last_visited_at DESC)`,

  `CREATE TABLE IF NOT EXISTS nav_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,

  `CREATE TABLE IF NOT EXISTS nav_icons (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    source TEXT NOT NULL,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_icons_user
     ON nav_icons(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS nav_favicons (
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    icon TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, domain)
  )`,

  `CREATE TABLE IF NOT EXISTS nav_category_unlocks (
    user_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, category_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nav_unlocks_expiry
     ON nav_category_unlocks(expires_at)`,

  `CREATE TABLE IF NOT EXISTS nav_secrets (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]

export const NAV_REQUIRED_TABLES = [
  'nav_categories',
  'nav_links',
  'nav_link_visits',
  'nav_settings',
  'nav_icons',
  'nav_favicons',
  'nav_category_unlocks',
  'nav_secrets',
] as const

export const NAV_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  nav_categories: ['id', 'user_id', 'name', 'icon', 'parent_id', 'password_hash', 'use_default_password', 'sort_order', 'kind', 'created_at', 'updated_at'],
  nav_links: ['id', 'user_id', 'title', 'url', 'icon', 'description', 'category_id', 'pinned', 'pinned_order', 'sort_order', 'created_at', 'updated_at'],
  nav_link_visits: ['user_id', 'link_id', 'last_visited_at', 'visit_count'],
  nav_settings: ['user_id', 'key', 'value', 'updated_at'],
  nav_icons: ['id', 'user_id', 'object_key', 'content_type', 'byte_size', 'width', 'height', 'source', 'source_url', 'created_at'],
  nav_favicons: ['user_id', 'domain', 'icon', 'updated_at'],
  nav_category_unlocks: ['user_id', 'category_id', 'token_hash', 'expires_at', 'created_at'],
  nav_secrets: ['user_id', 'key', 'ciphertext', 'hint', 'updated_at'],
}

export const NAV_REQUIRED_INDEXES = [
  'idx_nav_categories_user',
  'idx_nav_links_user_cat',
  'idx_nav_links_user_pin',
  'idx_nav_links_category',
  'idx_nav_visits_user_time',
  'idx_nav_icons_user',
  'idx_nav_unlocks_expiry',
] as const
