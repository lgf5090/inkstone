/**
 * The Cloudflare app's tables, declared where the boot can find them.
 *
 * Every table leads with `user_id`: the reference module was a single-reader deploy, while this
 * notebook has accounts, and one reader's Cloudflare credentials, logs, conversations and tasks must
 * never be visible to another. Account rows carry a generated 26-character id rather than the
 * reference's autoincrement, because the credential vault derives its key from that id.
 *
 * Credential material is not in any of these tables. It lives in the R2 bucket under
 * `cloudflare/txt/accounts/<id>.txt`, sealed by the credential vault (see `credentials.ts`).
 */

export const CLOUDFLARE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cloudflare_account (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('token', 'global_key')),
    email TEXT,
    cf_account_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    enabled_features TEXT NOT NULL DEFAULT 'ai,workers,browser_render,dns,storage',
    available_features TEXT NOT NULL DEFAULT '',
    has_credentials INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_account_user
    ON cloudflare_account(user_id, created_at DESC)`,

  // A deleted account waits here while the reader can still take the deletion back. Every list
  // stops seeing it immediately; this copy plus the untouched credential file is what an undo
  // restores. Anything past the grace window is purged on the next read of the list.
  `CREATE TABLE IF NOT EXISTS cloudflare_account_trash (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    email TEXT,
    cf_account_id TEXT,
    is_active INTEGER NOT NULL,
    enabled_features TEXT NOT NULL,
    available_features TEXT NOT NULL,
    has_credentials INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS cloudflare_quota_usage (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    optimistic INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, account_id, resource, date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_quota_usage_day
    ON cloudflare_quota_usage(user_id, date, resource)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    status TEXT NOT NULL CHECK (status IN ('success', 'error')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_log_user_time
    ON cloudflare_log(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_log_user_action
    ON cloudflare_log(user_id, action, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_scheduled_task (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    cron TEXT NOT NULL,
    config TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_task_enabled
    ON cloudflare_scheduled_task(enabled, type)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_task_execution (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
    detail TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_task_execution_task
    ON cloudflare_task_execution(user_id, task_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_catalog_source (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_synced INTEGER,
    last_status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    etag TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cloudflare_catalog_source_url
    ON cloudflare_catalog_source(user_id, url)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_chat_session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_chat_session_user
    ON cloudflare_chat_session(user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_chat_message (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cloudflare_chat_message_session
    ON cloudflare_chat_message(user_id, session_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS cloudflare_setting (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]

export const CLOUDFLARE_REQUIRED_TABLES: readonly string[] = [
  'cloudflare_account',
  'cloudflare_account_trash',
  'cloudflare_quota_usage',
  'cloudflare_log',
  'cloudflare_scheduled_task',
  'cloudflare_task_execution',
  'cloudflare_catalog_source',
  'cloudflare_chat_session',
  'cloudflare_chat_message',
  'cloudflare_setting',
]

export const CLOUDFLARE_REQUIRED_INDEXES: readonly string[] = [
  'idx_cloudflare_account_user',
  'idx_cloudflare_quota_usage_day',
  'idx_cloudflare_log_user_time',
  'idx_cloudflare_log_user_action',
  'idx_cloudflare_task_enabled',
  'idx_cloudflare_task_execution_task',
  'idx_cloudflare_catalog_source_url',
  'idx_cloudflare_chat_session_user',
  'idx_cloudflare_chat_message_session',
]

export const CLOUDFLARE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  cloudflare_account: [
    'id', 'user_id', 'name', 'auth_type', 'email', 'cf_account_id', 'is_active',
    'enabled_features', 'available_features', 'has_credentials', 'created_at', 'updated_at',
  ],
  cloudflare_account_trash: [
    'id', 'user_id', 'name', 'auth_type', 'email', 'cf_account_id', 'is_active',
    'enabled_features', 'available_features', 'has_credentials', 'created_at', 'updated_at', 'deleted_at',
  ],
  cloudflare_quota_usage: ['user_id', 'account_id', 'resource', 'date', 'count', 'optimistic', 'exhausted'],
  cloudflare_log: ['id', 'user_id', 'account_id', 'action', 'target', 'detail', 'status', 'created_at'],
  cloudflare_scheduled_task: ['id', 'user_id', 'name', 'type', 'cron', 'config', 'enabled', 'created_at', 'updated_at'],
  cloudflare_task_execution: ['id', 'user_id', 'task_id', 'status', 'detail', 'started_at', 'finished_at'],
  cloudflare_catalog_source: ['id', 'user_id', 'url', 'name', 'is_default', 'enabled', 'last_synced', 'last_status', 'last_error', 'etag', 'created_at'],
  cloudflare_chat_session: ['id', 'user_id', 'title', 'pinned', 'favorite', 'created_at', 'updated_at'],
  cloudflare_chat_message: ['id', 'user_id', 'session_id', 'role', 'content', 'created_at'],
  cloudflare_setting: ['user_id', 'key', 'value', 'updated_at'],
}
