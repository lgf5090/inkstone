export const DEVELOPMENT_XGET_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_xget_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config_json TEXT NOT NULL DEFAULT '{}',
    proxy_token_hash TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS development_xget_stats (
    day TEXT NOT NULL,
    platform TEXT NOT NULL,
    ok INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, platform, ok)
  )`,
]

export const DEVELOPMENT_XGET_AUDIT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS development_xget_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_development_xget_audit_at ON development_xget_audit(at)`,
]

export type XgetAuditAction =
  | 'settings.update'
  | 'token.set'
  | 'token.clear'
  | 'proxy.denied'
  | 'proxy.rate_limited'

export const DEVELOPMENT_XGET_REQUIRED_TABLES: readonly string[] = [
  'development_xget_settings',
  'development_xget_stats',
  'development_xget_audit',
]

export const DEVELOPMENT_XGET_REQUIRED_INDEXES: readonly string[] = [
  'idx_development_xget_audit_at',
]

export const DEVELOPMENT_XGET_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  development_xget_settings: ['id', 'config_json', 'proxy_token_hash', 'updated_at'],
  development_xget_stats: ['day', 'platform', 'ok', 'count'],
  development_xget_audit: ['id', 'at', 'actor', 'action', 'detail'],
}
