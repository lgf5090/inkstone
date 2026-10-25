/** Defines the idempotent final D1 schema initialized by every Worker isolate. */
import { isValidTimeZone } from '@shared/assistant-schedule'
import { localDate } from '@shared/assistant-time'
import type { DatabaseState, Env } from '../env'
import { getMeta, setMeta } from './metadata'
import { storedObject } from '../lib/json'
import { READER_BOOK_INDEX, READER_BOOK_TABLE, READER_GROUP_INDEX, READER_GROUP_TABLE, READER_SCHEMA_STATEMENTS } from './reader-schema'
import {
  ASSISTANT_REQUIRED_COLUMNS,
  ASSISTANT_REQUIRED_INDEXES,
  ASSISTANT_REQUIRED_TABLES,
  ASSISTANT_SCHEMA_STATEMENTS,
} from '../assistant/schema'
import {
  SUBSCRIPTIONS_REQUIRED_COLUMNS,
  SUBSCRIPTIONS_REQUIRED_INDEXES,
  SUBSCRIPTIONS_REQUIRED_TABLES,
  SUBSCRIPTIONS_SCHEMA_STATEMENTS,
} from '../subscriptions/schema'
import {
  TODOS_REQUIRED_COLUMNS,
  TODOS_REQUIRED_INDEXES,
  TODOS_REQUIRED_TABLES,
  TODOS_SCHEMA_STATEMENTS,
} from '../todos/schema'
import {
  MEMOS_REQUIRED_COLUMNS,
  MEMOS_REQUIRED_INDEXES,
  MEMOS_REQUIRED_TABLES,
  MEMOS_SCHEMA_STATEMENTS,
} from '../memos/schema'
import {
  SHARE_HUB_REQUIRED_COLUMNS,
  SHARE_HUB_REQUIRED_INDEXES,
  SHARE_HUB_REQUIRED_TABLES,
  SHARE_HUB_SCHEMA_STATEMENTS,
} from '../share/hub-schema'
import {
  EMAIL_REQUIRED_COLUMNS,
  EMAIL_REQUIRED_INDEXES,
  EMAIL_REQUIRED_TABLES,
  EMAIL_SCHEMA_STATEMENTS,
} from '../email/schema'
import {
  MUSIC_REQUIRED_COLUMNS,
  MUSIC_REQUIRED_INDEXES,
  MUSIC_REQUIRED_TABLES,
  MUSIC_SCHEMA_STATEMENTS,
} from '../music/schema'

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
    scope TEXT NOT NULL DEFAULT 'notes',
    note_id TEXT,
    folder_id TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    object_key TEXT,
    width INTEGER,
    height INTEGER,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    storage TEXT NOT NULL CHECK (storage IN ('r2', 'kv')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments(user_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user_scope ON attachments(user_id, scope, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_user_folder ON attachments(user_id, folder_id)`,

  // The hub's own organiser stacks. Folders and tags are per scope rather than global because a
  // "Screenshots" folder in notes and one in chat are unrelated things that happen to share a name,
  // and the sidebar that draws them is the same component opened on two scopes.
  //
  // Both lead their key with user_id, which is the shape the tenancy guard asks for: an id that
  // comes from the client cannot address a row belonging to somebody else.
  `CREATE TABLE IF NOT EXISTS attachment_folders (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    scope TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_folders_user
     ON attachment_folders(user_id, scope, position)`,

  `CREATE TABLE IF NOT EXISTS attachment_tags (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, scope, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachment_tags_user
     ON attachment_tags(user_id, scope, name)`,

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
    folder_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    password_hash TEXT,
    expires_at INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    last_viewed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares(user_id, created_at DESC, slug DESC)`,
  // The hub's list is always one account's shares narrowed by a status and, from the sidebar, by a
  // folder — so the two columns every query filters on lead the index, with the listing's own order
  // last so a plain "all my links, newest first" walk needs no sort.
  `CREATE INDEX IF NOT EXISTS idx_shares_user_enabled_folder
     ON shares(user_id, is_enabled, folder_id, created_at DESC, slug DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_user_expires
     ON shares(user_id, expires_at)`,

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

  ...SHARE_HUB_SCHEMA_STATEMENTS,


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
    todo_read_enabled INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    disabled_tools TEXT NOT NULL DEFAULT '[]',
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
  ...TODOS_SCHEMA_STATEMENTS,
  ...SUBSCRIPTIONS_SCHEMA_STATEMENTS,
  ...MEMOS_SCHEMA_STATEMENTS,
  ...EMAIL_SCHEMA_STATEMENTS,
  ...MUSIC_SCHEMA_STATEMENTS,
]

export interface SchemaMigration {
  version: number
  statements: readonly string[]
  skipIfColumnExists?: { table: string; column: string }
  /**
   * The mirror of the guard above, for a migration that takes a column away rather than adding one.
   *
   * `skipIfColumnExists` answers "is the shape this version writes already here", which is the only
   * question an `ADD COLUMN` can ask. A `DROP COLUMN` fails outright on a database that never had the
   * column — every fresh one, since the table declaration no longer carries it — so its version is
   * satisfied by the column being absent. The ledger records the number either way, so the next boot
   * asks once instead of every time.
   */
  skipIfColumnMissing?: { table: string; column: string }
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
         disabled_tools TEXT NOT NULL DEFAULT '[]',
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
  {
    // A conversation the reader has put away without deleting: still searchable, still backed up, but out
    // of the everyday list. A flag rather than a second table, because it is one bit of the same row and
    // every listing already reads that row.
    version: 83,
    skipIfColumnExists: { table: 'chat_conversations', column: 'archived' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The MCP server's own tools the reader has switched off, by the name the server registers them under.
    // The switched-off set rather than the enabled one, so a tool a later build adds arrives usable: a
    // reader who switched two tools off has not thereby switched off the fortieth.
    version: 84,
    skipIfColumnExists: { table: 'mcp_preferences', column: 'disabled_tools' },
    statements: [
      `ALTER TABLE mcp_preferences ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // A conversation the reader asked not to keep. Stored all the same — a thread that vanished on a
    // reload would lose the thought being had — but kept out of every listing, out of search and out of a
    // backup, and swept away once it has gone untouched for the retention window.
    version: 85,
    skipIfColumnExists: { table: 'chat_conversations', column: 'ephemeral' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // What a published link points at: the whole thread, or the exchanges the reader picked. The empty
    // string is the whole conversation, which is what every link made before this column existed meant —
    // so the default is the reading that loses nothing. The key moves to include the scope because one
    // thread may now be published in more than one shape at once, and a reader who narrows a link must
    // not have that overwrite the link they already sent.
    //
    // The old index is dropped here rather than redefined where it was written: `CREATE INDEX IF NOT
    // EXISTS` will not replace an index that already exists, so a database carrying the old one would
    // keep the old key and refuse the second link. The replacement is created by the boot's index pass,
    // which runs after the migrations — after this column exists for it to be keyed on.
    version: 86,
    skipIfColumnExists: { table: 'chat_share_links', column: 'scope' },
    statements: [
      `ALTER TABLE chat_share_links ADD COLUMN scope TEXT NOT NULL DEFAULT ''`,
      `DROP INDEX IF EXISTS idx_chat_share_links_conversation`,
    ],
  },
  {
    // Which project a remembered fact belongs to; null for one that belongs to the account. Nullable
    // rather than defaulted, because the two are different claims: every memory that existed before this
    // column was learned in the account's own context, and "no project" is exactly what that means. A
    // default would say the same thing, but a null says it without pretending a project was chosen.
    version: 87,
    skipIfColumnExists: { table: 'chat_memories', column: 'project_id' },
    statements: [
      `ALTER TABLE chat_memories ADD COLUMN project_id TEXT`,
    ],
  },
  {
    // The note a memory was saved as, when the reader asked for one. Nullable and never defaulted: a
    // memory that has not been written out is not a memory with an empty note, and the two read
    // differently in the list. It is a pointer into the vault rather than a copy of the text, so a note
    // the reader deletes leaves the memory whole and its link pointing at nothing — which the screen
    // says out loud instead of offering a note that is not there.
    version: 88,
    skipIfColumnExists: { table: 'chat_memories', column: 'note_id' },
    statements: [
      `ALTER TABLE chat_memories ADD COLUMN note_id TEXT`,
    ],
  },
  {
    // The conversation a branch was forked from; null for one that started the thread of its own. Nullable
    // rather than defaulted, because "not a branch" is not an empty parent — every conversation that
    // existed before this column did was its own root, and that is exactly what null says. The parent is
    // only a label on the tree: deleting either side leaves the other whole, since a fork copies its turns.
    version: 89,
    skipIfColumnExists: { table: 'chat_conversations', column: 'parent_id' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN parent_id TEXT`,
    ],
  },
  {
    // The note a conversation was started from. Null for one that was not started from a note, and for
    // every thread written before this column existed — a guessed origin is worse than none.
    version: 90,
    skipIfColumnExists: { table: 'chat_conversations', column: 'note_id' },
    statements: [
      `ALTER TABLE chat_conversations ADD COLUMN note_id TEXT`,
    ],
  },
  {
    // What a turn was allowed to read. The scope is chosen per turn and used to be gone the moment the
    // answer landed, so a reader coming back could not tell why an answer only knew one note — the
    // transcript now says it. Defaulted rather than nullable: an unscoped turn is an empty list, which is
    // also what every row written before this column means.
    version: 91,
    skipIfColumnExists: { table: 'chat_messages', column: 'scopes' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The context window the vendor says this model has, learned from its listing or its published docs
    // when the row was made. Nullable with no default and no backfill, because every row written before
    // this column is one nobody has asked a vendor about: a guess here would cut the editor's ladder and
    // warn about a number nobody stated. Kept apart from `context_tokens` on purpose — that one is the
    // reader's own setting, whose null means "inherit the account's ceiling".
    version: 92,
    skipIfColumnExists: { table: 'chat_models', column: 'vendor_context_tokens' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN vendor_context_tokens INTEGER`,
    ],
  },
  {
    // The output ceiling the vendor says this model has. Same reading as the window above: null is
    // "not known", and only a known ceiling is allowed to shorten a reader's answer.
    version: 93,
    skipIfColumnExists: { table: 'chat_models', column: 'vendor_max_output_tokens' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN vendor_max_output_tokens INTEGER`,
    ],
  },
  {
    // Which model a day's per-model usage was billed to, held as its id next to the label.
    //
    // The label alone cannot carry a cost across a rename: renaming a model detaches every row filed under
    // the old word, so a reader who tidies a name silently loses that model's whole spending history. The id
    // survives the rename, and the read path resolves a price by it first. Nullable because a usage row may
    // name a model the reader has since deleted.
    //
    // The backfill sets the id only where the label names exactly one of this account's models. Where two
    // models share a label, or none carries it any more, the row is left NULL: a guessed attribution would
    // bill one model for another's tokens, which is worse than none — the same rule `note_id` was written
    // under at version 90. A NULL row still reads by its label, so nothing that can be resolved is lost.
    version: 94,
    skipIfColumnExists: { table: 'chat_usage_daily_model', column: 'model_id' },
    statements: [
      `ALTER TABLE chat_usage_daily_model ADD COLUMN model_id TEXT`,
      `UPDATE chat_usage_daily_model SET model_id = (
         SELECT m.id FROM chat_models m
          WHERE m.user_id = chat_usage_daily_model.user_id
            AND m.label = chat_usage_daily_model.model_label
       ) WHERE model_id IS NULL AND (
         SELECT COUNT(*) FROM chat_models m
          WHERE m.user_id = chat_usage_daily_model.user_id
            AND m.label = chat_usage_daily_model.model_label
       ) = 1`,
    ],
  },
  {
    // The reader's shelf and reading state, so a cleared browser or a second device finds the books
    // where they were left.
    //
    // This entry used to claim version 30 beside the `users.rss` column, and the pair cancelled each
    // other out: the ledger keys on the number alone, so whichever boot recorded 30 first spent it, and
    // every later boot skipped both entries — neither one's statements were ever sent again. It now
    // sits at the end with a number nobody has spent, which is where a fresh entry belongs: nothing here
    // depends on its position, because every statement is `CREATE ... IF NOT EXISTS` and the boot that
    // runs migrations has already created these tables from SCHEMA_STATEMENTS. A database whose ledger
    // spent 30 on the reader lineage simply re-runs this no-op and gains its `rss` column from the
    // entry that now owns 30.
    version: 95,
    statements: READER_SCHEMA_STATEMENTS,
  },
  {
    // The reader's standing decision that this model never gets a tool, kept apart from `supports_tools`
    // because that one answers "what the vendor says this model can do" and this one answers "what this
    // account will let it do": a model that calls tools well and writes to the vault when asked is both
    // capable and not wanted. Defaulted rather than nullable so a row from before this column reads as
    // the switch never being touched, which is what it was. One column, one version number.
    version: 96,
    skipIfColumnExists: { table: 'chat_models', column: 'no_tools' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN no_tools INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // The pages a project reads by name. `note_scope` selects whole folders, which is the wrong grain for
    // a brief that should be answered from three specific pages sitting in a folder of three hundred.
    // One JSON list beside the other, defaulted rather than nullable: an empty selection is what every
    // project written before this column means, and it is also what "no selection" reads as.
    version: 97,
    skipIfColumnExists: { table: 'chat_projects', column: 'note_ids' },
    statements: [
      `ALTER TABLE chat_projects ADD COLUMN note_ids TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // Which facts the assistant remembers were written out of which page.
    //
    // `chat_memories.note_id` has been here since version 90, and nothing has ever asked for the rows by
    // it: the memory page filters by project, by status and by text, and the note's own backlink panel did
    // not exist. That panel is the first reader that names a page and asks what is known about it, and the
    // only index the query could reach starts with `user_id` alone — so the answer walked every fact in the
    // account. An index led by the account and then the page is what makes it a seek, and the same read
    // keeps working for a vault with one page or with ten thousand facts.
    version: 98,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_chat_memories_note
         ON chat_memories(user_id, note_id, updated_at DESC)`,
    ],
  },
  {
    // The folder a note-writing schedule files its answer into.
    //
    // A schedule that could only leave a notification behind cannot answer "turn yesterday into a log
    // page every morning", so the routine now writes the page itself — and the reader has to say where.
    // Nullable rather than defaulted: every schedule that already exists writes nothing, and a routine of
    // the other kinds must be able to say so without a sentinel. The create refuses a folder this account
    // does not own instead of dropping it, because a schedule that quietly lost its target would run
    // forever and write nothing. One column, one version number; its pair is the next one.
    version: 99,
    skipIfColumnExists: { table: 'chat_automations', column: 'target_folder_id' },
    statements: [
      `ALTER TABLE chat_automations ADD COLUMN target_folder_id TEXT`,
    ],
  },
  {
    // The page a note-writing schedule rewrites instead of making a new one.
    //
    // The other half of the choice the reader makes: file the answer somewhere, or keep one standing
    // page and refill it. Exactly one of this and `target_folder_id` is ever set, and the pair is what
    // the next version's `chat_runs.note_id` reports as written.
    version: 100,
    skipIfColumnExists: { table: 'chat_automations', column: 'target_note_id' },
    statements: [
      `ALTER TABLE chat_automations ADD COLUMN target_note_id TEXT`,
    ],
  },
  {
    // Which page a run wrote, named on the receipt.
    //
    // "Success" is not enough for a schedule that makes a page every morning: the reader looking at the
    // run list wants to open what it made, and a result string cut to 2000 characters is not an address.
    // Null for every run that filed nothing, including the failures — pointing at a page that was never
    // written would be worse than pointing at none.
    version: 101,
    skipIfColumnExists: { table: 'chat_runs', column: 'note_id' },
    statements: [
      `ALTER TABLE chat_runs ADD COLUMN note_id TEXT`,
    ],
  },
  {
    // The answer the reader kept.
    //
    // A thread is the unit every other shortlist here works on — `starred`, `pinned` and `archived` are all
    // columns of `chat_conversations` — but keeping is something a reader does to one answer: the paragraph
    // that finally answered the question, not the forty turns around it. Nullable rather than a 0/1 flag:
    // the column says both whether this turn is kept and since when, and NULL is what every row written
    // before it means — a turn nobody kept, which is the reading that loses nothing. One column, one
    // version number; the index the kept list needs is the next one.
    version: 102,
    skipIfColumnExists: { table: 'chat_messages', column: 'saved_at' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN saved_at INTEGER`,
    ],
  },
  {
    // The kept answers, reached without walking the transcript.
    //
    // The list reads one account's turns where `saved_at` is set, newest kept first. Nothing asked that
    // question before — the flag was on the conversation, and `idx_chat_messages_user` is ordered by when
    // the turn was written — so the only index a saved read could reach led with `user_id` alone and then
    // looked at every turn the account has, which is the same shape as the message count at version 98.
    // The account still leads: this is one reader's shelf, and an index that could serve another's would be
    // a scan waiting to happen.
    version: 103,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_saved
         ON chat_messages(user_id, saved_at DESC, id)`,
    ],
  },
  {
    // The devices a reader has asked to be pushed to. Created here as well as in the table list so an
    // account that has been running since before Web Push existed gets it on the next boot.
    //
    // One table, one version; the unique index the per-account upsert needs is the next one. The triple is
    // a credential and is deliberately kept out of every export path — see the comment on the table in
    // `assistant/schema.ts`.
    version: 104,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (user_id, id)
  )`,
    ],
  },
  {
    // One endpoint per account, which is what lets a renewed subscription overwrite its own keys instead of
    // stacking a second credential for the same device. It leads with `user_id` for the same reason every
    // other index here does: the only list this serves is one reader's devices.
    version: 105,
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_push_subscriptions_endpoint
     ON chat_push_subscriptions(user_id, endpoint)`,
    ],
  },
  {
    // The delivery fact behind a late nudge.
    //
    // `chat_notifications` said only what was delivered and whether the reader had looked; nothing said
    // whether a device was ever told. A cron catch-up fire has to know that, or it re-nudges every unread
    // row inside its window on every fire — the "same notification, four times an hour" shape the task this
    // column exists for forbids. No other reading works: `read_at` is the reader's state, so a row they have
    // not opened is not a row nobody was told about, and a window rule alone cannot tell a notification the
    // sweep already nudged from one the process died before nudging. Null is every row written before the
    // marker, which decays out of the window instead of being backfilled into a send that never happened.
    version: 106,
    skipIfColumnExists: { table: 'chat_notifications', column: 'pushed_at' },
    statements: [
      `ALTER TABLE chat_notifications ADD COLUMN pushed_at INTEGER`,
    ],
  },
  {
    // The rows a catch-up fire is looking for, reached without walking the notification history.
    //
    // The fire runs three times an hour on every account's un-nudged rows, and a deployment never deletes a
    // delivered notification, so the query it runs is against a table that only grows. Partial on
    // `pushed_at IS NULL`: the marked rows are never candidates for anything, and leaving them out is what
    // keeps this index the size of the backlog rather than the size of the shelf. Same shape as version 103
    // spending its own number on the index a column two versions up needed.
    version: 107,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_chat_notifications_unpushed
     ON chat_notifications(user_id, created_at) WHERE pushed_at IS NULL`,
    ],
  },
  {
    // The words a turn had already written, carried on the claim that turn is standing on.
    //
    // A Worker isolate killed by its CPU limit takes the request with it, and the assistant row is written
    // at `finish`, so nothing about that turn ever reaches `chat_messages` — while `chat_active_runs` goes
    // on claiming the conversation for the whole `RUN_LEASE_MS`. The reader who came back to that thread saw
    // a marker, then a toast, then nothing: the half answer was simply gone, and the control that continues
    // an answer reads the last stored row, which did not exist. Writing the fragment out with the renewal
    // the turn already performs costs no extra round trip and leaves something to be read back.
    //
    // Nullable, and only nullable: a claim made before this column, and a claim by a turn that has not
    // streamed a word yet, both mean "nothing written yet", which is a different fact from "an empty
    // answer". One column, one version — and no index to spend on it, because the only reader reaches this
    // row by its primary key.
    version: 108,
    skipIfColumnExists: { table: 'chat_active_runs', column: 'partial_text' },
    statements: [
      `ALTER TABLE chat_active_runs ADD COLUMN partial_text TEXT`,
    ],
  },
  {
    // The follow-up chips a naming pass volunteers for a finished first answer.
    //
    // The reader asked for the thread to be named by the model rather than by their first line, and the same
    // cheap second call that writes that title also proposes three questions to ask next. Those questions
    // belong to the answer they follow, so they are stored on the assistant row that produced them — the one
    // place that survives reopening the thread, and a restore onto another device, and is why the transcript
    // can show the same three chips tomorrow without a second call. `[]` means none, which is what every row
    // written before this column carries and what a naming call that failed leaves behind: an honest absence,
    // not a frame of filler. NOT NULL with a default because the column rides in the assistant backup's
    // `EXPORT_COLUMNS`, and a nullable one there is the quiet half of a bug this table has paid for twice — a
    // restore that binds the missing key NULL into a NOT NULL column loses the whole message row to
    // `INSERT OR IGNORE`. One column, one version.
    version: 109,
    skipIfColumnExists: { table: 'chat_messages', column: 'suggestions' },
    statements: [
      `ALTER TABLE chat_messages ADD COLUMN suggestions TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // The history of one draft. The artifact row stays the head, so the list of drafts does not need a
    // join; each version is a full snapshot because a diff is a view over two of them, not the storage
    // format. The unique key makes replaying the backfill below idempotent.
    version: 110,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_artifact_versions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user','assistant','restore','import')),
    message_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_artifact_versions_unique
         ON chat_artifact_versions(user_id, artifact_id, version)`,
      `CREATE INDEX IF NOT EXISTS idx_chat_artifact_versions_conversation
         ON chat_artifact_versions(user_id, conversation_id, version DESC)`,
    ],
  },
  {
    // The head version number. Existing rows are version 1; the backfill in the next migration writes
    // the matching version row, so a draft that predates history still opens with one entry in it.
    version: 111,
    skipIfColumnExists: { table: 'chat_artifacts', column: 'version' },
    statements: [
      `ALTER TABLE chat_artifacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // One version row per draft that predates history. `INSERT OR IGNORE` against the unique key makes
    // a retry safe; the id is generated in SQL because a migration has no access to the app's id helper.
    // The alphabet SQLite produces here (lowercase hex) is a subset of the app's id alphabet.
    version: 112,
    statements: [
      `INSERT OR IGNORE INTO chat_artifact_versions
         (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
       SELECT lower(hex(randomblob(13))), user_id, id, conversation_id, 1, title, content, 'import', NULL, updated_at
         FROM chat_artifacts`,
    ],
  },
  {
    // A pricing page with peak and off-peak hours, stored as one JSON array on the model. The usage side
    // records only which window was in force, so a rate change stays a read-time estimate like the base
    // price already is, and a deleted window falls back to that base.
    version: 113,
    skipIfColumnExists: { table: 'chat_models', column: 'price_periods' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN price_periods TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // Tokens split by the pricing window that was active when the turn was recorded. The daily model and
    // key tables keep their totals; this sidecar is what lets a cost be computed per window without
    // rebuilding either table's primary key. Tokens written before it, or outside every window, have no
    // row here and are priced at the base rate.
    version: 114,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_usage_daily_period (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        model_label TEXT NOT NULL,
        model_id TEXT,
        period_id TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        key_id TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, model_label, period_id, provider_id, key_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_usage_period_user
         ON chat_usage_daily_period(user_id, day DESC)`,
    ],
  },
  {
    // The mark a provider wears. The picker stores a short encoded value; the listing that reads a row
    // written before this column existed gets '' and infers the brand from the name and address.
    version: 115,
    skipIfColumnExists: { table: 'chat_providers', column: 'icon' },
    statements: [
      `ALTER TABLE chat_providers ADD COLUMN icon TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // A model's own mark, overriding the one inferred from its family and provider. The same encoding
    // as the provider column: brand, emoji, Lucide name, or a small uploaded image.
    version: 116,
    skipIfColumnExists: { table: 'chat_models', column: 'icon' },
    statements: [
      `ALTER TABLE chat_models ADD COLUMN icon TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // The face a subscription type or category wears.
    //
    // `sub_category` existed as a bare name list, which is enough to autocomplete a form and nothing
    // else: the reader who wants a streaming type to read as red-on-tv and a gym one as green-on-dumbbell
    // has to put that choice somewhere, and a name is the wrong place to hang it because renaming the
    // label would take the identity with it. An empty string means "nobody chose", which is deliberately
    // not the same as a chosen value — a preset that changes later still reaches the accounts that never
    // picked.
    //
    // Defaults rather than nullable because these columns ride in a backup, and a restore that binds a
    // missing key NULL into a NOT NULL column loses the row to `INSERT OR IGNORE`.
    version: 117,
    skipIfColumnExists: { table: 'sub_category', column: 'icon' },
    statements: [
      `ALTER TABLE sub_category ADD COLUMN icon TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // One column, one version, as every other pair here: `skipIfColumnExists` can only guard one, and
    // a version that added two would skip the second one on a database that had somehow acquired only
    // the first.
    version: 118,
    skipIfColumnExists: { table: 'sub_category', column: 'color' },
    statements: [
      `ALTER TABLE sub_category ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // Which currency the dashboard totals are added up in.
    //
    // It was fixed at CNY in the client, which is a defensible default for an app whose reference
    // implementation was written for yuan and is an odd one for a reader whose every subscription is
    // billed in dollars — they were shown a yuan total converted at a rate they never chose. The
    // conversion itself lives in `app_meta`'s cached rate table; this is only the preference.
    version: 119,
    skipIfColumnExists: { table: 'sub_settings', column: 'base_currency' },
    statements: [
      `ALTER TABLE sub_settings ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY'`,
    ],
  },
  {
    // When the reader told an expired subscription's rule they had seen it.
    //
    // `repeat_until` has been stored since the first version and read by nothing — the reference project
    // had the same dropdown and the same dead field, and its engine header even claimed the scheduler
    // filtered on it, which the scheduler does not. `acknowledged` could not mean anything without a
    // record of the acknowledgement, so this is the half that was missing rather than a new idea.
    version: 120,
    skipIfColumnExists: { table: 'sub_reminder_rule', column: 'acknowledged_at' },
    statements: [
      `ALTER TABLE sub_reminder_rule ADD COLUMN acknowledged_at INTEGER`,
    ],
  },
  {
    // The subscription trash.
    //
    // Deleting a subscription used to erase it and every receipt under it in one batch, which is a
    // strange thing for the one table in this app that holds financial history: a mis-tap cost the reader
    // a record they may have kept for years, and no confirm dialog is a substitute for being able to
    // change one's mind. Nullable rather than a status flag, and shaped exactly like `notes.deleted_at`,
    // so the two trashes are the same idea in one database.
    version: 121,
    skipIfColumnExists: { table: 'sub_item', column: 'deleted_at' },
    statements: [
      `ALTER TABLE sub_item ADD COLUMN deleted_at INTEGER`,
    ],
  },
  {
    // When a free trial stops being free.
    //
    // A trial is not a free subscription (`amount` null already means that) and not a zero-cost period
    // either: it is a known date after which the real price starts biting, which makes it the single
    // most worth-reminding-about thing in a subscription list. Nullable, because most rows are not
    // trials and a sentinel would put a fake date in front of every reminder that reads this column.
    version: 122,
    skipIfColumnExists: { table: 'sub_item', column: 'trial_ends_at' },
    statements: [
      `ALTER TABLE sub_item ADD COLUMN trial_ends_at INTEGER`,
    ],
  },
  {
    // What a month of subscriptions is allowed to cost.
    //
    // The dashboard already says what was spent; the question a reader actually asks is whether that is
    // too much, and that needs a number they supply rather than one the app invents. NULL is "no budget
    // set", which is different from a budget of zero and must stay distinguishable in the column.
    version: 123,
    skipIfColumnExists: { table: 'sub_settings', column: 'budget_monthly' },
    statements: [
      `ALTER TABLE sub_settings ADD COLUMN budget_monthly REAL`,
    ],
  },
  {
    // An in-app notification about a plan said what was due and nothing else: the row had no pointer back
    // to the subscription it was written for, so the reader had to go find it in the list. Nullable rather
    // than defaulted, because a notification from a routine or an automation names no plan and keeps
    // arriving exactly as it did before this column existed.
    version: 124,
    skipIfColumnExists: { table: 'chat_notifications', column: 'subscription_id' },
    statements: [
      `ALTER TABLE chat_notifications ADD COLUMN subscription_id TEXT`,
    ],
  },
  {
    // The rates an account pinned for itself, as `1 unit = N CNY`.
    //
    // The feed answers once a day for everybody; a reader billing in a currency that moves faster than
    // that, or at their bank's price rather than an index, had no way to say so and got totals that looked
    // authoritative. A JSON map rather than one column per currency because the currencies are a set the
    // app already enumerates, and a column each would mean a migration every time one is added.
    version: 125,
    skipIfColumnExists: { table: 'sub_settings', column: 'rate_overrides' },
    statements: [
      `ALTER TABLE sub_settings ADD COLUMN rate_overrides TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // What a year of subscriptions is allowed to cost.
    //
    // A monthly ceiling cannot carry this question: an annual plan charges once, lands entirely in one
    // month, and makes that month read as reckless while the year it pays for is on plan. NULL is "no
    // ceiling", which stays a different state from a ceiling of zero.
    version: 126,
    skipIfColumnExists: { table: 'sub_settings', column: 'budget_yearly' },
    statements: [
      `ALTER TABLE sub_settings ADD COLUMN budget_yearly REAL`,
    ],
  },
  {
    // What a year of one category is allowed to cost, as a map of the reader's own names to numbers.
    //
    // A JSON cell rather than a table: these are a handful of numbers read and written as one bundle, never
    // queried one at a time, and a table would buy a join for nothing. Names are the key because that is
    // how the reader chose them and how the dashboard already groups the spending.
    version: 127,
    skipIfColumnExists: { table: 'sub_settings', column: 'budget_categories' },
    statements: [
      `ALTER TABLE sub_settings ADD COLUMN budget_categories TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // Where a delivered notice was about.
    //
    // A reminder said what had happened and whether the reader had looked, and nothing said where the thing
    // itself lives — so pressing it could only ever open a list, which is the half of the loop that makes a
    // reminder worth having. `link` carries `<app>:<id>`, `todo:<task id>` first, and it is an app-and-id
    // pair rather than a URL on purpose: a stored address would let whatever wrote the row aim a reader's
    // press at a site this deployment never chose, while the client resolves the pair inside its own origin
    // and already knows what to do with a task it cannot read. Nullable with no default because a digest, a
    // finished run and every row written before this column all genuinely point nowhere — an honest absence,
    // and the reading the notification centre expands instead of navigating on. One column, one version; no
    // index, since the only reader reaches the row by the primary key it already has.
    version: 128,
    skipIfColumnExists: { table: 'chat_notifications', column: 'link' },
    statements: [
      `ALTER TABLE chat_notifications ADD COLUMN link TEXT`,
    ],
  },
  {
    // The newest-first order the task list gained — `sort=created` — for one account at a time.
    //
    // The table's indexes are all built around what a view filters on (`status, due_at`, `list_id,
    // status`), and none of them can produce `ORDER BY created_at`, so the sort was a full build over
    // the account's whole shelf on every page: the larger the history, the slower each first page
    // became. A separate number is what lets a database built before the order existed get the index
    // on its next boot. The same statement lives in `todos/schema.ts`, so a fresh install creates it
    // without replaying this history.
    version: 129,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_created
     ON todos_tasks(user_id, created_at)`,
    ],
  },
  {
    // The other order the list gained — `sort=completed` — and the same shape of gap as 129.
    //
    // Finished tasks are read newest-finish first, and `completed_at` had no index at all: SQLite had
    // to visit every row the account owns and sort it, even though the view shows one page. Keyed on
    // the account first for the reason every index here is, so the walk never crosses into another
    // account's rows. One index, one version.
    version: 130,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed
     ON todos_tasks(user_id, completed_at)`,
    ],
  },
  {
    // The day the reader finished the task, in the account's own zone.
    //
    // The statistics group finished work by day, and a day computed from `completed_at` at query time
    // is wrong twice a year: a fixed offset shifts by an hour across a DST boundary, and a per-row
    // conversion in the database grows with the shelf. The stored day is the one fact the group needs,
    // and a streak then costs one index walk. Nullable with no default because an unfinished task has
    // no completion day — an honest absence, filled in by `migrateTodoDayColumns` for rows that
    // finished before this column existed.
    version: 131,
    skipIfColumnExists: { table: 'todos_tasks', column: 'completed_on' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN completed_on TEXT`,
    ],
  },
  {
    // The day the task was written, in the account's own zone, for the same reason as 131.
    //
    // Created-versus-completed is the pair the daily trend compares, and both sides have to be read
    // in one calendar. Nullable because rows written before the column existed have no day until the
    // backfill computes one from `created_at`.
    version: 132,
    skipIfColumnExists: { table: 'todos_tasks', column: 'created_on' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN created_on TEXT`,
    ],
  },
  {
    // What the statistics read: one account's finished tasks by the day they were finished.
    //
    // Keyed on the account first for the reason every index here is — the walk never crosses into
    // another reader's rows — and on the day second so a streak or a daily trend is one ordered
    // range instead of a full scan of the shelf. One index, one version.
    version: 133,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_completed_on
     ON todos_tasks(user_id, completed_on)`,
    ],
  },
  {
    // The day a reader picked a task into "today" — "My Day", which is not the same question as
    // "what is due today".
    //
    // The value is the account's calendar day (`YYYY-MM-DD`), the same shape `completed_on` uses and
    // for the same reason: a day derived from an offset drifts across DST. It is a day rather than a
    // boolean because the membership has to lapse at midnight without a sweep — yesterday's string
    // simply stops equalling today's, so no cron and no state drift. Nullable with no default because
    // a task nobody picked is an honest absence, not a different kind of plan. The number follows the index above it: the
    // to-do read switch this column once left room for arrived later under its own number.
    version: 134,
    skipIfColumnExists: { table: 'todos_tasks', column: 'planned_for' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN planned_for TEXT`,
    ],
  },
  {
    // The today view now reads two predicates — due by the end of the day, or picked for it — and the
    // second had no index: every listing and every badge walked the account's whole shelf. Keyed on
    // the account first for the reason every index here is, and on the picked day second so the
    // membership is one range. One index, one version.
    version: 135,
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_planned
     ON todos_tasks(user_id, planned_for)`,
    ],
  },
  {
    // The task row's own version, so an edit cannot land on a row somebody else already changed.
    //
    // A task stays on screen for as long as the reader takes to edit it, and a route, the assistant and
    // a second device can all save inside that window: the later write used to replace the other one
    // without a word. `rev` is moved on by every write path — `updateTask`, `planTask`, `setTaskTags`
    // and the row-touching ones beside them — and a guarded write names the revision it read, so a
    // stale one is refused (409, zero writes) instead of overwriting a newer edit. NOT NULL with a
    // default of 1 because every row written before this column existed is a first revision, and a
    // nullable column would make "no version" indistinguishable from one. One column, one version.
    version: 136,
    skipIfColumnExists: { table: 'todos_tasks', column: 'rev' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN rev INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // When a list was put away, or null while it is in use.
    //
    // Archiving is a stamp rather than a boolean so the shelf can say when a list was put away, and
    // nullable because every list that was never archived is an honest absence rather than a date.
    // The lists endpoint reads it as the difference between the working page and the archive, and
    // every account-wide count leaves a stamped list's tasks out. One column, one version.
    version: 137,
    skipIfColumnExists: { table: 'todos_lists', column: 'archived_at' },
    statements: [
      `ALTER TABLE todos_lists ADD COLUMN archived_at INTEGER`,
    ],
  },
  {
    // The one container a list may sit under.
    //
    // Grouping is deliberately one level: the organizer page draws a list inside its parent and a
    // parent inside nothing, so the column names a root and a route refuses a parent that is itself a
    // child. Nullable because most lists are roots, and no foreign key because deleting a container
    // must not delete its lists — the app lifts its children to the top level instead. One column,
    // one version.
    version: 138,
    skipIfColumnExists: { table: 'todos_lists', column: 'parent_id' },
    statements: [
      `ALTER TABLE todos_lists ADD COLUMN parent_id TEXT`,
    ],
  },
  {
    // When a task was moved to the trash, or null while it is live.
    //
    // Deleting a task is now a stamp rather than a row removal, so an accidental delete can be taken
    // back with the row's steps, tags and reminders intact. Nullable because a task that was never
    // deleted has no deletion day — an honest absence rather than a sentinel. Every task read names
    // `deleted_at IS NULL` through the predicate in `assistant/store.ts`, and the stamp is what the
    // trash list and the 30-day sweep read instead. The index pairs the account with the stamp: the
    // sweep asks for every account's expired rows at once, and the trash page reads one account's
    // newest first, so the account has to lead. One column and its index, one version.
    version: 139,
    skipIfColumnExists: { table: 'todos_tasks', column: 'deleted_at' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN deleted_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_trash
     ON todos_tasks(user_id, deleted_at)`,
    ],
  },
  {
    // When a task may be begun, or null when the reader named no start.
    //
    // A start date is not a second due date: it marks the day the row becomes work, while the due
    // date says when it is owed. Nullable because most tasks are work from the moment they are filed,
    // and an absent start is an honest absence rather than a sentinel. The plan view falls back to the
    // due date when it is absent. One column, one version.
    version: 140,
    skipIfColumnExists: { table: 'todos_tasks', column: 'start_at' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN start_at INTEGER`,
    ],
  },
  {
    // The account switch behind `todos:read`.
    //
    // A key that names the to-do scope could read tasks with no account switch to stop it, while the
    // note family and the to-do writes both answered to one. The column defaults to 1 rather than 0:
    // every account whose keys already read tasks was allowed to, and a switch that arrives off would
    // revoke that silently on the boot that added it. One column, one version.
    version: 141,
    skipIfColumnExists: { table: 'mcp_preferences', column: 'todo_read_enabled' },
    statements: [
      `ALTER TABLE mcp_preferences ADD COLUMN todo_read_enabled INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // Where a task sits in the reader's own order, or null while nobody has placed it.
    //
    // The to-do list has only ever been read in an order the app computed — due date first — and the
    // drag and the phone's move menu need the reader's own answer stored somewhere. REAL rather than
    // INTEGER because a row lands between two neighbours by folding their midpoint: an integer would
    // run out of room after one drop into the same gap. Nullable with no default because a task
    // nobody placed is an honest absence, and every read keeps its old order until the first move.
    // The index leads with the account and the list, which is the scope a move and a listing read,
    // so a manual order is an ordered range rather than a sort of the whole shelf. One column and its
    // index, one version.
    version: 142,
    skipIfColumnExists: { table: 'todos_tasks', column: 'position' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN position REAL`,
      `CREATE INDEX IF NOT EXISTS idx_todos_tasks_position
     ON todos_tasks(user_id, list_id, position)`,
    ],
  },
  {
    // The task's own icon, or null while it wears its list's.
    //
    // A list has carried one since lists existed, and a task that names none reads the list's — the
    // fallback the inbox gets today. Nullable with no default because "the reader placed nothing here"
    // and "the reader kept the list's" are different rows, and only one of them is an absence. The
    // colour below arrives in its own version because the migration ledger counts one column per
    // version: they reach the reader as one feature but travel one migration at a time. A fresh
    // database already carries both from the table declaration, so the guard is the icon column
    // alone; a database that somehow holds one and not the other is completed from that declaration
    // by `repairMissingColumns`.
    version: 143,
    skipIfColumnExists: { table: 'todos_tasks', column: 'icon' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN icon TEXT`,
    ],
  },
  {
    // The task's own colour, or null while it wears its list's.
    //
    // The second half of the face the icon started: an icon with no colour is half a look, and the
    // editor that sets one sets both. Its own version rather than a second statement above because
    // the migration ledger counts one new column per version — one feature, two migrations. The
    // guard is the colour column because a database that ran 143 already carries the icon, and a
    // fresh database carries both from the table declaration; only a database skipped by 126 needs
    // this one, and `repairMissingColumns` closes the gap if it ever holds the icon without the
    // colour.
    version: 144,
    skipIfColumnExists: { table: 'todos_tasks', column: 'color' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN color TEXT`,    ],
  },
  {
    version: 145,
    statements: MEMOS_SCHEMA_STATEMENTS,
  },
  {
    // Where an attachment's bytes actually are, so a rename or a re-file can no longer move them.
    //
    // Deliberately not backfilled: null reads as "this row predates the hub", and those objects are
    // still sitting in the flat unprefixed layout. Reproducing the extension rule in SQL to fill
    // this column in would be the one chance to get a key wrong on a row nobody can otherwise
    // detect, for no benefit a reader does not already get from the fallback.
    version: 146,
    skipIfColumnExists: { table: 'attachments', column: 'object_key' },
    statements: [
      `ALTER TABLE attachments ADD COLUMN object_key TEXT`,
    ],
  },
  {
    // Which application owns an attachment row.
    //
    // Task uploads already shared this table with notes and were told apart by a null `note_id`,
    // which is also what an MCP upload with no note looks like and what a note's file looks like
    // once its note is trashed — so the column cannot be inferred at read time and has to be
    // stamped at write time. The backfill uses the only structured link that exists, the task's own
    // row in `todos_attachments`; a file linked to two tasks lands in `todos` either way, and a
    // file whose task was deleted with the link removed has no home left to be wrong about.
    version: 147,
    skipIfColumnExists: { table: 'attachments', column: 'scope' },
    statements: [
      `ALTER TABLE attachments ADD COLUMN scope TEXT NOT NULL DEFAULT 'notes'`,
      `UPDATE attachments SET scope = 'todos'
        WHERE EXISTS (
          SELECT 1 FROM todos_attachments ta
           WHERE ta.user_id = attachments.user_id AND ta.attachment_id = attachments.id
        )`,
    ],
  },
  {
    // The four columns the hub filters and files shares by, one version each so a database that
    // died halfway through the feature resumes at the column it did not get rather than at the
    // start of a bundle whose earlier halves `skipIfColumnExists` would have to guess about.
    //
    // `is_enabled` is `NOT NULL DEFAULT 1` and the payload reads it as `!== 0`, which makes "the
    // link answers a reader" one value rather than a value plus a missing case — the ALTER fills
    // existing rows with 1, so a share that predates the hub is live, exactly as it was.
    version: 148,
    skipIfColumnExists: { table: 'shares', column: 'folder_id' },
    statements: [
      `ALTER TABLE shares ADD COLUMN folder_id TEXT`,
    ],
  },
  {
    version: 149,
    skipIfColumnExists: { table: 'shares', column: 'tags' },
    statements: [
      `ALTER TABLE shares ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 150,
    skipIfColumnExists: { table: 'shares', column: 'is_enabled' },
    statements: [
      `ALTER TABLE shares ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    // Deliberately not backfilled from `shares.views`: the counter says a link *was* read but not
    // when, and a wrong timestamp would make a genuinely stale link look freshly opened. A null
    // reads as "this link predates the log", which the stale report already has to answer for.
    version: 151,
    skipIfColumnExists: { table: 'shares', column: 'last_viewed_at' },
    statements: [
      `ALTER TABLE shares ADD COLUMN last_viewed_at INTEGER`,
    ],
  },
  {
    version: 152,
    statements: [
      ...SHARE_HUB_SCHEMA_STATEMENTS,
      // The hub's two list-shaped indexes, after the columns above exist on a migrated database.
      // Both are `IF NOT EXISTS`, so a fresh install that already carries them from the table
      // declaration simply finds them there.
      `CREATE INDEX IF NOT EXISTS idx_shares_user_enabled_folder
         ON shares(user_id, is_enabled, folder_id, created_at DESC, slug DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_user_expires ON shares(user_id, expires_at)`,
    ],
  },
  {
    // How long a task's reader expects it to take, in milliseconds.
    //
    // Nullable on purpose: "nobody estimated" and "the estimate is zero" are different answers, and
    // the worklog has to tell them apart. The table declaration carries the column for a fresh
    // database; this version is what an older one gains it under. `todos_time_entries` itself needs
    // no number — tables are built before the ledger is consulted, the same way `todos_task_events`
    // arrived without one.
    version: 153,
    skipIfColumnExists: { table: 'todos_tasks', column: 'time_estimate_ms' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN time_estimate_ms INTEGER`,
    ],
  },
  {
    // The shelf a task is put away on, as distinct from the trash it is deleted into.
    //
    // "Finish day" needs a place to send work the reader has looked at and is not going to do — a row
    // that is neither owed (so it leaves today, the badges, the board and the calendar) nor gone (so its
    // hours stay in the statistics and its record stays in the completed list). Nullable, because every
    // row written before this line is, correctly, not put away.
    version: 154,
    skipIfColumnExists: { table: 'todos_tasks', column: 'archived_at' },
    statements: [
      `ALTER TABLE todos_tasks ADD COLUMN archived_at INTEGER`,
    ],
  },
  {
    // The two columns a task's one reminder used to live in, and the index that read them.
    //
    // `todos_reminders` (one row per instant, `fired_at` as the delivery mark) superseded both: no code
    // has read or written `remind_at` / `reminded_at` since, `migrateTaskReminders` empties whatever a
    // database still holds into the table, and five reminders per task cannot fit in one column at all.
    // This round of the to-do app lives at 153, 154 and here: 148 to 152 were reached first by the
    // share hub on the branch this one merged, and a migration number is a promise to every database.
    //
    // Three statements, in this order, in one batch:
    //  - SQLite refuses `DROP COLUMN` for a column an index still names, so the partial index over
    //    `remind_at` has to go first (measured: the drop alone fails with "error in index … after drop
    //    column: no such column"). It is a dead index in any case — the sweep has read
    //    `todos_reminders.remind_at` since the table arrived, so this also stops every task write from
    //    maintaining an index nothing queries.
    //  - the columns follow, in the order the table declared them.
    // The guard is the mirror of an `ADD`'s: a fresh database has neither column, and `ALTER TABLE …
    // DROP COLUMN` of a column that is not there is an error rather than a no-op.
    version: 155,
    skipIfColumnMissing: { table: 'todos_tasks', column: 'remind_at' },
    statements: [
      `DROP INDEX IF EXISTS idx_todos_tasks_remind`,
      `ALTER TABLE todos_tasks DROP COLUMN remind_at`,
      `ALTER TABLE todos_tasks DROP COLUMN reminded_at`,
    ],
  },
  {
    version: 156,
    skipIfColumnExists: { table: 'mcp_preferences', column: 'email_enabled' },
    statements: [
      `ALTER TABLE mcp_preferences ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 157,
    skipIfColumnExists: { table: 'email_contacts', column: 'pinned' },
    statements: [
      `ALTER TABLE email_contacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 158,
    skipIfColumnExists: { table: 'email_contacts', column: 'avatar' },
    statements: [
      `ALTER TABLE email_contacts ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 159,
    skipIfColumnExists: { table: 'email_groups', column: 'starred' },
    statements: [
      `ALTER TABLE email_groups ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 160,
    skipIfColumnExists: { table: 'email_groups', column: 'pinned' },
    statements: [
      `ALTER TABLE email_groups ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 161,
    skipIfColumnExists: { table: 'email_groups', column: 'avatar' },
    statements: [
      `ALTER TABLE email_groups ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 162,
    statements: [
      `CREATE TABLE IF NOT EXISTS email_deployment_settings (
        id TEXT PRIMARY KEY,
        domains TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL DEFAULT 'cloudflare',
        resend_from TEXT NOT NULL DEFAULT '',
        resend_key_ciphertext TEXT NOT NULL DEFAULT '',
        resend_key_hint TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Pinning a favourite is a sub-state of being a favourite, so the column is nullable and NULL is
    // "not pinned" — which is also the only honest reading of every row that predates it. The index
    // follows the list order (`(pinned_at IS NULL), pinned_at DESC`) rather than leading with it.
    version: 163,
    skipIfColumnExists: { table: 'music_favorite', column: 'pinned_at' },
    statements: [
      `ALTER TABLE music_favorite ADD COLUMN pinned_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_music_favorite_pinned
         ON music_favorite(user_id, pinned_at DESC)`,
    ],
  },
  {
    version: 164,
    skipIfColumnExists: { table: 'music_playlist', column: 'pinned_at' },
    statements: [
      `ALTER TABLE music_playlist ADD COLUMN pinned_at INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_music_playlist_pinned
         ON music_playlist(user_id, pinned_at DESC)`,
    ],
  },
  {
    // A cache rather than a library: deleting a track removes its rows, and the primary key already
    // answers the one lookup the translation route needs.
    version: 165,
    statements: [
      `CREATE TABLE IF NOT EXISTS music_lyric_ai (
        user_id TEXT NOT NULL,
        track_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'translation',
        lang TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, track_key, kind, lang)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_music_lyric_ai_track
         ON music_lyric_ai(user_id, track_key)`,
    ],
  },
  {
    version: 166,
    statements: [
      `CREATE TABLE IF NOT EXISTS music_mount (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'alist',
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        root_path TEXT NOT NULL DEFAULT '/',
        secret TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_music_mount_user
         ON music_mount(user_id, created_at, id)`,
    ],
  },
  {
    // A cover the reader uploaded lives beside the audio, not in the playlist row: the R2 key is
    // what the media route reads, while `cover_url` is the address the page renders.
    version: 167,
    skipIfColumnExists: { table: 'music_playlist', column: 'cover_key' },
    statements: [
      `ALTER TABLE music_playlist ADD COLUMN cover_key TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // Sharing is a slug rather than a boolean so a link can be rotated and revoked independently.
    // The partial unique index keeps every generated address global while unshared rows stay NULL.
    version: 168,
    skipIfColumnExists: { table: 'music_playlist', column: 'share_slug' },
    statements: [
      `ALTER TABLE music_playlist ADD COLUMN share_slug TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_music_playlist_share
         ON music_playlist(share_slug) WHERE share_slug IS NOT NULL`,
    ],
  },
  {
    // Earlier builds asked Netease for no lyric forms, so stored LRC-only rows have to be fetched
    // again now that the provider request includes YRC. Only the provider cache is cleared.
    version: 169,
    statements: [
      `DELETE FROM music_lyric WHERE source = 'netease' AND yrc = ''`,
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
  attachments: ['id', 'user_id', 'scope', 'note_id', 'folder_id', 'filename', 'mime', 'size', 'sha256', 'object_key', 'width', 'height', 'is_starred', 'is_pinned', 'tags', 'storage', 'created_at'],
  attachment_folders: ['user_id', 'id', 'scope', 'parent_id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at'],
  attachment_tags: ['user_id', 'id', 'scope', 'name', 'color', 'is_pinned', 'created_at'],
  attachment_cleanup: ['object_key', 'user_id', 'created_at'],
  import_mappings: ['user_id', 'entity', 'source_id', 'target_id', 'updated_at'],
  backup_targets: ['id', 'user_id', 'type', 'name', 'enabled', 'config', 'secret', 'last_run_at', 'last_status', 'last_error', 'created_at', 'updated_at'],
  backup_archives: ['user_id', 'target_id', 'destination', 'archive_path', 'created_at'],
  backup_runs: ['id', 'user_id', 'trigger', 'status', 'started_at', 'finished_at', 'note_count', 'file_count', 'bytes', 'detail'],
  shares: ['slug', 'note_id', 'user_id', 'folder_id', 'tags', 'password_hash', 'expires_at', 'views', 'is_enabled', 'last_viewed_at', 'created_at'],
  share_asset_sessions: ['id', 'slug', 'password_hash', 'expires_at', 'created_at'],
  changes: ['seq', 'user_id', 'entity', 'entity_id', 'op', 'at'],
  sessions: ['id', 'user_id', 'expires_at', 'created_at'],
  login_attempts: ['key', 'fails', 'last_fail_at', 'locked_until'],
  totp_credentials: ['user_id', 'secret_ciphertext', 'enabled_at', 'pending_token_hash', 'pending_session_id', 'pending_expires_at', 'recovery_generation', 'last_used_step', 'last_used_by', 'created_at', 'updated_at'],
  totp_recovery_codes: ['user_id', 'code_hash', 'generation', 'created_at', 'used_at', 'used_by'],
  totp_login_challenges: ['id', 'user_id', 'expires_at', 'claimed_by', 'created_at'],
  mcp_preferences: ['user_id', 'write_enabled', 'trash_enabled', 'todo_read_enabled', 'email_enabled', 'disabled_tools', 'updated_at'],
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
  ...TODOS_REQUIRED_COLUMNS,
  ...SUBSCRIPTIONS_REQUIRED_COLUMNS,
  ...MEMOS_REQUIRED_COLUMNS,
  ...SHARE_HUB_REQUIRED_COLUMNS,
  ...EMAIL_REQUIRED_COLUMNS,
  ...MUSIC_REQUIRED_COLUMNS,
} as const

export const REQUIRED_TABLES = [
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
  'attachment_folders',
  'attachment_tags',
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
  ...TODOS_REQUIRED_TABLES,
  ...SUBSCRIPTIONS_REQUIRED_TABLES,
  ...MEMOS_REQUIRED_TABLES,
  ...SHARE_HUB_REQUIRED_TABLES,
  ...EMAIL_REQUIRED_TABLES,
  ...MUSIC_REQUIRED_TABLES,
] as const

export const REQUIRED_INDEXES = [
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
  'idx_attachments_user_scope',
  'idx_attachments_user_folder',
  'idx_attachment_folders_user',
  'idx_attachment_tags_user',
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
  'idx_shares_user_enabled_folder',
  'idx_shares_user_expires',
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
  ...TODOS_REQUIRED_INDEXES,
  ...SUBSCRIPTIONS_REQUIRED_INDEXES,
  ...MEMOS_REQUIRED_INDEXES,
  ...SHARE_HUB_REQUIRED_INDEXES,
  ...EMAIL_REQUIRED_INDEXES,
  ...MUSIC_REQUIRED_INDEXES,
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
  // Ahead of the migrations, and that order is load-bearing: migration 155 drops the two columns this
  // reads, so a boot that ran the migrations first would delete a pending reminder out of the only place
  // an older account had ever written one. Nothing here needs a migration's output — `todos_reminders` is
  // a declared table created by the statements just above, and the pair it empties has been on the task
  // table since before any version number was spent on it.
  await migrateTaskReminders(db)
  await applyMigrations(db)
  await repairReaderBookTenantKey(db)
  await migrateTaskTable(db)
  await migrateTodoDayColumns(db)
  // The event backfill asks "does this task have a birth/completion yet" once per task, and without
  // `idx_todos_task_events_task` each answer walks the whole history. On a shelf of ten thousand
  // rows that turns the boot into minutes, so the indexes have to be in place before the probe, not
  // after it. Nothing here is reordered across the tables and migrations it reads: this is still
  // after `applyMigrations`, and the repair functions above never need an index they create.
  if (initialized) {
    await runStatements(db, INDEX_SCHEMA_STATEMENTS)
  }
  await migrateTaskEvents(db)
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

/**
 * Moves an older database's tasks into the table the to-do app owns.
 *
 * The task list began as `chat_tasks` inside the assistant schema. Renaming it is not a migration:
 * a migration would have to be written against a table name that either exists or does not, and the
 * ledger cannot express "only when the old table is still here". A repair step can — and, more
 * importantly, it can refuse to drop anything until every row has landed in the new table. A copy
 * that silently lost a row would be worse than a boot that stops and says so.
 */
async function migrateTaskTable(db: D1Database): Promise<void> {
  const legacy = await db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'chat_tasks'`)
    .first<{ present: number }>()
  if (!legacy) return
  const columns = 'user_id, id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at'
  const before = await db.prepare(`SELECT COUNT(*) AS n FROM chat_tasks`).first<{ n: number }>()
  await db
    .prepare(`INSERT OR IGNORE INTO todos_tasks (${columns}) SELECT ${columns} FROM chat_tasks`)
    .run()
  const after = await db.prepare(`SELECT COUNT(*) AS n FROM todos_tasks`).first<{ n: number }>()
  const copied = after?.n ?? 0
  const original = before?.n ?? 0
  if (copied < original) {
    throw new Error(
      `The task table could not be moved: ${copied} of ${original} rows reached todos_tasks. ` +
      'chat_tasks has been left untouched, so no task was lost; the boot stops here rather than dropping it.',
    )
  }
  await db.prepare(`DROP TABLE chat_tasks`).run()
  console.warn('[inkstone] Schema repair: moved chat_tasks into todos_tasks')
}

/**
 * How many rows one day-column update carries.
 *
 * The backfill used to prepare one `UPDATE` per row. A few hundred rows made that a few hundred D1
 * statements inside the first request, and a shelf of ten thousand held the boot for minutes — the
 * app appeared down because every API request waits for this. One statement per hundred rows writes
 * the same values in a handful of statements; the row count is the batch, not the statement.
 */
const DAY_BACKFILL_ROWS_PER_STATEMENT = 100

/**
 * Files every task that predates the day columns under its account's calendar day.
 *
 * `created_on` / `completed_on` (versions 131 and 132) hold the day the reader wrote or finished a
 * task, because a day derived at query time drifts across DST and files work under the wrong date.
 * Rows that existed before the columns did have no day, so this one-shot repair computes one from
 * `created_at` / `completed_at` in the account's stored zone — the same `chat_settings` value every
 * due date and every "today" is already read in — falling back to UTC when the row or the zone is
 * missing or unrecognised. `isValidTimeZone` is the check rather than a hand-written parser.
 *
 * Two properties make it safe to run on every boot:
 *  - it only fills columns that are NULL (`COALESCE`), so a reader who changes zones later never has
 *    yesterday's task re-filed, and a second boot has nothing left to do;
 *  - every day is computed before the first write, and the filled counts are compared with what was
 *    missing afterwards. A row that cannot be dated, or a write that did not land, stops the boot
 *    with the reason instead of leaving a table whose statistics would silently undercount.
 */
async function migrateTodoDayColumns(db: D1Database): Promise<void> {
  const before = await todoDayCounts(db)
  if (!before.createdMissing && !before.completedMissing) return

  const { results: accounts } = await db.prepare(
    `SELECT DISTINCT user_id FROM todos_tasks
      WHERE created_on IS NULL OR (completed_on IS NULL AND completed_at IS NOT NULL)`,
  ).all<{ user_id: string }>()

  // Computed first, written afterwards: a row whose timestamp is not a date has to stop the boot
  // before any account's days have landed, or the table would be half filled.
  const updates: D1PreparedStatement[] = []
  for (const account of accounts ?? []) {
    const zone = await accountTimeZone(db, account.user_id)
    const { results: rows } = await db.prepare(
      `SELECT id, created_at, completed_at FROM todos_tasks
        WHERE user_id = ?1 AND (created_on IS NULL OR (completed_on IS NULL AND completed_at IS NOT NULL))`,
    ).bind(account.user_id).all<{ id: string; created_at: number; completed_at: number | null }>()
    const filed: { id: string; createdOn: string; completedOn: string | null }[] = []
    for (const row of rows ?? []) {
      let createdOn: string
      let completedOn: string | null
      try {
        createdOn = todoDayColumn(row.created_at, zone)
        completedOn = row.completed_at === null ? null : todoDayColumn(row.completed_at, zone)
      } catch (cause) {
        throw new Error(
          `The task day columns could not be filled: task ${row.id} of account ${account.user_id} ` +
          `has a timestamp that is not a date (${String(row.created_at)} / ${String(row.completed_at)}). ` +
          'No day was written, and the boot stops here rather than leaving a half-filled table.',
          { cause },
        )
      }
      filed.push({ id: row.id, createdOn, completedOn })
    }
    for (const chunk of chunkStatements(filed, DAY_BACKFILL_ROWS_PER_STATEMENT)) {
      // `COALESCE` keeps the values a previous boot already wrote, and the `WHERE` guard keeps this
      // statement's rows to the ones the count above found missing. The chunk travels as one bound
      // JSON document rather than a parameter per value: a hundred rows carry two hundred values,
      // past D1's bound-parameter ceiling, and the document also keeps every id out of the SQL text.
      const entries = chunk.map((row) => ({ id: row.id, created: row.createdOn, completed: row.completedOn }))
      updates.push(db.prepare(
        `UPDATE todos_tasks
            SET created_on = COALESCE(created_on, (
                  SELECT json_extract(entry.value, '$.created') FROM json_each(?2) AS entry
                   WHERE json_extract(entry.value, '$.id') = todos_tasks.id)),
                completed_on = COALESCE(completed_on, (
                  SELECT json_extract(entry.value, '$.completed') FROM json_each(?2) AS entry
                   WHERE json_extract(entry.value, '$.id') = todos_tasks.id))
          WHERE user_id = ?1
            AND id IN (SELECT json_extract(entry.value, '$.id') FROM json_each(?2) AS entry)
            AND (created_on IS NULL OR (completed_on IS NULL AND completed_at IS NOT NULL))`,
      ).bind(account.user_id, JSON.stringify(entries)))
    }
  }

  for (const group of chunkStatements(updates, SCHEMA_BATCH_STATEMENTS)) await db.batch(group)

  const after = await todoDayCounts(db)
  const createdFilled = after.createdFilled - before.createdFilled
  const completedFilled = after.completedFilled - before.completedFilled
  if (createdFilled !== before.createdMissing || completedFilled !== before.completedMissing) {
    throw new Error(
      `The task day columns could not be filled: ${createdFilled} of ${before.createdMissing} created ` +
      `days and ${completedFilled} of ${before.completedMissing} completed days landed. The columns are ` +
      'left as they are, and the boot stops here rather than serving statistics that would undercount.',
    )
  }
  console.warn(
    `[inkstone] Schema repair: filed ${createdFilled} created and ${completedFilled} completed task day(s)`,
  )
}

/** The day counts the backfill compares before and after its writes: what is missing and what is filled. */
async function todoDayCounts(db: D1Database): Promise<{
  createdMissing: number
  createdFilled: number
  completedMissing: number
  completedFilled: number
}> {
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN created_on IS NULL THEN 1 ELSE 0 END), 0) AS created_missing,
       COALESCE(SUM(CASE WHEN created_on IS NOT NULL THEN 1 ELSE 0 END), 0) AS created_filled,
       COALESCE(SUM(CASE WHEN completed_on IS NULL AND completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed_missing,
       COALESCE(SUM(CASE WHEN completed_on IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed_filled
     FROM todos_tasks`,
  ).first<{
    created_missing: number
    created_filled: number
    completed_missing: number
    completed_filled: number
  }>()
  return {
    createdMissing: Number(row?.created_missing ?? 0),
    createdFilled: Number(row?.created_filled ?? 0),
    completedMissing: Number(row?.completed_missing ?? 0),
    completedFilled: Number(row?.completed_filled ?? 0),
  }
}

/**
 * Moves the old single reminder into `todos_reminders`.
 *
 * `todos_tasks.remind_at` / `reminded_at` held one instant and its delivery fact. The table is now the
 * only place a reminder lives, so a database that predates it has to hand its rows over exactly once:
 * each `remind_at` becomes a row, and a non-null `reminded_at` becomes its `fired_at` — a reminder the
 * reader was already told about must not be announced a second time by a deployment upgrade.
 *
 * Four properties make it safe to run on every boot:
 *  - it starts by asking whether the table still has the column at all. Migration 155 drops the pair
 *    behind this repair, and a database that has been through it holds nothing to move and no column for
 *    the statements below to name;
 *  - it only looks at rows whose `remind_at` is not null, and the same batch clears that column, so a
 *    converged database pays one count and nothing else;
 *  - the insert and the clear are one `db.batch`, which D1 runs as a transaction: a failure (a locked
 *    table, a trigger, a restored backup with a conflicting id) leaves the old columns exactly as they
 *    were, so no reminder is lost and the next boot tries again;
 *  - the counts the batch answers with are compared with what was asked for. A mismatch stops the boot
 *    with the numbers instead of serving a database whose reminders quietly differ from its tasks.
 *
 * The ids are `lower(hex(randomblob(13)))`: 26 hex characters, which is exactly the shape `isValidId`
 * accepts and the alphabet `newId()` draws from — minted in SQL because the rows are copied in one
 * statement rather than read into memory and written back one at a time.
 */
async function migrateTaskReminders(db: D1Database): Promise<void> {
  if (!await hasColumn(db, { table: 'todos_tasks', column: 'remind_at' })) return
  const legacy = await db.prepare(
    `SELECT COUNT(*) AS n FROM todos_tasks WHERE remind_at IS NOT NULL`,
  ).first<{ n: number | null }>()
  const expected = Number(legacy?.n ?? 0)
  if (!expected) return

  const results = await db.batch([
    db.prepare(
      `INSERT INTO todos_reminders (user_id, id, task_id, remind_at, fired_at, created_at)
       SELECT user_id, lower(hex(randomblob(13))), id, remind_at, reminded_at, created_at
         FROM todos_tasks WHERE remind_at IS NOT NULL`,
    ),
    db.prepare(
      `UPDATE todos_tasks SET remind_at = NULL, reminded_at = NULL WHERE remind_at IS NOT NULL`,
    ),
  ])
  const inserted = Number(results[0]?.meta?.changes ?? 0)
  const cleared = Number(results[1]?.meta?.changes ?? 0)
  if (inserted !== expected || cleared !== expected) {
    throw new Error(
      `The single task reminders could not be moved: ${inserted} of ${expected} rows reached ` +
      `todos_reminders and ${cleared} were cleared. The move is one transaction, so the old columns are ` +
      'either untouched or fully handed over; the boot stops here rather than serving reminders that ' +
      'disagree with their tasks.',
    )
  }
  console.warn(`[inkstone] Schema repair: moved ${inserted} single task reminder(s) into todos_reminders`)
}

/**
 * Seeds an older database's task history from the rows it already holds.
 *
 * `todos_task_events` records every status change from the day the table existed; a database that
 * predates it holds tasks with no history at all, and the cumulative flow would open on an empty
 * range. Two kinds of row can still be told from the task table alone, and both are filed here: a
 * `born` for every task (at `created_at`, under `created_on`) and a completion for every task that
 * is done now (at `completed_at`, under `completed_on`). The day columns already carry the
 * account's zone, so no row is dated a second time. What cannot be told is left alone: a task
 * that was started and reopened before this table existed moved through states nothing recorded,
 * so a completion's `from_status` is the documented approximation `'todo'`, and the flow's
 * `trackedSince` line marks where the real record begins. A birth is always filed as `'todo'` for
 * the same reason: a task born and finished long ago has no start event to replay, and filing its
 * birth under `done` would add it to the finished band a second time when the completion beside it
 * is replayed.
 *
 * Three properties make it safe to run on every boot, the ones `migrateTaskReminders` set:
 *  - each insert only fills the rows its `NOT EXISTS` guard says are missing, so a converged
 *    database pays two counts and nothing else, and a second boot has nothing left to write;
 *  - the two inserts are one `db.batch`, which D1 runs as a transaction: a failure (a locked
 *    table, a restored backup with a conflicting id) leaves the events exactly as they were, so no
 *    history is lost and the next boot tries again;
 *  - the rows the batch answers with are compared with what was missing. A mismatch stops the boot
 *    with the numbers instead of serving a flow that quietly disagrees with its tasks.
 *
 * The ids are `lower(hex(randomblob(13)))` for the reason the reminder move gives: 26 hex
 * characters, the shape `isValidId` accepts, minted in SQL because the rows are copied in one
 * statement rather than read into memory and written back one at a time.
 */
async function migrateTaskEvents(db: D1Database): Promise<void> {
  const gaps = await taskEventGaps(db)
  if (!gaps.born && !gaps.done) return

  const results = await db.batch([
    db.prepare(
      `INSERT INTO todos_task_events (id, user_id, task_id, at, on_day, kind, from_status, to_status)
       SELECT lower(hex(randomblob(13))), user_id, id, created_at, created_on, 'born', NULL, 'todo'
         FROM todos_tasks t
        WHERE NOT EXISTS (SELECT 1 FROM todos_task_events e WHERE e.task_id = t.id AND e.kind = 'born')`,
    ),
    db.prepare(
      `INSERT INTO todos_task_events (id, user_id, task_id, at, on_day, kind, from_status, to_status)
       SELECT lower(hex(randomblob(13))), user_id, id, completed_at, completed_on, 'status', 'todo', 'done'
         FROM todos_tasks t
        WHERE t.completed_at IS NOT NULL AND t.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM todos_task_events e
                           WHERE e.task_id = t.id AND e.kind = 'status' AND e.at = t.completed_at
                             AND e.to_status = 'done')`,
    ),
  ])
  const bornFilled = Number(results[0]?.meta?.changes ?? 0)
  const doneFilled = Number(results[1]?.meta?.changes ?? 0)
  if (bornFilled !== gaps.born || doneFilled !== gaps.done) {
    throw new Error(
      `The task history could not be backfilled: ${bornFilled} of ${gaps.born} born event(s) and ` +
      `${doneFilled} of ${gaps.done} completion event(s) landed. The two inserts are one transaction, ` +
      'so the events are either untouched or fully written; the boot stops here rather than serving a ' +
      'cumulative flow that disagrees with its tasks.',
    )
  }
  console.warn(
    `[inkstone] Schema repair: backfilled ${bornFilled} born and ${doneFilled} completion task event(s)`,
  )
}

/** The rows the backfill still owes, counted under the same guards its two inserts carry. */
async function taskEventGaps(db: D1Database): Promise<{ born: number; done: number }> {
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM todos_tasks t
          WHERE NOT EXISTS (SELECT 1 FROM todos_task_events e WHERE e.task_id = t.id AND e.kind = 'born')) AS born,
       (SELECT COUNT(*) FROM todos_tasks t
          WHERE t.completed_at IS NOT NULL AND t.status = 'done'
            AND NOT EXISTS (SELECT 1 FROM todos_task_events e
                             WHERE e.task_id = t.id AND e.kind = 'status' AND e.at = t.completed_at
                               AND e.to_status = 'done')) AS done`,
  ).first<{ born: number | null; done: number | null }>()
  return { born: Number(row?.born ?? 0), done: Number(row?.done ?? 0) }
}

/** The account's scheduling zone: the one `getSettings()` reads, or UTC when absent or unrecognised. */
async function accountTimeZone(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(`SELECT config FROM chat_settings WHERE user_id = ?1`)
    .bind(userId).first<{ config: string }>()
  const stored = storedObject(row?.config ?? '{}').timezone
  return typeof stored === 'string' && isValidTimeZone(stored) ? stored : 'UTC'
}

/** A stored instant as the account's `YYYY-MM-DD`, refusing text or an out-of-range number. */
function todoDayColumn(instant: number, zone: string): string {
  if (typeof instant !== 'number' || !Number.isFinite(instant) || Number.isNaN(new Date(instant).getTime())) {
    throw new TypeError(`${String(instant)} is not a millisecond timestamp`)
  }
  return localDate(instant, zone)
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
    // Either guard means the shape this version exists to produce is already the shape of the database:
    // an `ADD` whose column is here, or a `DROP` whose column is not. The statements are skipped and the
    // number is written all the same, which is what keeps a version from being asked twice per boot.
    if (migration.skipIfColumnExists && await hasColumn(db, migration.skipIfColumnExists)) {
      migrationStatements = []
    }
    if (migration.skipIfColumnMissing && !await hasColumn(db, migration.skipIfColumnMissing)) {
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
