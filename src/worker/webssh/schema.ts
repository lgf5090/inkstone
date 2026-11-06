export const WEBSSH_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS webssh_host_groups (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_host_groups_user_parent
     ON webssh_host_groups(user_id, parent_id, position)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_webssh_host_groups_name
     ON webssh_host_groups(user_id, parent_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS webssh_hosts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_folded TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    group_id TEXT NOT NULL DEFAULT '',
    auth_method TEXT NOT NULL DEFAULT 'password',
    credential_id TEXT NOT NULL DEFAULT '',
    key_id TEXT NOT NULL DEFAULT '',
    encoding TEXT NOT NULL DEFAULT 'utf-8',
    term_type TEXT NOT NULL DEFAULT 'xterm-256color',
    initial_command TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0,
    last_connected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_hosts_group
     ON webssh_hosts(user_id, group_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_hosts_name
     ON webssh_hosts(user_id, name_folded)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_hosts_recent
     ON webssh_hosts(user_id, last_connected_at DESC)`,

  `CREATE TABLE IF NOT EXISTS webssh_credentials (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    password_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_credentials_user
     ON webssh_credentials(user_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS webssh_keys (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    public_key TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    private_key_ciphertext TEXT NOT NULL DEFAULT '',
    passphrase_ciphertext TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_keys_user
     ON webssh_keys(user_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_webssh_keys_fingerprint
     ON webssh_keys(user_id, fingerprint)`,

  `CREATE TABLE IF NOT EXISTS webssh_host_keys (
    user_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    trusted_at INTEGER,
    revoked_at INTEGER,
    PRIMARY KEY (user_id, host_id, fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_host_keys_host
     ON webssh_host_keys(user_id, host_id, last_seen_at DESC)`,

  `CREATE TABLE IF NOT EXISTS webssh_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    client_ip_hash TEXT NOT NULL DEFAULT '',
    user_agent_hash TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    connected_at INTEGER,
    ended_at INTEGER,
    last_activity_at INTEGER NOT NULL DEFAULT 0,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    close_reason TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    recording_id TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_sessions_user
     ON webssh_sessions(user_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_sessions_status
     ON webssh_sessions(status, last_activity_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_sessions_host
     ON webssh_sessions(host_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS webssh_session_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_session_tickets_expires
     ON webssh_session_tickets(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_session_tickets_session
     ON webssh_session_tickets(user_id, session_id)`,

  `CREATE TABLE IF NOT EXISTS webssh_recordings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'cast',
    r2_key TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    cols INTEGER NOT NULL DEFAULT 0,
    rows INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'recording',
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at INTEGER NOT NULL,
    finalized_at INTEGER,
    expires_at INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_recordings_user
     ON webssh_recordings(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_recordings_session
     ON webssh_recordings(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_recordings_expires
     ON webssh_recordings(expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_webssh_recordings_key
     ON webssh_recordings(r2_key)`,

  `CREATE TABLE IF NOT EXISTS webssh_shares (
    slug TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    passcode_hash TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    max_views INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_viewed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_shares_user
     ON webssh_shares(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_shares_expires
     ON webssh_shares(expires_at)`,

  `CREATE TABLE IF NOT EXISTS webssh_snippets (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    title_folded TEXT NOT NULL,
    command TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    shell TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_snippets_order
     ON webssh_snippets(user_id, sort_order, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_snippets_title
     ON webssh_snippets(user_id, title_folded)`,

  `CREATE TABLE IF NOT EXISTS webssh_audit_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    host_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    ip_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_audit_user
     ON webssh_audit_events(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_audit_event
     ON webssh_audit_events(event_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_webssh_audit_session
     ON webssh_audit_events(session_id)`,

  `CREATE TABLE IF NOT EXISTS webssh_settings (
    user_id TEXT PRIMARY KEY,
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,
]

export const WEBSSH_REQUIRED_TABLES: readonly string[] = [
  'webssh_host_groups',
  'webssh_hosts',
  'webssh_credentials',
  'webssh_keys',
  'webssh_host_keys',
  'webssh_sessions',
  'webssh_session_tickets',
  'webssh_recordings',
  'webssh_shares',
  'webssh_snippets',
  'webssh_audit_events',
  'webssh_settings',
]

export const WEBSSH_REQUIRED_INDEXES: readonly string[] = [
  'idx_webssh_host_groups_user_parent',
  'idx_webssh_host_groups_name',
  'idx_webssh_hosts_group',
  'idx_webssh_hosts_name',
  'idx_webssh_hosts_recent',
  'idx_webssh_credentials_user',
  'idx_webssh_keys_user',
  'idx_webssh_keys_fingerprint',
  'idx_webssh_host_keys_host',
  'idx_webssh_sessions_user',
  'idx_webssh_sessions_status',
  'idx_webssh_sessions_host',
  'idx_webssh_session_tickets_expires',
  'idx_webssh_session_tickets_session',
  'idx_webssh_recordings_user',
  'idx_webssh_recordings_session',
  'idx_webssh_recordings_expires',
  'idx_webssh_recordings_key',
  'idx_webssh_shares_user',
  'idx_webssh_shares_expires',
  'idx_webssh_snippets_order',
  'idx_webssh_snippets_title',
  'idx_webssh_audit_user',
  'idx_webssh_audit_event',
  'idx_webssh_audit_session',
]

export const WEBSSH_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  webssh_host_groups: [
    'user_id', 'id', 'parent_id', 'name', 'color', 'icon', 'position', 'created_at', 'updated_at',
  ],
  webssh_hosts: [
    'user_id', 'id', 'name', 'name_folded', 'host', 'port', 'username', 'group_id', 'auth_method',
    'credential_id', 'key_id', 'encoding', 'term_type', 'initial_command', 'color', 'tags', 'notes',
    'favorite', 'sort_order', 'last_connected_at', 'created_at', 'updated_at', 'deleted_at',
  ],
  webssh_credentials: [
    'user_id', 'id', 'label', 'password_ciphertext', 'created_at', 'updated_at', 'last_used_at', 'deleted_at',
  ],
  webssh_keys: [
    'user_id', 'id', 'label', 'algorithm', 'public_key', 'fingerprint', 'private_key_ciphertext',
    'passphrase_ciphertext', 'created_at', 'updated_at', 'last_used_at', 'deleted_at',
  ],
  webssh_host_keys: [
    'user_id', 'host_id', 'algorithm', 'fingerprint', 'first_seen_at', 'last_seen_at', 'trusted_at', 'revoked_at',
  ],
  webssh_sessions: [
    'id', 'user_id', 'host_id', 'status', 'client_ip_hash', 'user_agent_hash', 'started_at', 'connected_at',
    'ended_at', 'last_activity_at', 'bytes_in', 'bytes_out', 'close_reason', 'error_code', 'recording_id',
  ],
  webssh_session_tickets: [
    'id', 'user_id', 'session_id', 'expires_at', 'created_at', 'consumed_at',
  ],
  webssh_recordings: [
    'id', 'user_id', 'session_id', 'host_id', 'format', 'r2_key', 'size_bytes', 'duration_ms', 'cols',
    'rows', 'status', 'visibility', 'created_at', 'finalized_at', 'expires_at', 'deleted_at',
  ],
  webssh_shares: [
    'slug', 'user_id', 'recording_id', 'title', 'passcode_hash', 'expires_at', 'max_views', 'views',
    'is_enabled', 'created_at', 'last_viewed_at',
  ],
  webssh_snippets: [
    'user_id', 'id', 'title', 'title_folded', 'command', 'description', 'tags', 'shell', 'favorite',
    'sort_order', 'created_at', 'updated_at', 'last_used_at',
  ],
  webssh_audit_events: [
    'id', 'user_id', 'session_id', 'host_id', 'event_type', 'metadata', 'ip_hash', 'created_at',
  ],
  webssh_settings: ['user_id', 'settings', 'updated_at'],
}
