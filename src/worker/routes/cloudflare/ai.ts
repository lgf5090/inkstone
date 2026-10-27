/**
 * `/api/cloudflare/ai` — the numbers behind the AI statistics tab.
 *
 * Cloudflare's GraphQL analytics are the authority for today's neurons. They are also the call most
 * likely to fail while the rest of the module works, so a failed lookup answers the locally counted
 * number with a warning instead of hiding the account: the screen exists to show what is left, and an
 * error there would hide every other account's numbers too.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { loadActiveAccounts } from '../../cloudflare/accounts'
import { getQuotaForAccount, setQuota } from '../../cloudflare/quota'
import { getAiUsageToday, type AiUsage } from '../../cloudflare/usage'

export const aiRouter = new Hono<AppBindings>()

export interface AiUsageAccountView {
  accountId: string
  accountName: string
  totalNeurons: number
  models: AiUsage['models']
  warning?: string
}

const LOCAL_ESTIMATE_WARNING = 'Could not read Cloudflare usage; showing the local estimate'
const ZERO_USAGE_WARNING = 'Cloudflare reported no neurons today; showing the local estimate'

aiRouter.get('/usage', async (c) => {
  const userId = c.get('userId')
  const accounts = (await loadActiveAccounts(c.env, userId)).filter(({ row }) => row.cf_account_id)

  const results: AiUsageAccountView[] = await Promise.all(
    accounts.map(async ({ row, auth }) => {
      const cfAccountId = row.cf_account_id as string
      try {
        const usage = await getAiUsageToday(auth, cfAccountId)
        if (usage.totalNeurons > 0) {
          // The analytics value replaces the counter for today; an exhausted flag is left alone, as an
          // exhausted account still needs an explicit reset before it can be used again.
          await setQuota(c.env, userId, row.id, 'ai_neurons', usage.totalNeurons)
          return {
            accountId: cfAccountId,
            accountName: row.name,
            totalNeurons: usage.totalNeurons,
            models: usage.models,
          }
        }
        const local = await getQuotaForAccount(c.env, userId, row.id, 'ai_neurons')
        return {
          accountId: cfAccountId,
          accountName: row.name,
          totalNeurons: local?.count ?? 0,
          models: [],
          warning: ZERO_USAGE_WARNING,
        }
      } catch (error) {
        console.warn(`[inkstone] AI usage sync failed for ${row.name}:`, (error as Error)?.message)
        const local = await getQuotaForAccount(c.env, userId, row.id, 'ai_neurons')
        return {
          accountId: cfAccountId,
          accountName: row.name,
          totalNeurons: local?.count ?? 0,
          models: [],
          warning: LOCAL_ESTIMATE_WARNING,
        }
      }
    }),
  )

  return c.json(results)
})
