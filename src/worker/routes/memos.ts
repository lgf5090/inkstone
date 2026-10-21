import { Hono } from 'hono'
import type { MemoListResponse } from '@shared/memos/types'
import type { AppBindings } from '../env'
import { requireMemoUser } from '../memos/auth'

export const memoListRoutes = new Hono<AppBindings>()

memoListRoutes.use('*', requireMemoUser)

memoListRoutes.get('/', (c) => {
  const page: MemoListResponse = { items: [], nextCursor: null }
  return c.json(page)
})
