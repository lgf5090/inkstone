import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { ApiError } from '../../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../../lib/request'
import { requireMemoUser } from '../../memos/auth'
import { scheduleMemoObjectCleanup } from '../../memos/cleanup'
import {
  createSpace,
  deleteSpace,
  listSpaces,
  patchSpace,
  type MemoSpaceDeleteMode,
  type MemoSpaceFields,
} from '../../memos/spaces'

function parseSpaceDeleteMode(value: string | undefined): MemoSpaceDeleteMode {
  if (value === undefined || value === '') return 'unfile'
  if (value === 'unfile' || value === 'delete') return value
  throw ApiError.badRequest('mode must be unfile or delete')
}

export const memoSpaceRoutes = new Hono<AppBindings>()

memoSpaceRoutes.use('*', requireMemoUser)

memoSpaceRoutes.get('/', async (c) => {
  const spaces = await listSpaces(c.env.DB, c.get('userId'))
  return c.json({ spaces })
})

memoSpaceRoutes.post('/', async (c) => {
  const body = await readJson<MemoSpaceFields>(c, JSON_BODY_LIMITS.small)
  const space = await createSpace(c.env.DB, c.get('userId'), body)
  return c.json(space, 201)
})

memoSpaceRoutes.patch('/:id', async (c) => {
  const body = await readJson<MemoSpaceFields>(c, JSON_BODY_LIMITS.small)
  const space = await patchSpace(c.env.DB, c.get('userId'), c.req.param('id'), body)
  if (!space) throw ApiError.notFound('Space not found')
  return c.json(space)
})

memoSpaceRoutes.delete('/:id', async (c) => {
  const mode = parseSpaceDeleteMode(c.req.query('mode'))
  const result = await deleteSpace(c.env.DB, c.get('userId'), c.req.param('id'), mode)
  if (!result.deleted) throw ApiError.notFound('Space not found')
  if (result.attachmentObjects.length) scheduleMemoObjectCleanup(c, result.attachmentObjects)
  return c.json({ ok: true })
})
