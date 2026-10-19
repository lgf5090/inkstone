/**
 * The account's subscription settings, and the credentials behind its channels.
 *
 * Two things here are deliberately unlike the reference project. A channel's configuration is stored
 * as one ciphertext rather than as forty columns, because it is a bundle nobody queries and because a
 * credential in a plain column is a credential in every backup and every log line. And the inbound
 * token is stored as a hash: the reference project could show a reader their token at any time, which
 * also meant the database could. Rotating it is one press, so nothing is lost.
 */
import { channelHint, channelDefinition } from '@shared/subscriptions/channels'
import {
  DEFAULT_SETTINGS,
  clampPaymentLimit,
  normalizeNotificationHours,
  type ChannelKind,
  type ChannelState,
  type NotifyLocale,
  type SubscriptionSettings,
} from '@shared/subscriptions/model'
import { isValidTimezone } from '@shared/subscriptions/time'
import { decryptChannelConfig, encryptChannelConfig } from '../lib/crypto'
import { sha256Hex, timingSafeEqual } from '../lib/encoding'
import { newId, newSlug } from '../lib/id'
import type { Env } from '../env'

interface SettingsRow {
  user_id: string
  timezone: string
  notification_hours: string
  show_lunar: number
  payment_history_limit: number
  locale: string
  inbound_token_hash: string
  inbound_token_hint: string
  updated_at: number
}

interface ChannelRow {
  user_id: string
  id: string
  kind: string
  enabled: number
  config_ciphertext: string
  config_hint: string
  last_test_at: number | null
  last_test_status: string
  last_test_error: string
  created_at: number
  updated_at: number
}

const SETTINGS_COLUMNS = `user_id, timezone, notification_hours, show_lunar, payment_history_limit,
  locale, inbound_token_hash, inbound_token_hint, updated_at`

const CHANNEL_COLUMNS = `user_id, id, kind, enabled, config_ciphertext, config_hint, last_test_at,
  last_test_status, last_test_error, created_at, updated_at`

function parseHours(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return normalizeNotificationHours(value)
  } catch {
    return []
  }
}

function toSettings(row: SettingsRow): SubscriptionSettings {
  return {
    timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_SETTINGS.timezone,
    notificationHours: parseHours(row.notification_hours),
    showLunar: row.show_lunar === 1,
    paymentHistoryLimit: clampPaymentLimit(row.payment_history_limit),
    locale: row.locale === 'en-US' ? 'en-US' : 'zh-CN',
    inboundTokenHint: row.inbound_token_hint,
  }
}

export async function loadSettings(db: D1Database, userId: string): Promise<SubscriptionSettings> {
  const row = await db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM sub_settings WHERE user_id = ?1`)
    .bind(userId)
    .first<SettingsRow>()
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS }
}

/** Every account's settings, for the scheduler's single pass. */
export async function loadAllSettings(db: D1Database): Promise<Array<{ userId: string; settings: SubscriptionSettings }>> {
  const { results } = await db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM sub_settings`)
    .all<SettingsRow>()
  return results.map((row) => ({ userId: row.user_id, settings: toSettings(row) }))
}

export interface SettingsPatch {
  timezone?: unknown
  notificationHours?: unknown
  showLunar?: unknown
  paymentHistoryLimit?: unknown
  locale?: unknown
}

/**
 * Write the settings a caller sent, keeping every field they did not.
 *
 * The timezone is the one field that can be wrong rather than merely absent: an unknown zone would
 * silently make every reminder land at the wrong hour, so it is refused instead of defaulted.
 */
export async function saveSettings(db: D1Database, userId: string, patch: SettingsPatch): Promise<SubscriptionSettings> {
  const current = await loadSettings(db, userId)
  const timezone = patch.timezone === undefined ? current.timezone : String(patch.timezone)
  if (!isValidTimezone(timezone)) throw new Error('invalid_timezone')
  const notificationHours = patch.notificationHours === undefined
    ? current.notificationHours
    : normalizeNotificationHours(patch.notificationHours)
  const showLunar = patch.showLunar === undefined ? current.showLunar : patch.showLunar === true
  const limit = patch.paymentHistoryLimit === undefined
    ? current.paymentHistoryLimit
    : clampPaymentLimit(patch.paymentHistoryLimit)
  const locale: NotifyLocale = patch.locale === undefined
    ? current.locale
    : patch.locale === 'en-US' ? 'en-US' : 'zh-CN'

  await db.prepare(
    `INSERT INTO sub_settings (${SETTINGS_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', '', ?7)
     ON CONFLICT(user_id) DO UPDATE SET
       timezone = excluded.timezone,
       notification_hours = excluded.notification_hours,
       show_lunar = excluded.show_lunar,
       payment_history_limit = excluded.payment_history_limit,
       locale = excluded.locale,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    timezone,
    JSON.stringify(notificationHours),
    showLunar ? 1 : 0,
    limit,
    locale,
    Date.now(),
  ).run()

  return { timezone, notificationHours, showLunar, paymentHistoryLimit: limit, locale, inboundTokenHint: current.inboundTokenHint }
}

export async function listChannels(db: D1Database, userId: string): Promise<ChannelState[]> {
  const { results } = await db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM sub_channel WHERE user_id = ?1`)
    .bind(userId)
    .all<ChannelRow>()
  const byKind = new Map(results.map((row) => [row.kind, row]))
  return (Object.keys(CHANNEL_KIND_ORDER) as ChannelKind[]).map((kind) => {
    const row = byKind.get(kind)
    return {
      kind,
      enabled: row?.enabled === 1,
      configured: Boolean(row && row.config_ciphertext),
      hint: row?.config_hint ?? '',
      lastTestAt: row?.last_test_at ? new Date(row.last_test_at).toISOString() : null,
      lastTestStatus: (row?.last_test_status === 'success' || row?.last_test_status === 'failed' ? row.last_test_status : '') as ChannelState['lastTestStatus'],
      lastTestError: row?.last_test_error ?? '',
    }
  })
}

