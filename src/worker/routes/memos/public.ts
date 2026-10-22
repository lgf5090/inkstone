import { Hono, type Context } from 'hono'
import { MEMO_PUBLIC_PAGE_SIZE } from '@shared/memos/constants'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { clampInt } from '../../lib/request'
import {
  MEMO_PUBLIC_MAX_PAGE_SIZE,
  getPublicMemo,
  getSharedMemo,
  listPublicMemos,
} from '../../memos/public'

function viewerId(c: Context<AppBindings>): string | null {
  return c.get('userId') || null
}

function pageLimit(c: Context<AppBindings>): number {
  return clampInt(c.req.query('limit'), 1, MEMO_PUBLIC_MAX_PAGE_SIZE, MEMO_PUBLIC_PAGE_SIZE)
}

export const memoPublicDataRoutes = new Hono<AppBindings>()

memoPublicDataRoutes.get('/users/:username/memos', async (c) => {
  const page = await listPublicMemos(c.env.DB, viewerId(c), {
    username: c.req.param('username'),
    cursor: c.req.query('cursor') || undefined,
    limit: pageLimit(c),
    tz: c.req.query('tz') || undefined,
  })
  if (!page) throw ApiError.notFound('User not found')
  return c.json(page)
})

memoPublicDataRoutes.get('/users/:username/memos/:id', async (c) => {
  const memo = await getPublicMemo(
    c.env.DB,
    viewerId(c),
    c.req.param('username'),
    c.req.param('id'),
  )
  if (!memo) throw ApiError.notFound('Memo not found')
  return c.json(memo)
})

memoPublicDataRoutes.get('/explore', async (c) => {
  const page = await listPublicMemos(c.env.DB, viewerId(c), {
    cursor: c.req.query('cursor') || undefined,
    limit: pageLimit(c),
    tz: c.req.query('tz') || undefined,
  })
  return c.json(page)
})

memoPublicDataRoutes.get('/shares/:token', async (c) => {
  const memo = await getSharedMemo(c.env.DB, c.req.param('token'))
  if (!memo) throw ApiError.notFound('Share not found')
  return c.json(memo)
})
