import { runAttachmentCleanup } from './attachments/cleanup'
import { runScheduledBackups } from './backup/scheduler'
import { runDueAssistantAutomations } from './assistant/scheduler'
import { sweepTaskReminders } from './assistant/tasks'
import { runPushCatchUp } from './assistant/push-fanout'
import { purgeExpiredEphemeralConversations, purgeExpiredTodoTrash } from './assistant/store'
import type { Env } from './env'
import { initializeDatabase } from './db/schema'
import { drainAllFtsQueues } from './db/fts'
import { drainAiIndexQueue } from './mcp/ai-search'
import { drainRewriteQueues } from './lib/rewrite-drain'
import { createOAuthProvider, providerForScheduled } from './mcp/oauth'
import { purgeRevokedMcpApiKeys } from './mcp/api-keys'
import { purgeExpiredMcpOperations } from './mcp/operations'
import { purgeExpiredOperationalData } from './lib/maintenance'
import { purgeExpiredSubscriptionData } from './subscriptions/logs'
import { sweepSubscriptions } from './subscriptions/scheduler'
import { refreshDueIcsSubscriptions } from './calendar/subscriptions'
import { sweepCalendarReminders } from './calendar/reminders'
import { syncDueProviderConnections } from './calendar/provider-sync'
import { ApiError } from './lib/errors'
import { withSecurityHeaders } from './lib/security-headers'
import { isXgetProxyPath } from './development/xget/paths'
import { normalizeRepeatedOAuthResource } from './lib/oauth-request'
import { dispatchInboundEmail } from './email/dispatch'
import { runEmailTrashCleanup } from './email/trash'
import { runMusicMaintenance } from './music/cleanup'
import { runImgbedMaintenanceSafely } from './imgbed/cleanup'
import { runNavMaintenance } from './nav/cleanup'
import { runEmailAutoDraftJobs } from './email/auto-draft'
import { runEmailSnoozeWake } from './email/snooze'
import { runEmailFollowUpSweep } from './email/follow-up'
import { runScheduledSends } from './email/scheduled-send'
import { runDueCloudflareTasks } from './cloudflare/tasks'

export { SyncHub } from './realtime/sync-hub'
export { CredentialVault } from './durable/credential-vault'
export { EmailMailbox } from './email/mailbox-do'
export { MusicQueue } from './music/queue'
export { MusicShareLimiter } from './music/share-limiter'

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
    if (isXgetProxyPath(new URL(oauthRequest.url).pathname)) return response
    return withSecurityHeaders(response, oauthRequest.url, { aiConnectHosts: env.AI_CONNECT_HOSTS })
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const { ftsEnabled } = await initializeDatabase(env)
      // The cron fires every minute: a reminder that arrives twenty-nine minutes late is a broken reminder,
      // so the three sweeps below ride every fire. The drains keep the three fires an hour `isDrainFire`
      // accepts and the whole-library work keeps the top of the hour, so the extra fires cost nothing beyond
      // the sweeps themselves — `initializeDatabase` answers from its per-isolate cache.
      // The Web Push nudges a sweep queues are handed to `waitUntil` rather than awaited: the notification
      // rows are the delivery, and a push service that answers slowly must not hold up the tick that wrote
      // them. What the sends cost comes back in the sweep result's `push` tally.
      const assistantTick = runDueAssistantAutomations(env, Date.now(), (task) => { ctx.waitUntil(task) })
      // Subscription reminders share the every-fire cadence for the same reason the assistant's do: a
      // reminder is cheap, and the sweep deduplicates by the reader's own local hour, so the fires that
      // follow find their deliveries already claimed.
      const subscriptionTick = sweepSubscriptions(env, event.scheduledTime)
      // ICS feeds need a copy on the server whether or not the reader has the calendar tab open;
      // the sweep itself spaces successes and failures, so this fire only starts what is due.
      const calendarTick = refreshDueIcsSubscriptions(env, event.scheduledTime)
      const calendarReminderTick = sweepCalendarReminders(env, event.scheduledTime, (task) => { ctx.waitUntil(task) })
      const calendarProviderTick = syncDueProviderConnections(env, event.scheduledTime)
      // Task reminders ride the same every-fire cadence, for the same reason: the claim on the row is
      // what deduplicates them, so a second fire in the same minute finds nothing left to deliver.
      const reminderTick = sweepTaskReminders(env, event.scheduledTime, (task) => { ctx.waitUntil(task) })
      const emailDraftTick = runEmailAutoDraftJobs(env, event.scheduledTime, 2)
      const emailSnoozeTick = runEmailSnoozeWake(env, event.scheduledTime)
      const emailFollowUpTick = runEmailFollowUpSweep(env, event.scheduledTime)
      // The Cloudflare app's scheduled maintenance runs on every fire: its own rows decide which
      // expressions include this minute, and each run is recorded either way.
      const cloudflareTick = runDueCloudflareTasks(env, event.scheduledTime).catch((error) => {
        console.warn('[inkstone] Cloudflare scheduled tasks failed:', (error as Error).message)
        return null
      })
      const emailScheduledTick = runScheduledSends(env, event.scheduledTime, 3).catch((error) => {
        console.warn('[inkstone] scheduled email send sweep failed:', (error as Error).message)
        return null
      })
      if (!isDrainFire(event.scheduledTime)) {
        await Promise.all([assistantTick, subscriptionTick, calendarTick, calendarReminderTick, calendarProviderTick, reminderTick, emailDraftTick, emailSnoozeTick, emailFollowUpTick, emailScheduledTick, cloudflareTick])
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
            purgeExpiredTodoTrash(env.DB),
            runEmailTrashCleanup(env),
            runNavMaintenance(env).catch((error) => {
              console.warn('[inkstone] Navigation maintenance sweep failed:', (error as Error).message)
              return null
            }),
            runImgbedMaintenanceSafely(env),
            runMusicMaintenance(env).catch((error) => {
              console.warn('[inkstone] Music maintenance sweep failed:', (error as Error).message)
              return null
            }),
            purgeExpiredSubscriptionData(env.DB),
            providerForScheduled(env).purgeExpiredData(env, { batchSize: 100 }),
          ]
        : []
      await Promise.all([...drains, ...heavy, subscriptionTick, calendarTick, calendarReminderTick, calendarProviderTick, reminderTick, emailDraftTick, emailSnoozeTick, emailFollowUpTick, emailScheduledTick, cloudflareTick])
    })())
  },

  /**
   * Email Routing's inbound door: `u+<token>@<MAIL_DOMAIN>` becomes a task, a mailbox address is
   * delivered to its owner's mailbox, and anything else is dropped.
   *
   * The handler is one call deep — routing, parsing, idempotency and the drops all live in
   * `email/dispatch.ts` and the modules it calls, so the Worker entry stays a list of the platform's
   * events. Nothing here answers the sender: an unknown recipient is dropped, not rejected, which is
   * what keeps the address space from being enumerable through bounces.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await dispatchInboundEmail(message, env, ctx)
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
