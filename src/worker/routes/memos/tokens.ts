import { Hono } from 'hono'
import type { MemoTokenCreateInput } from '@shared/memos/types'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import { createToken, listTokens, revokeToken } from '../../memos/pat'

export const memoTokenRoutes = new Hono<AppBindings>()

memoTokenRoutes.use('*', requireMemoUser)

memoTokenRoutes.get('/', async (c) => {
  const tokens = await listTokens(c.env.DB, c.get('userId'))
  return c.json({ tokens })
})

memoTokenRoutes.post('/', async (c) => {
  const body = await readJson<MemoTokenCreateInput>(c, JSON_BODY_LIMITS.small)
  const result = await createToken(c.env.DB, c.get('userId'), body)
  return c.json(result, 201)
})

memoTokenRoutes.delete('/:id', async (c) => {
  const revoked = await revokeToken(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!revoked) throw ApiError.notFound('Token not found')
  return c.json({ ok: true })
})
