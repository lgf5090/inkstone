/**
 * The chat assistant's tables.
 *
 * Everything the assistant owns is prefixed `chat_` and keyed by `(user_id, id)` rather than by
 * `id` alone. That is the one place the port had to depart from the reference project's schema: it
 * stored all of this in a Durable Object belonging to a single owner, so a bare `id TEXT PRIMARY KEY`
 * was enough — and here it is not. A global id key would let a backup restored into a second account
 * collide with the first one's row, and a write that quietly does nothing is the worst kind of data
 * loss, because every status code still says it worked.
 *
 * Every query in `store.ts` binds `user_id` for the same reason; the columns below are what makes that
 * filter indexable rather than a full scan.
 */

export const ASSISTANT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chat_settings (
    user_id TEXT PRIMARY KEY,
    config TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chat_providers (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_providers_user
     ON chat_providers(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS chat_models (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    temperature REAL,
    max_output_tokens INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    position REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_models_provider
     ON chat_models(user_id, provider_id, position)`,

  `CREATE TABLE IF NOT EXISTS chat_conversations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT,
    summary_upto INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    folder_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
     ON chat_conversations(user_id, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversations_folder
     ON chat_conversations(user_id, folder_id, updated_at DESC)`,

  // The join table mirrors note_tags: one row in tags, shared by whatever it labels.
  `CREATE TABLE IF NOT EXISTS chat_conversation_tags (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_conversation_tags_tag
     ON chat_conversation_tags(user_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    source TEXT NOT NULL DEFAULT 'chat',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
     ON chat_messages(user_id, conversation_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_user
     ON chat_messages(user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS chat_memories (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    valid_from TEXT,
    valid_until TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_user_updated
     ON chat_memories(user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_status
     ON chat_memories(user_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_memories_superseded
     ON chat_memories(user_id, superseded_by)`,

  `CREATE TABLE IF NOT EXISTS chat_memory_reviews (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_reviews_memory
     ON chat_memory_reviews(user_id, memory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_reviews_other
     ON chat_memory_reviews(user_id, other_id)`,

  `CREATE TABLE IF NOT EXISTS chat_tasks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_at INTEGER,
    project_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_tasks_user_status_due
     ON chat_tasks(user_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_tasks_project
     ON chat_tasks(user_id, project_id)`,

  `CREATE TABLE IF NOT EXISTS chat_projects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_projects_unique
     ON chat_projects(user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS chat_automations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'scheduled',
    next_run INTEGER,
    last_run INTEGER,
    last_result TEXT,
    last_error TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_automations_due
     ON chat_automations(enabled, next_run)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_automations_user
     ON chat_automations(user_id, enabled, next_run)`,

  `CREATE TABLE IF NOT EXISTS chat_runs (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    automation_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_runs_started
     ON chat_runs(user_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS chat_notifications (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    automation_id TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_notifications_user
     ON chat_notifications(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_notifications_unread
     ON chat_notifications(user_id, read_at, created_at)`,

  `CREATE TABLE IF NOT EXISTS chat_pending_actions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_actions_conversation
     ON chat_pending_actions(user_id, conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_actions_pending
     ON chat_pending_actions(user_id, status, expires_at)`,

  `CREATE TABLE IF NOT EXISTS chat_usage_daily (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    scheduled_runs INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,

  `CREATE TABLE IF NOT EXISTS chat_activity (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_activity_user
     ON chat_activity(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS chat_active_runs (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_active_runs_user
     ON chat_active_runs(user_id, lease_until)`,
]

export const ASSISTANT_REQUIRED_TABLES: readonly string[] = [
  'chat_settings',
  'chat_providers',
  'chat_models',
  'chat_conversations',
  'chat_conversation_tags',
  'chat_messages',
  'chat_memories',
  'chat_memory_reviews',
  'chat_tasks',
  'chat_projects',
  'chat_automations',
  'chat_runs',
  'chat_notifications',
  'chat_pending_actions',
  'chat_usage_daily',
  'chat_activity',
  'chat_active_runs',
]

export const ASSISTANT_REQUIRED_INDEXES: readonly string[] = [
  'idx_chat_providers_user',
  'idx_chat_models_provider',
  'idx_chat_conversations_user',
  'idx_chat_conversations_folder',
  'idx_chat_conversation_tags_tag',
  'idx_chat_messages_conversation',
  'idx_chat_messages_user',
  'idx_chat_memories_user_updated',
  'idx_chat_memories_status',
  'idx_chat_memories_superseded',
  'idx_chat_reviews_memory',
  'idx_chat_reviews_other',
  'idx_chat_tasks_user_status_due',
  'idx_chat_tasks_project',
  'idx_chat_projects_unique',
  'idx_chat_automations_due',
  'idx_chat_automations_user',
  'idx_chat_runs_started',
  'idx_chat_notifications_user',
  'idx_chat_notifications_unread',
  'idx_chat_actions_conversation',
  'idx_chat_actions_pending',
  'idx_chat_activity_user',
  'idx_chat_active_runs_user',
]

export const ASSISTANT_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  chat_settings: ['user_id', 'config', 'updated_at'],
  chat_providers: ['user_id', 'id', 'label', 'protocol', 'base_url', 'key_ciphertext', 'created_at', 'updated_at'],
  chat_models: ['user_id', 'id', 'provider_id', 'model', 'label', 'temperature', 'max_output_tokens', 'enabled', 'position'],
  chat_conversations: ['user_id', 'id', 'title', 'summary', 'summary_upto', 'pinned', 'folder_id', 'created_at', 'updated_at'],
  chat_conversation_tags: ['user_id', 'conversation_id', 'tag_id', 'created_at'],
  chat_messages: ['user_id', 'id', 'conversation_id', 'role', 'content', 'tools', 'status', 'error', 'source', 'input_tokens', 'output_tokens', 'created_at'],
  chat_memories: ['user_id', 'id', 'content', 'category', 'source', 'status', 'superseded_by', 'valid_from', 'valid_until', 'created_at', 'updated_at'],
  chat_memory_reviews: ['user_id', 'id', 'memory_id', 'other_id', 'relationship', 'reason', 'created_at'],
  chat_tasks: ['user_id', 'id', 'title', 'description', 'status', 'priority', 'due_at', 'project_id', 'created_at', 'updated_at', 'completed_at'],
  chat_projects: ['user_id', 'id', 'name', 'description', 'created_at', 'updated_at'],
  chat_automations: ['user_id', 'id', 'name', 'kind', 'message', 'schedule', 'enabled', 'status', 'next_run', 'last_run', 'last_result', 'last_error', 'run_count', 'claimed_at', 'created_at', 'updated_at'],
  chat_runs: ['user_id', 'id', 'automation_id', 'automation_name', 'started_at', 'finished_at', 'status', 'result', 'error'],
  chat_notifications: ['user_id', 'id', 'title', 'body', 'automation_id', 'read_at', 'created_at'],
  chat_pending_actions: ['user_id', 'id', 'conversation_id', 'tool', 'target_id', 'target_label', 'status', 'error', 'created_at', 'expires_at', 'resolved_at'],
  chat_usage_daily: ['user_id', 'day', 'requests', 'input_tokens', 'output_tokens', 'tool_calls', 'scheduled_runs', 'errors'],
  chat_activity: ['user_id', 'id', 'type', 'summary', 'created_at'],
  chat_active_runs: ['user_id', 'conversation_id', 'started_at', 'lease_until'],
}
