/**
 * The one way in from outside: a script, a cron job, a phone shortcut.
 *
 * It is mounted at `/hooks/subscriptions` rather than under `/api` for a specific reason: every `/api`
 * POST requires the client-identification header this app's own browser sends, which is a CSRF guard and
 * exactly the wrong thing to ask a third-party `curl` for. Nothing here is authenticated by a session;
 * the token in the path is the credential, and it is compared against a stored digest.
 *
 * The budget is per token rather than per address, because the token is what identifies the caller and
 * an attacker who has it does not need to be polite about which address they use.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { createMinuteBudget } from '../lib/rate-limit'
import { initializeDatabase } from '../db/schema'
import { dispatch } from '../subscriptions/channels'
import { writeNotifyLog } from '../subscriptions/logs'
import { enabledChannels, loadSettings, userIdForInboundToken } from '../subscriptions/settings'
import { buildEvents, toICal } from '../subscriptions/calendar'
import { SubscriptionsStore, storeContext } from '../subscriptions/store'

const BODY_LIMIT = 8 * 1024
const BUDGET_PER_MINUTE = 30
/** A calendar that polls more than this is not a calendar; the budget is per token, as above. */
const CALENDAR_BUDGET_PER_MINUTE = 30

export const subscriptionInboundRoutes = new Hono<AppBindings>()

const takeBudget = createMinuteBudget(BUDGET_PER_MINUTE, 'Too many notifications from this token. Try again in a minute.')
const takeCalendarBudget = createMinuteBudget(CALENDAR_BUDGET_PER_MINUTE, 'Too many calendar fetches for this link. Try again in a minute.')

subscriptionInboundRoutes.post('/:token', async (c) => {
  await initializeDatabase(c.env)

  const presented = bearer(c) ?? c.req.param('token')
  const userId = await userIdForInboundToken(c.env.DB, presented)
  if (!userId) throw ApiError.notFound('No such token')
  takeBudget(presented)

  const raw = await readJson<{ title?: unknown; content?: unknown; tags?: unknown }>(c, BODY_LIMIT)
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!content) throw ApiError.badRequest('A message body is required')
  if (content.length > 4000) throw ApiError.badRequest('That message is too long')
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : 'Notification'
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 20)
    : []

  const settings = await loadSettings(c.env.DB, userId)
  const channels = await enabledChannels(c.env, c.env.DB, userId)
  if (channels.length === 0) throw ApiError.badRequest('No notification channel is enabled')

  const result = await dispatch(
    { title, content, metadata: { tags } },
    channels,
    { timezone: settings.timezone, locale: settings.locale },
    { env: c.env, userId },
  )

  for (const outcome of result.results) {
    await writeNotifyLog(c.env.DB, userId, {
      subscriptionId: '',
      ruleId: 'inbound',
      channel: outcome.channel,
      status: outcome.success ? 'success' : 'failed',
      title,
      body: content,
      error: outcome.error ?? '',
      detail: outcome.detail ?? '',
    })
  }

  return c.json({ ok: result.failedCount === 0, attempted: result.attempted, successCount: result.successCount, failedCount: result.failedCount })
})

/**
 * The renewal dates as a calendar a phone or a web calendar can subscribe to.
 *
 * Same door, same credential as the POST above: a calendar client is exactly the third party that has no
 * session and no client header, so the token in the path is the whole authorisation. Unlike the POST, this
 * one cannot accept a bearer header — a client that polls a URL for updates sends no headers it is not
 * asked to — so this address is a link that carries a secret, and the settings screen says so where the
 * reader copies it from.
 *
 * Nothing personal is in the answer. A plan's notes are the one field a reader may have used for anything,
 * and they are not in the file; what is there is the name, the date, the cycle and the price.
 */
subscriptionInboundRoutes.get('/calendar/:token', async (c) => {
  await initializeDatabase(c.env)

  const presented = c.req.param('token')
  const userId = await userIdForInboundToken(c.env.DB, presented)
  if (!userId) throw ApiError.notFound('No such token')
  takeCalendarBudget(presented)

  const settings = await loadSettings(c.env.DB, userId)
  const items = await new SubscriptionsStore(c.env.DB, userId).list(storeContext(settings))
  const body = toICal(buildEvents(items), { name: 'Inkstone subscriptions', stamp: Date.now() })

  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="subscriptions.ics"',
      // Every fetch is rebuilt from the rows, and a cached copy would be a calendar that quietly stops
      // agreeing with the app it came from.
      'cache-control': 'no-store',
    },
  })
})

/** `Authorization: Bearer <token>` wins over the path, so a caller can keep the token out of a URL log. */
function bearer(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match ? match[1]! : null
}
