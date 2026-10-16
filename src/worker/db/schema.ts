/** Defines the idempotent final D1 schema initialized by every Worker isolate. */
import type { DatabaseState, Env } from '../env'
import { getMeta, setMeta } from './metadata'
import { READER_BOOK_INDEX, READER_BOOK_TABLE, READER_GROUP_INDEX, READER_GROUP_TABLE, READER_SCHEMA_STATEMENTS } from './reader-schema'
import {
  ASSISTANT_REQUIRED_COLUMNS,
  ASSISTANT_REQUIRED_INDEXES,
  ASSISTANT_REQUIRED_TABLES,
  ASSISTANT_SCHEMA_STATEMENTS,
} from '../assistant/schema'

const BACKUP_ARCHIVES_TABLE = `CREATE TABLE IF NOT EXISTS backup_archives (
  user_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id, destination, archive_path)
)`
const BACKUP_ARCHIVES_INDEX = `CREATE INDEX IF NOT EXISTS idx_backup_archives_retention
  ON backup_archives(user_id, target_id, destination, created_at DESC, archive_path DESC)`

/**
 * The reader's library, one row per thing the account decides about.
 *
 * Article text is not here: a feed's entries are rebuilt from the network and live on the device
 * that fetched them, so what this schema keeps is the subscriptions, the folders, the tags, and the
 * marks a reader made — read, starred, later, hidden, opened, and the note an article became.
 */
const REWRITE_QUEUE_TABLE = `CREATE TABLE IF NOT EXISTS rewrite_queue (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  PRIMARY KEY (user_id, kind, source_id)
)`

/** Cron claims one account's oldest due row, so the queue is indexed per account. */
const REWRITE_QUEUE_INDEX = `CREATE INDEX IF NOT EXISTS idx_rewrite_queue_due
  ON rewrite_queue(user_id, created_at)`


