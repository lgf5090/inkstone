/**
 * The self-hosted AI gateway's local ledger.
 *
 * Cloudflare's GraphQL atoms are the authoritative daily total, but they arrive late. These tables are
 * the gate: an account/day row is updated with one conditional statement so concurrent requests cannot
 * reserve past the threshold, while the request and snapshot tables keep the evidence needed to audit
 * what happened. No request or response bodies are stored here.
 */
export const AI_GATEWAY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ai_gateway_account_ledger (
     user_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     day TEXT NOT NULL,
     model TEXT NOT NULL DEFAULT '*',
     reserved_neurons INTEGER NOT NULL DEFAULT 0,
     actual_neurons INTEGER NOT NULL DEFAULT 0,
     requests INTEGER NOT NULL DEFAULT 0,
     exhausted INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, account_id, day, model)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_ledger_user_day
     ON ai_gateway_account_ledger(user_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_ledger_account_day
     ON ai_gateway_account_ledger(user_id, account_id, day)`,

  `CREATE TABLE IF NOT EXISTS ai_gateway_account_state (
     user_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     cooldown_until INTEGER NOT NULL DEFAULT 0,
     error_code TEXT,
     last_error_at INTEGER,
     failure_count INTEGER NOT NULL DEFAULT 0,
     selection_day TEXT,
     selection_count INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, account_id)
   )`,

  `CREATE TABLE IF NOT EXISTS ai_gateway_keys (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     allowed_models TEXT NOT NULL DEFAULT '*',
     daily_request_limit INTEGER NOT NULL DEFAULT 0,
     revoked_at INTEGER,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_keys_user
     ON ai_gateway_keys(user_id, revoked_at, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS ai_gateway_key_usage (
     key_id TEXT NOT NULL,
     day TEXT NOT NULL,
     user_id TEXT NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0,
     neurons INTEGER NOT NULL DEFAULT 0,
     tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (key_id, day)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_key_usage_user_day
     ON ai_gateway_key_usage(user_id, day)`,

  `CREATE TABLE IF NOT EXISTS ai_gateway_requests (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     key_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     day TEXT NOT NULL,
     format TEXT NOT NULL,
     stream INTEGER NOT NULL DEFAULT 0,
     model TEXT NOT NULL,
     status TEXT NOT NULL,
     http_status INTEGER NOT NULL,
     upstream_status INTEGER,
     reserved_neurons INTEGER NOT NULL DEFAULT 0,
     actual_neurons INTEGER NOT NULL DEFAULT 0,
     prompt_tokens INTEGER NOT NULL DEFAULT 0,
     completion_tokens INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     error_code TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_user_time
     ON ai_gateway_requests(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_account_day
     ON ai_gateway_requests(user_id, account_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_requests_key_time
     ON ai_gateway_requests(key_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS ai_gateway_reconcile_snapshots (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     day TEXT NOT NULL,
     authoritative_neurons INTEGER NOT NULL,
     local_effective INTEGER NOT NULL,
     delta INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     checked_at INTEGER NOT NULL,
     note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_gateway_reconcile_history
     ON ai_gateway_reconcile_snapshots(user_id, account_id, day, checked_at DESC)`,
]
