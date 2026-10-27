/**
 * `/api/cloudflare/quota` — today's allowance.
 *
 * The numbers come from the store the previous visit refreshed; Cloudflare is asked again behind the
 * response, so opening the dashboard costs one read instead of one GraphQL call per product per
 * account. The exception is a day with nothing counted yet: that answer would be blank, so it waits.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { hasStoredQuota, quotaSummary, syncQuotaFromCloudflare } from '../../cloudflare/quota'

export const quotaRouter = new Hono<AppBindings>()

quotaRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const [stored, counted] = await Promise.all([
    quotaSummary(c.env, userId),
    hasStoredQuota(c.env, userId),
  ])
  const refresh = syncQuotaFromCloudflare(c.env, userId).catch((error: unknown) => {
    console.warn('[inkstone] Cloudflare quota refresh failed:', (error as Error)?.message)
  })

  if (stored.length > 0 && !counted) {
    await refresh
    return c.json({ accounts: await quotaSummary(c.env, userId) })
  }

  try {
    c.executionCtx.waitUntil(refresh)
  } catch {
    // No execution context (unit tests, a runtime that has none): the refresh still runs unawaited.
  }
  return c.json({ accounts: stored })
})
