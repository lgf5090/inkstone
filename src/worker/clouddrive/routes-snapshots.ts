import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { recordActivity } from './activity'
import { createSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot, snapshotView } from './snapshots'

export const clouddriveSnapshotRoutes = new Hono<AppBindings>()

clouddriveSnapshotRoutes.use('/snapshots', requireOwner)
clouddriveSnapshotRoutes.use('/snapshots/*', requireOwner)

clouddriveSnapshotRoutes.get('/snapshots', async (c) => {
  const rows = await listSnapshots(c.env.DB, c.get('userId'))
  return c.json({ snapshots: rows.map(snapshotView) })
})

clouddriveSnapshotRoutes.post('/snapshots', async (c) => {
  const body = await readJson<{ name?: unknown }>(c, 4096)
  const snapshot = await createSnapshot(c.env, c.get('userId'), typeof body.name === 'string' ? body.name : '')
  await recordActivity(c.env.DB, c.get('userId'), { action: 'snapshot_create', targetPath: '/', detail: snapshot.id })
  return c.json({ snapshot: snapshotView(snapshot) }, 201)
})

clouddriveSnapshotRoutes.post('/snapshots/:id/restore', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Snapshot not found')
  const result = await restoreSnapshot(c.env, c.get('userId'), id)
  await recordActivity(c.env.DB, c.get('userId'), {
    action: 'snapshot_restore', targetPath: '/', detail: `${id}:${result.restored}:${result.skipped}`,
  })
  return c.json(result, result.skipped > 0 ? 207 : 200)
})

clouddriveSnapshotRoutes.delete('/snapshots/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Snapshot not found')
  const deleted = await deleteSnapshot(c.env, c.get('userId'), id)
  if (deleted) await recordActivity(c.env.DB, c.get('userId'), { action: 'snapshot_delete', targetPath: '/', detail: id })
  return c.json({ ok: deleted })
})
