import { createMiddleware } from 'hono/factory'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { findToken } from './pat'
import { memoPatFromAuthorization } from './tokens'

export const requireMemoUser = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get('userId')) {
    await next()
    return
  }
  const token = memoPatFromAuthorization(c.req.header('Authorization'))
  if (!token) {
    await requireAuth(c, next)
    return
  }
  const owner = await findToken(c.env.DB, token)
  if (!owner) throw ApiError.unauthenticated('Invalid or expired access token')
  c.set('userId', owner.userId)
  await next()
})
