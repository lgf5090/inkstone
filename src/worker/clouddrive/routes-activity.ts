import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { listActivities } from './activity'

export const clouddriveActivityRoutes = new Hono<AppBindings>()

clouddriveActivityRoutes.use('/activity', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

clouddriveActivityRoutes.get('/activity', async (c) => {
  const result = await listActivities(c.env.DB, c.get('userId'), {
    cursor: c.req.query('cursor') || undefined,
    alerts: c.req.query('alerts') === '1',
    limit: Number(c.req.query('limit')),
  })
  return c.json(result)
})
