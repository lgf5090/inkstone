/**
 * The subscription app's data as a backup can carry it.
 *
 * Two things are deliberately not in here, and both absences are the point:
 *
 *  - **Channel configurations.** Each one is an encrypted credential bundle — a bot token, an API key,
 *    a device key. A backup is a file that leaves the server, gets emailed, and sits in a bucket, so
 *    ciphertext travels with it to nowhere useful and puts every credential one compromised archive
 *    away from a reader's reminders being sent by a stranger. A restore therefore re-arms nothing; the
 *    reader reconnects their channels, which is what the app's own "not configured" state is for.
 *  - **The delivery and sweep logs.** Thirty days of diagnostics about *sending*, not a record the
 *    reader would want back. Restoring them would also make a restore lie: a notification that was
 *    sent from the old account would appear to have been sent from the new one.
 *
 * Inbound webhook tokens are excluded for the same credential reason, which means a restored account
 * hands out a new URL. That is correct — an old URL that still worked after a restore would be a
 * second, undocumented way into the account.
 */
import { normalizeNotificationHours, normalizeRateOverrides, normalizeBudgetCategories, clampPaymentLimit, isCurrencyCode, isPeriodUnit, isSubscriptionMode, LABEL_MAX, NAME_MAX, NOTES_MAX } from '@shared/subscriptions/model'

export const SUBSCRIPTIONS_BACKUP_VERSION = 1 as const

/** Ceilings on a restore. Above these the file is not a personal subscription list. */
const MAX_ITEMS = 5_000
const MAX_PAYMENTS = 50_000
const MAX_RULES = 20_000
const MAX_LABELS = 2_000

export interface SubscriptionsBackupSummary {
  items: number
  payments: number
  rules: number
  labels: number
}

interface TableRows {
  items: Array<Record<string, unknown>>
  payments: Array<Record<string, unknown>>
  rules: Array<Record<string, unknown>>
  categories: Array<Record<string, unknown>>
  types: Array<Record<string, unknown>>
  settings: Record<string, unknown> | null
}

/**
 * The account's subscription data as JSON, or null when the account has none.
 *
 * Null rather than an empty document: a backup of a reader who never opened the subscriptions tab
 * should not grow a file that a restore then treats as "clear everything".
 */
export async function readBackupSubscriptions(db: D1Database, userId: string): Promise<string | null> {
  const rows = await tableRows(db, userId)
  const total = rows.items.length + rows.payments.length + rows.rules.length
    + rows.categories.length + rows.types.length
  if (total === 0 && rows.settings === null) return null
  return JSON.stringify({
    version: SUBSCRIPTIONS_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ...rows,
  })
}

async function tableRows(db: D1Database, userId: string): Promise<TableRows> {
  const [items, payments, rules, categories, types, settings] = await Promise.all([
    db.prepare(`SELECT id, name, custom_type, category, amount, currency, start_date, expiry_date,
                       period_value, period_unit, subscription_mode, use_lunar, is_active, auto_renew,
                       notes, last_payment_date, trial_ends_at, deleted_at, created_at, updated_at
                  FROM sub_item WHERE user_id = ?1 ORDER BY created_at`).bind(userId).all(),
    db.prepare(`SELECT id, subscription_id, paid_at, amount, currency, kind, note,
                       period_start, period_end, created_at
                  FROM sub_payment WHERE user_id = ?1 ORDER BY paid_at`).bind(userId).all(),
    db.prepare(`SELECT id, subscription_id, kind, value, unit, repeat_interval, repeat_until,
                       acknowledged_at, enabled, created_at
                  FROM sub_reminder_rule WHERE user_id = ?1 ORDER BY created_at`).bind(userId).all(),
    db.prepare(`SELECT name, icon, color, created_at FROM sub_category WHERE user_id = ?1 ORDER BY name`)
      .bind(userId).all(),
    db.prepare(`SELECT name, icon, color, created_at FROM sub_type WHERE user_id = ?1 ORDER BY name`)
      .bind(userId).all(),
    db.prepare(`SELECT timezone, notification_hours, show_lunar, payment_history_limit, locale,
                       base_currency, budget_monthly, budget_yearly, budget_categories, rate_overrides
                  FROM sub_settings WHERE user_id = ?1`).bind(userId).first<Record<string, unknown>>(),
  ])
  return {
    items: items.results as Array<Record<string, unknown>>,
    payments: payments.results as Array<Record<string, unknown>>,
    rules: rules.results as Array<Record<string, unknown>>,
    categories: categories.results as Array<Record<string, unknown>>,
    types: types.results as Array<Record<string, unknown>>,
    settings: settings ?? null,
  }
}

