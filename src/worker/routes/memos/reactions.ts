import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import {
  deleteMemoReaction,
  listMemoReactions,
  upsertMemoReaction,
} from '../../memos/reactions'

export const memoReactionRoutes = new Hono<AppBindings>()

memoReactionRoutes.use('*', requireMemoUser)

memoReactionRoutes.get('/:id/reactions', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const reactions = await listMemoReactions(c.env.DB, c.get('userId'), memoId)
  return c.json({ reactions })
})

memoReactionRoutes.put('/:id/reactions', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const body = await readJson<{ type?: unknown }>(c, JSON_BODY_LIMITS.small)
  const reactions = await upsertMemoReaction(c.env.DB, c.get('userId'), memoId, body.type)
  return c.json({ reactions })
})

memoReactionRoutes.delete('/:id/reactions/:type', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const reactions = await deleteMemoReaction(c.env.DB, c.get('userId'), memoId, c.req.param('type'))
  return c.json({ reactions })
})

function requireMemoId(value: string): string {
  if (!isValidId(value)) throw ApiError.notFound('Memo not found')
  return value
}
