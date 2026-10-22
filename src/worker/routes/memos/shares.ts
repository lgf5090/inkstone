import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import {
  createShare,
  listShares,
  revokeShare,
  type MemoShareFields,
} from '../../memos/shares'

export const memoShareRoutes = new Hono<AppBindings>()

memoShareRoutes.use('*', requireMemoUser)

memoShareRoutes.get('/:id/shares', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const shares = await listShares(c.env.DB, c.get('userId'), memoId)
  return c.json({ shares })
})

memoShareRoutes.post('/:id/shares', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const body = await readJson<MemoShareFields>(c, JSON_BODY_LIMITS.small)
  const share = await createShare(c.env.DB, c.get('userId'), memoId, body.expiresAt)
  return c.json(share, 201)
})

memoShareRoutes.delete('/:id/shares/:shareId', async (c) => {
  const memoId = requireMemoId(c.req.param('id'))
  const shareId = requireShareId(c.req.param('shareId'))
  const revoked = await revokeShare(c.env.DB, c.get('userId'), memoId, shareId)
  if (!revoked) throw ApiError.notFound('Share not found')
  return c.json({ ok: true })
})

function requireMemoId(value: string): string {
  if (!isValidId(value)) throw ApiError.notFound('Memo not found')
  return value
}

function requireShareId(value: string): string {
  if (!isValidId(value)) throw ApiError.notFound('Share not found')
  return value
}
