/**
 * D1 schema for ScriptsHub (`scriptshub_*`).
 *
 * Snippet bodies live here, one row per file, because the search has to reach them with SQL; only
 * uploaded images and binaries go to R2, and those rows hold the object key. Every table carries the
 * account it belongs to in its primary key or in every index that reads it, so a missing `user_id`
 * predicate is a bug rather than a cross-account leak.
 */

export const SCRIPTSHUB_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS scriptshub_folders (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    icon TEXT,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_folders_user_parent
     ON scriptshub_folders(user_id, parent_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_tags (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_tags_user_parent
     ON scriptshub_tags(user_id, parent_id, name)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_snippets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    folder_id TEXT,
    language TEXT NOT NULL DEFAULT 'shell',
    source_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_deprecated INTEGER NOT NULL DEFAULT 0,
    copy_count INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippets_user_updated
     ON scriptshub_snippets(user_id, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippets_user_folder
     ON scriptshub_snippets(user_id, folder_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippets_user_favorite
     ON scriptshub_snippets(user_id, is_favorite, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippets_user_pinned
     ON scriptshub_snippets(user_id, is_pinned, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippets_user_title
     ON scriptshub_snippets(user_id, title)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_files (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_files_user_snippet
     ON scriptshub_files(user_id, snippet_id, position, created_at)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_snippet_tags (
    user_id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (user_id, snippet_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_snippet_tags_user_tag
     ON scriptshub_snippet_tags(user_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_revisions (
    user_id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    files_json TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    diff_stat TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'save',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, snippet_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_revisions_user_snippet
     ON scriptshub_revisions(user_id, snippet_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_revisions_user_created
     ON scriptshub_revisions(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_assets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_assets_user_snippet
     ON scriptshub_assets(user_id, snippet_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_publications (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    path TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'token')),
    token_hash TEXT,
    expires_at INTEGER,
    short_slug TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_served_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_scriptshub_publications_path
     ON scriptshub_publications(path)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_publications_user_snippet
     ON scriptshub_publications(user_id, snippet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_publications_user_created
     ON scriptshub_publications(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_events (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    publication_id TEXT,
    snippet_id TEXT,
    kind TEXT NOT NULL,
    status INTEGER NOT NULL,
    at INTEGER NOT NULL,
    visitor_fp TEXT,
    ua_family TEXT,
    device_type TEXT,
    referrer_host TEXT,
    country TEXT,
    path TEXT,
    revision INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_events_user_at
     ON scriptshub_events(user_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_events_pub_at
     ON scriptshub_events(publication_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_events_user_kind_at
     ON scriptshub_events(user_id, kind, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_events_user_visitor
     ON scriptshub_events(user_id, visitor_fp, at DESC)`,

  `CREATE TABLE IF NOT EXISTS scriptshub_copy_events (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    file_id TEXT,
    surface TEXT NOT NULL DEFAULT 'app',
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_copy_events_user_at
     ON scriptshub_copy_events(user_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scriptshub_copy_events_user_snippet
     ON scriptshub_copy_events(user_id, snippet_id, at DESC)`,
]

export const SCRIPTSHUB_REQUIRED_TABLES: readonly string[] = [
  'scriptshub_folders',
  'scriptshub_tags',
  'scriptshub_snippets',
  'scriptshub_files',
  'scriptshub_snippet_tags',
  'scriptshub_revisions',
  'scriptshub_assets',
  'scriptshub_publications',
  'scriptshub_events',
  'scriptshub_copy_events',
]

export const SCRIPTSHUB_REQUIRED_INDEXES: readonly string[] = [
  'idx_scriptshub_folders_user_parent',
  'idx_scriptshub_tags_user_parent',
  'idx_scriptshub_snippets_user_updated',
  'idx_scriptshub_snippets_user_folder',
  'idx_scriptshub_snippets_user_favorite',
  'idx_scriptshub_snippets_user_pinned',
  'idx_scriptshub_snippets_user_title',
  'idx_scriptshub_files_user_snippet',
  'idx_scriptshub_snippet_tags_user_tag',
  'idx_scriptshub_revisions_user_snippet',
  'idx_scriptshub_revisions_user_created',
  'idx_scriptshub_assets_user_snippet',
  'idx_scriptshub_publications_path',
  'idx_scriptshub_publications_user_snippet',
  'idx_scriptshub_publications_user_created',
  'idx_scriptshub_events_user_at',
  'idx_scriptshub_events_pub_at',
  'idx_scriptshub_events_user_kind_at',
  'idx_scriptshub_events_user_visitor',
  'idx_scriptshub_copy_events_user_at',
  'idx_scriptshub_copy_events_user_snippet',
]

export const SCRIPTSHUB_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  scriptshub_folders: ['user_id', 'id', 'parent_id', 'name', 'position', 'icon', 'color', 'created_at', 'updated_at'],
  scriptshub_tags: ['user_id', 'id', 'name', 'parent_id', 'color', 'created_at', 'updated_at'],
  scriptshub_snippets: [
    'user_id', 'id', 'title', 'description', 'folder_id', 'language', 'source_url', 'notes',
    'is_favorite', 'is_pinned', 'is_deprecated', 'copy_count', 'download_count', 'rev',
    'created_at', 'updated_at', 'last_used_at',
  ],
  scriptshub_files: ['user_id', 'id', 'snippet_id', 'name', 'language', 'content', 'position', 'created_at', 'updated_at'],
  scriptshub_snippet_tags: ['user_id', 'snippet_id', 'tag_id'],
  scriptshub_revisions: ['user_id', 'snippet_id', 'version', 'title', 'description', 'files_json', 'file_count', 'char_count', 'diff_stat', 'source', 'created_at'],
  scriptshub_assets: ['user_id', 'id', 'snippet_id', 'file_name', 'content_type', 'byte_size', 'r2_key', 'created_at'],
  scriptshub_publications: [
    'user_id', 'id', 'snippet_id', 'file_id', 'path', 'is_enabled', 'visibility',
    'token_hash', 'expires_at', 'short_slug', 'created_at', 'updated_at', 'last_served_at',
  ],
  scriptshub_events: ['id', 'user_id', 'publication_id', 'snippet_id', 'kind', 'status', 'at', 'visitor_fp', 'ua_family', 'device_type', 'referrer_host', 'country', 'path', 'revision'],
  scriptshub_copy_events: ['id', 'user_id', 'snippet_id', 'file_id', 'surface', 'at'],
}