const CHANNEL_KIND_ORDER: Record<ChannelKind, true> = {
  telegram: true,
  notifyx: true,
  webhook: true,
  wechatbot: true,
  email: true,
  bark: true,
  gotify: true,
  serverchan: true,
  pushplus: true,
}

/**
 * A channel's stored configuration, decrypted.
 *
 * Returns null when the row is missing or the ciphertext cannot be read — which is not the same as an
 * empty configuration, and the caller treats it as "this channel cannot send" rather than as "this
 * channel is configured with nothing".
 */
export async function readChannelConfig(
  env: Env,
  db: D1Database,
  userId: string,
  kind: ChannelKind,
): Promise<{ row: ChannelRow; config: Record<string, unknown> } | null> {
  const row = await db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM sub_channel WHERE user_id = ?1 AND kind = ?2`)
    .bind(userId, kind)
    .first<ChannelRow>()
  if (!row || !row.config_ciphertext) return null
  const config = await decryptChannelConfig(env, row.id, row.config_ciphertext)
  return config ? { row, config } : null
}

export interface ChannelSaveInput {
  enabled?: unknown
  config?: unknown
}

/**
 * Save one channel, merging rather than replacing.
 *
 * A blank secret means "keep the one you have", which is the only way a reader can change a webhook
 * address without retyping a bot token the screen never showed them. A required field that is blank on
 * a channel with nothing stored is refused, because a channel that cannot send should not be enabled.
 */
export async function saveChannel(
  env: Env,
  db: D1Database,
  userId: string,
  kind: ChannelKind,
  input: ChannelSaveInput,
): Promise<ChannelState> {
  const existing = await db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM sub_channel WHERE user_id = ?1 AND kind = ?2`)
    .bind(userId, kind)
    .first<ChannelRow>()
  const stored = existing && existing.config_ciphertext
    ? await decryptChannelConfig(env, existing.id, existing.config_ciphertext)
    : null

  const incoming = input.config && typeof input.config === 'object' && !Array.isArray(input.config)
    ? input.config as Record<string, unknown>
    : {}
  const definition = channelDefinition(kind)
  const merged: Record<string, unknown> = { ...(stored ?? {}) }
  for (const field of definition.fields) {
    if (!(field.key in incoming)) continue
    const value = incoming[field.key]
    if (field.type === 'password' && (value === '' || value === null || value === undefined)) continue
    if (field.type === 'switch') {
      merged[field.key] = value === true || value === 'true'
      continue
    }
    merged[field.key] = typeof value === 'string' ? value.trim() : value
  }

  const problem = validateChannelConfig(kind, merged)
  if (problem) throw new Error(problem)

  const id = existing?.id ?? newId()
  const ciphertext = await encryptChannelConfig(env, id, merged)
  const hint = channelHint(kind, merged)
  const enabled = input.enabled === undefined ? existing?.enabled === 1 : input.enabled === true
  const now = Date.now()

  await db.prepare(
    `INSERT INTO sub_channel (${CHANNEL_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '', '', ?7, ?7)
     ON CONFLICT(user_id, kind) DO UPDATE SET
       enabled = excluded.enabled,
       config_ciphertext = excluded.config_ciphertext,
       config_hint = excluded.config_hint,
       updated_at = excluded.updated_at`,
  ).bind(userId, id, kind, enabled ? 1 : 0, ciphertext, hint, now).run()

  return {
    kind,
    enabled,
    configured: true,
    hint,
    lastTestAt: existing?.last_test_at ? new Date(existing.last_test_at).toISOString() : null,
    lastTestStatus: (existing?.last_test_status === 'success' || existing?.last_test_status === 'failed' ? existing.last_test_status : '') as ChannelState['lastTestStatus'],
    lastTestError: existing?.last_test_error ?? '',
  }
}