const RSS_LIBRARY_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rss_feed (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    site_url TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    group_id TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error_at INTEGER NOT NULL DEFAULT 0,
    etag TEXT NOT NULL DEFAULT '',
    last_modified TEXT NOT NULL DEFAULT '',
    paused INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rss_feed_shelf ON rss_feed(user_id, group_id, position)`,

  `CREATE TABLE IF NOT EXISTS rss_feed_tag (
    user_id TEXT NOT NULL,
    feed_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (user_id, feed_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS rss_group (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0,
    icon TEXT,
    color TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  )`,

  /**
   * One row per (kind, article): the marks that used to be six arrays in a JSON blob.
   *
   * `value` carries what the mark points at — the note id for `note`/`copy` — and `at` when it was
   * made, which is what `opened` is and what lets a trimmed list keep its newest entries.
   */
  `CREATE TABLE IF NOT EXISTS rss_mark (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, entry_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rss_mark_recent ON rss_mark(user_id, kind, at DESC)`,

  /** The one row per account that is not a list: where the reader was, and when the row set last moved. */
  `CREATE TABLE IF NOT EXISTS rss_state (
    user_id TEXT PRIMARY KEY,
    last_channel TEXT NOT NULL DEFAULT '',
    saved_at INTEGER NOT NULL DEFAULT 0
  )`,
]

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    settings TEXT NOT NULL DEFAULT '{}',
    template_library TEXT,
    quickadd TEXT,
    rss TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, parent_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_sibling
     ON folders(user_id, IFNULL(parent_id, ''), lower(name)) WHERE deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    folder_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    title_key TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 1,
    word_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user_updated
     ON notes(user_id, deleted_at, is_archived, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_updated
     ON notes(user_id, deleted_at, is_archived, is_pinned DESC, updated_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(user_id, folder_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(user_id, is_starred, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes(user_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_title_key
     ON notes(user_id, title_key, deleted_at, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id, id)`,

  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    is_manual INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique ON tags(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(user_id, name COLLATE NOCASE)`,

  `CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (note_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`,

  `CREATE TABLE IF NOT EXISTS links (
    source_note_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    target_title TEXT NOT NULL,
    target_note_id TEXT,
    user_id TEXT NOT NULL,
    PRIMARY KEY (source_note_id, target_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_links_target ON links(user_id, target_key)`,
  `CREATE INDEX IF NOT EXISTS idx_links_target_note ON links(target_note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_links_user_target ON links(user_id, target_note_id)`,

  `CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_user ON note_versions(user_id)`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    note_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    storage TEXT NOT NULL CHECK (storage IN ('r2', 'kv')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id)`,

  `CREATE TABLE IF NOT EXISTS attachment_cleanup (
    object_key TEXT PRIMARY KEY CHECK (object_key GLOB 'r2:?*' OR object_key GLOB 'kv:?*'),
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_created
     ON attachment_cleanup(created_at, object_key)`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_user
     ON attachment_cleanup(user_id, created_at, object_key)`,

  `CREATE TABLE IF NOT EXISTS import_mappings (
    user_id TEXT NOT NULL,
    entity TEXT NOT NULL CHECK (entity IN ('note', 'attachment')),
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_import_mappings_target
     ON import_mappings(user_id, entity, target_id)`,

  `CREATE TABLE IF NOT EXISTS backup_targets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    secret TEXT,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_targets_user ON backup_targets(user_id, created_at)`,
  BACKUP_ARCHIVES_TABLE,
  BACKUP_ARCHIVES_INDEX,

  `CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    note_count INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_user ON backup_runs(user_id, started_at DESC, id DESC)`,

  `CREATE TABLE IF NOT EXISTS shares (
    slug TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares(user_id, created_at DESC, slug DESC)`,

  `CREATE TABLE IF NOT EXISTS share_asset_sessions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_asset_sessions_slug
     ON share_asset_sessions(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_share_asset_sessions_expires
     ON share_asset_sessions(expires_at)`,

  // One row per shared note currently being presented to an audience. Keyed by slug because that is
  // all a viewer knows, and one row per share is the decision that "a share has one show at a time"
  // enforced by the schema rather than by convention. The token is stored hashed for the same reason
  // session tokens are: this row is the capability that lets a stranger read where a talk is, and a
  // leaked row must not be a leaked link. Nothing else lives here — no viewer identifiers, no per-page
  // history, no counts — and the lease in `expires_at` is what stops a forgotten show from answering
  // forever.
  `CREATE TABLE IF NOT EXISTS share_presence (
    slug TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    slide INTEGER NOT NULL DEFAULT 0,
    page INTEGER NOT NULL DEFAULT 0,
    step INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_share_presence_user ON share_presence(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_share_presence_expiry ON share_presence(expires_at)`,

  `CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_changes_user ON changes(user_id, seq)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_at INTEGER NOT NULL,
    locked_until INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts_last_fail ON login_attempts(last_fail_at)`,

  `CREATE TABLE IF NOT EXISTS totp_credentials (
    user_id TEXT PRIMARY KEY,
    secret_ciphertext TEXT NOT NULL,
    enabled_at INTEGER,
    pending_token_hash TEXT,
    pending_session_id TEXT,
    pending_expires_at INTEGER,
    recovery_generation TEXT NOT NULL DEFAULT '',
    last_used_step INTEGER,
    last_used_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS totp_recovery_codes (
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    generation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    PRIMARY KEY (user_id, code_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_totp_recovery_codes_user
     ON totp_recovery_codes(user_id, generation, used_at)`,

  `CREATE TABLE IF NOT EXISTS totp_login_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_totp_challenges_user
     ON totp_login_challenges(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires
     ON totp_login_challenges(expires_at)`,

  `CREATE TABLE IF NOT EXISTS mcp_preferences (
    user_id TEXT PRIMARY KEY,
    write_enabled INTEGER NOT NULL DEFAULT 1 CHECK (write_enabled IN (0, 1)),
    trash_enabled INTEGER NOT NULL DEFAULT 0 CHECK (trash_enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_operations (
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_operations_created
     ON mcp_operations(created_at)`,

  `CREATE TABLE IF NOT EXISTS mcp_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT 'notes:read',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_user
     ON mcp_api_keys(user_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_revoked
     ON mcp_api_keys(revoked_at)`,

  `CREATE TABLE IF NOT EXISTS ai_note_embeddings (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    indexed_at INTEGER NOT NULL,
    norm REAL,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_embeddings_indexed
     ON ai_note_embeddings(user_id, indexed_at)`,

  `CREATE TABLE IF NOT EXISTS ai_index_queue (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('embed', 'delete')),
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_index_queue_due
     ON ai_index_queue(user_id, created_at, note_id)`,

  `CREATE TABLE IF NOT EXISTS fts_index_queue (
    user_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, note_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fts_index_queue_due
     ON fts_index_queue(user_id, created_at, note_id)`,
  `CREATE TABLE IF NOT EXISTS community_templates (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    category TEXT NOT NULL DEFAULT '',
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_community_templates_created
     ON community_templates(created_at DESC, id)`,
  `CREATE INDEX IF NOT EXISTS idx_community_templates_author
     ON community_templates(author_id)`,

  // The rewrite queue is also migration 22 and 24, but a database whose ledger already holds those
  // numbers for other work would never get them: a required table cannot depend on a version number.
  REWRITE_QUEUE_TABLE,
  REWRITE_QUEUE_INDEX,
  ...READER_SCHEMA_STATEMENTS,

  ...RSS_LIBRARY_STATEMENTS,
  ...ASSISTANT_SCHEMA_STATEMENTS,
]

export interface SchemaMigration {
  version: number
  statements: readonly string[]
  skipIfColumnExists?: { table: string; column: string }
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    // Explicit whitelist (not a regex over SCHEMA_STATEMENTS) so later
    // additions like mcp_api_keys can never be picked up accidentally.
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS mcp_preferences (
         user_id TEXT PRIMARY KEY,
         write_enabled INTEGER NOT NULL DEFAULT 1 CHECK (write_enabled IN (0, 1)),
         trash_enabled INTEGER NOT NULL DEFAULT 0 CHECK (trash_enabled IN (0, 1)),
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS mcp_operations (
         user_id TEXT NOT NULL,
         operation_id TEXT NOT NULL,
         tool TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         response_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         PRIMARY KEY (user_id, operation_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_mcp_operations_created
         ON mcp_operations(created_at)`,
    ],
  },
  {
    // Only CREATE TABLE / INDEX statements: D1 does not reliably support
    // ALTER TABLE ADD COLUMN with constraints, so the AI search preference
    // lives in app_meta (key `ai-search-enabled:<userId>`) instead of a
    // new column on the pre-existing mcp_preferences table.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS mcp_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT 'notes:read',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_user
         ON mcp_api_keys(user_id, revoked_at)`,
      `CREATE TABLE IF NOT EXISTS ai_note_embeddings (
        user_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, note_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_embeddings_indexed
         ON ai_note_embeddings(user_id, indexed_at)`,
      `CREATE TABLE IF NOT EXISTS ai_index_queue (
        user_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('embed', 'delete')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, note_id)
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS fts_index_queue (
        user_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, note_id)
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_fts_index_queue_due
         ON fts_index_queue(user_id, created_at, note_id)`,
    ],
  },
  {
    version: 5,
    skipIfColumnExists: { table: 'folders', column: 'color' },
    statements: [
      `ALTER TABLE folders ADD COLUMN color TEXT`,
    ],
  },
  {
    version: 6,
    skipIfColumnExists: { table: 'tags', column: 'is_manual' },
    statements: [
      `ALTER TABLE tags ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments(user_id, sha256)`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_ai_index_queue_due
         ON ai_index_queue(user_id, created_at, note_id)`,
    ],
  },
  {
    version: 9,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_user
         ON attachment_cleanup(user_id, created_at, object_key)`,
    ],
  },
  {
    version: 10,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_revoked
         ON mcp_api_keys(revoked_at)`,
    ],
  },
  {
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS totp_credentials (
        user_id TEXT PRIMARY KEY,
        secret_ciphertext TEXT NOT NULL,
        enabled_at INTEGER,
        pending_token_hash TEXT,
        pending_session_id TEXT,
        pending_expires_at INTEGER,
        recovery_generation TEXT NOT NULL DEFAULT '',
        last_used_step INTEGER,
        last_used_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS totp_recovery_codes (
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        generation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by TEXT,
        PRIMARY KEY (user_id, code_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_totp_recovery_codes_user
         ON totp_recovery_codes(user_id, generation, used_at)`,
      `CREATE TABLE IF NOT EXISTS totp_login_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_by TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_totp_challenges_user
         ON totp_login_challenges(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires
         ON totp_login_challenges(expires_at)`,
    ],
  },
  {
    version: 12,
    statements: [
      `DROP INDEX IF EXISTS idx_versions_note`,
      `CREATE INDEX idx_versions_note ON note_versions(note_id, created_at DESC, id DESC)`,
      `DROP INDEX IF EXISTS idx_runs_user`,
      `CREATE INDEX idx_runs_user ON backup_runs(user_id, started_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_nocase ON tags(user_id, name COLLATE NOCASE)`,
      `CREATE INDEX IF NOT EXISTS idx_versions_user ON note_versions(user_id)`,
    ],
  },
  {
    version: 13,
    statements: [BACKUP_ARCHIVES_TABLE, BACKUP_ARCHIVES_INDEX],
  },
  {
    version: 14,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_links_user_target ON links(user_id, target_note_id)`,
    ],
  },
  {
    version: 15,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_updated
         ON notes(user_id, deleted_at, is_archived, is_pinned DESC, updated_at DESC, id)`,
    ],
  },
  {
    version: 16,
    statements: [`ALTER TABLE ai_note_embeddings ADD COLUMN norm REAL`],
    skipIfColumnExists: { table: 'ai_note_embeddings', column: 'norm' },
  },
  {
    version: 17,
    statements: [REWRITE_QUEUE_TABLE],
  },
  {
    version: 18,
    statements: [
      `ALTER TABLE ai_index_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
    ],
    skipIfColumnExists: { table: 'ai_index_queue', column: 'attempts' },
  },
  {
    version: 19,
    statements: [
      `ALTER TABLE ai_index_queue ADD COLUMN next_retry_at INTEGER`,
    ],
    skipIfColumnExists: { table: 'ai_index_queue', column: 'next_retry_at' },
  },
  {
    version: 20,
    statements: [REWRITE_QUEUE_INDEX],
  },
  {
    version: 21,
    statements: [`ALTER TABLE rewrite_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`],
    skipIfColumnExists: { table: 'rewrite_queue', column: 'attempts' },
  },
  {
    version: 22,
    statements: [`ALTER TABLE rewrite_queue ADD COLUMN claimed_at INTEGER`],
    skipIfColumnExists: { table: 'rewrite_queue', column: 'claimed_at' },
  },
  {
    // The list endpoint can order by created_at or title as well; without a matching
    // compound index SQLite sorts every visible row (up to notesMaxPerUser) per page.
    // EXPLAIN on a 5k-row replica: created/title orderings report
    // "USE TEMP B-TREE FOR ORDER BY" until these exist.
    version: 23,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_created
         ON notes(user_id, deleted_at, is_archived, is_pinned DESC, created_at DESC, id)`,
      `CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_title
         ON notes(user_id, deleted_at, is_archived, is_pinned DESC, title COLLATE NOCASE DESC, id)`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_user_size ON attachments(user_id, size)`,
    ],
  },
  {
    // EXPLAIN on a 594-link replica: /api/graph's edge fetch moves from
    // "USING INDEX idx_links_user_target (user_id=?)" — a scan of every link the
    // user owns — to "(user_id=? AND source_note_id=?)". The two OR-shaped
    // predicates (includeOrphans, local BFS) keep their old plans: one index
    // cannot serve an OR across two columns.
    version: 24,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_links_user_source ON links(user_id, source_note_id)`,
    ],
  },
  {
    // The shared template directory: one row per published template, listed newest first.
    version: 26,
    statements: [
      `CREATE TABLE IF NOT EXISTS community_templates (
         id TEXT PRIMARY KEY,
         author_id TEXT NOT NULL,
         author_name TEXT NOT NULL,
         name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         content TEXT NOT NULL,
         tags TEXT NOT NULL DEFAULT '[]',
         category TEXT NOT NULL DEFAULT '',
         uses INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_community_templates_created
         ON community_templates(created_at DESC, id)`,
      `CREATE INDEX IF NOT EXISTS idx_community_templates_author
         ON community_templates(author_id)`,
    ],
  },
  {
    // The account's own template library, so it survives a cleared browser and travels
    // between devices the way `settings` does. `skipIfColumnExists` because a fresh
    // database already gets the column from SCHEMA_STATEMENTS.
    version: 27,
    skipIfColumnExists: { table: 'users', column: 'template_library' },
    statements: [
      `ALTER TABLE users ADD COLUMN template_library TEXT`,
    ],
  },
  {
    // How many accounts adopted each published template. `skipIfColumnExists` because a
    // fresh database already gets the column from SCHEMA_STATEMENTS and from version 26.
    version: 28,
    skipIfColumnExists: { table: 'community_templates', column: 'uses' },
    statements: [
      `ALTER TABLE community_templates ADD COLUMN uses INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The account's reading library: subscriptions, groups and what has been read. Beside
    // `quickadd` for the same reason as that column — a cleared browser and another device must
    // both find it — and as its own column rather than inside `settings`, because a few hundred
    // feeds would crowd out every preference the account has.
    version: 30,
    skipIfColumnExists: { table: 'users', column: 'rss' },
    statements: [
      `ALTER TABLE users ADD COLUMN rss TEXT`,
    ],
  },
  {
    // The reader's shelf and reading state, so a cleared browser or a second device finds the books
    // where they were left. `IF NOT EXISTS` because a fresh database already gets them from
    // SCHEMA_STATEMENTS.
    version: 30,
    statements: READER_SCHEMA_STATEMENTS,
  },
  {
    // The flag saying a book's file is in R2, so a shelf that predates the sync can be filled in.
    version: 31,
    skipIfColumnExists: { table: 'reader_books', column: 'has_blob' },
    statements: [
      `ALTER TABLE reader_books ADD COLUMN has_blob INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The cover as its own object, so a second device can paint the shelf without pulling 40 MB of book.
    version: 32,
    skipIfColumnExists: { table: 'reader_books', column: 'cover_key' },
    statements: [
      `ALTER TABLE reader_books ADD COLUMN cover_key TEXT`,
      `ALTER TABLE reader_books ADD COLUMN cover_size INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The reader's own groupings of the shelf. `IF NOT EXISTS` because a fresh database already gets
    // them from SCHEMA_STATEMENTS.
    version: 33,
    statements: [READER_GROUP_TABLE, READER_GROUP_INDEX],
  },
  {
    // The reading library as rows instead of one JSON column: one row per feed, per tag, per
    // folder, per mark. Article text is deliberately absent — only the decisions travel.
    version: 34,
    statements: RSS_LIBRARY_STATEMENTS,
  },
  {
    // The chat app's three later additions. Each is already in the table definition above, so only a
    // database created before the round that added it needs the ALTER; `skipIfColumnExists` makes that
    // a no-op on a fresh install, where the CREATE already carried the column.
    version: 35,
    skipIfColumnExists: { table: 'chat_conversations', column: 'folder_id' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN folder_id TEXT`,
    ],
  },
  {
    version: 36,
    skipIfColumnExists: { table: 'chat_usage_daily', column: 'embeddings' },
    statements: [
      `ALTER TABLE chat_usage_daily ADD COLUMN embeddings INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 37,
    skipIfColumnExists: { table: 'chat_conversations', column: 'starred' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The composer's two per-model capabilities: how much the model is asked to think, and how much
    // context it is fed. Both were added together, so one database missing either is one from before both.
    version: 38,
    skipIfColumnExists: { table: 'chat_models', column: 'reasoning' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN reasoning TEXT NOT NULL DEFAULT 'auto'`,
    ],
  },
  {
    version: 39,
    skipIfColumnExists: { table: 'chat_models', column: 'context_tokens' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN context_tokens INTEGER`,
    ],
  },
  {
    // Whether the model may be shown an image at all. Measured against a live endpoint, not assumed:
    // a text-only model that is sent a picture answers with an error the reader did not cause.
    version: 40,
    skipIfColumnExists: { table: 'chat_models', column: 'vision' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN vision INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // A message's own attachment ids, so a picture or a file stays with the turn that used it.
    //
    // Appended as 37 rather than slotted in beside the other chat columns: a version number is an
    // identity, and an account that already recorded 35 as applied would never run a second meaning
    // of it. That is exactly how a missing column survived every restart here.
    version: 41,
    skipIfColumnExists: { table: 'chat_messages', column: 'attachments' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // purpose: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 42,
    skipIfColumnExists: { table: 'chat_models', column: 'purpose' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN purpose TEXT NOT NULL DEFAULT 'chat'`,
    ],
  },
  {
    // kind: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 43,
    skipIfColumnExists: { table: 'chat_models', column: 'kind' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`,
    ],
  },
  {
    // supports_tools: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 44,
    skipIfColumnExists: { table: 'chat_models', column: 'supports_tools' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // max_input_tokens: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 45,
    skipIfColumnExists: { table: 'chat_models', column: 'max_input_tokens' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN max_input_tokens INTEGER`,
    ],
  },
  {
    // top_p: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 46,
    skipIfColumnExists: { table: 'chat_models', column: 'top_p' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN top_p REAL`,
    ],
  },
  // Version 43 is spent: it added `chat_models.streaming`, a switch nothing could read, and it was
  // dropped before release. Do not reuse the number — an account that recorded it would silently skip
  // whatever else claimed it. The next chat migration is 45.
  {
    // custom_params: one version per column. A version number is an identity, and one entry that adds two
    // columns cannot be retried for the half that failed on an account which already recorded it.
    version: 47,
    skipIfColumnExists: { table: 'chat_models', column: 'custom_params' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN custom_params TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The reader's saved prompts. Created here as well as in the table list so an account that has been
    // running since before the prompt library exists gets it on the next boot.
    version: 48,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_prompts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_prompts_user ON chat_prompts(user_id, updated_at)`,
    ],
  },
  {
    version: 49,
    skipIfColumnExists: { table: 'chat_messages', column: 'duration_ms' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The answers a retry displaced. Created here as well as in the table list so an account that has
    // been running since before answer history exists gets it on the next boot.
    version: 50,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_answer_versions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    model_label TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_answer_versions_message ON chat_answer_versions(user_id, message_id, created_at, id)`,
    ],
  },
  {
    version: 51,
    skipIfColumnExists: { table: 'chat_messages', column: 'model_label' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN model_label TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 52,
    skipIfColumnExists: { table: 'chat_models', column: 'modalities' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN modalities TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The reader's own external MCP servers. Created here as well as in the table list so an account that
    // has been running since before this existed gets it on the next boot.
    version: 53,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_mcp_servers (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    header_ciphertext TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT 'streamableHttp',
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    tool_mode TEXT NOT NULL DEFAULT 'ask',
    disabled_tools TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_mcp_servers_user ON chat_mcp_servers(user_id, created_at)`,
    ],
  },
  {
    // An external tool call cannot be replayed from a target id the way deleting a note can: its
    // arguments are the whole proposal, so the approved row has to carry them.
    version: 54,
    skipIfColumnExists: { table: 'chat_pending_actions', column: 'args' },
    statements: [
      `ALTER TABLE chat_pending_actions ADD COLUMN args TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // One gateway can answer on more than one wire, so the other addresses belong to the provider.
    version: 55,
    skipIfColumnExists: { table: 'chat_providers', column: 'endpoints' },
    statements: [
      `ALTER TABLE chat_providers ADD COLUMN endpoints TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // Which of those wires a model is called on; null keeps following the provider.
    version: 56,
    skipIfColumnExists: { table: 'chat_models', column: 'protocol' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN protocol TEXT`,
    ],  },
  {
    // An MCP server is one switch for the reader and a dozen switches inside it: a third party's tools are
    // not equally trusted, and hiding a whole server was the only thing the row could say before. The
    // column holds the server's own names for the tools that are off.
    version: 57,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'disabled_tools' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // A server's card said where it lives and nothing about what it is for. A reader with three of them is
    // the one who needs the reminder, and the form's own placeholder is the whole reason it exists.
    version: 58,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'description' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // Which protocol the address speaks. Stored rather than assumed even though one transport is offered
    // today: a row has to say what it is, or a second one could never be told apart from the first.
    version: 59,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'transport' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'streamableHttp'`,
    ],
  },
  {
    // How long to wait for one answer. It was a constant in the client, which made a slow third party
    // unfixable from the screen that added it.
    version: 60,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'timeout_seconds' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 30`,
    ],
  },
  {
    // What the model thought before it answered. It only ever lived in the streaming turn, so a thread
    // reopened the next morning showed an answer whose reasoning had never been filed at all.
    version: 61,
    skipIfColumnExists: { table: 'chat_messages', column: 'reasoning' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // The same trace on a displaced answer, so paging back to an earlier reply shows the thinking that
    // reply was written by rather than the one the reader just replaced it with.
    version: 62,
    skipIfColumnExists: { table: 'chat_answer_versions', column: 'reasoning' },
    statements: [
      `ALTER TABLE chat_answer_versions ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // Which thinking contract an address speaks, when the reader has to say so: a gateway's hostname and a
    // proxied model name are the two things the inference in `reasoning.ts` cannot read. Null is "no pin",
    // which is how a model's own protocol column already says "follow the provider".
    version: 63,
    skipIfColumnExists: { table: 'chat_providers', column: 'reasoning_dialect' },
    statements: [
      `ALTER TABLE chat_providers ADD COLUMN reasoning_dialect TEXT`,
    ],
  },
  {
    // What the model costs, so the usage screen can answer "what did this cost me" instead of leaving the
    // reader to multiply tokens by a price they looked up elsewhere. One version per column, for the
    // reason the entries above give.
    version: 65,
    skipIfColumnExists: { table: 'chat_models', column: 'input_price' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN input_price REAL`,
    ],
  },
  {
    version: 66,
    skipIfColumnExists: { table: 'chat_models', column: 'output_price' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN output_price REAL`,
    ],
  },
  {
    // The currency the two prices are in. Free text because the bill is in whatever the provider bills
    // in, and a closed list would be a list this app has to keep up to date for no gain.
    version: 67,
    skipIfColumnExists: { table: 'chat_models', column: 'price_currency' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN price_currency TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // The pages a web search consulted. A JSON array on the row because it is read with the answer and
    // written once: a table of sources would be joined for every message to show a list of links.
    version: 68,
    skipIfColumnExists: { table: 'chat_messages', column: 'sources' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The reader's verdict on one answer: 'up', 'down' or ''. Kept on the message rather than in a table
    // of its own because a turn has at most one verdict and the transcript is what reads it — but it is
    // stored at all so the judgement outlives the scroll, which a chip held in a component would not.
    version: 64,
    skipIfColumnExists: { table: 'chat_messages', column: 'feedback' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN feedback TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // A project's standing instructions: the text every conversation inside it is answered under.
    version: 69,
    skipIfColumnExists: { table: 'chat_projects', column: 'instructions' },
    statements: [
      `ALTER TABLE chat_projects ADD COLUMN instructions TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // The folders a project reads its knowledge from, as a JSON array of folder ids.
    version: 70,
    skipIfColumnExists: { table: 'chat_projects', column: 'note_scope' },
    statements: [
      `ALTER TABLE chat_projects ADD COLUMN note_scope TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The model a project prefers, when the reader has said so.
    version: 71,
    skipIfColumnExists: { table: 'chat_projects', column: 'model_id' },
    statements: [
      `ALTER TABLE chat_projects ADD COLUMN model_id TEXT`,
    ],
  },
  {
    // Which project a conversation belongs to.
    version: 72,
    skipIfColumnExists: { table: 'chat_conversations', column: 'project_id' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN project_id TEXT`,
    ],
  },
  {
    // A saved prompt's tool set: the names the assistant can actually call, as a JSON array.
    version: 73,
    skipIfColumnExists: { table: 'chat_prompts', column: 'tools' },
    statements: [
      `ALTER TABLE chat_prompts ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The note folders and tags a saved prompt reads, in the same shape one turn pins with `#`.
    version: 74,
    skipIfColumnExists: { table: 'chat_prompts', column: 'scopes' },
    statements: [
      `ALTER TABLE chat_prompts ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The model a saved prompt answers with, when the reader named one.
    version: 75,
    skipIfColumnExists: { table: 'chat_prompts', column: 'model_id' },
    statements: [
      `ALTER TABLE chat_prompts ADD COLUMN model_id TEXT`,
    ],
  },
  {
    // The tokens of an authorized MCP server, vaulted the same way its static headers already are.
    version: 76,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'oauth_ciphertext' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN oauth_ciphertext TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // What the MCP server's own discovery said: endpoints, scopes, client id and when the token dies.
    // Plain on purpose — none of it is a secret, and a settings screen that lists ten servers would pay
    // ten vault round trips to say "authorized until Friday".
    version: 77,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'oauth_meta' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN oauth_meta TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // The words a document's own bytes carry but the worker cannot pull out — a PDF's text layer, read
    // in the browser where the parser already runs. Stored beside the file so the model is shown the
    // contents on every turn, not only the one that carried the upload.
    version: 78,
    skipIfColumnExists: { table: 'chat_attachments', column: 'extracted_text' },
    statements: [
      `ALTER TABLE chat_attachments ADD COLUMN extracted_text TEXT`,
    ],
  },
  {
    // When the provider's own key last signed a call, so rotation can prefer the least recently used one
    // instead of always starting from the same key. Extra keys carry their own column on their own row.
    version: 79,
    skipIfColumnExists: { table: 'chat_providers', column: 'key_last_used_at' },
    statements: [
      `ALTER TABLE chat_providers ADD COLUMN key_last_used_at INTEGER`,
    ],
  },
  {
    // The model a turn falls back to when this one cannot answer at all. A plain column rather than a
    // table: a spare is one model, not a set, and the chain is followed through the column itself.
    version: 80,
    skipIfColumnExists: { table: 'chat_models', column: 'fallback_model_id' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN fallback_model_id TEXT`,
    ],
  },
  {
    // The emoji a saved skill wears in the library, so a reader with a dozen of them can find one by
    // sight rather than by reading every title. Empty is a skill that never picked one, which is every
    // row written before this column existed.
    version: 81,
    skipIfColumnExists: { table: 'chat_prompts', column: 'icon' },
    statements: [
      `ALTER TABLE chat_prompts ADD COLUMN icon TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // The three-way mode moves from the server's own row down to each of its tools: "this server may
    // write" and "this one function may write" are different questions, and only the second one is the
    // reader's real answer. A tool that was switched off is exactly a tool set to 'off', so the old list
    // is converted rather than carried alongside — two fields for one setting is how two answers drift.
    version: 82,
    skipIfColumnExists: { table: 'chat_mcp_servers', column: 'tool_modes' },
    statements: [
      `ALTER TABLE chat_mcp_servers ADD COLUMN tool_modes TEXT NOT NULL DEFAULT '{}'`,
      `UPDATE chat_mcp_servers SET tool_modes = (
         SELECT json_group_object(value, 'off') FROM json_each(chat_mcp_servers.disabled_tools)
       ) WHERE json_valid(disabled_tools) AND json_array_length(disabled_tools) > 0`,
      `ALTER TABLE chat_mcp_servers DROP COLUMN disabled_tools`,
    ],
  },
]

const FTS_STATEMENT = `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id,
  user_id,
  title,
  body,
  tokenize = "unicode61 remove_diacritics 2"
)`

const DATABASE_STATE_KEY = 'database-state-v1'

const TABLE_SCHEMA_STATEMENTS = SCHEMA_STATEMENTS.filter((statement) =>
  /^\s*CREATE TABLE IF NOT EXISTS/.test(statement),
)
const INDEX_SCHEMA_STATEMENTS = SCHEMA_STATEMENTS.filter((statement) =>
  /^\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/.test(statement),
)

export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  app_meta: ['key', 'value'],
  schema_migrations: ['version', 'applied_at'],
  users: ['id', 'username', 'password_hash', 'login', 'name', 'avatar_url', 'role', 'settings', 'template_library', 'quickadd', 'rss', 'created_at', 'last_seen_at'],
  folders: ['id', 'user_id', 'parent_id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at', 'deleted_at'],
  notes: ['id', 'user_id', 'folder_id', 'title', 'title_key', 'content', 'excerpt', 'rev', 'word_count', 'char_count', 'is_pinned', 'is_starred', 'is_archived', 'position', 'content_hash', 'created_at', 'updated_at', 'deleted_at'],
  tags: ['id', 'user_id', 'name', 'color', 'is_manual', 'created_at'],
  note_tags: ['note_id', 'tag_id'],
  links: ['source_note_id', 'target_key', 'target_title', 'target_note_id', 'user_id'],
  note_versions: ['id', 'note_id', 'user_id', 'title', 'content', 'size', 'created_at'],
  attachments: ['id', 'user_id', 'note_id', 'filename', 'mime', 'size', 'sha256', 'width', 'height', 'storage', 'created_at'],
  attachment_cleanup: ['object_key', 'user_id', 'created_at'],
  import_mappings: ['user_id', 'entity', 'source_id', 'target_id', 'updated_at'],
  backup_targets: ['id', 'user_id', 'type', 'name', 'enabled', 'config', 'secret', 'last_run_at', 'last_status', 'last_error', 'created_at', 'updated_at'],
  backup_archives: ['user_id', 'target_id', 'destination', 'archive_path', 'created_at'],
  backup_runs: ['id', 'user_id', 'trigger', 'status', 'started_at', 'finished_at', 'note_count', 'file_count', 'bytes', 'detail'],
  shares: ['slug', 'note_id', 'user_id', 'password_hash', 'expires_at', 'views', 'created_at'],
  share_asset_sessions: ['id', 'slug', 'password_hash', 'expires_at', 'created_at'],
  changes: ['seq', 'user_id', 'entity', 'entity_id', 'op', 'at'],
  sessions: ['id', 'user_id', 'expires_at', 'created_at'],
  login_attempts: ['key', 'fails', 'last_fail_at', 'locked_until'],
  totp_credentials: ['user_id', 'secret_ciphertext', 'enabled_at', 'pending_token_hash', 'pending_session_id', 'pending_expires_at', 'recovery_generation', 'last_used_step', 'last_used_by', 'created_at', 'updated_at'],
  totp_recovery_codes: ['user_id', 'code_hash', 'generation', 'created_at', 'used_at', 'used_by'],
  totp_login_challenges: ['id', 'user_id', 'expires_at', 'claimed_by', 'created_at'],
  mcp_preferences: ['user_id', 'write_enabled', 'trash_enabled', 'updated_at'],
  mcp_operations: ['user_id', 'operation_id', 'tool', 'request_hash', 'response_json', 'created_at'],
  mcp_api_keys: ['id', 'user_id', 'name', 'key_hash', 'scopes', 'created_at', 'last_used_at', 'revoked_at'],
  ai_note_embeddings: ['user_id', 'note_id', 'model', 'vector', 'indexed_at', 'norm'],
  ai_index_queue: ['user_id', 'note_id', 'kind', 'created_at', 'attempts', 'next_retry_at'],
  fts_index_queue: ['user_id', 'note_id', 'kind', 'created_at'],
  rewrite_queue: ['user_id', 'kind', 'source_id', 'old_value', 'new_value', 'created_at', 'attempts', 'claimed_at'],
  community_templates: ['id', 'author_id', 'author_name', 'name', 'description', 'content', 'tags', 'category', 'uses', 'created_at'],
  rss_feed: ['user_id', 'id', 'url', 'title', 'site_url', 'image_url', 'group_id', 'position', 'updated_at', 'last_attempt_at', 'error', 'error_count', 'last_error_at', 'etag', 'last_modified', 'paused', 'pinned'],
  rss_feed_tag: ['user_id', 'feed_id', 'tag'],
  rss_group: ['user_id', 'id', 'parent_id', 'name', 'position', 'collapsed', 'icon', 'color', 'created_at', 'updated_at'],
  rss_mark: ['user_id', 'kind', 'entry_id', 'value', 'at'],
  rss_state: ['user_id', 'last_channel', 'saved_at'],
  ...ASSISTANT_REQUIRED_COLUMNS,
} as const

const REQUIRED_TABLES = [
  'app_meta',
  'schema_migrations',
  'users',
  'folders',
  'notes',
  'tags',
  'note_tags',
  'links',
  'note_versions',
  'attachments',
  'attachment_cleanup',
  'import_mappings',
  'backup_targets',
  'backup_archives',
  'backup_runs',
  'shares',
  'share_asset_sessions',
  'share_presence',
  'changes',
  'sessions',
  'login_attempts',
  'totp_credentials',
  'totp_recovery_codes',
  'totp_login_challenges',
  'mcp_preferences',
  'mcp_operations',
  'mcp_api_keys',
  'ai_note_embeddings',
  'ai_index_queue',
  'fts_index_queue',
  'rewrite_queue',
  'community_templates',
  'reader_books',
  'reader_groups',
  'reader_progress',
  'reader_highlights',
  'reader_marks',
  'reader_stats',
  'reader_notes',
  'reader_meta',
  'rss_feed',
  'rss_feed_tag',
  'rss_group',
  'rss_mark',
  'rss_state',
  ...ASSISTANT_REQUIRED_TABLES,
] as const

const REQUIRED_INDEXES = [
  'idx_folders_user',
  'idx_folders_unique_sibling',
  'idx_notes_user_updated',
  'idx_notes_user_pinned_updated',
  'idx_notes_folder',
  'idx_notes_starred',
  'idx_notes_trash',
  'idx_notes_title_key',
  'idx_notes_user_id',
  'idx_tags_unique',
  'idx_tags_name_nocase',
  'idx_note_tags_tag',
  'idx_links_target',
  'idx_links_target_note',
  'idx_links_user_target',
  'idx_links_user_source',
  'idx_versions_note',
  'idx_versions_user',
  'idx_attachments_user',
  'idx_attachments_user_sha',
  'idx_attachments_note',
  'idx_attachment_cleanup_created',
  'idx_attachment_cleanup_user',
  'idx_import_mappings_target',
  'idx_targets_user',
  'idx_reader_books_user',
  'idx_reader_groups_user',
  'idx_reader_highlights_book',
  'idx_reader_marks_book',
  'idx_backup_archives_retention',
  'idx_runs_user',
  'idx_shares_note',
  'idx_shares_user_created',
  'idx_share_asset_sessions_slug',
  'idx_share_asset_sessions_expires',
  'idx_changes_user',
  'idx_sessions_user',
  'idx_sessions_expires',
  'idx_login_attempts_last_fail',
  'idx_totp_recovery_codes_user',
  'idx_totp_challenges_user',
  'idx_totp_challenges_expires',
  'idx_mcp_operations_created',
  'idx_mcp_api_keys_user',
  'idx_mcp_api_keys_revoked',
  'idx_ai_embeddings_indexed',
  'idx_ai_index_queue_due',
  'idx_fts_index_queue_due',
  'idx_rewrite_queue_due',
  'idx_notes_user_pinned_created',
  'idx_notes_user_pinned_title',
  'idx_attachments_user_size',
  'idx_community_templates_created',
  'idx_community_templates_author',
  'idx_rss_feed_shelf',
  'idx_rss_mark_recent',
  ...ASSISTANT_REQUIRED_INDEXES,
] as const


const initializationCache = new WeakMap<D1Database, Promise<DatabaseState>>()

/**
 * D1 refuses a batch of more than about a hundred statements, and the schema list is now well past
 * that with the assistant's tables. Local doubles accept any size, so the ceiling only shows up on a
 * real deployment — which is why the chunking lives here rather than at each call site, and why the
 * `schema batching` block in `tests/assistant-rules.test.ts` counts the calls instead of trusting the
 * outcome.
 */
const SCHEMA_BATCH_STATEMENTS = 40

export function chunkStatements<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

async function runStatements(db: D1Database, statements: readonly string[]): Promise<void> {
  for (const group of chunkStatements(statements, SCHEMA_BATCH_STATEMENTS)) {
    await db.batch(group.map((statement) => db.prepare(statement)))
  }
}

export function initializeDatabase(env: Env): Promise<DatabaseState> {
  const existing = initializationCache.get(env.DB)
  if (existing) return existing

  const pending = createSchema(env.DB).catch((error) => {
    initializationCache.delete(env.DB)
    throw error
  })
  initializationCache.set(env.DB, pending)
  return pending
}

async function createSchema(db: D1Database): Promise<DatabaseState> {
  const stored = await readStoredDatabaseState(db)
  if (stored) return stored

  const initialized = await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .first<{ present: number }>()
  if (!initialized) {
    await runStatements(db, SCHEMA_STATEMENTS)
  } else {
    // Existing installations must converge additively. CREATE IF NOT EXISTS
    // never rewrites user data; running table creation before indexes also
    // lets a partially initialized database recover missing feature tables.
    await runStatements(db, TABLE_SCHEMA_STATEMENTS)
  }
  await applyMigrations(db)
  await repairReaderBookTenantKey(db)
  if (initialized) {
    await runStatements(db, INDEX_SCHEMA_STATEMENTS)
  }
  await assertFinalSchema(db)

  let state: DatabaseState
  try {
    await db.prepare(FTS_STATEMENT).run()
    await upgradeFtsIdentifiers(db)
    state = { ftsEnabled: true }
  } catch (error) {
    console.warn(
      '[inkstone] Full-text index initialization or upgrade failed; search will use LIKE:',
      error instanceof Error ? error.message : error,
    )
    state = { ftsEnabled: false }
  }
  await setMeta(db, DATABASE_STATE_KEY, JSON.stringify({
    schema: schemaFingerprint(),
    ftsEnabled: state.ftsEnabled,
  }))
  return state
}

async function upgradeFtsIdentifiers(db: D1Database): Promise<void> {
  await rebuildFtsIfLegacyShape(db, /note_id\s+UNINDEXED/i, 'notes_fts_identifiers')
  await rebuildFtsIfLegacyShape(db, /user_id\s+UNINDEXED/i, 'notes_fts_tenant')
}

async function rebuildFtsIfLegacyShape(
  db: D1Database,
  legacyPattern: RegExp,
  tempName: string,
): Promise<void> {
  const table = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'`,
  ).first<{ sql: string }>()
  if (!table || !legacyPattern.test(table.sql)) return
  // Keep the existing indexed text and rowids. The batch either replaces the
  // complete index or rolls back, including when an old installation retries.
  await db.batch([
    db.prepare(FTS_STATEMENT.replace('notes_fts', tempName)),
    db.prepare(`INSERT INTO ${tempName} (rowid, note_id, user_id, title, body)
      SELECT rowid, note_id, user_id, title, body FROM notes_fts`),
    db.prepare(`DROP TABLE notes_fts`),
    db.prepare(`ALTER TABLE ${tempName} RENAME TO notes_fts`),
  ])
}

/**
 * Put the reader's shelf rows under their own account's key.
 *
 * `reader_books` used to make the book id the whole primary key, while the id itself is minted by the
 * client from the file's name and size — so two accounts that added the same file held the same key and
 * a push from one replaced the other's row away. SQLite cannot alter a primary key, so the table is
 * rebuilt in place the way the full-text index is: copy, drop, rename, in one batch that either lands
 * whole or leaves the old table alone. Only the legacy shape is rebuilt, so a converged database pays
 * one read of `sqlite_master` and nothing else.
 */
async function repairReaderBookTenantKey(db: D1Database): Promise<void> {
  const table = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reader_books'`,
  ).first<{ sql: string }>()
  if (!table || !/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i.test(table.sql)) return
  // The columns are named on both sides of the copy on purpose: a database whose ledger lied about a
  // reader column would then fail the insert loudly instead of shifting every value one slot right.
  const columns = 'id, user_id, title, author, format, filename, language, publisher, size, unit_count, r2_key, has_cover, toc, added_at, updated_at, has_blob, cover_key, cover_size'
  await db.batch([
    db.prepare(READER_BOOK_TABLE.replace('IF NOT EXISTS reader_books', 'reader_books_tenant_key')),
    db.prepare(`INSERT INTO reader_books_tenant_key (${columns}) SELECT ${columns} FROM reader_books`),
    db.prepare('DROP TABLE reader_books'),
    db.prepare('ALTER TABLE reader_books_tenant_key RENAME TO reader_books'),
    // Dropping the table dropped its index with it; the shelf is read one account at a time, so it
    // has to be back before the boot checks the required indexes.
    db.prepare(READER_BOOK_INDEX),
  ])
  console.warn('[inkstone] Schema repair: rebuilt reader_books on a per-account primary key')
}

async function applyMigrations(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  ).run()
  const { results } = await db.prepare(`SELECT version FROM schema_migrations`).all<{ version: number }>()
  const applied = new Set(results.map((row) => row.version))

  for (const migration of SCHEMA_MIGRATIONS) {
    // A database whose ledger says a version ran, but which does not have the shape that version
    // adds, was written by something else: another branch that spent the same numbers on other
    // work, or a restore from before it. The shape is the fact and the number is only a note about
    // it, so the note is corrected afterwards by `repairMissingColumns` rather than trusted here.
    if (applied.has(migration.version)) continue
    let migrationStatements = migration.statements
    if (migration.skipIfColumnExists && await hasColumn(db, migration.skipIfColumnExists)) {
      migrationStatements = []
    }
    const statements = migrationStatements.map((statement) => db.prepare(statement))
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)`)
        .bind(migration.version, Date.now()),
    )
    await db.batch(statements)
  }
  await repairMissingColumns(db, applied)
}

/** Whether a table already carries the column a migration guards itself on. */
async function hasColumn(db: D1Database, guard: { table: string; column: string }): Promise<boolean> {
  const { results } = await db.prepare(`PRAGMA table_info(${guard.table})`).all<{ name: string }>()
  return results.some((entry) => entry.name === guard.column)
}

/**
 * Add the required columns that the ledger claims already arrived.
 *
 * Only two kinds of statement can be replayed safely: `CREATE ... IF NOT EXISTS`, and
 * `ALTER TABLE ... ADD COLUMN`, which is what every column this schema has ever gained came in
 * through. Anything else is left alone — replaying an `UPDATE` or an `INSERT` would repeat work the
 * database has already counted. A column no migration adds stays a gap, and the boot then refuses
 * the schema out loud rather than serving a half-built database.
 */
async function repairMissingColumns(db: D1Database, applied: Set<number>): Promise<void> {
  const gaps = await missingColumns(db)
  if (!gaps.size) return
  const replayable = replayableAdditions(applied)
  let repaired = 0
  for (const [table, missing] of [...gaps]) {
    for (const column of missing) {
      const definition = replayable.get(`${table}.${column}`) ?? declaredColumn(table, column)
      if (!definition) continue
      // Each gap is one column and is visited once, so nothing here can add the same column twice:
      // a failure is a real schema problem and belongs in the face of whoever deployed.
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run()
      repaired++
    }
  }
  if (repaired) {
    console.warn(`[inkstone] Schema repair: added ${repaired} column(s) the migration ledger claimed were there`)
  }
}

/**
 * The `ADD COLUMN` statements this schema's own migrations used, keyed by `table.column`.
 *
 * A column that arrived later carries the default its migration chose, which is not always what the
 * `CREATE TABLE` says — so the migration wins when there is one, and the table definition is the
 * fallback for columns a branch never numbered at all.
 */
function replayableAdditions(applied: Set<number>): Map<string, string> {
  const out = new Map<string, string>()
  for (const migration of SCHEMA_MIGRATIONS) {
    if (!applied.has(migration.version)) continue
    for (const statement of migration.statements) {
      const added = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(.*)$/is.exec(statement.trim())
      if (!added) continue
      const key = `${added[1]}.${added[2]}`
      if (!out.has(key)) out.set(key, `${added[2]} ${added[3]}`.trim())
    }
  }
  return out
}

/** The column as the `CREATE TABLE` for it declares it, or nothing a safe `ADD COLUMN` can build. */
function declaredColumn(table: string, column: string): string | null {
  const statement = TABLE_SCHEMA_STATEMENTS.find((text) => text.includes(`IF NOT EXISTS ${table} (`))
  if (!statement) return null
  const body = statement.slice(statement.indexOf('(', statement.indexOf(table)) + 1, statement.lastIndexOf(')'))
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '')
    const declared = new RegExp(`^${column}\\s+(.*)$`, 'i').exec(trimmed)
    if (!declared) continue
    const definition = declared[1]!.trim()
    // A primary or unique key cannot be added to a table that already has rows.
    if (/\b(PRIMARY|UNIQUE)\b/i.test(definition)) return null
    return definition ? `${column} ${definition}` : `${column}`
  }
  return null
}

async function readStoredDatabaseState(db: D1Database): Promise<DatabaseState | null> {
  try {
    const raw = await getMeta(db, DATABASE_STATE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { schema?: unknown; ftsEnabled?: unknown }
    if (value.schema !== schemaFingerprint() || typeof value.ftsEnabled !== 'boolean') return null
    return { ftsEnabled: value.ftsEnabled }
  } catch {
    return null
  }
}

function schemaFingerprint(): string {
  const migrationSource = SCHEMA_MIGRATIONS.map((migration) => JSON.stringify({
    version: migration.version,
    statements: migration.statements,
    skipIfColumnExists: migration.skipIfColumnExists ?? null,
  }))
  const source = [...SCHEMA_STATEMENTS, FTS_STATEMENT, ...migrationSource].join('\n')
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The required columns that an existing table does not have, by table. */
async function missingColumns(db: D1Database): Promise<Map<string, Set<string>>> {
  const tableEntries = Object.entries(REQUIRED_COLUMNS)
  const pragmaStatements = tableEntries.map(([table]) => db.prepare(`PRAGMA table_info(${table})`))
  const batchResults = await db.batch<{ name: string }>(pragmaStatements)
  const gaps = new Map<string, Set<string>>()
  for (let index = 0; index < tableEntries.length; index++) {
    const [table, required] = tableEntries[index]!
    const columns = new Set((batchResults[index]!.results ?? []).map((row) => row.name))
    if (!columns.size) continue
    const missing = required.filter((column) => !columns.has(column))
    if (missing.length) gaps.set(table, new Set(missing))
  }
  return gaps
}

async function assertFinalSchema(db: D1Database): Promise<void> {
  const { results: tableRows } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all<{ name: string }>()
  const tables = new Set(tableRows.map((row) => row.name))
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table))
  if (missingTables.length) {
    throw new Error(
      `The database migration did not produce the required tables: ${missingTables.join(', ')}`,
    )
  }

  const { results: indexRows } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all<{ name: string }>()
  const indexes = new Set(indexRows.map((row) => row.name))
  const missingIndexes = REQUIRED_INDEXES.filter((index) => !indexes.has(index))
  if (missingIndexes.length) {
    throw new Error(
      `The database migration did not produce the required indexes: ${missingIndexes.join(', ')}`,
    )
  }

  const gaps = await missingColumns(db)
  if (gaps.size) {
    const first = gaps.entries().next().value as [string, Set<string>]
    throw new Error(
      `The database schema is incompatible (${first[0]} is missing ${[...first[1]].join(', ')})`,
    )
  }
}
