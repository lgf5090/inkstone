/**
 * `/api/cloudflare/settings` — what the module is configured with, and the one cache it keeps.
 *
 * The reference module's settings screen also carried a global proxy and a Resin pool. Neither exists
 * here: an HTTP proxy is a Node transport, and a Worker that silently ignored the setting would be
 * lying to whoever configured it. The screen therefore shows the deployment's real state — vault, R2,
 * version — and the demo accounts a reader has marked, which is the one value that lives in a table.
 */
import { Hono } from 'hono'
import { APP_VERSION } from '@shared/constants'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { resetRenderState } from '../../cloudflare/browser-render'
import { DEMO_ACCOUNT_IDS_KEY, readSetting, setSetting } from '../../cloudflare/settings'

export const settingsRouter = new Hono<AppBindings>()

const DEMO_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

settingsRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const demo = (await readSetting(c.env, userId, DEMO_ACCOUNT_IDS_KEY)) ?? ''
  return c.json({
    platform: 'cloudflare-workers',
    demo_account_ids: demo,
    r2: Boolean(c.env.FILES),
    vault: Boolean(c.env.CREDENTIAL_VAULT),
    version: APP_VERSION,
  })
})

settingsRouter.post('/cache/clear', (c) => {
  resetRenderState()
  return c.json({ cleared: true })
})

/** Mark accounts as demo accounts: the server refuses destructive actions on them. */
settingsRouter.put('/demo-accounts', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null
  if (!Array.isArray(body?.ids)) throw ApiError.badRequest('ids must be an array of account ids')
  const ids = body.ids.map((value) => String(value).trim()).filter(Boolean)
  if (ids.some((id) => !DEMO_ID.test(id))) throw ApiError.badRequest('Every demo account id must be a 26-character id')
  await setSetting(c.env, userId, DEMO_ACCOUNT_IDS_KEY, ids.join(','))
  return c.json({ demo_account_ids: ids.join(',') })
})
