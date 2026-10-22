/**
 * The share hub's tables, in one array so a fresh database and a migrated one arrive at the same
 * shape by the same text.
 *
 * `SCHEMA_STATEMENTS` spreads this beside the `shares` table it hangs off, and migration 151 applies
 * the very same array to a database that predates the hub. Two copies — a declaration here and an
 * `ALTER`/`CREATE` list there — is how a fresh install and an upgraded one come to differ.
 */
export const SHARE_HUB_SCHEMA_STATEMENTS: readonly string[] = [
  // The hub's own organizer, shaped like `folders` and `tags` because it answers the same questions,
  // and deliberately not those two tables: a link's filing is the owner's decision about
  // *publishing*, and a note moving between folders would otherwise silently move a published
  // collection's readership with it.
  `CREATE TABLE IF NOT EXISTS share_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_folders_user
     ON share_folders(user_id, parent_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_share_folders_unique_sibling
     ON share_folders(user_id, IFNULL(parent_id, ''), lower(name))`,

  `CREATE TABLE IF NOT EXISTS share_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_share_tags_unique ON share_tags(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_share_tags_name_nocase
     ON share_tags(user_id, name COLLATE NOCASE)`,

  // One row per read of a public link. What a visit *is* (bot, owner, self-referral) is decided when
  // it is recorded and stored as a flag, so a reading never has to re-derive it from a `user_agent`
  // string that a later rule change would reinterpret. `visitor_fp` is a truncated keyed hash and
  // never the address it came from; it is what makes a distinct-visitor count possible without
  // storing anything that identifies a person.
  `CREATE TABLE IF NOT EXISTS share_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    visited_at INTEGER NOT NULL,
    visitor_fp TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    referrer TEXT,
    referrer_host TEXT,
    device_type TEXT,
    os TEXT,
    browser TEXT,
    language TEXT,
    user_agent TEXT,
    is_bot INTEGER NOT NULL DEFAULT 0,
    is_self_referrer INTEGER NOT NULL DEFAULT 0,
    is_owner INTEGER NOT NULL DEFAULT 0,
    -- The distribution marker: a validated token, an empty string when one was sent but refused,
    -- NULL when the URL carried none. Nothing derived from the refused raw value is ever stored.
    channel TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_visits_user_time
     ON share_visits(user_id, visited_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_share_visits_slug_time
     ON share_visits(slug, visited_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_share_visits_note_time
     ON share_visits(note_id, visited_at DESC)`,
  // Every dashboard reading except the raw one applies at least the bot filter, and most apply all
  // three; leading with the flags is what keeps "real visitors" off a full-window scan.
  `CREATE INDEX IF NOT EXISTS idx_share_visits_filter_time
     ON share_visits(user_id, is_bot, is_self_referrer, is_owner, visited_at DESC)`,
  // The retention sweep runs across every account at once, so no user-leading index can serve it.
  `CREATE INDEX IF NOT EXISTS idx_share_visits_retention ON share_visits(visited_at)`,

  // A published collection: a folder or a tag given a stable public address. The address and the
  // access policy are stored; the members are derived from the shares on every request, so a page
  // cannot show a link the owner has since revoked.
  `CREATE TABLE IF NOT EXISTS share_collections (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'tag', 'manual')),
    target_value TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    member_sort TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_share_collections_slug ON share_collections(slug)`,
  // One live directory per target: two enabled collections over the same folder would be two answers
  // to "what does this folder publish", and the disabled half of a rename is allowed to pile up.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_share_collections_target
     ON share_collections(user_id, target_type, target_value) WHERE is_enabled = 1`,
  `CREATE INDEX IF NOT EXISTS idx_share_collections_user
     ON share_collections(user_id, created_at DESC)`,

  // Hand-picked members only. A folder or tag collection derives its roster from the shares, so a
  // stored membership there would be a second answer that goes stale the moment a link moves.
  `CREATE TABLE IF NOT EXISTS share_collection_members (
    collection_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (collection_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_collection_members_note
     ON share_collection_members(note_id)`,

  // The share link's own change history: append-only, and a passcode is recorded as set/cleared
  // rather than as anything derived from it, because the previous hash is a secret the log has no
  // business repeating.
  `CREATE TABLE IF NOT EXISTS share_audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'revoke', 'batch')),
    changed_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_audit_log_user
     ON share_audit_log(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_share_audit_log_note
     ON share_audit_log(note_id, created_at DESC)`,
]

/**
 * The startup self-check's lists, derived from the statements above rather than retyped beside them.
 *
 * A table the schema creates and the check does not name is a table that can be missing from a live
 * database in silence, which is the exact failure the check exists for; generating the lists from the
 * one text that creates the tables means adding a table cannot be half-done.
 */
export const SHARE_HUB_REQUIRED_TABLES = [
  'share_folders',
  'share_tags',
  'share_visits',
  'share_collections',
  'share_collection_members',
  'share_audit_log',
] as const

export const SHARE_HUB_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  share_folders: ['id', 'user_id', 'parent_id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at'],
  share_tags: ['id', 'user_id', 'name', 'color', 'is_pinned', 'created_at'],
  share_visits: [
    'id',
    'user_id',
    'note_id',
    'slug',
    'visited_at',
    'visitor_fp',
    'country',
    'region',
    'city',
    'referrer',
    'referrer_host',
    'device_type',
    'os',
    'browser',
    'language',
    'user_agent',
    'is_bot',
    'is_self_referrer',
    'is_owner',
    'channel',
  ],
  share_collections: [
    'id',
    'slug',
    'user_id',
    'target_type',
    'target_value',
    'password_hash',
    'expires_at',
    'is_enabled',
    'member_sort',
    'title',
    'created_at',
    'updated_at',
  ],
  share_collection_members: ['collection_id', 'note_id', 'sort_order'],
  share_audit_log: ['id', 'user_id', 'note_id', 'slug', 'action', 'changed_json', 'created_at'],
}

export const SHARE_HUB_REQUIRED_INDEXES = [
  'idx_share_folders_user',
  'idx_share_folders_unique_sibling',
  'idx_share_tags_unique',
  'idx_share_tags_name_nocase',
  'idx_share_visits_user_time',
  'idx_share_visits_slug_time',
  'idx_share_visits_note_time',
  'idx_share_visits_filter_time',
  'idx_share_visits_retention',
  'idx_share_collections_slug',
  'idx_share_collections_target',
  'idx_share_collections_user',
  'idx_share_collection_members_note',
  'idx_share_audit_log_user',
  'idx_share_audit_log_note',
] as const
