/**
 * D1 schema statements and invariants for the Password Manager tool (`tools_password_*`).
 */

export const TOOLS_PASSWORD_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools_password_vault (
    user_id TEXT NOT NULL,
    master_hash TEXT NOT NULL,
    kdf_salt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS tools_password_groups (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_password_groups_user
     ON tools_password_groups(user_id, sort ASC, id)`,

  `CREATE TABLE IF NOT EXISTS tools_password_accounts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    totp_secret TEXT NOT NULL DEFAULT '',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_password_accounts_group
     ON tools_password_accounts(user_id, group_id, sort ASC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_tools_password_accounts_fav
     ON tools_password_accounts(user_id, is_favorite, sort ASC, id)`,
  // The whole-vault list sorts by `user_id, sort` with no group filter; neither index above leads
  // with that pair, so unlock used to scan and sort the table every time.
  `CREATE INDEX IF NOT EXISTS idx_tools_password_accounts_user
     ON tools_password_accounts(user_id, sort ASC, id)`,

  `CREATE TABLE IF NOT EXISTS tools_password_settings (
    user_id TEXT NOT NULL,
    auto_lock_minutes INTEGER NOT NULL DEFAULT 5,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS tools_password_backups (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_password_backups_user
     ON tools_password_backups(user_id, created_at DESC)`,
]

export const TOOLS_PASSWORD_REQUIRED_TABLES: readonly string[] = [
  'tools_password_vault',
  'tools_password_groups',
  'tools_password_accounts',
  'tools_password_settings',
  'tools_password_backups',
]

export const TOOLS_PASSWORD_REQUIRED_INDEXES: readonly string[] = [
  'idx_tools_password_groups_user',
  'idx_tools_password_accounts_group',
  'idx_tools_password_accounts_fav',
  'idx_tools_password_accounts_user',
  'idx_tools_password_backups_user',
]

export const TOOLS_PASSWORD_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tools_password_vault: [
    'user_id',
    'master_hash',
    'kdf_salt',
    'created_at',
    'updated_at',
  ],
  tools_password_groups: [
    'user_id',
    'id',
    'name',
    'parent_id',
    'icon',
    'sort',
    'created_at',
    'updated_at',
  ],
  tools_password_accounts: [
    'user_id',
    'id',
    'group_id',
    'title',
    'username',
    'password',
    'link',
    'remark',
    'totp_secret',
    'is_favorite',
    'sort',
    'created_at',
    'updated_at',
  ],
  tools_password_settings: [
    'user_id',
    'auto_lock_minutes',
    'updated_at',
  ],
  tools_password_backups: [
    'user_id',
    'id',
    'filename',
    'r2_key',
    'size',
    'type',
    'created_at',
  ],
}
