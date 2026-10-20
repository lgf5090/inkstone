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
 */

export const TODOS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS todos_tasks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_at INTEGER,
    completed_at INTEGER,
    -- The account's calendar day (YYYY-MM-DD) of the two instants beside them. Stored rather than
    -- derived at query time: a day computed from an offset drifts across DST and files a task under
    -- the wrong day, which is exactly what a streak or a daily trend must not do.
    completed_on TEXT,
    created_on TEXT,
    project_id TEXT,
    list_id TEXT,
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
]

export const TODOS_REQUIRED_TABLES: readonly string[] = [
  'todos_tasks',
  'todos_reminders',
  'todos_lists',
  'todos_steps',
  'todos_tags',
  'todos_tag_links',
  'todos_feeds',
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
  'idx_todos_reminders_task',
  'idx_todos_reminders_due',
  'idx_todos_lists_unique',
  'idx_todos_steps_task',
  'idx_todos_tags_unique',
  'idx_todos_tag_links_tag',
  'idx_todos_feeds_slug',
  'idx_todos_feeds_user',
]

export const TODOS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // `remind_at` / `reminded_at` stay listed because a database that predates the reminders table
  // still carries them and the boot guard compares the declared shape with the real one; nothing
  // reads or writes them any more, and `migrateTaskReminders` is what empties them (pending removal).
  todos_tasks: [
    'user_id', 'id', 'title', 'description', 'status', 'priority', 'due_at', 'completed_at',
    'completed_on', 'created_on',
    'project_id', 'list_id', 'starred', 'repeat_rule', 'remind_at', 'reminded_at', 'planned_for', 'note_id',
    'conversation_id', 'created_at', 'updated_at',
  ],
  todos_reminders: ['user_id', 'id', 'task_id', 'remind_at', 'fired_at', 'created_at'],
  todos_lists: ['user_id', 'id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at'],
  todos_steps: ['user_id', 'id', 'task_id', 'text', 'done', 'position', 'created_at'],
  todos_tags: ['user_id', 'id', 'name', 'color', 'created_at', 'updated_at'],
  todos_tag_links: ['user_id', 'task_id', 'tag_id', 'created_at'],
  todos_feeds: ['slug', 'user_id', 'password_hash', 'expires_at', 'revoked_at', 'created_at'],
}
