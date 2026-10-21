import { Hono } from 'hono'
import type { MemoListResponse } from '@shared/memos/types'
import type { AppBindings } from '../env'
import { requireMemoUser } from './auth'

export const memosRoutes = new Hono<AppBindings>()

memosRoutes.use('*', requireMemoUser)

memosRoutes.get('/', (c) => {
  const page: MemoListResponse = { items: [], nextCursor: null }
  return c.json(page)
})
