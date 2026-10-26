/**
 * The `/api/cloudflare/*` surface.
 *
 * Everything under it needs a session: these routes act with a reader's own Cloudflare credentials,
 * and an unauthenticated caller has none. The routers are mounted with their static prefixes first —
 * `/ai/chat/sessions` before `/ai`, `/workers/summary` inside that router before its `/:accountId`
 * arm — because Hono answers in registration order.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { requireAuth } from '../../middleware/auth'
import { accountsRouter } from './accounts'
import { aiRouter } from './ai'
import { aiV1Router } from './ai-v1'
import { auditLogRouter } from './audit-log'
import { browserRenderRouter } from './browser-render'
import { chatSessionsRouter } from './chat-sessions'
import { dashboardRouter } from './dashboard'
import { dnsRouter } from './dns'
import { quotaRouter } from './quota'
import { settingsRouter } from './settings'
import { storageRouter } from './storage'
import { storeRouter } from './store'
import { tasksRouter } from './tasks'
import { tunnelsRouter } from './tunnels'
import { workersRouter } from './workers'

export const cloudflareRoutes = new Hono<AppBindings>()

cloudflareRoutes.use('*', requireAuth)

/** What the module needs from the deployment. Answers, it does not guess. */
cloudflareRoutes.get('/health', (c) => c.json({
  ok: true,
  r2: Boolean(c.env.FILES),
  vault: Boolean(c.env.CREDENTIAL_VAULT),
}))

cloudflareRoutes.route('/accounts', accountsRouter)
cloudflareRoutes.route('/dashboard', dashboardRouter)
cloudflareRoutes.route('/audit-log', auditLogRouter)
cloudflareRoutes.route('/dns', dnsRouter)
cloudflareRoutes.route('/workers', workersRouter)
cloudflareRoutes.route('/storage', storageRouter)
cloudflareRoutes.route('/tunnels', tunnelsRouter)
cloudflareRoutes.route('/browser-render', browserRenderRouter)
cloudflareRoutes.route('/store', storeRouter)
cloudflareRoutes.route('/settings', settingsRouter)
cloudflareRoutes.route('/tasks', tasksRouter)
cloudflareRoutes.route('/quota', quotaRouter)
// Before `/ai`: the chat history is an `/ai/chat/sessions` address, and an `/ai` router mounted first
// would answer it with its own not-found before this one saw the request.
cloudflareRoutes.route('/ai/chat/sessions', chatSessionsRouter)
cloudflareRoutes.route('/ai', aiRouter)
cloudflareRoutes.route('/v1', aiV1Router)
