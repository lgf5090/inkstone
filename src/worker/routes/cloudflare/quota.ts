/**
 * `/api/cloudflare/quota` — today's allowance, refreshed from Cloudflare before it is answered.
 *
 * The refresh is what makes the dashboard's numbers the account's numbers rather than this
 * deployment's guess. It costs one GraphQL call per enabled product per active account, so it runs
 * on the quota read itself and nowhere else.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { quotaSummary, syncQuotaFromCloudflare } from '../../cloudflare/quota'

export const quotaRouter = new Hono<AppBindings>()

quotaRouter.get('/', async (c) => {
  const userId = c.get('userId')
  await syncQuotaFromCloudflare(c.env, userId)
  return c.json({ accounts: await quotaSummary(c.env, userId) })
})
