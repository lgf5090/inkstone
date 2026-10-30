import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { createApiKey, listApiKeys, revokeApiKey } from './store-keys'

export const clouddriveKeyRoutes = new Hono<AppBindings>()

clouddriveKeyRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

clouddriveKeyRoutes.get('/api-keys', async (c) => {
  return c.json({ keys: await listApiKeys(c.env.DB, userIdOf(c)) })
})

clouddriveKeyRoutes.post('/api-keys', async (c) => {
  const body = await readJson<{
    name?: unknown
    scopes?: unknown
    pathPrefix?: unknown
    expiresAt?: unknown
  }>(c, JSON_BODY_LIMITS.small)
  const created = await createApiKey(c.env.DB, userIdOf(c), body)
  // The token is deliberately present in this one response only; the listing has just its prefix.
  return c.json(created, 201)
})

clouddriveKeyRoutes.delete('/api-keys/:id', async (c) => {
  const revoked = await revokeApiKey(c.env.DB, userIdOf(c), c.req.param('id'))
  if (!revoked) throw ApiError.notFound('API key not found')
  return c.json({ ok: true })
})
