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
    color TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    recurrence_rule TEXT,
    recurrence_parent_id TEXT,
    recurrence_id TEXT,
    recurrence_cancelled INTEGER NOT NULL DEFAULT 0,
    resource_id TEXT,
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
  // The activity heatmap counts events by the day they were created; the range index is ordered by
  // start_ms and cannot answer that, so this one covers the year window instead of scanning.
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_created
     ON calendar_events(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_recurring
     ON calendar_events(user_id, recurrence_rule) WHERE recurrence_rule IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_recurrence_parent
     ON calendar_events(user_id, recurrence_parent_id) WHERE recurrence_parent_id IS NOT NULL`,
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
    minutes INTEGER NOT NULL DEFAULT 0,
    fired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_id, occurrence_start_ms, minutes)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_reminder_fires_fired
     ON calendar_reminder_fires(user_id, fired_at)`,
  // One row per (event, minutes-before) pair: the sweep asks "which events in this window have a
  // reminder due", and a column of JSON minutes would answer that only by reading every row.
  `CREATE TABLE IF NOT EXISTS calendar_event_reminders (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_id, minutes)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_window
     ON calendar_event_reminders(user_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS calendar_event_attendees (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'needs-action',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_event_attendees_event
     ON calendar_event_attendees(user_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS calendar_provider_calendars (
    user_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    remote_calendar_id TEXT NOT NULL,
    local_calendar_id TEXT NOT NULL,
    last_sync_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, connection_id, remote_calendar_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_provider_local
     ON calendar_provider_calendars(user_id, local_calendar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_provider_due
     ON calendar_provider_calendars(user_id, connection_id, last_sync_at)`,
  // One public link per calendar. The slug is the whole capability — a reader has no session, so it is
  // looked up on its own — while the key stays account-first like every other calendar table. Revoking
  // deletes the row, so an address a reader wrote down is gone rather than parked next to a new one.
  `CREATE TABLE IF NOT EXISTS calendar_shares (
    user_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_viewed_at INTEGER,
    PRIMARY KEY (user_id, calendar_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_shares_slug
     ON calendar_shares(slug)`,

  // One row per file hung on an event. The bytes and their row live in the shared attachment tables;
  // this only names which event shows the file, and it goes away with that event.
  `CREATE TABLE IF NOT EXISTS calendar_event_attachments (
    user_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, attachment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_event_attachments_event
     ON calendar_event_attachments(user_id, event_id)`,

  // Calendar sharing is account-to-account. The row is the invitation and the permission at once:
  // pending rows are invites, accepted rows are shared calendars, declined rows stay as history.
  `CREATE TABLE IF NOT EXISTS calendar_members (
    owner_user_id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    member_user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'reader',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_user_id, calendar_id, member_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_members_member
     ON calendar_members(member_user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_members_calendar
     ON calendar_members(owner_user_id, calendar_id, status)`,

  // A reusable address book for guests and birthdays. Email is the identity inside one account.
  `CREATE TABLE IF NOT EXISTS calendar_contacts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    birthday TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_contacts_email
     ON calendar_contacts(user_id, lower(email))`,

  `CREATE TABLE IF NOT EXISTS calendar_event_templates (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'event',
    all_day INTEGER NOT NULL DEFAULT 0,
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    color TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_templates_user
     ON calendar_event_templates(user_id, name)`,

  // A resource is a calendar with a name and capacity; its events are reservations.
  `CREATE TABLE IF NOT EXISTS calendar_resources (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    name TEXT NOT NULL,
    capacity INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_resources_calendar
     ON calendar_resources(user_id, calendar_id)`,

  // A public booking page: the slug is the capability, the owner's calendar is where the booked
  // event lands, and the weekly window is stored as JSON so a link survives a time-zone change.
  `CREATE TABLE IF NOT EXISTS calendar_scheduling_links (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    days_json TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    start_hour INTEGER NOT NULL DEFAULT 9,
    end_hour INTEGER NOT NULL DEFAULT 17,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_scheduling_slug
     ON calendar_scheduling_links(slug)`,

  // Countdowns: dated milestones that are deliberately not events. They have no duration, no calendar
  // and no place in the range query, so one can never be dragged onto the grid or exported as a
  // meeting. `target_date` is the solar day the reader typed; the lunar fields are what a lunar repeat
  // needs after the fact, resolved once at write time so a list read never touches the lunar tables.
  `CREATE TABLE IF NOT EXISTS calendar_countdowns (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    target_date TEXT NOT NULL,
    repeat_mode TEXT NOT NULL DEFAULT 'none',
    lunar_month INTEGER,
    lunar_day INTEGER,
    lunar_leap INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_countdowns_order
     ON calendar_countdowns(user_id, pinned DESC, target_date)`,

  // A one-off "remind me again" parked on an event. The sweep reads it by notify_at and deletes the
  // row after delivering, so a snooze never changes the event's own lead list.
  `CREATE TABLE IF NOT EXISTS calendar_reminder_snoozes (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    notify_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_reminder_snoozes_due
     ON calendar_reminder_snoozes(user_id, notify_at)`,

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
  'calendar_event_reminders',
  'calendar_reminder_snoozes',
  'calendar_event_attendees',
  'calendar_shares',
  'calendar_event_attachments',
  'calendar_provider_calendars',
  'calendar_members',
  'calendar_contacts',
  'calendar_event_templates',
  'calendar_resources',
  'calendar_scheduling_links',
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
  'idx_calendar_event_reminders_window',
  'idx_calendar_reminder_snoozes_due',
  'idx_calendar_event_attendees_event',
  'idx_calendar_shares_slug',
  'idx_calendar_event_attachments_event',
  'idx_calendar_provider_local',
  'idx_calendar_provider_due',
  'idx_calendar_events_recurrence_parent',
  'idx_calendar_members_member',
  'idx_calendar_members_calendar',
  'idx_calendar_contacts_email',
  'idx_calendar_templates_user',
  'idx_calendar_resources_calendar',
  'idx_calendar_scheduling_slug',
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
    'color', 'meta_json', 'recurrence_rule', 'recurrence_parent_id', 'recurrence_id',
    'recurrence_cancelled', 'resource_id', 'calendar_source', 'external_scope', 'external_id',
    'remote_etag',
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
  calendar_reminder_fires: ['user_id', 'event_id', 'occurrence_start_ms', 'minutes', 'fired_at'],
  calendar_event_reminders: ['user_id', 'event_id', 'minutes', 'created_at'],
  calendar_reminder_snoozes: ['user_id', 'id', 'event_id', 'notify_at', 'created_at'],
  calendar_event_attendees: ['user_id', 'event_id', 'email', 'name', 'status', 'created_at'],
  calendar_shares: ['user_id', 'calendar_id', 'slug', 'views', 'created_at', 'updated_at', 'last_viewed_at'],
  calendar_event_attachments: ['user_id', 'attachment_id', 'event_id', 'created_at'],
  calendar_provider_calendars: [
    'user_id', 'connection_id', 'remote_calendar_id', 'local_calendar_id', 'last_sync_at',
    'last_error_code', 'created_at', 'updated_at',
  ],
  calendar_members: [
    'owner_user_id', 'calendar_id', 'member_user_id', 'role', 'status', 'created_at',
    'updated_at',
  ],
  calendar_contacts: ['user_id', 'id', 'name', 'email', 'birthday', 'created_at', 'updated_at', 'rev'],
  calendar_event_templates: [
    'user_id', 'id', 'name', 'title', 'description', 'kind', 'all_day', 'duration_minutes',
    'color', 'meta_json', 'created_at', 'updated_at', 'rev',
  ],
  calendar_resources: ['user_id', 'id', 'calendar_id', 'name', 'capacity', 'created_at', 'updated_at'],
  calendar_scheduling_links: [
    'user_id', 'id', 'calendar_id', 'slug', 'title', 'duration_minutes', 'days_json',
    'start_hour', 'end_hour', 'enabled', 'created_at', 'updated_at',
  ],
}
