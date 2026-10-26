/**
 * The calendar app's tables.
 *
 * Tables are created from this list before the migration ledger is consulted; indexes follow. New
 * columns on an existing deployment need a migration and a REQUIRED_COLUMNS entry, but the tables
 * themselves do not spend a version number.
 */

export const CALENDAR_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS calendar_calendars (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    dark_color TEXT NOT NULL,
    icon TEXT,
    group_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    read_only INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'local',
    subscription_id TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_calendars_order
     ON calendar_calendars(user_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_calendars_group
     ON calendar_calendars(user_id, group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_calendars_subscription
     ON calendar_calendars(user_id, subscription_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_calendars_default
     ON calendar_calendars(user_id) WHERE is_default = 1`,

  `CREATE TABLE IF NOT EXISTS calendar_groups (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_groups_name
     ON calendar_groups(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_groups_order
     ON calendar_groups(user_id, position)`,

  `CREATE TABLE IF NOT EXISTS calendar_events (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'event',
    task_completed INTEGER,
    task_completed_at INTEGER,
    task_completed_at_value TEXT,
    task_priority TEXT,
    conference_json TEXT,
    start_value TEXT NOT NULL,
    start_type TEXT NOT NULL,
    time_zone TEXT,
    start_ms INTEGER NOT NULL,
    end_value TEXT NOT NULL,
    end_type TEXT NOT NULL,
    end_ms INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    icon_json TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    recurrence_rule TEXT,
    calendar_source TEXT NOT NULL DEFAULT 'local',
    external_scope TEXT NOT NULL DEFAULT '',
    external_id TEXT,
    remote_etag TEXT,
    remote_updated_at INTEGER,
    batch_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_range
     ON calendar_events(user_id, start_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_updated
     ON calendar_events(user_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_recurring
     ON calendar_events(user_id, recurrence_rule) WHERE recurrence_rule IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_batch
     ON calendar_events(user_id, batch_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_external
     ON calendar_events(user_id, calendar_source, external_scope, external_id)
     WHERE external_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS calendar_event_calendars (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, event_id, calendar_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_event_calendars_calendar
     ON calendar_event_calendars(user_id, calendar_id, event_id)`,

  `CREATE TABLE IF NOT EXISTS calendar_subscriptions (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    connection_id TEXT,
    url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sync_cursor TEXT,
    sync_state_json TEXT NOT NULL DEFAULT '{}',
    last_sync_at INTEGER,
    last_error_code TEXT,
    last_error_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_subscriptions_calendar
     ON calendar_subscriptions(user_id, calendar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_subscriptions_connection
     ON calendar_subscriptions(user_id, connection_id)`,

  `CREATE TABLE IF NOT EXISTS calendar_connections (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    calendar_home_url TEXT,
    username TEXT,
    scope TEXT NOT NULL DEFAULT 'read',
    writable INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'connected',
    last_synced_at INTEGER,
    last_error_code TEXT,
    last_error_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_connections_kind
     ON calendar_connections(user_id, kind)`,

  `CREATE TABLE IF NOT EXISTS calendar_credentials (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_credentials_connection
     ON calendar_credentials(user_id, connection_id, kind)`,

  `CREATE TABLE IF NOT EXISTS calendar_oauth_states (
    user_id TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    verifier_ciphertext TEXT NOT NULL,
    redirect_to TEXT NOT NULL DEFAULT '/calendar',
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, state_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_oauth_expiry
     ON calendar_oauth_states(expires_at)`,

  `CREATE TABLE IF NOT EXISTS calendar_reminder_fires (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    occurrence_start_ms INTEGER NOT NULL,
    fired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_id, occurrence_start_ms)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_reminder_fires_fired
     ON calendar_reminder_fires(user_id, fired_at)`,
  `CREATE TABLE IF NOT EXISTS calendar_preferences (
    user_id TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id)
  )`,
]

export const CALENDAR_REQUIRED_TABLES: readonly string[] = [
  'calendar_calendars',
  'calendar_groups',
  'calendar_events',
  'calendar_event_calendars',
  'calendar_subscriptions',
  'calendar_connections',
  'calendar_credentials',
  'calendar_oauth_states',
  'calendar_preferences',
  'calendar_reminder_fires',
]

export const CALENDAR_REQUIRED_INDEXES: readonly string[] = [
  'idx_calendar_calendars_order',
  'idx_calendar_calendars_group',
  'idx_calendar_calendars_subscription',
  'idx_calendar_calendars_default',
  'idx_calendar_groups_name',
  'idx_calendar_groups_order',
  'idx_calendar_events_range',
  'idx_calendar_events_updated',
  'idx_calendar_events_recurring',
  'idx_calendar_events_batch',
  'idx_calendar_events_external',
  'idx_calendar_event_calendars_calendar',
  'idx_calendar_subscriptions_calendar',
  'idx_calendar_subscriptions_connection',
  'idx_calendar_connections_kind',
  'idx_calendar_credentials_connection',
  'idx_calendar_oauth_expiry',
  'idx_calendar_reminder_fires_fired',
]

export const CALENDAR_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  calendar_calendars: [
    'user_id', 'id', 'name', 'color', 'dark_color', 'icon', 'group_id', 'is_default',
    'is_visible', 'read_only', 'source', 'subscription_id', 'position', 'created_at',
    'updated_at', 'rev',
  ],
  calendar_groups: ['user_id', 'id', 'name', 'position', 'created_at', 'updated_at'],
  calendar_events: [
    'user_id', 'id', 'title', 'description', 'kind', 'task_completed', 'task_completed_at',
    'task_completed_at_value', 'task_priority', 'conference_json', 'start_value', 'start_type',
    'time_zone', 'start_ms', 'end_value', 'end_type', 'end_ms', 'all_day', 'icon_json',
    'meta_json', 'recurrence_rule', 'calendar_source', 'external_scope', 'external_id', 'remote_etag',
    'remote_updated_at', 'batch_key', 'created_at', 'updated_at', 'rev',
  ],
  calendar_event_calendars: ['user_id', 'event_id', 'calendar_id', 'position'],
  calendar_subscriptions: [
    'user_id', 'id', 'calendar_id', 'kind', 'connection_id', 'url', 'enabled', 'sync_cursor',
    'sync_state_json', 'last_sync_at', 'last_error_code', 'last_error_at', 'created_at',
    'updated_at',
  ],
  calendar_connections: [
    'user_id', 'id', 'kind', 'label', 'base_url', 'calendar_home_url', 'username', 'scope',
    'writable', 'status', 'last_synced_at', 'last_error_code', 'last_error_at', 'created_at',
    'updated_at',
  ],
  calendar_credentials: ['user_id', 'id', 'connection_id', 'kind', 'ciphertext', 'created_at', 'updated_at'],
  calendar_oauth_states: [
    'user_id', 'state_hash', 'provider', 'verifier_ciphertext', 'redirect_to', 'expires_at',
    'used_at', 'created_at',
  ],
  calendar_preferences: ['user_id', 'preferences_json', 'updated_at'],
  calendar_reminder_fires: ['user_id', 'event_id', 'occurrence_start_ms', 'fired_at'],
}
