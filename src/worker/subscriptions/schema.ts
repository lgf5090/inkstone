/**
 * The subscription app's tables, declared where the boot can find them.
 *
 * The tables themselves are declared here rather than numbered into the migration ledger, which is
 * what the schema's own ordering allows: tables are created before the ledger is consulted, indexes
 * after it, and `assertFinalSchema` only checks the lists below. Spending a version number on a table
 * that no older shape ever occupied would buy nothing and risk the collision the ledger has already
 * paid for once — a branch that used the same number for other work leaves a database whose ledger says
 * the shape arrived when it did not.
 *
 * Columns added to a table that is already deployed are the exception: those do need a version, and
 * live in `SCHEMA_MIGRATIONS` beside every other one. `sub_category.icon`/`color` and the whole of
 * `sub_type` are that case, so a database created before the identity work still gets them.
 *
 * Two shapes differ from the reference project's KV records on purpose:
 *  - a subscription's payment history is its own table, so one receipt can be edited or removed
 *    without rewriting the subscription and so a year's spending is one query rather than a walk;
 *  - a channel's configuration is one ciphertext, because it is a credential bundle rather than a row
 *    of fields anyone queries.
 */

export const SUBSCRIPTIONS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sub_item (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    custom_type TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    amount REAL,
    currency TEXT NOT NULL DEFAULT 'CNY',
    start_date INTEGER,
    expiry_date INTEGER NOT NULL,
    period_value INTEGER NOT NULL DEFAULT 1,
    period_unit TEXT NOT NULL DEFAULT 'month',
    subscription_mode TEXT NOT NULL DEFAULT 'cycle',
    use_lunar INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    auto_renew INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    last_payment_date INTEGER,
    trial_ends_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_item_expiry ON sub_item(user_id, expiry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_item_active ON sub_item(user_id, is_active, expiry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_item_trash ON sub_item(user_id, deleted_at)`,

  `CREATE TABLE IF NOT EXISTS sub_payment (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    paid_at INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    kind TEXT NOT NULL DEFAULT 'manual',
    note TEXT NOT NULL DEFAULT '',
    period_start INTEGER,
    period_end INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_payment_sub ON sub_payment(user_id, subscription_id, paid_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_payment_recent ON sub_payment(user_id, paid_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sub_reminder_rule (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'before_expiry',
    value INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'days',
    repeat_interval INTEGER,
    repeat_until TEXT NOT NULL DEFAULT 'renewed',
    acknowledged_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_rule_sub ON sub_reminder_rule(user_id, subscription_id, value)`,

  /**
   * The two label registries — a type and a category are the same thing wearing different names.
   *
   * Both carry the identity the reader picked, which is what makes a name look the same in the list,
   * the rail, the share bars and a pushed notification: the subscription stores the label as free text
   * and the registry owns how it is drawn. `icon`/`color` empty means "no choice yet", which is
   * different from a choice and resolves through `identity.ts` rather than being filled in on write —
   * a preset that later changes should still reach the readers who never picked.
   *
   * Types get a table for the same reason categories already had one: without it a type cannot be
   * offered before its first subscription exists, renamed, or carry an icon at all, and the reference
   * project's hardcoded list could not be edited by anyone.
   */
  `CREATE TABLE IF NOT EXISTS sub_category (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS sub_type (
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS sub_channel (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    config_ciphertext TEXT NOT NULL DEFAULT '',
    config_hint TEXT NOT NULL DEFAULT '',
    last_test_at INTEGER,
    last_test_status TEXT NOT NULL DEFAULT '',
    last_test_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_channel_kind ON sub_channel(user_id, kind)`,

  `CREATE TABLE IF NOT EXISTS sub_settings (
    user_id TEXT PRIMARY KEY,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    notification_hours TEXT NOT NULL DEFAULT '[]',
    show_lunar INTEGER NOT NULL DEFAULT 0,
    payment_history_limit INTEGER NOT NULL DEFAULT 100,
    locale TEXT NOT NULL DEFAULT 'zh-CN',
    base_currency TEXT NOT NULL DEFAULT 'CNY',
    budget_monthly REAL,
    inbound_token_hash TEXT NOT NULL DEFAULT '',
    inbound_token_hint TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    rate_overrides TEXT NOT NULL DEFAULT '{}',
    budget_yearly REAL,
    budget_categories TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS sub_notify_log (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    subscription_id TEXT NOT NULL DEFAULT '',
    rule_id TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_notify_log_recent ON sub_notify_log(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_notify_log_sub ON sub_notify_log(user_id, subscription_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sub_schedule_log (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    timezone TEXT NOT NULL,
    hour TEXT NOT NULL,
    hours TEXT NOT NULL DEFAULT '[]',
    in_window INTEGER NOT NULL DEFAULT 0,
    checked_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    deduped_count INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    renewed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    reason TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_schedule_log_recent ON sub_schedule_log(user_id, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sub_notify_dedupe (
    user_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    hour_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, subscription_id, rule_id, hour_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sub_dedupe_created ON sub_notify_dedupe(user_id, created_at)`,
]

export const SUBSCRIPTIONS_REQUIRED_TABLES: readonly string[] = [
  'sub_item',
  'sub_payment',
  'sub_reminder_rule',
  'sub_category',
  'sub_type',
  'sub_channel',
  'sub_settings',
  'sub_notify_log',
  'sub_schedule_log',
  'sub_notify_dedupe',
]

export const SUBSCRIPTIONS_REQUIRED_INDEXES: readonly string[] = [
  'idx_sub_item_expiry',
  'idx_sub_item_active',
  'idx_sub_item_trash',
  'idx_sub_payment_sub',
  'idx_sub_payment_recent',
  'idx_sub_rule_sub',
  'idx_sub_channel_kind',
  'idx_sub_notify_log_recent',
  'idx_sub_notify_log_sub',
  'idx_sub_schedule_log_recent',
  'idx_sub_dedupe_created',
]

export const SUBSCRIPTIONS_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sub_item: [
    'user_id', 'id', 'name', 'custom_type', 'category', 'amount', 'currency', 'start_date',
    'expiry_date', 'period_value', 'period_unit', 'subscription_mode', 'use_lunar', 'is_active',
    'auto_renew', 'notes', 'last_payment_date', 'trial_ends_at', 'deleted_at', 'created_at', 'updated_at',
  ],
  sub_payment: [
    'user_id', 'id', 'subscription_id', 'paid_at', 'amount', 'currency', 'kind', 'note',
    'period_start', 'period_end', 'created_at',
  ],
  sub_reminder_rule: [
    'user_id', 'id', 'subscription_id', 'kind', 'value', 'unit', 'repeat_interval',
    'repeat_until', 'acknowledged_at', 'enabled', 'created_at',
  ],
  sub_category: ['user_id', 'name', 'icon', 'color', 'created_at'],
  sub_type: ['user_id', 'name', 'icon', 'color', 'created_at'],
  sub_channel: [
    'user_id', 'id', 'kind', 'enabled', 'config_ciphertext', 'config_hint', 'last_test_at',
    'last_test_status', 'last_test_error', 'created_at', 'updated_at',
  ],
  sub_settings: [
    'user_id', 'timezone', 'notification_hours', 'show_lunar', 'payment_history_limit',
    'locale', 'base_currency', 'budget_monthly', 'inbound_token_hash', 'inbound_token_hint', 'updated_at',
    'rate_overrides', 'budget_yearly', 'budget_categories',
  ],
  sub_notify_log: [
    'user_id', 'id', 'subscription_id', 'rule_id', 'channel', 'status', 'title', 'body',
    'error', 'detail', 'created_at',
  ],
  sub_schedule_log: [
    'user_id', 'id', 'started_at', 'finished_at', 'timezone', 'hour', 'hours', 'in_window',
    'checked_count', 'matched_count', 'deduped_count', 'sent_count', 'renewed_count', 'status',
    'reason', 'detail',
  ],
  sub_notify_dedupe: ['user_id', 'subscription_id', 'rule_id', 'hour_key', 'created_at'],
}
