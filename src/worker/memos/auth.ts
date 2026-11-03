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
  c.set('memoPatId', owner.id)
  c.set('memoPatScope', owner.scope)
  await next()
})

/**
 * The token ledger and the account archive stay behind a session or an explicit owner-scope token.
 *
 * Everything else a `memos` token reaches is ordinary memo data; a leaked automation credential must
 * not be able to list and mint more tokens (renewing itself) or download the whole account archive.
 */
export const requireMemoOwner = createMiddleware<AppBindings>(async (c, next) => {
  // Resolve the credential first: a delegating call that only reports its refusal afterwards cannot
  // catch the scope it just learned, and the route would already have run.
  if (!c.get('userId')) {
    const token = memoPatFromAuthorization(c.req.header('Authorization'))
    if (!token) {
      await requireAuth(c, next)
      return
    }
    const owner = await findToken(c.env.DB, token)
    if (!owner) throw ApiError.unauthenticated('Invalid or expired access token')
    c.set('userId', owner.userId)
    c.set('memoPatId', owner.id)
    c.set('memoPatScope', owner.scope)
  }
  if (c.get('memoPatScope') && c.get('memoPatScope') !== 'owner') {
    throw ApiError.forbidden('This access token cannot manage tokens or export the account')
  }
  await next()
})
