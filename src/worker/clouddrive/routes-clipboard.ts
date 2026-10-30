import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { parsePath, resolveMount } from './lib'

export const clouddriveClipboardRoutes = new Hono<AppBindings>()

clouddriveClipboardRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const MAX_IDS = 200
const WRITE_BATCH = 90

interface ClipboardRow {
  mode: string
  mount_id: string
  source_path: string
  ids: string
  updated_at: number
}

interface ClipboardView {
  mode: 'copy' | 'cut'
  mountId: string
  sourcePath: string
  ids: string[]
  updatedAt: number
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw ApiError.badRequest('ids must name at least one entry')
  if (value.length > MAX_IDS) throw ApiError.badRequest(`ids holds at most ${MAX_IDS} entries`)
  const ids = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || !isValidId(id)) throw ApiError.badRequest('ids contains an invalid id')
    ids.add(id)
  }
  return [...ids]
}

async function existingIds(db: D1Database, userId: string, mountId: string, ids: readonly string[]): Promise<number> {
  let found = 0
  for (let offset = 0; offset < ids.length; offset += WRITE_BATCH) {
    const chunk = ids.slice(offset, offset + WRITE_BATCH)
    const placeholders = chunk.map(() => '?').join(', ')
    const row = await db.prepare(
      `SELECT COUNT(*) AS count FROM CloudDrive_files
        WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    ).bind(userId, mountId, ...chunk).first<{ count: number }>()
    found += row?.count ?? 0
  }
  return found
}

function toView(row: ClipboardRow): ClipboardView | null {
  let ids: unknown
  try {
    ids = JSON.parse(row.ids)
  } catch {
    return null
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return null
  return {
    mode: row.mode === 'cut' ? 'cut' : 'copy',
    mountId: row.mount_id,
    sourcePath: row.source_path,
    ids: ids as string[],
    updatedAt: row.updated_at,
  }
}

clouddriveClipboardRoutes.get('/clipboard', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT mode, mount_id, source_path, ids, updated_at
       FROM CloudDrive_clipboard WHERE user_id = ?`,
  ).bind(userIdOf(c)).first<ClipboardRow>()
  return c.json({ clipboard: row ? toView(row) : null })
})

clouddriveClipboardRoutes.put('/clipboard', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mode?: unknown; mountId?: unknown; ids?: unknown; sourcePath?: unknown }>(
    c,
    JSON_BODY_LIMITS.small,
  )
  const mode = body.mode === 'cut' ? 'cut' : body.mode === 'copy' ? 'copy' : null
  if (!mode) throw ApiError.badRequest('mode must be copy or cut')
  const mountId = typeof body.mountId === 'string' && body.mountId.length > 0 ? body.mountId : 'primary'
  const mount = await resolveMount(c.env.DB, userId, mountId)
  if (mount.storageId !== 'primary') {
    throw ApiError.badRequest('External mounts are read only and cannot be placed on the clipboard')
  }
  const ids = readIds(body.ids)
  if (await existingIds(c.env.DB, userId, mount.id, ids) !== ids.length) {
    throw ApiError.notFound('One or more entries no longer exist')
  }
  const sourcePath = parsePath(body.sourcePath ?? '/')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_clipboard (user_id, mode, mount_id, source_path, ids, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       mode = excluded.mode, mount_id = excluded.mount_id, source_path = excluded.source_path,
       ids = excluded.ids, updated_at = excluded.updated_at`,
  ).bind(userId, mode, mount.id, sourcePath, JSON.stringify(ids), now).run()
  return c.json({
    clipboard: { mode, mountId: mount.id, sourcePath, ids, updatedAt: now } satisfies ClipboardView,
  })
})

clouddriveClipboardRoutes.delete('/clipboard', async (c) => {
  await c.env.DB.prepare(`DELETE FROM CloudDrive_clipboard WHERE user_id = ?`).bind(userIdOf(c)).run()
  return c.json({ ok: true })
})
