/** Snapshot routes: create from the server's own library, list, restore and delete. */
import { Hono } from 'hono'
import {
  createInknoteSnapshot,
  deleteInknoteSnapshot,
  listInknoteSnapshots,
  restoreInknoteSnapshot,
} from '../inknote/snapshots'
import { drainInknoteCleanup } from '../inknote/assets'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readOptionalJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'

export const inknoteSnapshotsRoutes = new Hono<AppBindings>()

inknoteSnapshotsRoutes.use('*', requireAuth)

inknoteSnapshotsRoutes.get('/snapshots', async (c) => {
  const snapshots = await listInknoteSnapshots(c.env.DB, c.get('userId'))
  return c.json({ snapshots })
})

inknoteSnapshotsRoutes.post('/snapshots', async (c) => {
  const body = await readOptionalJson<{ label?: unknown }>(c, JSON_BODY_LIMITS.small, {})
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') {
    throw ApiError.badRequest('label must be a string')
  }
  const snapshot = await createInknoteSnapshot(c.env, c.get('userId'), body.label ?? undefined)
  return c.json(snapshot, 201)
})

inknoteSnapshotsRoutes.post('/snapshots/:id/restore', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Snapshot not found')
  const result = await restoreInknoteSnapshot(c.env, c.get('userId'), id)
  return c.json(result)
})

inknoteSnapshotsRoutes.delete('/snapshots/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Snapshot not found')
  if (!(await deleteInknoteSnapshot(c.env, userId, id))) {
    throw ApiError.notFound('Snapshot not found')
  }
  await drainInknoteCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Snapshot cleanup will retry later:', error)
  })
  return c.json({ ok: true })
})
