import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  createIcsSubscription,
  deleteIcsSubscription,
  refreshIcsSubscription,
  setIcsSubscriptionEnabled,
} from '../calendar/subscriptions'

const budget = createMinuteBudget(20, 'Too many calendar subscription changes. Try again in a minute.')

export const calendarSubscriptionRoutes = new Hono<AppBindings>()

calendarSubscriptionRoutes.use('*', requireAuth)
calendarSubscriptionRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') budget(c.get('userId'))
  await next()
})

calendarSubscriptionRoutes.post('/', async (c) => {
  const body = await readJson<{ url?: unknown; name?: unknown; color?: unknown }>(c, 8 * 1024)
  if (typeof body.url !== 'string') throw ApiError.badRequest('url is required')
  const name = typeof body.name === 'string' ? body.name : undefined
  const color = typeof body.color === 'string' ? body.color : undefined
  const result = await createIcsSubscription(c.env, c.get('userId'), {
    url: body.url,
    name,
    color,
  })
  return c.json({
    calendarId: result.calendarId,
    subscription: result.subscription,
    imported: result.imported,
    warnings: result.warnings,
  })
})

calendarSubscriptionRoutes.post('/:id/refresh', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Subscription not found')
  const result = await refreshIcsSubscription(c.env, c.get('userId'), id)
  return c.json(result)
})

calendarSubscriptionRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Subscription not found')
  const body = await readJson<{ enabled?: unknown }>(c, 8 * 1024)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be true or false')
  await setIcsSubscriptionEnabled(c.env, c.get('userId'), id, body.enabled)
  return c.body(null, 204)
})

calendarSubscriptionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Subscription not found')
  await deleteIcsSubscription(c.env, c.get('userId'), id)
  return c.body(null, 204)
})
