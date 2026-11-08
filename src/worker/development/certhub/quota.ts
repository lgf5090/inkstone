import type { Env } from '../../env'
import { ApiError } from '../../lib/errors'
import type { CerthubCa, CerthubConfigView, CerthubQuotaView, CerthubSettingsView } from '@shared/development/certhub/types'
import {
  countActiveOrders,
  countLiveCertificates,
  incrementUsage,
  readConfig,
  readSettings,
  readUsage,
  usageDay,
  usageMonth,
} from './store'

export interface QuotaContext {
  config: CerthubConfigView
  settings: CerthubSettingsView
  quota: CerthubQuotaView
}

export async function quotaContext(db: D1Database, userId: string): Promise<QuotaContext> {
  const [config, settings, dailyUsed, monthlyUsed, pendingOrders, activeCerts] = await Promise.all([
    readConfig(db),
    readSettings(db, userId),
    readUsage(db, userId, 'orders_created', usageDay()),
    readUsage(db, userId, 'orders_created', usageMonth()),
    countActiveOrders(db, userId),
    countLiveCertificates(db, userId),
  ])
  return {
    config,
    settings,
    quota: {
      maxActiveCerts: settings.maxActiveCerts,
      activeCerts,
      pendingOrders,
      dailyUsed,
      dailyLimit: config.maxOrdersPerDay,
      monthlyUsed,
      monthlyLimit: config.maxOrdersPerMonth,
    },
  }
}

export async function assertCanCreateOrder(
  db: D1Database,
  userId: string,
  ca: CerthubCa,
  domainCount: number,
): Promise<QuotaContext> {
  const context = await quotaContext(db, userId)
  if (!context.config.enabledCas.includes(ca)) {
    throw ApiError.badRequest('The selected certificate authority is disabled on this deployment')
  }
  if (domainCount > context.config.maxDomainsPerOrder) {
    throw ApiError.badRequest(`An order may name at most ${context.config.maxDomainsPerOrder} domains`)
  }
  if (context.quota.pendingOrders >= context.config.maxPendingOrders) {
    throw new ApiError(429, 'quota_exceeded', 'Too many orders are waiting for validation')
  }
  if (context.quota.dailyUsed >= context.config.maxOrdersPerDay) {
    throw new ApiError(429, 'quota_exceeded', 'The daily certificate order limit has been reached')
  }
  if (context.quota.monthlyUsed >= context.config.maxOrdersPerMonth) {
    throw new ApiError(429, 'quota_exceeded', 'The monthly certificate order limit has been reached')
  }
  if (context.quota.activeCerts >= context.settings.maxActiveCerts) {
    throw new ApiError(429, 'quota_exceeded', 'The active certificate limit has been reached')
  }
  return context
}

export async function recordOrderCreated(db: D1Database, userId: string): Promise<void> {
  await incrementUsage(db, userId, 'orders_created', usageDay())
  await incrementUsage(db, userId, 'orders_created', usageMonth())
}

export async function verifyTurnstile(env: Env, token: string | undefined, remoteIp: string | undefined): Promise<void> {
  const secret = env.CERTHUB_TURNSTILE_SECRET?.trim()
  if (!secret) return
  if (!token) throw new ApiError(403, 'forbidden', 'Please complete the human verification first')
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (remoteIp) form.append('remoteip', remoteIp)
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const payload = await response.json() as { success?: boolean }
    if (!payload.success) throw new ApiError(403, 'forbidden', 'The human verification did not pass')
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, 'upstream_unavailable', 'The human verification service is unavailable')
  }
}
