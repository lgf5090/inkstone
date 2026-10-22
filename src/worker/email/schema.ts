export const EMAIL_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS email_accounts (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    address_normalized TEXT NOT NULL,
    display_name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_address
     ON email_accounts(address_normalized)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_id
     ON email_accounts(id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_accounts_user
     ON email_accounts(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS email_auto_draft_jobs (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_auto_draft_due
     ON email_auto_draft_jobs(status, created_at)
     WHERE status = 'queued'`,
  `CREATE INDEX IF NOT EXISTS idx_email_auto_draft_user
     ON email_auto_draft_jobs(user_id, status, created_at)`,

  `CREATE TABLE IF NOT EXISTS email_attachments (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT,
    email_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    content_id TEXT,
    disposition TEXT,
    object_key TEXT NOT NULL,
    storage TEXT NOT NULL DEFAULT 'r2',
    folder_id TEXT,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_attachments_email
     ON email_attachments(user_id, email_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_email_attachments_folder
     ON email_attachments(user_id, folder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_attachments_created
     ON email_attachments(user_id, created_at DESC)`,
]

export const EMAIL_REQUIRED_TABLES: readonly string[] = [
  'email_accounts',
  'email_auto_draft_jobs',
  'email_attachments',
]

export const EMAIL_REQUIRED_INDEXES: readonly string[] = [
  'idx_email_accounts_address',
  'idx_email_accounts_id',
  'idx_email_accounts_user',
  'idx_email_auto_draft_due',
  'idx_email_auto_draft_user',
  'idx_email_attachments_email',
  'idx_email_attachments_folder',
  'idx_email_attachments_created',
]

export const EMAIL_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  email_accounts: ['id', 'user_id', 'address', 'address_normalized', 'display_name', 'settings', 'created_at', 'updated_at'],
  email_auto_draft_jobs: ['user_id', 'account_id', 'message_id', 'thread_id', 'status', 'reason', 'attempts', 'claimed_at', 'created_at', 'updated_at'],
  email_attachments: ['id', 'user_id', 'account_id', 'email_id', 'filename', 'mime', 'size', 'width', 'height', 'content_id', 'disposition', 'object_key', 'storage', 'folder_id', 'is_starred', 'is_pinned', 'tags', 'locked', 'created_at'],
}
