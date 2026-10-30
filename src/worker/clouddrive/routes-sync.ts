import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import { parsePath, resolveMount } from './lib'

export const clouddriveSyncRoutes = new Hono<AppBindings>()

clouddriveSyncRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 16 * 1024
const REMOTE_INDEX_MAX = 20_000

interface SyncTargetRow {
  id: string
  name: string
  local_label: string
  mount_id: string
  remote_path: string
  enabled: number
  last_sync_at: number | null
  last_status: string | null
  last_error: string | null
  last_file_count: number
  last_bytes: number
  created_at: number
  updated_at: number
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function toView(row: SyncTargetRow) {
  return {
    id: row.id,
    name: row.name,
    localLabel: row.local_label,
    mountId: row.mount_id,
    remotePath: row.remote_path,
    enabled: row.enabled === 1,
    lastSyncAt: row.last_sync_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastFileCount: row.last_file_count,
    lastBytes: row.last_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function targetById(c: Context<AppBindings>, id: string): Promise<SyncTargetRow | null> {
  if (!isValidId(id)) return null
  return await c.env.DB.prepare(
    `SELECT id, name, local_label, mount_id, remote_path, enabled, last_sync_at, last_status,
            last_error, last_file_count, last_bytes, created_at, updated_at
       FROM CloudDrive_sync_targets WHERE user_id = ? AND id = ?`,
  ).bind(userIdOf(c), id).first<SyncTargetRow>()
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().slice(0, 64) : ''
  if (!name) throw ApiError.badRequest('A target name is required')
  return name
}

function cleanLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

async function primaryMount(c: Context<AppBindings>, mountId: string): Promise<string> {
  const mount = await resolveMount(c.env.DB, userIdOf(c), mountId || 'primary')
  if (mount.storageId !== 'primary') throw ApiError.badRequest('Sync targets must live on the primary mount')
  return mount.id
}

clouddriveSyncRoutes.get('/sync/targets', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, local_label, mount_id, remote_path, enabled, last_sync_at, last_status,
            last_error, last_file_count, last_bytes, created_at, updated_at
       FROM CloudDrive_sync_targets WHERE user_id = ? ORDER BY created_at`,
  ).bind(userIdOf(c)).all<SyncTargetRow>()
  return c.json({ targets: (results ?? []).map(toView) })
})

clouddriveSyncRoutes.post('/sync/targets', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ name?: unknown; localLabel?: unknown; mountId?: unknown; remotePath?: unknown }>(c, BODY_LIMIT)
  const name = cleanName(body.name)
  const mountId = await primaryMount(c, typeof body.mountId === 'string' ? body.mountId : 'primary')
  const remotePath = parsePath(body.remotePath ?? '/')
  const now = Date.now()
  const id = newId()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_sync_targets
       (user_id, id, name, local_label, mount_id, remote_path, enabled, last_sync_at, last_status,
        last_error, last_file_count, last_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 0, 0, ?, ?)`,
  ).bind(userId, id, name, cleanLabel(body.localLabel), mountId, remotePath, now, now).run()
  const row = await targetById(c, id)
  return c.json({ target: toView(row!) }, 201)
})

clouddriveSyncRoutes.patch('/sync/targets/:id', async (c) => {
  const row = await targetById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Sync target not found')
  const body = await readJson<{ name?: unknown; localLabel?: unknown; remotePath?: unknown; enabled?: unknown }>(c, BODY_LIMIT)
  const sets: string[] = []
  const values: unknown[] = []
  const put = (sql: string, value: unknown) => { sets.push(sql); values.push(value) }
  if (body.name !== undefined) put('name = ?', cleanName(body.name))
  if (body.localLabel !== undefined) put('local_label = ?', cleanLabel(body.localLabel))
  if (body.remotePath !== undefined) put('remote_path = ?', parsePath(body.remotePath))
  if (body.enabled !== undefined) put('enabled = ?', body.enabled ? 1 : 0)
  if (!sets.length) return c.json({ target: toView(row) })
  values.push(Date.now(), userIdOf(c), row.id)
  await c.env.DB.prepare(
    `UPDATE CloudDrive_sync_targets SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ? AND id = ?`,
  ).bind(...values).run()
  return c.json({ target: toView((await targetById(c, row.id))!) })
})

clouddriveSyncRoutes.delete('/sync/targets/:id', async (c) => {
  const row = await targetById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Sync target not found')
  await c.env.DB.prepare(`DELETE FROM CloudDrive_sync_targets WHERE user_id = ? AND id = ?`)
    .bind(userIdOf(c), row.id).run()
  return c.json({ ok: true })
})

clouddriveSyncRoutes.get('/sync/remote', async (c) => {
  const userId = userIdOf(c)
  const mountId = await primaryMount(c, c.req.query('mount') || 'primary')
  const base = parsePath(c.req.query('path') || '/')
  const rows = base === '/'
    ? await c.env.DB.prepare(
      `SELECT path, kind, size, modified_at FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
        ORDER BY path LIMIT ?`,
    ).bind(userId, mountId, REMOTE_INDEX_MAX + 1).all<{ path: string; kind: string; size: number; modified_at: number }>()
    : await c.env.DB.prepare(
      `SELECT path, kind, size, modified_at FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
          AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
        ORDER BY path LIMIT ?`,
    ).bind(userId, mountId, base, base, base, REMOTE_INDEX_MAX + 1).all<{ path: string; kind: string; size: number; modified_at: number }>()
  const entries = (rows.results ?? []).slice(0, REMOTE_INDEX_MAX)
  const relative = (path: string) => base === '/' ? path.slice(1) : path.slice(base.length).replace(/^\//, '')
  return c.json({
    base,
    truncated: (rows.results ?? []).length > REMOTE_INDEX_MAX,
    entries: entries.flatMap((row) => {
      const path = relative(row.path)
      return path ? [{ path, kind: row.kind, size: row.size, modifiedAt: row.modified_at }] : []
    }),
  })
})

clouddriveSyncRoutes.post('/sync/targets/:id/report', async (c) => {
  const row = await targetById(c, c.req.param('id'))
  if (!row) throw ApiError.notFound('Sync target not found')
  const body = await readJson<{ status?: unknown; files?: unknown; bytes?: unknown; error?: unknown }>(c, BODY_LIMIT)
  const status = body.status === 'success' ? 'success' : body.status === 'error' ? 'error' : null
  if (!status) throw ApiError.badRequest('status must be success or error')
  const files = Number(body.files)
  const bytes = Number(body.bytes)
  if (!Number.isSafeInteger(files) || files < 0 || files > 1_000_000) throw ApiError.badRequest('files is invalid')
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1_000_000_000_000) throw ApiError.badRequest('bytes is invalid')
  const error = status === 'error' && typeof body.error === 'string' ? body.error.slice(0, 500) : null
  const now = Date.now()
  await c.env.DB.prepare(
    `UPDATE CloudDrive_sync_targets
        SET last_sync_at = ?, last_status = ?, last_error = ?, last_file_count = ?, last_bytes = ?, updated_at = ?
      WHERE user_id = ? AND id = ?`,
  ).bind(now, status, error, files, bytes, now, userIdOf(c), row.id).run()
  return c.json({ target: toView((await targetById(c, row.id))!) })
})