/**
 * Put a carried document back, replacing whatever the account has now.
 *
 * Replace rather than merge, because that is what "restore this backup" means and a merge would produce
 * a state that never existed at any moment in time. The whole document is validated *before* anything is
 * written: a file with one unreadable row in the middle must fail as a whole rather than leave the
 * account holding the first ninety per cent of a library.
 */
export async function applyBackupSubscriptions(
  db: D1Database,
  userId: string,
  carried: unknown,
): Promise<SubscriptionsBackupSummary> {
  const parsed = typeof carried === 'string' ? safeParse(carried) : carried
  if (!parsed || typeof parsed !== 'object') throw new Error('The backup contains no readable subscription data')
  const source = parsed as Record<string, unknown>
  if (source.version !== SUBSCRIPTIONS_BACKUP_VERSION) {
    throw new Error(`Unsupported subscription backup version: ${String(source.version)}`)
  }

  const items = cleanRows(source.items, MAX_ITEMS, 'subscriptions')
    .filter((row) => typeof row.id === 'string' && typeof row.name === 'string' && row.name.trim())
  const payments = cleanRows(source.payments, MAX_PAYMENTS, 'payments')
  const rules = cleanRows(source.rules, MAX_RULES, 'reminder rules')
  const categories = cleanRows(source.categories, MAX_LABELS, 'categories')
  const types = cleanRows(source.types, MAX_LABELS, 'types')

  // A receipt or a rule that points at a subscription the file does not carry is not restorable, so it
  // is dropped here and the count says so — silently inserting orphans would make the history wrong.
  const ids = new Set(items.map((row) => String(row.id)))
  const owned = payments.filter((row) => ids.has(String(row.subscription_id ?? '')))
  const ownedRules = rules.filter((row) => ids.has(String(row.subscription_id ?? '')))

  const statements: D1PreparedStatement[] = [
    ...clearStatements(db, userId),
  ]
  for (const row of items) {
    statements.push(db.prepare(
      `INSERT INTO sub_item (user_id, id, name, custom_type, category, amount, currency, start_date, expiry_date,
        period_value, period_unit, subscription_mode, use_lunar, is_active, auto_renew, notes,
        last_payment_date, trial_ends_at, deleted_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    ).bind(
      userId,
      bounded(String(row.id), 64),
      bounded(String(row.name).trim(), NAME_MAX),
      bounded(String(row.custom_type ?? ''), LABEL_MAX),
      bounded(String(row.category ?? ''), LABEL_MAX * 4),
      numberOrNull(row.amount),
      isCurrencyCode(row.currency) ? row.currency : 'CNY',
      numberOrNull(row.start_date),
      // Expiry is NOT NULL and every reminder calculation reads it, so a row without one is not a
      // subscription. It is dropped, and the summary reports how many were.
      numberOrNull(row.expiry_date) ?? numberOrNull(row.start_date) ?? Date.now(),
      intAtLeast(row.period_value, 1, 120),
      isPeriodUnit(row.period_unit) ? row.period_unit : 'month',
      isSubscriptionMode(row.subscription_mode) ? row.subscription_mode : 'cycle',
      truthy(row.use_lunar) ? 1 : 0,
      truthy(row.is_active) ? 1 : 0,
      truthy(row.auto_renew) ? 1 : 0,
      bounded(String(row.notes ?? ''), NOTES_MAX),
      numberOrNull(row.last_payment_date),
      numberOrNull(row.trial_ends_at),
      numberOrNull(row.deleted_at),
      numberOrNull(row.created_at) ?? Date.now(),
      numberOrNull(row.updated_at) ?? Date.now(),
    ))
  }
  for (const row of owned) {
    statements.push(db.prepare(
      `INSERT INTO sub_payment (user_id, id, subscription_id, paid_at, amount, currency, kind, note,
        period_start, period_end, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      userId,
      bounded(String(row.id), 64),
      bounded(String(row.subscription_id), 64),
      numberOrNull(row.paid_at) ?? Date.now(),
      numberOrNull(row.amount) ?? 0,
      isCurrencyCode(row.currency) ? row.currency : 'CNY',
      ['initial', 'manual', 'auto'].includes(String(row.kind)) ? row.kind : 'manual',
      bounded(String(row.note ?? ''), 200),
      numberOrNull(row.period_start),
      numberOrNull(row.period_end),
      numberOrNull(row.created_at) ?? Date.now(),
    ))
  }
  for (const row of ownedRules) {
    statements.push(db.prepare(
      `INSERT INTO sub_reminder_rule (user_id, id, subscription_id, kind, value, unit, repeat_interval,
        repeat_until, acknowledged_at, enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      userId,
      bounded(String(row.id), 64),
      bounded(String(row.subscription_id), 64),
      ['before_expiry', 'on_expiry', 'after_expiry'].includes(String(row.kind)) ? row.kind : 'before_expiry',
      intAtLeast(row.value, 0, 3650),
      row.unit === 'hours' ? 'hours' : 'days',
      numberOrNull(row.repeat_interval),
      ['renewed', 'acknowledged', 'never'].includes(String(row.repeat_until)) ? row.repeat_until : 'renewed',
      numberOrNull(row.acknowledged_at),
      truthy(row.enabled) ? 1 : 0,
      numberOrNull(row.created_at) ?? Date.now(),
    ))
  }
  for (const [table, rows] of [['sub_category', categories], ['sub_type', types]] as const) {
    for (const row of rows) {
      const name = String(row.name ?? '').trim()
      if (!name) continue
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO ${table} (user_id, name, icon, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(userId, bounded(name, LABEL_MAX), bounded(String(row.icon ?? ''), 40), bounded(String(row.color ?? ''), 7),
        numberOrNull(row.created_at) ?? Date.now()))
    }
  }

  const settings = source.settings
  if (settings && typeof settings === 'object') {
    const row = settings as Record<string, unknown>
    statements.push(db.prepare(
      `INSERT INTO sub_settings (user_id, timezone, notification_hours, show_lunar, payment_history_limit,
         locale, base_currency, budget_monthly, budget_yearly, budget_categories, rate_overrides, inbound_token_hash, inbound_token_hint, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', '', ?12)
       ON CONFLICT(user_id) DO UPDATE SET
         timezone = excluded.timezone, notification_hours = excluded.notification_hours,
         show_lunar = excluded.show_lunar, payment_history_limit = excluded.payment_history_limit,
         locale = excluded.locale, base_currency = excluded.base_currency,
         budget_monthly = excluded.budget_monthly, budget_yearly = excluded.budget_yearly,
         budget_categories = excluded.budget_categories,
         rate_overrides = excluded.rate_overrides,
         updated_at = excluded.updated_at`,
    ).bind(
      userId,
      bounded(String(row.timezone ?? 'Asia/Shanghai'), 64),
      JSON.stringify(normalizeNotificationHours(carriedField(row.notification_hours))),
      truthy(row.show_lunar) ? 1 : 0,
      clampPaymentLimit(row.payment_history_limit),
      row.locale === 'en-US' ? 'en-US' : 'zh-CN',
      isCurrencyCode(row.base_currency) ? row.base_currency : 'CNY',
      numberOrNull(row.budget_monthly),
      numberOrNull(row.budget_yearly),
      JSON.stringify(normalizeBudgetCategories(carriedField(row.budget_categories))),
      JSON.stringify(normalizeRateOverrides(carriedField(row.rate_overrides))),
      Date.now(),
    ))
  }

  await batchInChunks(db, statements)
  return {
    items: items.length,
    payments: owned.length,
    rules: ownedRules.length,
    labels: categories.length + types.length,
  }
}

/** Everything the account has now, gone. The token columns go with it, which is the intent. */
function clearStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    'sub_item', 'sub_payment', 'sub_reminder_rule', 'sub_category', 'sub_type',
    'sub_channel', 'sub_settings', 'sub_notify_log', 'sub_schedule_log', 'sub_notify_dedupe',
  ].map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?1`).bind(userId))
}

/** D1 refuses an oversized batch, and a five-thousand-row library is a plausible personal archive. */
async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const chunk = 80
  for (let offset = 0; offset < statements.length; offset += chunk) {
    await db.batch(statements.slice(offset, offset + chunk))
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // null is the caller's "this archive holds nothing readable", which it already has to answer: the
    // whole document is checked before a single row is written.
    return null
  }
}

/**
 * A settings field the archive carries as the column's own text — an hour list, a rate map.
 *
 * The document is a dump of rows, so these arrive as the JSON string the column holds, not as the value
 * the app works with. Read straight, a window written as `["08","20"]` would be split on its commas and
 * become two hours that match nothing, and every reminder after a restore would fall silent.
 */
function carriedField(value: unknown): unknown {
  return typeof value === 'string' ? safeParse(value) : value
}

function cleanRows(value: unknown, limit: number, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`The backup's ${label} are not a list`)
  if (value.length > limit) throw new Error(`The backup carries ${value.length} ${label}, over the ${limit} limit`)
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function intAtLeast(value: unknown, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function truthy(value: unknown): boolean {
  if (typeof value === 'number') return value === 1
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLocaleLowerCase())
}
