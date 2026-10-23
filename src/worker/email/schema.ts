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

  `CREATE TABLE IF NOT EXISTS email_scheduled_sends (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_scheduled_due
     ON email_scheduled_sends(status, send_at)
     WHERE status = 'queued'`,
  `CREATE INDEX IF NOT EXISTS idx_email_scheduled_user
     ON email_scheduled_sends(user_id, account_id, status, send_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_scheduled_operation
     ON email_scheduled_sends(user_id, operation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_scheduled_pending
     ON email_scheduled_sends(user_id, account_id, draft_id)
     WHERE status IN ('queued', 'running')`,

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

  `CREATE TABLE IF NOT EXISTS email_contacts (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    starred INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    avatar TEXT NOT NULL DEFAULT '',
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_contacts_email
     ON email_contacts(user_id, email_normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_email_contacts_name
     ON email_contacts(user_id, name)`,

  `CREATE TABLE IF NOT EXISTS email_groups (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    starred INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    avatar TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_groups_name
     ON email_groups(user_id, name COLLATE NOCASE)`,

  `CREATE TABLE IF NOT EXISTS email_group_members (
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, contact_id)
  )`,
]

export const EMAIL_REQUIRED_TABLES: readonly string[] = [
  'email_accounts',
  'email_auto_draft_jobs',
  'email_scheduled_sends',
  'email_attachments',
  'email_contacts',
  'email_groups',
  'email_group_members',
]

export const EMAIL_REQUIRED_INDEXES: readonly string[] = [
  'idx_email_accounts_address',
  'idx_email_accounts_id',
  'idx_email_accounts_user',
  'idx_email_auto_draft_due',
  'idx_email_auto_draft_user',
  'idx_email_scheduled_due',
  'idx_email_scheduled_user',
  'idx_email_scheduled_operation',
  'idx_email_scheduled_pending',
  'idx_email_attachments_email',
  'idx_email_attachments_folder',
  'idx_email_attachments_created',
  'idx_email_contacts_email',
  'idx_email_contacts_name',
  'idx_email_groups_name',
]

export const EMAIL_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  email_accounts: ['id', 'user_id', 'address', 'address_normalized', 'display_name', 'settings', 'created_at', 'updated_at'],
  email_auto_draft_jobs: ['user_id', 'account_id', 'message_id', 'thread_id', 'status', 'reason', 'attempts', 'claimed_at', 'created_at', 'updated_at'],
  email_scheduled_sends: ['id', 'user_id', 'account_id', 'draft_id', 'operation_id', 'send_at', 'status', 'attempts', 'claimed_at', 'last_error', 'created_at', 'updated_at'],
  email_attachments: ['id', 'user_id', 'account_id', 'email_id', 'filename', 'mime', 'size', 'width', 'height', 'content_id', 'disposition', 'object_key', 'storage', 'folder_id', 'is_starred', 'is_pinned', 'tags', 'locked', 'created_at'],
  email_contacts: ['id', 'user_id', 'email', 'email_normalized', 'name', 'company', 'notes', 'starred', 'pinned', 'avatar', 'usage_count', 'last_used_at', 'created_at', 'updated_at'],
  email_groups: ['id', 'user_id', 'name', 'description', 'starred', 'pinned', 'avatar', 'created_at', 'updated_at'],
  email_group_members: ['user_id', 'group_id', 'contact_id', 'created_at'],
}
