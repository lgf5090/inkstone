/** Blog tables, indexes and the required-shape lists the schema convergence repair reads. */
export const BLOG_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS blog_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_settings_user
     ON blog_settings(user_id)`,

  `CREATE TABLE IF NOT EXISTS blog_posts (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    category_id TEXT,
    series_id TEXT,
    series_order INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    pinned INTEGER NOT NULL DEFAULT 0,
    comments_enabled INTEGER NOT NULL DEFAULT 1,
    language TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL DEFAULT '{}',
    encrypted INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_hint TEXT NOT NULL DEFAULT '',
    hide_home_content INTEGER NOT NULL DEFAULT 1,
    alias TEXT NOT NULL DEFAULT '',
    permalink TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    reading_minutes INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    render_key TEXT,
    render_hash TEXT NOT NULL DEFAULT '',
    renderer_version TEXT NOT NULL DEFAULT '',
    render_status TEXT NOT NULL DEFAULT 'missing',
    render_generated_at INTEGER,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_posts_user_note
     ON blog_posts(user_id, note_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_posts_user_slug
     ON blog_posts(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_status
     ON blog_posts(user_id, status, published_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_category
     ON blog_posts(user_id, category_id, status, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_series
     ON blog_posts(user_id, series_id, series_order, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_pinned
     ON blog_posts(user_id, status, pinned DESC, published_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_render
     ON blog_posts(user_id, render_status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_updated
     ON blog_posts(user_id, updated_at DESC, id)`,

  `CREATE TABLE IF NOT EXISTS blog_categories (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_categories_user_slug
     ON blog_categories(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_categories_user_position
     ON blog_categories(user_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS blog_tags (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_tags_user_slug
     ON blog_tags(user_id, slug)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_tags_user_name
     ON blog_tags(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_tags_user_position
     ON blog_tags(user_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS blog_post_tags (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, post_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_post_tags_post
     ON blog_post_tags(user_id, post_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_post_tags_tag
     ON blog_post_tags(user_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS blog_series (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    overview TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    status TEXT NOT NULL DEFAULT 'ongoing',
    default_category_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_series_user_slug
     ON blog_series(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_series_user_position
     ON blog_series(user_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS blog_moments (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT '',
    mood TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    published_at INTEGER NOT NULL,
    draft INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_moments_user_published
     ON blog_moments(user_id, published_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_moments_user_pinned
     ON blog_moments(user_id, pinned DESC, published_at DESC)`,

  `CREATE TABLE IF NOT EXISTS blog_albums (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    date TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    layout TEXT NOT NULL DEFAULT 'grid',
    columns INTEGER NOT NULL DEFAULT 3,
    password_hash TEXT,
    password_hint TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_albums_user_slug
     ON blog_albums(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_albums_user_position
     ON blog_albums(user_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS blog_photos (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    alt TEXT NOT NULL DEFAULT '',
    taken_at TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_photos_album
     ON blog_photos(album_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_photos_user
     ON blog_photos(user_id, album_id)`,

  `CREATE TABLE IF NOT EXISTS blog_friends (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    avatar_asset_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_friends_user_position
     ON blog_friends(user_id, position, name)`,

  `CREATE TABLE IF NOT EXISTS blog_projects (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL DEFAULT '',
    technologies TEXT NOT NULL DEFAULT '[]',
    icon TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    featured INTEGER NOT NULL DEFAULT 0,
    repository TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_projects_user_key
     ON blog_projects(user_id, key)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_projects_user_position
     ON blog_projects(user_id, position, title)`,

  `CREATE TABLE IF NOT EXISTS blog_skills (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    level INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_skills_user_position
     ON blog_skills(user_id, position, name)`,

  `CREATE TABLE IF NOT EXISTS blog_devices (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    specs TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    year TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_devices_user_position
     ON blog_devices(user_id, position, name)`,

  `CREATE TABLE IF NOT EXISTS blog_games (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    developer TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    cover_asset_id TEXT,
    icon TEXT NOT NULL DEFAULT '',
    rating REAL,
    hours REAL,
    platform TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_games_user_position
     ON blog_games(user_id, position, name)`,

  `CREATE TABLE IF NOT EXISTS blog_anime (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    cover_asset_id TEXT,
    cover_url TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    rating REAL,
    watched INTEGER,
    total INTEGER,
    year TEXT NOT NULL DEFAULT '',
    studio TEXT NOT NULL DEFAULT '',
    genres TEXT NOT NULL DEFAULT '[]',
    period_start TEXT NOT NULL DEFAULT '',
    period_end TEXT NOT NULL DEFAULT '',
    identity TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_anime_user_position
     ON blog_anime(user_id, position, title)`,

  `CREATE TABLE IF NOT EXISTS blog_compass_shelves (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    blurb TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_compass_shelves_user_key
     ON blog_compass_shelves(user_id, key)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_compass_shelves_user_position
     ON blog_compass_shelves(user_id, position, name)`,

  `CREATE TABLE IF NOT EXISTS blog_compass_entries (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    shelf_id TEXT NOT NULL,
    label TEXT NOT NULL,
    href TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_compass_entries_shelf
     ON blog_compass_entries(shelf_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_compass_entries_user
     ON blog_compass_entries(user_id, shelf_id)`,

  `CREATE TABLE IF NOT EXISTS blog_timeline (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    highlights TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    links TEXT NOT NULL DEFAULT '[]',
    icon TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_timeline_user_position
     ON blog_timeline(user_id, position, date)`,

  `CREATE TABLE IF NOT EXISTS blog_pages (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'custom',
    body TEXT NOT NULL DEFAULT '',
    note_id TEXT,
    published_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_pages_user_slug
     ON blog_pages(user_id, slug)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_pages_user_note
     ON blog_pages(user_id, note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_posts_user_published
     ON blog_posts(user_id, published_at DESC, id)`,

  `CREATE TABLE IF NOT EXISTS blog_assets (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_key TEXT NOT NULL,
    variants TEXT NOT NULL DEFAULT '[]',
    filename TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_assets_user_hash
     ON blog_assets(user_id, hash, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_assets_user_created
     ON blog_assets(user_id, created_at DESC, id)`,

  `CREATE TABLE IF NOT EXISTS blog_post_assets (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id, asset_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_post_assets_post
     ON blog_post_assets(user_id, post_id)`,

  `CREATE TABLE IF NOT EXISTS blog_redirects (
    user_id TEXT NOT NULL,
    from_slug TEXT NOT NULL,
    to_slug TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 301,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, from_slug)
  )`,

  `CREATE TABLE IF NOT EXISTS blog_preview_tokens (
    token_hash TEXT NOT NULL,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, token_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_preview_tokens_expiry
     ON blog_preview_tokens(expires_at)`,

  `CREATE TABLE IF NOT EXISTS blog_tasks (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload TEXT NOT NULL DEFAULT '{}',
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_tasks_user_status
     ON blog_tasks(user_id, status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS blog_visit_daily (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,

  `CREATE TABLE IF NOT EXISTS blog_audit (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_audit_user_created
     ON blog_audit(user_id, created_at DESC, id)`,
]

export const BLOG_COMMENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS blog_comments (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    parent_id TEXT,
    author_name TEXT NOT NULL,
    author_email_hash TEXT NOT NULL DEFAULT '',
    author_url TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    ip_hash TEXT NOT NULL DEFAULT '',
    user_agent_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blog_comments_post
     ON blog_comments(user_id, post_id, status, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_comments_status
     ON blog_comments(user_id, status, created_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_blog_comments_parent
     ON blog_comments(user_id, parent_id)`,
]

export const BLOG_ALL_SCHEMA_STATEMENTS: readonly string[] = [
  ...BLOG_SCHEMA_STATEMENTS,
  ...BLOG_COMMENT_SCHEMA_STATEMENTS,
]

export const BLOG_REQUIRED_TABLES = [
  'blog_settings',
  'blog_posts',
  'blog_categories',
  'blog_tags',
  'blog_post_tags',
  'blog_series',
  'blog_moments',
  'blog_albums',
  'blog_photos',
  'blog_friends',
  'blog_projects',
  'blog_skills',
  'blog_devices',
  'blog_games',
  'blog_anime',
  'blog_compass_shelves',
  'blog_compass_entries',
  'blog_timeline',
  'blog_pages',
  'blog_assets',
  'blog_post_assets',
  'blog_redirects',
  'blog_preview_tokens',
  'blog_tasks',
  'blog_visit_daily',
  'blog_audit',
  'blog_comments',
] as const

export const BLOG_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  blog_settings: ['user_id', 'key', 'value', 'updated_at'],
  blog_posts: [
    'id', 'user_id', 'note_id', 'slug', 'title', 'excerpt', 'description', 'cover_asset_id',
    'category_id', 'series_id', 'series_order', 'status', 'pinned', 'comments_enabled', 'language',
    'license', 'encrypted', 'password_hash', 'password_hint', 'hide_home_content', 'alias',
    'permalink', 'word_count', 'reading_minutes', 'view_count', 'content_hash', 'render_key',
    'render_hash', 'renderer_version', 'render_status', 'render_generated_at', 'published_at',
    'created_at', 'updated_at', 'deleted_at',
  ],
  blog_categories: ['id', 'user_id', 'name', 'slug', 'description', 'position', 'created_at', 'updated_at'],
  blog_tags: ['id', 'user_id', 'name', 'slug', 'color', 'position', 'created_at'],
  blog_post_tags: ['user_id', 'post_id', 'tag_id', 'position'],
  blog_series: ['id', 'user_id', 'slug', 'title', 'description', 'overview', 'cover_asset_id', 'status', 'default_category_id', 'position', 'created_at', 'updated_at'],
  blog_moments: ['id', 'user_id', 'content', 'pinned', 'location', 'mood', 'images', 'tags', 'published_at', 'draft', 'created_at', 'updated_at', 'deleted_at'],
  blog_albums: ['id', 'user_id', 'slug', 'title', 'description', 'cover_asset_id', 'date', 'location', 'tags', 'layout', 'columns', 'password_hash', 'password_hint', 'position', 'published_at', 'created_at', 'updated_at'],
  blog_photos: ['id', 'user_id', 'album_id', 'asset_id', 'caption', 'alt', 'taken_at', 'position'],
  blog_friends: ['id', 'user_id', 'name', 'url', 'avatar_asset_id', 'description', 'tags', 'position', 'enabled'],
  blog_projects: ['id', 'user_id', 'key', 'title', 'summary', 'category', 'phase', 'technologies', 'icon', 'cover_asset_id', 'featured', 'repository', 'year', 'position'],
  blog_skills: ['id', 'user_id', 'name', 'description', 'icon', 'category', 'level', 'position'],
  blog_devices: ['id', 'user_id', 'name', 'brand', 'category', 'status', 'specs', 'description', 'icon', 'featured', 'year', 'link', 'position'],
  blog_games: ['id', 'user_id', 'name', 'developer', 'category', 'status', 'cover_asset_id', 'icon', 'rating', 'hours', 'platform', 'year', 'tags', 'description', 'link', 'featured', 'position'],
  blog_anime: ['id', 'user_id', 'title', 'cover_asset_id', 'cover_url', 'link', 'status', 'rating', 'watched', 'total', 'year', 'studio', 'genres', 'period_start', 'period_end', 'identity', 'position'],
  blog_compass_shelves: ['id', 'user_id', 'key', 'name', 'icon', 'blurb', 'position'],
  blog_compass_entries: ['id', 'user_id', 'shelf_id', 'label', 'href', 'note', 'icon', 'image', 'position'],
  blog_timeline: ['id', 'user_id', 'title', 'date', 'category', 'subtitle', 'description', 'highlights', 'tags', 'links', 'icon', 'featured', 'position'],
  blog_pages: ['id', 'user_id', 'slug', 'title', 'kind', 'body', 'note_id', 'published_at', 'updated_at'],
  blog_assets: ['id', 'user_id', 'kind', 'object_key', 'variants', 'filename', 'mime', 'size', 'width', 'height', 'hash', 'created_at'],
  blog_post_assets: ['user_id', 'post_id', 'asset_id', 'source_ref', 'created_at'],
  blog_redirects: ['user_id', 'from_slug', 'to_slug', 'status', 'created_at'],
  blog_preview_tokens: ['token_hash', 'user_id', 'post_id', 'expires_at'],
  blog_tasks: ['id', 'user_id', 'type', 'status', 'payload', 'progress', 'error', 'created_at', 'started_at', 'finished_at'],
  blog_visit_daily: ['user_id', 'day', 'views', 'visitors'],
  blog_audit: ['id', 'user_id', 'action', 'entity', 'entity_id', 'detail', 'created_at'],
  blog_comments: ['id', 'user_id', 'post_id', 'parent_id', 'author_name', 'author_email_hash', 'author_url', 'content', 'status', 'ip_hash', 'user_agent_hash', 'created_at', 'updated_at', 'deleted_at'],
}

export const BLOG_REQUIRED_INDEXES = [
  'idx_blog_settings_user',
  'idx_blog_posts_user_note',
  'idx_blog_posts_user_slug',
  'idx_blog_posts_user_status',
  'idx_blog_posts_user_category',
  'idx_blog_posts_user_series',
  'idx_blog_posts_user_pinned',
  'idx_blog_posts_user_render',
  'idx_blog_posts_user_updated',
  'idx_blog_categories_user_slug',
  'idx_blog_categories_user_position',
  'idx_blog_tags_user_slug',
  'idx_blog_tags_user_name',
  'idx_blog_tags_user_position',
  'idx_blog_post_tags_post',
  'idx_blog_post_tags_tag',
  'idx_blog_series_user_slug',
  'idx_blog_series_user_position',
  'idx_blog_moments_user_published',
  'idx_blog_moments_user_pinned',
  'idx_blog_albums_user_slug',
  'idx_blog_albums_user_position',
  'idx_blog_photos_album',
  'idx_blog_photos_user',
  'idx_blog_friends_user_position',
  'idx_blog_projects_user_key',
  'idx_blog_projects_user_position',
  'idx_blog_skills_user_position',
  'idx_blog_devices_user_position',
  'idx_blog_games_user_position',
  'idx_blog_anime_user_position',
  'idx_blog_compass_shelves_user_key',
  'idx_blog_compass_shelves_user_position',
  'idx_blog_compass_entries_shelf',
  'idx_blog_compass_entries_user',
  'idx_blog_timeline_user_position',
  'idx_blog_pages_user_slug',
  'idx_blog_pages_user_note',
  'idx_blog_posts_user_published',
  'idx_blog_assets_user_hash',
  'idx_blog_assets_user_created',
  'idx_blog_post_assets_post',
  'idx_blog_preview_tokens_expiry',
  'idx_blog_tasks_user_status',
  'idx_blog_audit_user_created',
  'idx_blog_comments_post',
  'idx_blog_comments_status',
  'idx_blog_comments_parent',
] as const
