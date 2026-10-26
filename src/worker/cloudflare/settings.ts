/**
 * The Cloudflare module's own settings, one row per key per reader.
 *
 * Only what a reader can change and the server must remember lives here. The reference module also
 * kept the proxy configuration in this table; this deployment has no outbound proxy (see the plan's
 * D-7), so those keys are not read or written.
 */
import type { Env } from '../env'

export const DEMO_ACCOUNT_IDS_KEY = 'demo_account_ids'

export type CloudflareSettings = Record<string, string>

export async function readSettings(env: Env, userId: string): Promise<CloudflareSettings> {
  const rows = await env.DB.prepare('SELECT key, value FROM cloudflare_setting WHERE user_id = ?')
    .bind(userId)
    .all<{ key: string; value: string }>()
  const out: CloudflareSettings = {}
  for (const row of rows.results ?? []) out[row.key] = row.value
  return out
}

export async function readSetting(env: Env, userId: string, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM cloudflare_setting WHERE user_id = ? AND key = ?')
    .bind(userId, key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(env: Env, userId: string, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cloudflare_setting (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(userId, key, value, Date.now())
    .run()
}
