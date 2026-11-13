/**
 * The project app's tables, in arrays so a fresh database and a migrated one arrive at the same shape
 * by the same text: `SCHEMA_STATEMENTS` spreads these, and migrations 287-291 apply the very same
 * arrays to a database that predates the app.
 *
 * Boards are shared objects, so a board-scoped row keys on its own id and reaches its audience through
 * `project_board_members`; only the account's own furniture (categories, settings) keys on the account.
 * Timestamps are milliseconds and a delete is a stamp, both as the rest of this database does it.
 */

export const PROJECT_CORE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_boards (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'P' CHECK (type IN ('O','P')),
    minimum_role TEXT NOT NULL DEFAULT '' CHECK (minimum_role IN ('','viewer','commenter','editor','admin')),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    show_description INTEGER NOT NULL DEFAULT 0,
    is_template INTEGER NOT NULL DEFAULT 0,
    template_version INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    modified_by TEXT NOT NULL,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_boards_owner
     ON project_boards(owner_id, delete_at, update_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_project_boards_template
     ON project_boards(owner_id, is_template, delete_at)`,

  // One role column rather than the reference's four scheme booleans: its own editor assigns them
  // cumulatively, so only four states are reachable and a single ordered column says the same thing.
  `CREATE TABLE IF NOT EXISTS project_board_members (
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','admin')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_members_user
     ON project_board_members(user_id, board_id)`,

  `CREATE TABLE IF NOT EXISTS project_properties (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_properties_order
     ON project_properties(board_id, position)`,

  // contentOrder lives on the card because it interleaves content ids with comment ids, and a nested
  // array threads comments under one block — an order a per-row position column cannot express.
  `CREATE TABLE IF NOT EXISTS project_cards (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    is_template INTEGER NOT NULL DEFAULT 0,
    content_order TEXT NOT NULL DEFAULT '[]',
    recurrence TEXT,
    created_by TEXT NOT NULL,
    modified_by TEXT NOT NULL,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_cards_board
     ON project_cards(board_id, delete_at, update_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_project_cards_board_create
     ON project_cards(board_id, delete_at, create_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_cards_parent
     ON project_cards(parent_id, delete_at)`,

  `CREATE TABLE IF NOT EXISTS project_card_values (
    card_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (card_id, property_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_values_property
     ON project_card_values(property_id, card_id)`,

  `CREATE TABLE IF NOT EXISTS project_views (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    view_type TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '{}',
    position REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    modified_by TEXT NOT NULL,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_views_board
     ON project_views(board_id, delete_at, position)`,
]

export const PROJECT_CONTENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_card_contents (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','checkbox','divider','image','attachment')),
    title TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}',
    position REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    modified_by TEXT NOT NULL,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_contents_card
     ON project_card_contents(card_id, delete_at, position)`,
  `CREATE INDEX IF NOT EXISTS idx_project_contents_board
     ON project_card_contents(board_id, delete_at, position, id)`,

  `CREATE TABLE IF NOT EXISTS project_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_comments_card
     ON project_comments(card_id, delete_at, create_at)`,
  `CREATE INDEX IF NOT EXISTS idx_project_comments_board
     ON project_comments(board_id, delete_at, create_at, id)`,

  `CREATE TABLE IF NOT EXISTS project_categories (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'custom' CHECK (type IN ('system','custom')),
    collapsed INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    create_at INTEGER NOT NULL,
    update_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_categories_user
     ON project_categories(user_id, delete_at, sort_order)`,

  // No Category.sorting column: the reference declares it but never reads or writes it, so order is
  // carried entirely by project_category_boards.position.
  `CREATE TABLE IF NOT EXISTS project_category_boards (
    user_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, category_id, board_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_category_boards_board
     ON project_category_boards(board_id, user_id)`,
]

export const PROJECT_AUX_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    card_id TEXT,
    folder_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage TEXT NOT NULL DEFAULT 'r2' CHECK (storage IN ('r2','kv')),
    object_key TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    thumbnail_key TEXT,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_attachments_card
     ON project_attachments(card_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_project_attachments_user
     ON project_attachments(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_project_attachments_board
     ON project_attachments(board_id, created_at DESC)`,

  // No subscriber type column: the reference's `channel` subscribers have no counterpart here.
  `CREATE TABLE IF NOT EXISTS project_subscriptions (
    block_type TEXT NOT NULL CHECK (block_type IN ('board','card')),
    block_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    notified_at INTEGER NOT NULL DEFAULT 0,
    create_at INTEGER NOT NULL,
    delete_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (block_id, subscriber_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_subscriptions_subscriber
     ON project_subscriptions(subscriber_id, delete_at)`,

  `CREATE TABLE IF NOT EXISTS project_shares (
    slug TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    show_comments INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_shares_board
     ON project_shares(user_id, board_id)`,

  `CREATE TABLE IF NOT EXISTS project_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
]

/**
 * Per-property settings that are not part of the column list: which board a relation points at, a
 * formula, or which roles may read and edit the property. Kept beside `project_properties` so the
 * hot property table's shape does not change for every new capability.
 */
export const PROJECT_PROPERTY_CONFIG_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_property_configs (
    board_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, property_id)
  )`,
]

/** One row per worked interval on a card; `ended_at` null means the timer is still running. */
export const PROJECT_TIME_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_time_entries (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_time_card
     ON project_time_entries(card_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_project_time_user
     ON project_time_entries(user_id, ended_at)`,
]

export const PROJECT_ENHANCE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS project_activity (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    type TEXT NOT NULL,
    target_id TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_activity_board
     ON project_activity(board_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_project_activity_created
     ON project_activity(created_at)`,

  `CREATE TABLE IF NOT EXISTS project_card_links (
    from_card_id TEXT NOT NULL,
    to_card_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('blocks','parent')),
    board_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_card_id, to_card_id, kind)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_card_links_to
     ON project_card_links(to_card_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_project_card_links_board
     ON project_card_links(board_id)`,

  `CREATE TABLE IF NOT EXISTS project_todo_links (
    card_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (card_id, todo_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_todo_links_todo
     ON project_todo_links(todo_id)`,
]

// Its own queue rather than notes' fts_index_queue: that table keys on note_id and its drain reads
// FROM notes, so sharing it would mean editing the notes search write path.
export const PROJECT_FTS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
    board_id, card_id, user_id, title, body,
    tokenize = "unicode61 remove_diacritics 2"
  )`,
  `CREATE TABLE IF NOT EXISTS project_fts_queue (
    user_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upsert','delete')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, card_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_fts_queue_due
     ON project_fts_queue(user_id, created_at, card_id)`,
]

export const PROJECT_REQUIRED_TABLES: readonly string[] = [
  'project_boards',
  'project_board_members',
  'project_properties',
  'project_cards',
  'project_card_values',
  'project_views',
  'project_card_contents',
  'project_comments',
  'project_categories',
  'project_category_boards',
  'project_attachments',
  'project_subscriptions',
  'project_shares',
  'project_settings',
  'project_activity',
  'project_card_links',
  'project_todo_links',
  'project_time_entries',
  'project_property_configs',
  'project_fts_queue',
  'project_fts',
]

export const PROJECT_REQUIRED_INDEXES: readonly string[] = [
  'idx_project_boards_owner',
  'idx_project_boards_template',
  'idx_project_members_user',
  'idx_project_properties_order',
  'idx_project_cards_board',
  'idx_project_cards_board_create',
  'idx_project_cards_parent',
  'idx_project_values_property',
  'idx_project_views_board',
  'idx_project_contents_card',
  'idx_project_contents_board',
  'idx_project_comments_card',
  'idx_project_comments_board',
  'idx_project_categories_user',
  'idx_project_category_boards_board',
  'idx_project_attachments_card',
  'idx_project_attachments_user',
  'idx_project_attachments_board',
  'idx_project_subscriptions_subscriber',
  'idx_project_shares_board',
  'idx_project_activity_board',
  'idx_project_activity_created',
  'idx_project_card_links_to',
  'idx_project_card_links_board',
  'idx_project_todo_links_todo',
  'idx_project_fts_queue_due',
]

// project_fts is deliberately absent: the boot's column repair replays CREATE TABLE declarations, and
// an fts5 virtual table has none to replay — its columns are changed by rebuilding it, not by ADD COLUMN.
export const PROJECT_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  project_boards: [
    'id', 'owner_id', 'type', 'minimum_role', 'title', 'description', 'icon', 'show_description',
    'is_template', 'template_version', 'created_by', 'modified_by', 'create_at', 'update_at',
    'delete_at', 'archived',
  ],
  project_board_members: ['board_id', 'user_id', 'role', 'created_at', 'updated_at'],
  project_properties: [
    'board_id', 'id', 'name', 'type', 'options', 'position', 'created_at', 'updated_at',
  ],
  project_cards: [
    'id', 'board_id', 'parent_id', 'title', 'icon', 'is_template', 'content_order', 'recurrence',
    'created_by', 'modified_by', 'create_at', 'update_at', 'delete_at',
  ],
  project_card_values: ['card_id', 'property_id', 'value', 'updated_at'],
  project_views: [
    'id', 'board_id', 'title', 'view_type', 'fields', 'position',
    'created_by', 'modified_by', 'create_at', 'update_at', 'delete_at',
  ],
  project_card_contents: [
    'id', 'card_id', 'board_id', 'type', 'title', 'fields', 'position',
    'created_by', 'modified_by', 'create_at', 'update_at', 'delete_at',
  ],
  project_comments: [
    'id', 'card_id', 'board_id', 'author_id', 'body', 'create_at', 'update_at', 'delete_at',
  ],
  project_categories: [
    'user_id', 'id', 'name', 'type', 'collapsed', 'sort_order', 'create_at', 'update_at', 'delete_at',
  ],
  project_category_boards: ['user_id', 'category_id', 'board_id', 'hidden', 'position', 'updated_at'],
  project_attachments: [
    'id', 'user_id', 'board_id', 'card_id', 'folder_id', 'filename', 'mime', 'size', 'storage',
    'object_key', 'width', 'height', 'thumbnail_key', 'is_starred', 'is_pinned', 'tags',
    'created_at', 'updated_at',
  ],
  project_subscriptions: [
    'block_type', 'block_id', 'subscriber_id', 'notified_at', 'create_at', 'delete_at',
  ],
  project_shares: [
    // The public link is read-only; comments are internal discussion unless the owner opts in.
    'slug', 'board_id', 'user_id', 'password_hash', 'expires_at', 'views', 'show_comments', 'created_at',
  ],
  project_settings: ['user_id', 'key', 'value', 'updated_at'],
  project_activity: ['board_id', 'id', 'actor_id', 'type', 'target_id', 'summary', 'created_at'],
  project_card_links: ['from_card_id', 'to_card_id', 'kind', 'board_id', 'created_at'],
  project_todo_links: ['card_id', 'todo_id', 'user_id', 'created_at'],
  project_fts_queue: ['user_id', 'card_id', 'kind', 'created_at'],
}