export const DEVELOPMENT_GITHUB_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_github_tags (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    parent_id  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_tags_user_parent
     ON development_github_tags(user_id, parent_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS development_github_repos (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    full_name  TEXT NOT NULL,
    url        TEXT NOT NULL DEFAULT '',
    data_json  TEXT NOT NULL DEFAULT '{}',
    tag_ids    TEXT NOT NULL DEFAULT '[]',
    pinned     INTEGER NOT NULL DEFAULT 0,
    favorited  INTEGER NOT NULL DEFAULT 0,
    notes      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_repos_user_updated
     ON development_github_repos(user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_github_gist_tags (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    parent_id  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_gist_tags_user_parent
     ON development_github_gist_tags(user_id, parent_id, sort_order, created_at)`,

  `CREATE TABLE IF NOT EXISTS development_github_gists (
    user_id     TEXT NOT NULL,
    id          TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    data_json   TEXT NOT NULL DEFAULT '{}',
    tag_ids     TEXT NOT NULL DEFAULT '[]',
    pinned      INTEGER NOT NULL DEFAULT 0,
    favorited   INTEGER NOT NULL DEFAULT 0,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_gists_user_updated
     ON development_github_gists(user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_github_accounts (
    user_id          TEXT NOT NULL,
    id               TEXT NOT NULL,
    username         TEXT NOT NULL,
    avatar_url       TEXT NOT NULL DEFAULT '',
    token_ciphertext TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_development_github_accounts_user_name
     ON development_github_accounts(user_id, username)`,

  `CREATE TABLE IF NOT EXISTS development_github_mirrors (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_mirrors_user_created
     ON development_github_mirrors(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS development_github_exports (
    user_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    filename   TEXT NOT NULL,
    format     TEXT NOT NULL,
    r2_key     TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_github_exports_user_created
     ON development_github_exports(user_id, created_at DESC)`,
]

export const DEVELOPMENT_GITHUB_REQUIRED_TABLES: readonly string[] = [
  'development_github_tags',
  'development_github_repos',
  'development_github_gist_tags',
  'development_github_gists',
  'development_github_accounts',
  'development_github_mirrors',
  'development_github_exports',
]

export const DEVELOPMENT_GITHUB_REQUIRED_INDEXES: readonly string[] = [
  'idx_development_github_tags_user_parent',
  'idx_development_github_repos_user_updated',
  'idx_development_github_gist_tags_user_parent',
  'idx_development_github_gists_user_updated',
  'idx_development_github_accounts_user_name',
  'idx_development_github_mirrors_user_created',
  'idx_development_github_exports_user_created',
]

export const DEVELOPMENT_GITHUB_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_github_tags: ['user_id', 'id', 'name', 'color', 'parent_id', 'sort_order', 'created_at', 'updated_at'],
  development_github_repos: ['user_id', 'id', 'full_name', 'url', 'data_json', 'tag_ids', 'pinned', 'favorited', 'notes', 'created_at', 'updated_at'],
  development_github_gist_tags: ['user_id', 'id', 'name', 'color', 'parent_id', 'sort_order', 'created_at', 'updated_at'],
  development_github_gists: ['user_id', 'id', 'description', 'url', 'data_json', 'tag_ids', 'pinned', 'favorited', 'notes', 'created_at', 'updated_at'],
  development_github_accounts: ['user_id', 'id', 'username', 'avatar_url', 'token_ciphertext', 'created_at', 'updated_at'],
  development_github_mirrors: ['user_id', 'id', 'name', 'url', 'enabled', 'created_at', 'updated_at'],
  development_github_exports: ['user_id', 'id', 'filename', 'format', 'r2_key', 'size', 'created_at'],
}
