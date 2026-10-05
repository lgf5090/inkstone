import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { checkRepositoryVersionCached } from '../lib/update-check'
import { requireAuth } from '../middleware/auth'

export const updateRoutes = new Hono<AppBindings>()

updateRoutes.use('*', requireAuth)

updateRoutes.get('/', async (c) => {
  if (c.get('user').role !== 'owner') {
    throw ApiError.forbidden('Only the owner can check deployment updates')
  }
  c.header('Cache-Control', 'no-store')
  return c.json(await checkRepositoryVersionCached())
})