/** Remove a channel's configuration and switch it off; the row stays so its test history does too. */
export async function clearChannel(db: D1Database, userId: string, kind: ChannelKind): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sub_channel SET enabled = 0, config_ciphertext = '', config_hint = '', last_test_status = '', last_test_error = '', updated_at = ?3
      WHERE user_id = ?1 AND kind = ?2`,
  ).bind(userId, kind, Date.now()).run()
  return (result.meta.changes ?? 0) > 0
}

export async function recordChannelTest(
  db: D1Database,
  userId: string,
  kind: ChannelKind,
  status: 'success' | 'failed',
  error: string,
): Promise<void> {
  await db.prepare(
    `UPDATE sub_channel SET last_test_at = ?3, last_test_status = ?4, last_test_error = ?5, updated_at = ?3
      WHERE user_id = ?1 AND kind = ?2`,
  ).bind(userId, kind, Date.now(), status, error.slice(0, 500)).run()
}

/** The channels that may actually send, with their configuration already decrypted. */
export async function enabledChannels(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<Array<{ kind: ChannelKind; config: Record<string, unknown> }>> {
  const { results } = await db.prepare(
    `SELECT kind FROM sub_channel WHERE user_id = ?1 AND enabled = 1 AND config_ciphertext != ''`,
  ).bind(userId).all<{ kind: string }>()
  const out: Array<{ kind: ChannelKind; config: Record<string, unknown> }> = []
  for (const row of results) {
    const kind = row.kind as ChannelKind
    if (!(kind in CHANNEL_KIND_ORDER)) continue
    const stored = await readChannelConfig(env, db, userId, kind)
    if (stored) out.push({ kind, config: stored.config })
  }
  return out
}

/**
 * The error a channel's configuration has, or null when it can send.
 *
 * Only the presence of the required fields is checked here. Whether the address is reachable is the
 * test button's question, and whether it is a safe address is the outbound guard's — a settings form
 * that refused a self-hosted server it could not reach would be refusing a correct answer.
 */
export function validateChannelConfig(kind: ChannelKind, config: Record<string, unknown>): string | null {
  const definition = channelDefinition(kind)
  for (const field of definition.fields) {
    if (!('required' in field) || !field.required) continue
    const value = config[field.key]
    if (typeof value !== 'string' || value.trim() === '') return `missing:${field.key}`
  }
  for (const field of definition.fields) {
    if (field.type !== 'url') continue
    const value = config[field.key]
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `invalid_url:${field.key}`
    } catch {
      return `invalid_url:${field.key}`
    }
  }
  for (const field of definition.fields) {
    if (field.type !== 'json') continue
    const value = config[field.key]
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      JSON.parse(value)
    } catch {
      return `invalid_json:${field.key}`
    }
  }
  return null
}

/**
 * A fresh inbound token, returned once.
 *
 * The plaintext never touches the database: what is stored is its digest and the last four characters
 * for the settings row to prove which token is in force. A reader who loses it rotates it, which is one
 * press and no data.
 */
export async function rotateInboundToken(db: D1Database, userId: string): Promise<{ token: string; hint: string }> {
  const token = newSlug()
  const hash = await sha256Hex(token)
  const hint = token.slice(-4)
  await db.prepare(
    `INSERT INTO sub_settings (${SETTINGS_COLUMNS}) VALUES (?1, ?2, '[]', 0, 100, 'zh-CN', ?3, ?4, ?5)
     ON CONFLICT(user_id) DO UPDATE SET
       inbound_token_hash = excluded.inbound_token_hash,
       inbound_token_hint = excluded.inbound_token_hint,
       updated_at = excluded.updated_at`,
  ).bind(userId, DEFAULT_SETTINGS.timezone, hash, hint, Date.now()).run()
  return { token, hint }
}

/**
 * Which account a presented token belongs to, or null.
 *
 * The digest is looked up rather than compared against every row, and the comparison that follows is
 * constant-time anyway — a lookup by hash is already an equality test the database performs, but the
 * second check costs nothing and keeps the shape right if this ever moves.
 */
export async function userIdForInboundToken(db: D1Database, token: string): Promise<string | null> {
  if (!token || token.length < 8 || token.length > 64) return null
  const hash = await sha256Hex(token)
  const row = await db.prepare(`SELECT user_id, inbound_token_hash FROM sub_settings WHERE inbound_token_hash = ?1`)
    .bind(hash)
    .first<{ user_id: string; inbound_token_hash: string }>()
  if (!row) return null
  return timingSafeEqual(row.inbound_token_hash, hash) ? row.user_id : null
}

export { CHANNEL_KIND_ORDER }
