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
    project_id TEXT,
    list_id TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    repeat_rule TEXT,
    remind_at INTEGER,
    reminded_at INTEGER,
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
  'idx_todos_lists_unique',
  'idx_todos_steps_task',
  'idx_todos_tags_unique',
  'idx_todos_tag_links_tag',
  'idx_todos_feeds_slug',
  'idx_todos_feeds_user',
]

export const TODOS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  todos_tasks: [
    'user_id', 'id', 'title', 'description', 'status', 'priority', 'due_at', 'completed_at',
    'project_id', 'list_id', 'starred', 'repeat_rule', 'remind_at', 'reminded_at', 'note_id',
    'conversation_id', 'created_at', 'updated_at',
  ],
  todos_lists: ['user_id', 'id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at'],
  todos_steps: ['user_id', 'id', 'task_id', 'text', 'done', 'position', 'created_at'],
  todos_tags: ['user_id', 'id', 'name', 'color', 'created_at', 'updated_at'],
  todos_tag_links: ['user_id', 'task_id', 'tag_id', 'created_at'],
  todos_feeds: ['slug', 'user_id', 'password_hash', 'expires_at', 'revoked_at', 'created_at'],
}
