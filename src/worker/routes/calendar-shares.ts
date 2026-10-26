/**
 * The owner's side of a public calendar link.
 *
 * Three calls: read the current state, publish, unpublish. The address itself is served by
 * `calendar-public.ts` under `/feeds/calendar/…`, which never comes through here and never needs a
 * session.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { parseEntityId } from '../calendar/validation'
import { findShare, mintShare, revokeShare } from '../calendar/shares'

const writeBudget = createMinuteBudget(20, 'Too many calendar share changes. Try again in a minute.')

export const calendarShareRoutes = new Hono<AppBindings>()

calendarShareRoutes.use('*', requireAuth)

function pathId(c: Context<AppBindings>): string {
  return parseEntityId(c.req.param('id'), 'id')
}

calendarShareRoutes.get('/calendars/:id/share', async (c) => {
  const id = pathId(c)
  const share = await findShare(c.env.DB, c.get('userId'), id)
  return c.json({ share })
})

calendarShareRoutes.post('/calendars/:id/share', async (c) => {
  writeBudget(c.get('userId'))
  const id = pathId(c)
  return c.json({ share: await mintShare(c.env.DB, c.get('userId'), id) })
})

calendarShareRoutes.delete('/calendars/:id/share', async (c) => {
  writeBudget(c.get('userId'))
  const id = pathId(c)
  if (!await revokeShare(c.env.DB, c.get('userId'), id)) {
    throw ApiError.notFound('That calendar is not shared')
  }
  return c.body(null, 204)
})
