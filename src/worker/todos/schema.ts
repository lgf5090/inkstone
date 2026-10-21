/**
 * The to-do app's tables, declared where the boot can find them.
 *
 * They are created as tables rather than migrations, which is what the schema's own ordering allows:
 * tables are built before the ledger is consulted, indexes after it, and `assertFinalSchema` only
 * checks the lists at the bottom of this file. Spending version numbers here would buy nothing.
 *
 * `todos_tasks` is the task list the assistant's tools have always written, under the name this module
 * owns. A database that predates the rename still holds its rows in `chat_tasks`; `migrateTaskTable`
 * copies them across once and drops the old table, so the two names never both hold live data.
 *
 * The attachment link's reads and writes live at the bottom of this file rather than in its route:
 * `tests/worker-layering.test.ts` keeps SQL out of every route, and this module already owns the
 * `todos_*` declarations those statements are bound against.
 */

export const TODOS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS todos_tasks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    -- Where the reader placed this task among its list's rows, or NULL while nobody has moved it.
    -- REAL because a drop between two neighbours folds their midpoint, and an integer runs out of
    -- room after one drop into the same gap. Migration 125 carries the column to older databases.
    position REAL,
    due_at INTEGER,
    -- When the task may be begun, or NULL when the reader named no start. Migration 123 carries the
    -- column to databases built before this line existed.
    start_at INTEGER,
    completed_at INTEGER,
    -- The account's calendar day (YYYY-MM-DD) of the two instants beside them. Stored rather than
    -- derived at query time: a day computed from an offset drifts across DST and files a task under
    -- the wrong day, which is exactly what a streak or a daily trend must not do.
    completed_on TEXT,
    created_on TEXT,
    project_id TEXT,
    list_id TEXT,
    -- The task's own face: an icon in the lists' format ('lucide:<Name>' or a single emoji) and one
    -- of the palette's 24 colours, or NULL while the task wears its list's. Nullable with no default
    -- because "the reader placed nothing here" and "the reader kept the list's" are different rows,
    -- and only one of them is an absence. Migrations 126 and 127 carry the two columns to databases
    -- built before these lines existed, one column per version as the ledger counts them.
    icon TEXT,
    color TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    repeat_rule TEXT,
    -- Superseded by todos_reminders (pending removal). The pair is emptied by migrateTaskReminders and no code
    -- reads or writes it after that; it stays only because dropping a column needs a migration number
    -- this change deliberately does not spend.
    remind_at INTEGER,
    reminded_at INTEGER,
    -- The account's calendar day (YYYY-MM-DD) the reader picked this task into "today", or NULL when
    -- it was never picked. A day rather than a boolean: a row planned for yesterday stops equalling
    -- today when the calendar moves, so the membership needs no midnight sweep to clear itself.
    planned_for TEXT,
    note_id TEXT,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- The row's version, moved on by every write. A caller that read the task names the revision it
    -- read, and a write naming an older one is refused instead of replacing an edit it never saw.
    -- Migration 119 carries the column to databases built before this line existed.
    rev INTEGER NOT NULL DEFAULT 1,
    -- When the task was moved to the trash, or NULL while it is live. Deleting stamps this column
    -- instead of removing the row, so a restore brings back the same steps, tags and reminders; every
    -- task read filters on it through TASK_LIVE_PREDICATE in assistant/store.ts. Migration 122
    -- carries the column to databases built before this line existed.
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_status_due
     ON todos_tasks(user_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_list
     ON todos_tasks(user_id, list_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_project
     ON todos_tasks(user_id, project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_star
     ON todos_tasks(user_id, starred, status)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_remind
     ON todos_tasks(remind_at) WHERE remind_at IS NOT NULL`,
  // The two orders the list gained after it shipped — `sort=created` and `sort=completed` — walk one
  // account's tasks by a column no index above leads with. Without these, every page of a long-lived
  // account sorted its whole table; the migration numbers 111 and 112 carry them to databases built
  // before this line existed.
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_created
     ON todos_tasks(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed
     ON todos_tasks(user_id, completed_at)`,
  // What the statistics group by: a streak or a daily trend walks one account's finished tasks in
  // the reader's own days, so the day column has to lead after the account or every read scans the
  // whole shelf. Migration 115 carries it to databases built before this line existed.
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed_on
     ON todos_tasks(user_id, completed_on)`,
  // What the today view and its badge read beyond due dates: one account's rows by the day they were
  // picked for. Migration 118 carries it to databases built before the column existed.
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_planned
     ON todos_tasks(user_id, planned_for)`,
  // The manual order a drag or the move menu writes, read in the scope a move is made in: one
  // account's rows in one list, by the place the reader gave them. Migration 125 carries it to
  // databases built before the column existed.
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_position
     ON todos_tasks(user_id, list_id, position)`,
  // What the trash page and the retention sweep read: the account leads, then the deletion stamp, so
  // one account's newest trash is an ordered range and the hourly sweep can ask across accounts in
  // stamp order. Migration 122 carries it to databases built before the column existed.
  `CREATE INDEX IF NOT EXISTS idx_todos_tasks_trash
     ON todos_tasks(user_id, deleted_at)`,

  // The reminders a task carries, one row each. The todos_tasks columns remind_at / reminded_at held
  // the same idea as a single pair and are no longer read or written: the one-shot repair
  // migrateTaskReminders moved their rows here, and they stay on the table only until a later
  // migration drops them (pending removal). A row is claimed by stamping fired_at, so the sweep needs no
  // scheduler of its own and two overlapping ticks cannot both deliver the same reminder.
  `CREATE TABLE IF NOT EXISTS todos_reminders (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    fired_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_reminders_task
     ON todos_reminders(user_id, task_id)`,
  // The sweep is the one cross-account reader: it asks every account's reminders what has come due,
  // never one account's. The partial predicate keeps the index to the rows that can still fire, so a
  // table full of history costs the tick nothing.
  `CREATE INDEX IF NOT EXISTS idx_todos_reminders_due
     ON todos_reminders(remind_at) WHERE fired_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS todos_lists (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    -- When the reader put the list away, or NULL while it is in use. Migration 120 carries it to
    -- databases built before this line existed.
    archived_at INTEGER,
    -- The one container this list sits under, or NULL for a top-level list. Grouping is one level
    -- deep, so a parent is always a root; migration 121 carries the column to older databases.
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_lists_unique
     ON todos_lists(user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS todos_steps (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_steps_task
     ON todos_steps(user_id, task_id, position)`,

  // A task's files, one link row each. The bytes and their metadata stay in `attachments`, exactly
  // where a note's uploads already put them; this table only says which task shows which file, so a
  // file may be named by more than one task and removing one link never removes the file. Nothing
  // cascades here (no table in this schema declares a foreign key), so trashing or purging a task
  // leaves both the links and the file alone — the same rule the notes side has always followed.
  `CREATE TABLE IF NOT EXISTS todos_attachments (
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, task_id, attachment_id)
  )`,

  `CREATE TABLE IF NOT EXISTS todos_tags (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_tags_unique
     ON todos_tags(user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS todos_tag_links (
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, task_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_tag_links_tag
     ON todos_tag_links(user_id, tag_id)`,

  // The read-only calendar subscription the to-do app publishes. Keyed on `user_id, slug` — the
  // opposite of `shares`, which keys on `slug` alone — because the schema guard refuses an
  // account-scoped table led by a global key; the unique index below is what lets the public reader
  // resolve a slug without knowing its owner, so it stays addressed by the link and not by an account.
  `CREATE TABLE IF NOT EXISTS todos_feeds (
    slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slug)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_feeds_slug
     ON todos_feeds(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_feeds_user
     ON todos_feeds(user_id, created_at DESC, slug DESC)`,

  // The address an account may post mail to: one per account, so rotation replaces the row rather than
  // accumulating addresses nobody remembers revoking. The token is stored in the clear because the
  // owner's settings screen has to show the address again — the capability is the token itself, and
  // its 200 bits of randomness are the authentication. The unique index is what turns a recipient
  // into an owner; the primary key only keeps "one address" true.
  `CREATE TABLE IF NOT EXISTS todos_mail_tokens (
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_mail_tokens_token
     ON todos_mail_tokens(token)`,

  // What makes a delivery idempotent: the Message-ID of every message already filed, claimed before
  // the task is written. Email delivery is at least once, so the same message can arrive twice; the
  // row is the claim that says the first arrival is the one that counts. Scoped by account because
  // one message may legitimately reach two accounts that both route it to their own task list; the
  // rows older than the idempotency window are pruned as new mail arrives, so the table stays small.
  `CREATE TABLE IF NOT EXISTS todos_mail_messages (
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  )`,
]

export const TODOS_REQUIRED_TABLES: readonly string[] = [
  'todos_tasks',
  'todos_reminders',
  'todos_lists',
  'todos_steps',
  'todos_attachments',
  'todos_tags',
  'todos_tag_links',
  'todos_feeds',
  'todos_mail_tokens',
  'todos_mail_messages',
]

export const TODOS_REQUIRED_INDEXES: readonly string[] = [
  'idx_todos_tasks_status_due',
  'idx_todos_tasks_list',
  'idx_todos_tasks_project',
  'idx_todos_tasks_star',
  'idx_todos_tasks_remind',
  'idx_todos_tasks_created',
  'idx_todos_tasks_completed',
  'idx_todos_tasks_completed_on',
  'idx_todos_tasks_planned',
  'idx_todos_tasks_position',
  'idx_todos_tasks_trash',
  'idx_todos_reminders_task',
  'idx_todos_reminders_due',
  'idx_todos_lists_unique',
  'idx_todos_steps_task',
  'idx_todos_tags_unique',
  'idx_todos_tag_links_tag',
  'idx_todos_feeds_slug',
  'idx_todos_feeds_user',
  'idx_todos_mail_tokens_token',
]

export const TODOS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // `remind_at` / `reminded_at` stay listed because a database that predates the reminders table
  // still carries them and the boot guard compares the declared shape with the real one; nothing
  // reads or writes them any more, and `migrateTaskReminders` is what empties them (pending removal).
  todos_tasks: [
    'user_id', 'id', 'title', 'description', 'status', 'priority', 'position', 'due_at', 'start_at', 'completed_at',
    'completed_on', 'created_on',
    'project_id', 'list_id', 'icon', 'color', 'starred', 'repeat_rule', 'remind_at', 'reminded_at', 'planned_for', 'note_id',
    'conversation_id', 'created_at', 'updated_at', 'rev', 'deleted_at',
  ],
  todos_reminders: ['user_id', 'id', 'task_id', 'remind_at', 'fired_at', 'created_at'],
  todos_lists: ['user_id', 'id', 'name', 'icon', 'color', 'position', 'archived_at', 'parent_id', 'created_at', 'updated_at'],
  todos_steps: ['user_id', 'id', 'task_id', 'text', 'done', 'position', 'created_at'],
  todos_attachments: ['user_id', 'task_id', 'attachment_id', 'created_at'],
  todos_tags: ['user_id', 'id', 'name', 'color', 'created_at', 'updated_at'],
  todos_tag_links: ['user_id', 'task_id', 'tag_id', 'created_at'],
  todos_feeds: ['slug', 'user_id', 'password_hash', 'expires_at', 'revoked_at', 'created_at'],
  todos_mail_tokens: ['user_id', 'token', 'created_at'],
  todos_mail_messages: ['user_id', 'message_id', 'created_at'],
}

// ------------------------------------------------------------- task attachments

/** One file a task shows, as the listing reads it: the attachment row, never the bytes. */
export interface TodoAttachmentRow {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  created_at: number
}

/**
 * Whether a task is one this account still has.
 *
 * `deleted_at IS NULL` is `TASK_LIVE_PREDICATE`'s rule, restated rather than imported: this module is
 * loaded during schema boot, and pulling the assistant's store in here for one constant would put the
 * whole store on that path. A trashed task is not an upload, list or detach target.
 */
export async function todoTaskIsLive(
  db: D1Database,
  userId: string,
  taskId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS live FROM todos_tasks
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(userId, taskId).first<{ live: number }>()
  return Boolean(row)
}

/**
 * The files a live task shows, newest first.
 *
 * The join is also the tenant check: a link row whose attachment belongs to another account (or whose
 * file was deleted through `/api/files`) simply does not surface, and `note_id` stays unread because a
 * task attachment is not a note attachment.
 */
export async function listTodoAttachments(
  db: D1Database,
  userId: string,
  taskId: string,
): Promise<TodoAttachmentRow[]> {
  const { results } = await db.prepare(
    `SELECT a.id, a.filename, a.mime, a.size, a.width, a.height, a.created_at
       FROM todos_attachments ta
       JOIN attachments a ON a.id = ta.attachment_id AND a.user_id = ta.user_id
      WHERE ta.user_id = ?1 AND ta.task_id = ?2
      ORDER BY ta.created_at DESC, ta.attachment_id DESC`,
  ).bind(userId, taskId).all<TodoAttachmentRow>()
  return results ?? []
}

/**
 * Record that a task shows a file, without moving or copying the file.
 *
 * The insert selects from `attachments` under the same account, so a link cannot be minted for a row
 * this account does not own. `false` means the attachment row was already gone; the caller rolls the
 * upload back rather than leaving a file nothing names.
 */
export async function linkTodoAttachment(
  db: D1Database,
  userId: string,
  taskId: string,
  attachmentId: string,
  createdAt: number,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO todos_attachments (user_id, task_id, attachment_id, created_at)
     SELECT ?1, ?2, ?3, ?4
      WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ?3 AND user_id = ?1)`,
  ).bind(userId, taskId, attachmentId, createdAt).run()
  return (result.meta?.changes ?? 0) > 0
}

/**
 * Drop one task's link to a file.
 *
 * The whole key is the predicate, so another task's link to the same file is untouched and the file
 * itself is not deleted — unlinking is not deleting, exactly as removing a note's mention is not.
 */
export async function unlinkTodoAttachment(
  db: D1Database,
  userId: string,
  taskId: string,
  attachmentId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM todos_attachments
      WHERE user_id = ?1 AND task_id = ?2 AND attachment_id = ?3`,
  ).bind(userId, taskId, attachmentId).run()
  return (result.meta?.changes ?? 0) > 0
}

// ------------------------------------------------------------- mail addresses

/** The address an account has issued, as the settings screen reads it: the capability itself. */
export interface MailTokenRow {
  token: string
  created_at: number
}

/** The account's one address, or null while it has never asked for one. */
export async function loadMailToken(db: D1Database, userId: string): Promise<MailTokenRow | null> {
  return (await db.prepare(
    `SELECT token, created_at FROM todos_mail_tokens WHERE user_id = ?1`,
  ).bind(userId).first<MailTokenRow>()) ?? null
}

/**
 * Issue an address, replacing the one the account already had.
 *
 * One statement, so rotation cannot leave an account with two rows or none: the upsert keeps the
 * primary key's promise even if two tabs press the button at once. The old token stops resolving the
 * moment this lands, which is what "rotate" means — a reader who wants to keep the old address keeps
 * it, because issuing is the only write that changes it.
 */
export async function saveMailToken(
  db: D1Database,
  userId: string,
  token: string,
  now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO todos_mail_tokens (user_id, token, created_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at`,
  ).bind(userId, token, now).run()
}

/** Revoke the account's address; `false` means there was none. */
export async function revokeMailToken(db: D1Database, userId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM todos_mail_tokens WHERE user_id = ?1`,
  ).bind(userId).run()
  return (result.meta?.changes ?? 0) > 0
}

/**
 * The account a delivered token belongs to, or null for a token nobody issued.
 *
 * This is the entire authentication of the inbound path: the address was handed to its owner, its
 * 200 bits cannot be guessed, and a mailbox that does not hold it never reaches this query. The
 * lookup is by the unique index, so a scanner walking `u+aaaa…` learns only that no row matched.
 */
export async function findMailTokenOwner(db: D1Database, token: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT user_id FROM todos_mail_tokens WHERE token = ?1`,
  ).bind(token).first<{ user_id: string }>()
  return row?.user_id ?? null
}

/**
 * Claim one inbound message before its task is written.
 *
 * `INSERT OR IGNORE` is the whole concurrency story: two deliveries of the same Message-ID race for
 * one primary key, and the loser sees zero changes and writes nothing. Stale claims are pruned on the
 * same call, which is why the table cannot grow without bound on a long-lived mailbox — the window is
 * far longer than any retry of one delivery, so pruning can never resurrect a message still in flight.
 * `false` means a previous delivery already claimed it.
 */
export async function claimMailMessage(
  db: D1Database,
  userId: string,
  messageId: string,
  now: number,
  staleBefore: number,
): Promise<boolean> {
  await db.prepare(
    `DELETE FROM todos_mail_messages WHERE user_id = ?1 AND created_at < ?2`,
  ).bind(userId, staleBefore).run()
  const result = await db.prepare(
    `INSERT OR IGNORE INTO todos_mail_messages (user_id, message_id, created_at)
     VALUES (?1, ?2, ?3)`,
  ).bind(userId, messageId, now).run()
  return (result.meta?.changes ?? 0) > 0
}

/**
 * Give a claim back after the task could not be written, so the platform's retry is not mistaken
 * for a duplicate. Deleting only this key leaves every other delivery's claim alone.
 */
export async function releaseMailMessage(
  db: D1Database,
  userId: string,
  messageId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM todos_mail_messages WHERE user_id = ?1 AND message_id = ?2`,
  ).bind(userId, messageId).run()
}
