export const DEVELOPMENT_CERTHUB_CORE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_certhub_accounts (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ca TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'production',
    directory_url TEXT NOT NULL,
    account_url TEXT NOT NULL DEFAULT '',
    key_ciphertext TEXT NOT NULL DEFAULT '',
    key_fingerprint TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    last_error_code TEXT,
    last_error_message TEXT,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (ca IN ('lets-encrypt','google-trust','buypass','zerossl','sslcom')),
    CHECK (environment IN ('production','staging')),
    CHECK (status IN ('active','deactivated','error'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_accounts_user_ca
     ON development_certhub_accounts(user_id, ca, environment, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_certhub_orders (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    ca TEXT NOT NULL,
    environment TEXT NOT NULL,
    key_algorithm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    subject_json TEXT NOT NULL DEFAULT '{}',
    auto_renew INTEGER NOT NULL DEFAULT 1,
    renew_at INTEGER,
    order_expires_at INTEGER,
    acme_order_url TEXT NOT NULL DEFAULT '',
    finalize_url TEXT NOT NULL DEFAULT '',
    csr_object_key TEXT NOT NULL DEFAULT '',
    cert_object_key TEXT NOT NULL DEFAULT '',
    chain_object_key TEXT NOT NULL DEFAULT '',
    key_object_key TEXT NOT NULL DEFAULT '',
    key_fingerprint TEXT NOT NULL DEFAULT '',
    serial_number TEXT NOT NULL DEFAULT '',
    issuer TEXT NOT NULL DEFAULT '',
    cert_not_before INTEGER,
    cert_not_after INTEGER,
    issued_at INTEGER,
    revoked_at INTEGER,
    revoke_reason INTEGER,
    key_purged_at INTEGER,
    failure_code TEXT,
    failure_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    lock_owner TEXT,
    locked_until INTEGER,
    renew_from_order_id TEXT,
    idempotency_key TEXT NOT NULL DEFAULT '',
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (key_algorithm IN ('rsa2048','eccp256','eccp384')),
    CHECK (status IN ('queued','creating_order','awaiting_dns','awaiting_http',
                      'validating','ready','finalizing','issued','failed',
                      'revoked','expired','canceled','deleting')),
    CHECK (auto_renew IN (0,1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_orders_user_status_updated
     ON development_certhub_orders(user_id, status, updated_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_orders_user_renew
     ON development_certhub_orders(user_id, renew_at)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_orders_user_not_after
     ON development_certhub_orders(user_id, cert_not_after)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_orders_user_created
     ON development_certhub_orders(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_orders_renew_from
     ON development_certhub_orders(user_id, renew_from_order_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_certhub_orders_idempotency
     ON development_certhub_orders(user_id, idempotency_key)
     WHERE idempotency_key <> ''`,

  `CREATE TABLE IF NOT EXISTS development_certhub_order_domains (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    name TEXT NOT NULL,
    wildcard INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    challenge_mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    authz_url TEXT NOT NULL DEFAULT '',
    challenge_url TEXT NOT NULL DEFAULT '',
    challenge_token TEXT NOT NULL DEFAULT '',
    key_authorization TEXT NOT NULL DEFAULT '',
    dns_record_name TEXT NOT NULL DEFAULT '',
    dns_record_type TEXT NOT NULL DEFAULT '',
    dns_record_value TEXT NOT NULL DEFAULT '',
    dns_provider_id TEXT NOT NULL DEFAULT '',
    dns_record_id TEXT NOT NULL DEFAULT '',
    validated_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (wildcard IN (0,1)),
    CHECK (is_primary IN (0,1)),
    CHECK (challenge_mode IN ('dns-01','http-01')),
    CHECK (status IN ('pending','prepared','validating','valid','invalid','expired'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_certhub_domains_user_order_name
     ON development_certhub_order_domains(user_id, order_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_domains_user_order
     ON development_certhub_order_domains(user_id, order_id, is_primary DESC, name)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_domains_user_name
     ON development_certhub_order_domains(user_id, name, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_domains_user_status
     ON development_certhub_order_domains(user_id, status, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_certhub_settings (
    user_id TEXT NOT NULL,
    default_ca TEXT NOT NULL DEFAULT 'lets-encrypt',
    default_key_algorithm TEXT NOT NULL DEFAULT 'eccp256',
    default_challenge_mode TEXT NOT NULL DEFAULT 'dns-01',
    default_auto_renew INTEGER NOT NULL DEFAULT 1,
    renew_days_before INTEGER NOT NULL DEFAULT 30,
    notify_on_issued INTEGER NOT NULL DEFAULT 1,
    notify_on_failed INTEGER NOT NULL DEFAULT 1,
    notify_on_expiring INTEGER NOT NULL DEFAULT 1,
    notify_on_expired INTEGER NOT NULL DEFAULT 1,
    max_active_certs INTEGER NOT NULL DEFAULT 50,
    require_reauth_for_keys INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id),
    CHECK (default_key_algorithm IN ('rsa2048','eccp256','eccp384')),
    CHECK (default_challenge_mode IN ('dns-01','http-01')),
    CHECK (default_auto_renew IN (0,1))
  )`,

  `CREATE TABLE IF NOT EXISTS development_certhub_api_tokens (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'read,issue',
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_certhub_tokens_hash
     ON development_certhub_api_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_tokens_user_created
     ON development_certhub_api_tokens(user_id, created_at DESC)`,
]

export const DEVELOPMENT_CERTHUB_ASYNC_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_certhub_jobs (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 8,
    lock_owner TEXT,
    locked_until INTEGER,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (kind IN ('advance','renew','cleanup','notify')),
    CHECK (status IN ('queued','running','done','failed','dead','canceled'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_jobs_claim
     ON development_certhub_jobs(status, run_after, priority DESC, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_jobs_user_order
     ON development_certhub_jobs(user_id, order_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_certhub_jobs_order_kind_active
     ON development_certhub_jobs(user_id, order_id, kind)
     WHERE status IN ('queued','running')`,

  `CREATE TABLE IF NOT EXISTS development_certhub_events (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    order_id TEXT NOT NULL DEFAULT '',
    domain_id TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message_code TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (actor IN ('user','api','system','owner')),
    CHECK (level IN ('info','warn','error'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_events_user_created
     ON development_certhub_events(user_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_events_user_order
     ON development_certhub_events(user_id, order_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_events_user_level
     ON development_certhub_events(user_id, level, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS development_certhub_usage (
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    period TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, metric, period),
    CHECK (metric IN ('orders_created','attempts','downloads','api_calls'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_usage_period
     ON development_certhub_usage(period, metric, value DESC)`,
]

export const DEVELOPMENT_CERTHUB_DNS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_certhub_dns_providers (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    zone_id TEXT NOT NULL DEFAULT '',
    zone_name TEXT NOT NULL DEFAULT '',
    account_email TEXT NOT NULL DEFAULT '',
    credential_ciphertext TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    last_checked_at INTEGER,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    CHECK (kind IN ('cloudflare','dcv-delegate')),
    CHECK (status IN ('active','error','disabled'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_certhub_dns_user_kind
     ON development_certhub_dns_providers(user_id, kind, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_certhub_dns_user_label
     ON development_certhub_dns_providers(user_id, label)`,

  `CREATE TABLE IF NOT EXISTS development_certhub_config (
    id INTEGER NOT NULL DEFAULT 1,
    enabled_cas TEXT NOT NULL DEFAULT 'lets-encrypt,google-trust,zerossl,sslcom',
    max_orders_per_day INTEGER NOT NULL DEFAULT 10,
    max_orders_per_month INTEGER NOT NULL DEFAULT 50,
    max_pending_orders INTEGER NOT NULL DEFAULT 20,
    max_active_certs_default INTEGER NOT NULL DEFAULT 50,
    max_domains_per_order INTEGER NOT NULL DEFAULT 20,
    acme_timeout_ms INTEGER NOT NULL DEFAULT 15000,
    job_batch_size INTEGER NOT NULL DEFAULT 20,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id)
  )`,
  `INSERT OR IGNORE INTO development_certhub_config (id, updated_at) VALUES (1, 0)`,
]

export const DEVELOPMENT_CERTHUB_SCHEMA_STATEMENTS: readonly string[] = [
  ...DEVELOPMENT_CERTHUB_CORE_SCHEMA_STATEMENTS,
  ...DEVELOPMENT_CERTHUB_ASYNC_SCHEMA_STATEMENTS,
  ...DEVELOPMENT_CERTHUB_DNS_SCHEMA_STATEMENTS,
]

export const DEVELOPMENT_CERTHUB_REQUIRED_TABLES: readonly string[] = [
  'development_certhub_accounts',
  'development_certhub_orders',
  'development_certhub_order_domains',
  'development_certhub_settings',
  'development_certhub_api_tokens',
  'development_certhub_jobs',
  'development_certhub_events',
  'development_certhub_usage',
  'development_certhub_dns_providers',
  'development_certhub_config',
]

export const DEVELOPMENT_CERTHUB_REQUIRED_INDEXES: readonly string[] = [
  'idx_certhub_accounts_user_ca',
  'idx_certhub_orders_user_status_updated',
  'idx_certhub_orders_user_renew',
  'idx_certhub_orders_user_not_after',
  'idx_certhub_orders_user_created',
  'idx_certhub_orders_renew_from',
  'idx_certhub_orders_idempotency',
  'idx_certhub_domains_user_order_name',
  'idx_certhub_domains_user_order',
  'idx_certhub_domains_user_name',
  'idx_certhub_domains_user_status',
  'idx_certhub_tokens_hash',
  'idx_certhub_tokens_user_created',
  'idx_certhub_jobs_claim',
  'idx_certhub_jobs_user_order',
  'idx_certhub_jobs_order_kind_active',
  'idx_certhub_events_user_created',
  'idx_certhub_events_user_order',
  'idx_certhub_events_user_level',
  'idx_certhub_usage_period',
  'idx_certhub_dns_user_kind',
  'idx_certhub_dns_user_label',
]

export const DEVELOPMENT_CERTHUB_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_certhub_accounts: [
    'user_id', 'id', 'ca', 'environment', 'directory_url', 'account_url', 'key_ciphertext',
    'key_fingerprint', 'contact_email', 'status', 'last_error_code', 'last_error_message',
    'last_used_at', 'created_at', 'updated_at',
  ],
  development_certhub_orders: [
    'user_id', 'id', 'account_id', 'ca', 'environment', 'key_algorithm', 'status', 'subject_json',
    'auto_renew', 'renew_at', 'order_expires_at', 'acme_order_url', 'finalize_url', 'csr_object_key',
    'cert_object_key', 'chain_object_key', 'key_object_key', 'key_fingerprint', 'serial_number',
    'issuer', 'cert_not_before', 'cert_not_after', 'issued_at', 'revoked_at', 'revoke_reason',
    'key_purged_at', 'failure_code', 'failure_message', 'attempts', 'last_attempt_at', 'lock_owner',
    'locked_until', 'renew_from_order_id', 'idempotency_key', 'deleted_at', 'version', 'created_at',
    'updated_at',
  ],
  development_certhub_order_domains: [
    'user_id', 'id', 'order_id', 'name', 'wildcard', 'is_primary', 'challenge_mode', 'status',
    'authz_url', 'challenge_url', 'challenge_token', 'key_authorization', 'dns_record_name',
    'dns_record_type', 'dns_record_value', 'dns_provider_id', 'dns_record_id', 'validated_at',
    'error_code', 'error_message', 'created_at', 'updated_at',
  ],
  development_certhub_settings: [
    'user_id', 'default_ca', 'default_key_algorithm', 'default_challenge_mode', 'default_auto_renew',
    'renew_days_before', 'notify_on_issued', 'notify_on_failed', 'notify_on_expiring',
    'notify_on_expired', 'max_active_certs', 'require_reauth_for_keys', 'created_at', 'updated_at',
  ],
  development_certhub_api_tokens: [
    'user_id', 'id', 'name', 'token_hash', 'token_prefix', 'scopes', 'expires_at', 'last_used_at',
    'revoked_at', 'created_at',
  ],
  development_certhub_jobs: [
    'user_id', 'id', 'order_id', 'kind', 'status', 'priority', 'run_after', 'attempts',
    'max_attempts', 'lock_owner', 'locked_until', 'last_error_code', 'last_error_message',
    'created_at', 'updated_at',
  ],
  development_certhub_events: [
    'user_id', 'id', 'order_id', 'domain_id', 'actor', 'kind', 'level', 'message_code',
    'detail_json', 'created_at',
  ],
  development_certhub_usage: ['user_id', 'metric', 'period', 'value', 'updated_at'],
  development_certhub_dns_providers: [
    'user_id', 'id', 'kind', 'label', 'zone_id', 'zone_name', 'account_email',
    'credential_ciphertext', 'status', 'last_checked_at', 'last_error_code', 'last_error_message',
    'created_at', 'updated_at',
  ],
  development_certhub_config: [
    'id', 'enabled_cas', 'max_orders_per_day', 'max_orders_per_month', 'max_pending_orders',
    'max_active_certs_default', 'max_domains_per_order', 'acme_timeout_ms', 'job_batch_size',
    'updated_at',
  ],
}
