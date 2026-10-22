import { Hono } from 'hono'
import { MEMO_FILTER_MAX_BYTES } from '@shared/memos/constants'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import {
  createView,
  deleteView,
  listViews,
  patchView,
  validateViewFilter,
  type MemoViewFields,
} from '../../memos/views'

const VIEW_BODY_MAX_BYTES = MEMO_FILTER_MAX_BYTES * 6 + 1024

export const memoViewRoutes = new Hono<AppBindings>()

memoViewRoutes.use('*', requireMemoUser)

memoViewRoutes.get('/', async (c) => {
  const views = await listViews(c.env.DB, c.get('userId'))
  return c.json({ views })
})

memoViewRoutes.post('/', async (c) => {
  const body = await readJson<MemoViewFields>(c, VIEW_BODY_MAX_BYTES)
  const view = await createView(c.env.DB, c.get('userId'), body)
  return c.json(view, 201)
})

memoViewRoutes.post('/validate', async (c) => {
  const body = await readJson<{ filter?: unknown }>(c, VIEW_BODY_MAX_BYTES)
  return c.json(validateViewFilter(body.filter))
})

memoViewRoutes.patch('/:id', async (c) => {
  const body = await readJson<MemoViewFields>(c, VIEW_BODY_MAX_BYTES)
  const view = await patchView(c.env.DB, c.get('userId'), c.req.param('id'), body)
  if (!view) throw ApiError.notFound('View not found')
  return c.json(view)
})

memoViewRoutes.delete('/:id', async (c) => {
  const deleted = await deleteView(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!deleted) throw ApiError.notFound('View not found')
  return c.json({ ok: true })
})
