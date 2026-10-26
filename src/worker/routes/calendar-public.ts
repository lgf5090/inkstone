/**
 * The public calendar link: `GET /feeds/calendar/<slug>.ics`.
 *
 * There is no session here and there never will be one — a third-party calendar polls this address and
 * cannot log in — so the unguessable slug is the whole capability, exactly as the task feed works. The
 * security `requireAuth` would otherwise supply is done by hand and deliberately:
 *   - the slug shape is checked before any database is touched, so a guessed slug is refused the same
 *     fast 404 as one that never existed and the endpoint cannot be used to probe;
 *   - revoked and unknown links both answer 404, never a 403 that explains which;
 *   - polling is throttled per slug and visitor, and the document itself is capped, so one shared
 *     calendar cannot be turned into unbounded work or an unbounded download.
 *
 * The document is built from the owner's calendar only: no other calendar, no account metadata, and
 * nothing that identifies the owner.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug } from '../lib/id'
import { requestClientIp } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { recordShareView, shareOwner, sharedCalendarChunks } from '../calendar/shares'

/** A published calendar is a subscription, not a report: four megabytes of text is generous. */
const PUBLIC_ICS_BYTES = 4 * 1024 * 1024

export const calendarPublicRoutes = new Hono<AppBindings>()

/** `ABC123….ics` and `abc123…` reach the same calendar; the stored slug is always lowercase. */
export function stripCalendarIcsSuffix(value: string | undefined): string {
  if (!value) return ''
  const lowered = value.toLowerCase()
  return lowered.endsWith('.ics') ? lowered.slice(0, -4) : lowered
}

function throttled(c: Context<AppBindings>, slug: string): Promise<void> {
  const ip = requestClientIp(c)
  return assertAttemptBudget(async () => {
    await consumeAttemptBudget(c.env.DB, [
      { key: `calendar-feed:${slug}:ip:${ip}`, maxAttempts: 60, windowMs: 5 * 60 * 1000 },
    ])
  })
}

calendarPublicRoutes.get('/calendar/:slug', async (c) => {
  const slug = stripCalendarIcsSuffix(c.req.param('slug'))
  if (!isValidSlug(slug)) throw ApiError.notFound('Calendar not found')
  await throttled(c, slug)
  const owner = await shareOwner(c.env.DB, slug)
  if (!owner) throw ApiError.notFound('Calendar not found')
  const answer = await sharedCalendarChunks(c.env.DB, owner.userId, owner.calendarId, PUBLIC_ICS_BYTES)
  if (!answer.chunks) {
    throw ApiError.tooLarge('That shared calendar is too large to publish as one file')
  }
  const chunks = answer.chunks
  await recordShareView(c.env.DB, slug)
  return c.body(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
})
