/**
 * Daily allowances, and what is left of them.
 *
 * Cloudflare's free tier is the budget: each account has its own Workers requests, AI neurons and
 * browser-render seconds per UTC day. The reference module kept a row per account/resource/day and
 * refreshed it from Cloudflare whenever the dashboard opened; this port keeps that shape, with the
 * reader's id in front so two readers' accounts can never share a counter.
 */
import type { Env } from '../env'
import { accountHasFeature, loadActiveAccounts, type CloudflareAccountRow } from './accounts'
import { getAiUsageToday, getWorkersUsageToday, utcDay } from './usage'

export const QUOTA_LIMITS = {
  workers_requests: 100_000,
  ai_neurons: 10_000,
  browser_render_seconds: 600,
} as const

export type QuotaResource = keyof typeof QUOTA_LIMITS

const RESOURCE_FEATURE: Record<QuotaResource, 'workers' | 'ai' | 'browser_render'> = {
  workers_requests: 'workers',
  ai_neurons: 'ai',
  browser_render_seconds: 'browser_render',
}

export interface QuotaRow {
  user_id: string
  account_id: string
  resource: string
  date: string
  count: number
  optimistic: number
  exhausted: number
}

export interface QuotaResourceView {
  resource: QuotaResource
  count: number
  limit: number
  remaining: number
  exhausted: boolean
}

export interface AccountQuotaView {
  account_id: string
  account_name: string
  resources: QuotaResourceView[]
}

export async function quotaSummary(env: Env, userId: string): Promise<AccountQuotaView[]> {
  const accounts = await env.DB.prepare(
    `SELECT id, user_id, name, auth_type, email, cf_account_id, is_active, enabled_features,
            available_features, has_credentials, created_at, updated_at
       FROM cloudflare_account WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .bind(userId)
    .all<CloudflareAccountRow>()
  const usage = await env.DB.prepare(
    'SELECT account_id, resource, count, exhausted FROM cloudflare_quota_usage WHERE user_id = ? AND date = ?',
  )
    .bind(userId, utcDay())
    .all<{ account_id: string; resource: string; count: number; exhausted: number }>()
  const byKey = new Map(
    (usage.results ?? []).map((row) => [`${row.account_id}:${row.resource}`, row]),
  )

  return (accounts.results ?? [])
    .filter((account) => account.is_active === 1)
    .map((account) => ({
      account_id: account.id,
      account_name: account.name,
      resources: (Object.keys(QUOTA_LIMITS) as QuotaResource[])
        .filter((resource) => accountHasFeature(account, RESOURCE_FEATURE[resource]))
        .map((resource) => {
          const limit = QUOTA_LIMITS[resource]
          const row = byKey.get(`${account.id}:${resource}`)
          const count = row?.count ?? 0
          return {
            resource,
            count,
            limit,
            remaining: Math.max(0, limit - count),
            exhausted: row?.exhausted === 1,
          }
        }),
    }))
}

/**
 * Refresh today's counters from Cloudflare before answering the dashboard.
 *
 * One account failing must not hide the others' numbers, which is the whole reason the screens exist;
 * the failure is logged with the account and the rest of the sync continues.
 */
export async function syncQuotaFromCloudflare(env: Env, userId: string): Promise<void> {
  const accounts = (await loadActiveAccounts(env, userId)).filter(({ row }) => row.cf_account_id)
  for (const { row, auth } of accounts) {
    try {
      if (accountHasFeature(row, 'ai')) {
        const usage = await getAiUsageToday(auth, row.cf_account_id)
        if (usage.totalNeurons > 0) await setQuota(env, userId, row.id, 'ai_neurons', usage.totalNeurons)
      }
    } catch (error) {
      console.warn(`[inkstone] AI usage sync failed for ${row.name}:`, (error as Error)?.message)
    }
    try {
      if (accountHasFeature(row, 'workers')) {
        const usage = await getWorkersUsageToday(auth, row.cf_account_id)
        if (usage.requests > 0) await setQuota(env, userId, row.id, 'workers_requests', usage.requests)
      }
    } catch (error) {
      console.warn(`[inkstone] Workers usage sync failed for ${row.name}:`, (error as Error)?.message)
    }
  }
}

export async function incrementQuota(
  env: Env,
  userId: string,
  accountId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cloudflare_quota_usage (user_id, account_id, resource, date, count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, account_id, resource, date)
     DO UPDATE SET count = count + excluded.count`,
  )
    .bind(userId, accountId, resource, utcDay(), amount)
    .run()
}

export async function setQuota(
  env: Env,
  userId: string,
  accountId: string,
  resource: QuotaResource,
  count: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cloudflare_quota_usage (user_id, account_id, resource, date, count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, account_id, resource, date) DO UPDATE SET count = excluded.count`,
  )
    .bind(userId, accountId, resource, utcDay(), count)
    .run()
}

export async function setExhausted(
  env: Env,
  userId: string,
  accountId: string,
  resource: QuotaResource,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cloudflare_quota_usage (user_id, account_id, resource, date, count, exhausted)
     VALUES (?, ?, ?, ?, 0, 1)
     ON CONFLICT(user_id, account_id, resource, date) DO UPDATE SET exhausted = 1`,
  )
    .bind(userId, accountId, resource, utcDay())
    .run()
}

export async function clearExhausted(
  env: Env,
  userId: string,
  accountId: string,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE cloudflare_quota_usage SET exhausted = 0 WHERE user_id = ? AND account_id = ? AND date = ?',
  )
    .bind(userId, accountId, utcDay())
    .run()
}

export async function getQuotaToday(
  env: Env,
  userId: string,
  resource: QuotaResource,
): Promise<QuotaRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM cloudflare_quota_usage WHERE user_id = ? AND resource = ? AND date = ?',
  )
    .bind(userId, resource, utcDay())
    .all<QuotaRow>()
  return rows.results ?? []
}

export async function getQuotaForAccount(
  env: Env,
  userId: string,
  accountId: string,
  resource: QuotaResource,
): Promise<QuotaRow | null> {
  return await env.DB.prepare(
    'SELECT * FROM cloudflare_quota_usage WHERE user_id = ? AND account_id = ? AND resource = ? AND date = ?',
  )
    .bind(userId, accountId, resource, utcDay())
    .first<QuotaRow>()
}
