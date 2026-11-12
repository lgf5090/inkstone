import { runAttachmentCleanup } from './attachments/cleanup'
import { runScheduledBackups } from './backup/scheduler'
import { runDueAssistantAutomations } from './assistant/scheduler'
import { sweepTaskReminders } from './assistant/tasks'
import { pruneProjectActivity, sweepProjectReminders } from './project/scheduler'
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
import { cleanupExpiredResponses } from './cloudflare/ai-gateway-responses'
import { cleanupGatewayMedia } from './cloudflare/ai-gateway-media'
import { runNavMaintenance } from './nav/cleanup'
import { runEmailAutoDraftJobs } from './email/auto-draft'
import { runEmailSnoozeWake } from './email/snooze'
import { runEmailFollowUpSweep } from './email/follow-up'
import { runScheduledSends } from './email/scheduled-send'
import { runShortlinksRetention } from './tools/shortlinks/maintenance'
import { runCompareRetention } from './tools/compare/retention'
import { runDueCloudflareTasks } from './cloudflare/tasks'
import { runDueCloudDriveJobs } from './clouddrive/routes-jobs'
import { runCerthubTick } from './development/certhub/worker'
import { resumeCloudDriveIndexTasks } from './clouddrive/routes-admin'
import { resumeCloudDriveRemoteTasks } from './clouddrive/remote'
import { runWebsshRetention } from './webssh/retention'
import { handleIconQueue, type IconQueueMessage } from './development/icons/queue'

export { SyncHub } from './realtime/sync-hub'
export { CredentialVault } from './durable/credential-vault'
export { WebsshSession } from './webssh/do/session'
export { EmailMailbox } from './email/mailbox-do'
export { MusicQueue } from './music/queue'
export { MusicShareLimiter } from './music/share-limiter'
export { SubagentRunner } from './assistant/subagent-do'

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
      // One certificate order that throws must not take the whole scheduled round with it: the other
      // ticks, and every order behind this one, still have work to do in the same fire.
      const certhubTick = runCerthubTick(env, event.scheduledTime).catch((error) => {
        console.warn('[inkstone] certificate hub tick failed:', (error as Error).message)
        return null
      })
      const projectReminderTick = sweepProjectReminders(env, event.scheduledTime, (task) => { ctx.waitUntil(task) }).catch((error) => {
        console.warn('[inkstone] project reminder sweep failed:', (error as Error).message)
        return 0
      })
      const emailDraftTick = runEmailAutoDraftJobs(env, event.scheduledTime, 2)
      const emailSnoozeTick = runEmailSnoozeWake(env, event.scheduledTime)
      const emailFollowUpTick = runEmailFollowUpSweep(env, event.scheduledTime)
      // The Cloudflare app's scheduled maintenance runs on every fire: its own rows decide which
      // expressions include this minute, and each run is recorded either way.
      // Click-detail retention rides the top of the hour only: it deletes in bounded chunks and must not
      // compete with the every-minute delivery sweeps.
      const shortlinksTick = new Date(event.scheduledTime).getUTCMinutes() === 0
        ? runShortlinksRetention(env, event.scheduledTime).catch((error) => {
            console.warn('[inkstone] shortlinks retention failed:', (error as Error).message)
            return 0
          })
        : Promise.resolve(0)
      // An upload the compare tool never saved into a project is an R2 object with no row pointing at
      // it. The sweep rides the top of the hour with the other bounded cleanups, not every minute.
      const compareTick = new Date(event.scheduledTime).getUTCMinutes() === 0
        ? runCompareRetention(env, event.scheduledTime).catch((error) => {
            console.warn('[inkstone] compare retention failed:', (error as Error).message)
          })
        : Promise.resolve()
      const projectRetentionTick = new Date(event.scheduledTime).getUTCMinutes() === 0
        ? pruneProjectActivity(env, event.scheduledTime).catch((error) => {
            console.warn('[inkstone] project activity retention failed:', (error as Error).message)
            return 0
          })
        : Promise.resolve(0)
      const cloudflareTick = runDueCloudflareTasks(env, event.scheduledTime).catch((error) => {
        console.warn('[inkstone] Cloudflare scheduled tasks failed:', (error as Error).message)
        return null
      })
      const emailScheduledTick = runScheduledSends(env, event.scheduledTime, 3).catch((error) => {
        console.warn('[inkstone] scheduled email send sweep failed:', (error as Error).message)
        return null
      })
      // CloudDrive's own sweeps (expired upload sessions, share sessions, trash retention) ride every fire
      // as well: each job decides for itself whether its interval has arrived, and an abandoned upload
      // holds R2 bytes that nothing else can release until its session row is closed.
      resumeCloudDriveIndexTasks(env, event.scheduledTime).catch((error) => {
        console.warn('[clouddrive] a queued index task could not resume:', error)
      })
      resumeCloudDriveRemoteTasks(env, event.scheduledTime).catch((error) => {
        console.warn('[clouddrive] a queued remote upload could not resume:', error)
      })
      const clouddriveTick = runDueCloudDriveJobs(env, event.scheduledTime, 10).catch((error) => {
        console.warn('[inkstone] CloudDrive scheduled jobs failed:', (error as Error).message)
        return null
      })
      if (!isDrainFire(event.scheduledTime)) {
        await Promise.all([assistantTick, subscriptionTick, certhubTick, calendarTick, calendarReminderTick, calendarProviderTick, reminderTick, projectReminderTick, projectRetentionTick, emailDraftTick, emailSnoozeTick, emailFollowUpTick, emailScheduledTick, cloudflareTick, shortlinksTick, compareTick, clouddriveTick])
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
            runWebsshRetention(env, event.scheduledTime).catch((error) => {
              console.warn('[inkstone] WebSSH retention sweep failed:', (error as Error).message)
              return 0
            }),
            runImgbedMaintenanceSafely(env),
            (async () => {
              const responses = await cleanupExpiredResponses(env)
              const media = await cleanupGatewayMedia(env)
              return { responses, media }
            })().catch((error) => {
              console.warn('[inkstone] AI gateway retention sweep failed:', (error as Error).message)
              return null
            }),
            runMusicMaintenance(env).catch((error) => {
              console.warn('[inkstone] Music maintenance sweep failed:', (error as Error).message)
              return null
            }),
            purgeExpiredSubscriptionData(env.DB),
            providerForScheduled(env).purgeExpiredData(env, { batchSize: 100 }),
          ]
        : []
      await Promise.all([...drains, ...heavy, subscriptionTick, certhubTick, calendarTick, calendarReminderTick, calendarProviderTick, reminderTick, projectReminderTick, emailDraftTick, emailSnoozeTick, emailFollowUpTick, emailScheduledTick, cloudflareTick, shortlinksTick, clouddriveTick])
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

  /**
   * Icon conversion. The message only names the job; the consumer loads the rows itself so a
   * redelivery after a crash picks up exactly the items that are still queued.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await initializeDatabase(env)
    await handleIconQueue(batch as unknown as MessageBatch<IconQueueMessage>, env)
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
