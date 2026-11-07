import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { ProjectStore } from './store'

export const projectRoutes = new Hono<AppBindings>()

projectRoutes.use('*', requireAuth)

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

function store(c: Context<AppBindings>): ProjectStore {
  return new ProjectStore(c.env.DB, userId(c))
}

projectRoutes.get('/boards', async (c) => {
  return c.json({ boards: await store(c).boards() })
})