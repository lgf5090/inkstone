import { runAttachmentCleanup } from './attachments/cleanup'
import { runScheduledBackups } from './backup/scheduler'
import { runDueAssistantAutomations } from './assistant/scheduler'
import { runPushCatchUp } from './assistant/push-fanout'
import { purgeExpiredEphemeralConversations } from './assistant/store'
import type { Env } from './env'
import { initializeDatabase } from './db/schema'
import { drainAllFtsQueues } from './db/fts'
import { drainAiIndexQueue } from './mcp/ai-search'
import { drainRewriteQueues } from './lib/rewrite-drain'
import { createOAuthProvider, providerForScheduled } from './mcp/oauth'
import { purgeRevokedMcpApiKeys } from './mcp/api-keys'
import { purgeExpiredMcpOperations } from './mcp/operations'
import { purgeExpiredOperationalData } from './lib/maintenance'
import { ApiError } from './lib/errors'
import { withSecurityHeaders } from './lib/security-headers'
import { normalizeRepeatedOAuthResource } from './lib/oauth-request'

export { SyncHub } from './realtime/sync-hub'
export { CredentialVault } from './durable/credential-vault'

// Codex CLI drops the `iss` callback parameter while its rmcp
// dependency enforces it whenever the authorization server advertises
// `authorization_response_iss_parameter_supported` (openai/codex#31573), so
// login fails even though the parameter is on the wire. Serve the metadata
// without that flag to keep codex compatible; the standard RFC 9207 `iss`
// parameter is still appended to callbacks for conforming clients.
const OAUTH_AUTHORIZATION_SERVER_METADATA = '/.well-known/oauth-authorization-server'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let oauthRequest: Request
    try {
      oauthRequest = await normalizeRepeatedOAuthResource(request)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      return withSecurityHeaders(
        Response.json(
          { error: 'invalid_request', error_description: 'The authorization request could not be completed' },
          { status: error.status },
        ),
        request.url,
        { aiConnectHosts: env.AI_CONNECT_HOSTS },
      )
    }
    const provider = createOAuthProvider(oauthRequest, env)
    const response = new URL(oauthRequest.url).pathname === OAUTH_AUTHORIZATION_SERVER_METADATA
      ? await oauthMetadataWithoutIssParameter(provider, oauthRequest, env, ctx)
      : await provider.fetch(oauthRequest, env, ctx)
    return withSecurityHeaders(response, oauthRequest.url, { aiConnectHosts: env.AI_CONNECT_HOSTS })
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const { ftsEnabled } = await initializeDatabase(env)
      // Index drains run on every cron fire; whole-library work (backups, attachment
      // cleanup, expired-record purges) only on the top of the hour, so a long backup
      // cannot take the embedding drains down with it.
      // The assistant's schedules are swept on every fire, including the minute-granular one, because
      // a reminder that arrives a quarter-hour late is a broken reminder. The existing drains keep the
      // cadence they had: they still run when they used to, not sixty times a day.
      // The Web Push nudges a sweep queues are handed to `waitUntil` rather than awaited: the notification
      // rows are the delivery, and a push service that answers slowly must not hold up the tick that wrote
      // them. What the sends cost comes back in the sweep result's `push` tally.
      const assistantTick = runDueAssistantAutomations(env, Date.now(), (task) => { ctx.waitUntil(task) })
      if (!isDrainFire(event.scheduledTime)) {
        await assistantTick
        return
      }
      const drains: Promise<unknown>[] = [
        drainAiIndexQueue(env, 300),
        drainAllFtsQueues(env.DB),
        drainRewriteQueues(env, ftsEnabled, 5),
        // Web Push's late pass, on the fire that already has the other maintenance work: it re-says what a
        // fan-out refused or a killed process never sent, and it prunes the subscriptions a service declares
        // gone. It is not a delivery path — the sweep above does that on every fire — and `pushed_at` is what
        // lets it run three times an hour without announcing the same row twice.
        runPushCatchUp(env),
      ]
      const heavy: Promise<unknown>[] = isHourStart(event.scheduledTime)
        ? [
            runScheduledBackups(env),
            runAttachmentCleanup(env),
            purgeExpiredMcpOperations(env.DB),
            purgeExpiredOperationalData(env.DB),
            purgeRevokedMcpApiKeys(env.DB),
            purgeExpiredEphemeralConversations(env.DB, env),
            providerForScheduled(env).purgeExpiredData(env, { batchSize: 100 }),
          ]
        : []
      await Promise.all([...drains, ...heavy])
    })())
  },
} satisfies ExportedHandler<Env>

/**
 * Which cron fires keep the whole-library drains.
 *
 * The minute pattern exists for the assistant's reminders. Running the queue drains on it too would
 * multiply work the deployment never asked for, so the drains are gated to the times they had before
 * the new pattern was added.
 */
export function isDrainFire(scheduledTime: number): boolean {
  const minute = new Date(scheduledTime).getUTCMinutes()
  return minute === 0 || minute === 15 || minute === 45
}

export function isHourStart(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() === 0
}

async function oauthMetadataWithoutIssParameter(
  provider: ReturnType<typeof createOAuthProvider>,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await provider.fetch(request, env, ctx)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.ok || !contentType.includes('application/json')) return response
  const metadata = (await response.json()) as Record<string, unknown>
  delete metadata.authorization_response_iss_parameter_supported
  const headers = new Headers(response.headers)
  headers.delete('Content-Length')
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
