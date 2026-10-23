export interface SqlExec {
  exec<T = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Iterable<T>
}

export interface MailboxMigration {
  name: string
  apply(sql: SqlExec): void
}

export interface TransactionalStorage {
  transactionSync<T>(closure: () => T): T
}

export function applyMailboxMigrations(
  sql: SqlExec,
  storage?: TransactionalStorage,
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS email_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  for (const migration of EMAIL_MAILBOX_MIGRATIONS) {
    const applied = [...sql.exec(`SELECT 1 FROM email_migrations WHERE name = ?1`, migration.name)]
    if (applied.length) continue
    const run = () => {
      migration.apply(sql)
      sql.exec(`INSERT INTO email_migrations (name, applied_at) VALUES (?1, ?2)`, migration.name, Date.now())
    }
    if (storage) storage.transactionSync(run)
    else run()
  }
}

export const EMAIL_MAILBOX_MIGRATIONS: readonly MailboxMigration[] = [
  {
    name: '1_initial_setup',
    apply: (sql) => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS email_folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          is_deletable INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_email_folders_name
          ON email_folders(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS email_messages (
          id TEXT PRIMARY KEY,
          folder_id TEXT NOT NULL,
          subject TEXT NOT NULL DEFAULT '',
          sender TEXT NOT NULL DEFAULT '',
          recipient TEXT NOT NULL DEFAULT '',
          cc TEXT,
          bcc TEXT,
          date INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          read INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          body TEXT NOT NULL DEFAULT '',
          body_source TEXT,
          in_reply_to TEXT,
          email_references TEXT,
          thread_id TEXT,
          message_id TEXT,
          raw_headers TEXT,
          delivery_status TEXT,
          delivery_error TEXT,
          provider_message_id TEXT,
          attachments_skipped INTEGER NOT NULL DEFAULT 0,
          has_attachment INTEGER NOT NULL DEFAULT 0,
          size INTEGER NOT NULL DEFAULT 0,
          deleted_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (folder_id) REFERENCES email_folders(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_email_messages_folder_date
          ON email_messages(folder_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_email_messages_thread
          ON email_messages(thread_id);
        CREATE INDEX IF NOT EXISTS idx_email_messages_in_reply_to
          ON email_messages(in_reply_to);
        CREATE INDEX IF NOT EXISTS idx_email_messages_message_id
          ON email_messages(message_id);
        CREATE INDEX IF NOT EXISTS idx_email_messages_date
          ON email_messages(date DESC);
        CREATE INDEX IF NOT EXISTS idx_email_messages_trash
          ON email_messages(deleted_at);

        CREATE TABLE IF NOT EXISTS email_inbound_claims (
          message_key TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS email_operations (
          operation_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO email_folders (id, name, is_deletable, created_at) VALUES
          ('inbox', 'Inbox', 0, 0),
          ('sent', 'Sent', 0, 0),
          ('draft', 'Drafts', 0, 0),
          ('archive', 'Archive', 0, 0),
          ('trash', 'Trash', 0, 0),
          ('spam', 'Spam', 0, 0);
      `)
    },
  },
  {
    name: '2_org_tags',
    apply: (sql) => {
      const columns = new Set(
        [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('email_folders')`)]
          .map((row) => row.name),
      )
      if (!columns.has('parent_id')) {
        sql.exec(`ALTER TABLE email_folders ADD COLUMN parent_id TEXT`)
      }
      if (!columns.has('color')) {
        sql.exec(`ALTER TABLE email_folders ADD COLUMN color TEXT`)
      }
      if (!columns.has('sort_order')) {
        sql.exec(`ALTER TABLE email_folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
      }
      sql.exec(`DROP INDEX IF EXISTS idx_email_folders_name`)
      sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_folders_parent_name
        ON email_folders(COALESCE(parent_id, ''), name COLLATE NOCASE)`)
      sql.exec(`CREATE TABLE IF NOT EXISTS email_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        created_at INTEGER NOT NULL
      )`)
      sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_tags_name
        ON email_tags(name COLLATE NOCASE)`)
      sql.exec(`CREATE TABLE IF NOT EXISTS email_message_tags (
        message_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, tag_id)
      )`)
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_email_message_tags_tag
        ON email_message_tags(tag_id, message_id)`)
    },
  },
  {
    name: '3_snooze',
    apply: (sql) => {
      const columns = new Set(
        [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('email_messages')`)]
          .map((row) => row.name),
      )
      if (!columns.has('snoozed_until')) {
        sql.exec(`ALTER TABLE email_messages ADD COLUMN snoozed_until INTEGER`)
      }
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_email_messages_snoozed
        ON email_messages(snoozed_until) WHERE snoozed_until IS NOT NULL`)
    },
  },
  {
    name: '4_inbound_rules',
    apply: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS email_filters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        conditions_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`)
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_email_filters_order
        ON email_filters(enabled, sort_order, created_at)`)
      sql.exec(`CREATE TABLE IF NOT EXISTS email_blocked_senders (
        email_normalized TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`)
    },
  },
  {
    name: '5_email_templates',
    apply: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS email_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
      sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_name
        ON email_templates(name COLLATE NOCASE)`)
    },
  },
]
