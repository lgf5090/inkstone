/**
 * Owner-only maintenance endpoints behind the CloudDrive admin pages.
 *
 * The overview, activity, file table and index page all speak the same rule as the rest of the app:
 * a query names its owner. The optional member-file view is the single deliberate widening, and it
 * only happens when the owner has turned `admin.ownerCanViewMemberFiles` on.
 */
import { Hono, type Context } from 'hono'
import { APP_VERSION } from '@shared/constants'
import {
  CLOUDDRIVE_CATEGORIES,
  CLOUDDRIVE_LIMITS,
  foldedName,
  type CloudDriveCategory,
} from '@shared/clouddrive/model'
import type { AppBindings, Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson, readOptionalJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { externalCapacityBytes } from './external'
import {
  decodeCursor,
  encodeCursor,
  initialsOf,
  parseLimit,
  PRIMARY_MOUNT,
  resolveMount,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from './lib'
import {
  cloudDriveUsage,
  ensurePrimaryMount,
  listMounts,
  readCloudDriveSettings,
} from './store'
import { trashEntries } from './store-files'

export const clouddriveAdminRoutes = new Hono<AppBindings>()

clouddriveAdminRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})
clouddriveAdminRoutes.use('/admin/*', requireOwner)
clouddriveAdminRoutes.use('*', async (c, next) => {
  await ensurePrimaryMount(c.env.DB, c.get('userId'))
  await next()
})

const INDEX_BATCH = 500
const WRITE_BATCH = 90
const DEFAULT_ACTIVITY_DAYS = 7
const MAX_ACTIVITY_DAYS = 90

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function categoryFilter(value: string | undefined): CloudDriveCategory | null {
  return value && (CLOUDDRIVE_CATEGORIES as readonly string[]).includes(value)
    ? value as CloudDriveCategory
    : null
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

async function countValue(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ count: number }>()
  return row?.count ?? 0
}

clouddriveAdminRoutes.get('/admin/overview', async (c) => {
  const userId = userIdOf(c)
  const [fileCounts, shares, keys, storages, usage, mounts, storageTypes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS files,
         SUM(CASE WHEN kind = 'folder' THEN 1 ELSE 0 END) AS folders
       FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NULL`,
    ).bind(userId).first<{ files: number | null; folders: number | null }>(),
    countValue(c.env.DB,
      `SELECT COUNT(*) AS count FROM CloudDrive_shares
        WHERE user_id = ? AND revoked_at IS NULL AND is_enabled = 1
          AND (expires_at IS NULL OR expires_at > ?)`, userId, Date.now()),
    countValue(c.env.DB,
      `SELECT COUNT(*) AS count FROM CloudDrive_api_keys
        WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      userId, Date.now()),
    countValue(c.env.DB, `SELECT COUNT(*) AS count FROM CloudDrive_storages WHERE user_id = ?`, userId),
    cloudDriveUsage(c.env.DB, userId, c.env),
    listMounts(c.env.DB, userId),
    c.env.DB.prepare(
      `SELECT category AS type, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
         FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NULL GROUP BY category ORDER BY category`,
    ).bind(userId).all<{ type: string; bytes: number; count: number }>(),
  ])

  const types = (storageTypes.results ?? []).map((row) => ({ type: row.type, bytes: row.bytes, count: row.count }))
  const settings = await readCloudDriveSettings(c.env.DB, userId)
  return c.json({
    scope: 'owner',
    counts: {
      files: (fileCounts?.files ?? 0) + (fileCounts?.folders ?? 0),
      shares,
      keys,
      storages,
      mounts: mounts.length,
    },
    capacity: {
      usedBytes: usage.usedBytes,
      quotaBytes: usage.quotaBytes,
      trashBytes: usage.trashBytes,
      storages: await Promise.all(mounts.map(async (mount) => ({
        id: mount.id,
        name: mount.name,
        type: mount.storageType,
        // An external mount's used bytes are a full driver walk, which P-03 moved off the request
        // path on purpose; reporting `null` keeps the card honest instead of painting a zero.
        usedBytes: mount.storageId === PRIMARY_MOUNT ? usage.usedBytes : null,
        quotaBytes: mount.storageId === PRIMARY_MOUNT
          ? usage.quotaBytes
          : await externalCapacityBytes(c.env.DB, mount),
      }))),
      types,
    },
    version: APP_VERSION,
    environment: 'Cloudflare Workers',
    database: 'D1',
    updatedAt: Date.now(),
    admin: { ownerCanViewMemberFiles: settings.adminOwnerCanViewMemberFiles },
  })
})

clouddriveAdminRoutes.get('/admin/activity', async (c) => {
  const userId = userIdOf(c)
  const requested = Number(c.req.query('days'))
  const days = Number.isSafeInteger(requested) && requested >= 1 && requested <= MAX_ACTIVITY_DAYS
    ? requested
    : DEFAULT_ACTIVITY_DAYS
  const now = Date.now()
  const startDay = utcDay(now - (days - 1) * 86_400_000)
  const startMs = Date.parse(`${startDay}T00:00:00.000Z`)

  const [uploads, shares] = await Promise.all([
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', uploaded_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
         FROM CloudDrive_files
        WHERE user_id = ? AND kind = 'file' AND uploaded_at >= ?
        GROUP BY day`,
    ).bind(userId, startMs).all<{ day: string; count: number }>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
         FROM CloudDrive_shares
        WHERE user_id = ? AND created_at >= ?
        GROUP BY day`,
    ).bind(userId, startMs).all<{ day: string; count: number }>(),
  ])
  const uploadMap = new Map((uploads.results ?? []).map((row) => [row.day, row.count]))
  const shareMap = new Map((shares.results ?? []).map((row) => [row.day, row.count]))
  const timeline = Array.from({ length: days }, (_, index) => {
    const date = utcDay(startMs + index * 86_400_000)
    return {
      date,
      uploads: uploadMap.get(date) ?? 0,
      shares: shareMap.get(date) ?? 0,
    }
  })
  return c.json({ scope: 'owner', days: timeline })
})

interface AdminFileRow extends CloudDriveFileRow {
  creator_username: string | null
  creator_name: string | null
}

async function adminFileRows(
  db: D1Database,
  userId: string,
  ids: readonly string[],
  canViewMemberFiles: boolean,
): Promise<AdminFileRow[]> {
  const rows: AdminFileRow[] = []
  for (let offset = 0; offset < ids.length; offset += WRITE_BATCH) {
    const chunk = ids.slice(offset, offset + WRITE_BATCH)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const scope = canViewMemberFiles ? '' : ' AND f.user_id = ?'
    const params: unknown[] = [...chunk]
    if (!canViewMemberFiles) params.push(userId)
    const { results } = await db.prepare(
      `SELECT f.*, u.username AS creator_username, u.name AS creator_name
         FROM CloudDrive_files f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.id IN (${placeholders})${scope}`,
    ).bind(...params).all<AdminFileRow>()
    rows.push(...(results ?? []))
  }
  return rows
}

function adminFileView(row: AdminFileRow) {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    mountId: row.mount_id,
    category: row.category,
    mime: row.mime,
    size: row.size,
    storageKind: row.storage_kind,
    storage: row.storage_kind === 'r2' ? 'Cloud Drive' : row.storage_kind,
    remainingViews: null,
    uploadedAt: row.uploaded_at,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: {
      id: row.user_id,
      username: row.creator_username ?? '',
      name: row.creator_name ?? row.creator_username ?? row.user_id,
    },
  }
}

clouddriveAdminRoutes.get('/admin/files', async (c) => {
  const userId = userIdOf(c)
  const settings = await readCloudDriveSettings(c.env.DB, userId)
  const canViewMemberFiles = settings.adminOwnerCanViewMemberFiles
  const clauses = ['f.deleted_at IS NULL']
  const params: unknown[] = []

  const creator = c.req.query('creator')?.trim() ?? ''
  if (!canViewMemberFiles) {
    // The toggle is off: the table is the owner's own drive even if a creator filter was sent.
    if (creator && creator !== userId) {
      return c.json({ files: [], cursor: null, total: 0, canViewMemberFiles })
    }
    clauses.push('f.user_id = ?')
    params.push(userId)
  } else if (creator) {
    clauses.push('f.user_id = ?')
    params.push(creator)
  }

  const query = c.req.query('q')?.trim() ?? ''
  if (query.length > 0) {
    if (query.length > 100) throw ApiError.badRequest('q is too long')
    clauses.push("f.name_folded LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(foldedName(query))}%`)
  }
  const category = categoryFilter(c.req.query('type'))
  if (category) {
    clauses.push('f.category = ?')
    params.push(category)
  }
  const storage = c.req.query('storage')?.trim() ?? ''
  if (storage === 'primary' || storage === 'r2') {
    clauses.push("f.storage_kind = 'r2'")
  } else if (storage) {
    clauses.push(
      'EXISTS (SELECT 1 FROM CloudDrive_mounts m WHERE m.user_id = f.user_id AND m.id = f.mount_id AND m.storage_id = ?)',
    )
    params.push(storage)
  }

  const baseWhere = clauses.join(' AND ')
  const limit = parseLimit(c.req.query('limit'))
  const pageParams = [...params]
  const cursorParam = c.req.query('cursor')
  if (cursorParam) {
    const decoded = decodeCursor(cursorParam, 'uploaded')
    if (typeof decoded.v !== 'number') throw ApiError.badRequest('The cursor is invalid')
    clauses.push('(f.uploaded_at < ? OR (f.uploaded_at = ? AND f.id < ?))')
    pageParams.push(decoded.v, decoded.v, decoded.id)
  }

  const [rowsResult, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.*, u.username AS creator_username, u.name AS creator_name
         FROM CloudDrive_files f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY f.uploaded_at DESC, f.id DESC
        LIMIT ?`,
    ).bind(...pageParams, limit).all<AdminFileRow>(),
    countValue(c.env.DB,
      `SELECT COUNT(*) AS count FROM CloudDrive_files f WHERE ${baseWhere}`, ...params),
  ])
  const rows = rowsResult.results ?? []
  const last = rows[rows.length - 1]
  const cursor = last && rows.length === limit
    ? encodeCursor('uploaded', last.uploaded_at, last.id)
    : null
  return c.json({
    files: rows.map(adminFileView),
    cursor,
    total: count > 10_000 ? null : count,
    canViewMemberFiles,
    ownerCanViewMemberFiles: canViewMemberFiles,
  })
})

clouddriveAdminRoutes.post('/admin/files/delete', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ ids?: unknown; onlyRecord?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw ApiError.badRequest('ids must name at least one file')
  }
  if (body.ids.length > CLOUDDRIVE_LIMITS.batchMax) {
    throw ApiError.badRequest(`ids holds at most ${CLOUDDRIVE_LIMITS.batchMax} entries`)
  }
  const ids = new Set<string>()
  for (const id of body.ids) {
    if (typeof id !== 'string' || !isValidId(id)) throw ApiError.badRequest('ids contains an invalid id')
    ids.add(id)
  }
  const onlyRecord = body.onlyRecord === true
  const settings = await readCloudDriveSettings(c.env.DB, userId)
  const canViewMemberFiles = settings.adminOwnerCanViewMemberFiles
  const rows = await adminFileRows(c.env.DB, userId, [...ids], canViewMemberFiles)
  if (rows.length === 0) {
    return c.json({ deleted: 0, onlyRecord, notFound: ids.size })
  }

  if (onlyRecord) {
    const byUser = new Map<string, string[]>()
    for (const row of rows) {
      const list = byUser.get(row.user_id) ?? []
      list.push(row.id)
      byUser.set(row.user_id, list)
    }
    const now = Date.now()
    const statements: D1PreparedStatement[] = []
    for (const [ownerId, fileIds] of byUser) {
      for (let offset = 0; offset < fileIds.length; offset += WRITE_BATCH) {
        const chunk = fileIds.slice(offset, offset + WRITE_BATCH)
        const placeholders = chunk.map(() => '?').join(', ')
        statements.push(c.env.DB.prepare(
          `DELETE FROM CloudDrive_file_tags WHERE user_id = ? AND file_id IN (${placeholders})`,
        ).bind(ownerId, ...chunk))
        statements.push(c.env.DB.prepare(
          `UPDATE CloudDrive_shares SET revoked_at = ?
            WHERE user_id = ? AND revoked_at IS NULL AND file_id IN (${placeholders})`,
        ).bind(now, ownerId, ...chunk))
        statements.push(c.env.DB.prepare(
          `DELETE FROM CloudDrive_file_parts WHERE user_id = ? AND file_id IN (${placeholders})`,
        ).bind(ownerId, ...chunk))
        statements.push(c.env.DB.prepare(
          `DELETE FROM CloudDrive_files WHERE user_id = ? AND id IN (${placeholders})`,
        ).bind(ownerId, ...chunk))
      }
    }
    for (let offset = 0; offset < statements.length; offset += WRITE_BATCH) {
      await c.env.DB.batch(statements.slice(offset, offset + WRITE_BATCH))
    }
    // The object keys are deliberately left in R2; the orphan scan is the documented cleanup path.
    return c.json({ deleted: rows.length, onlyRecord, notFound: ids.size - rows.length })
  }

  const byMount = new Map<string, { userId: string; mountId: string; ids: string[] }>()
  for (const row of rows) {
    const key = `${row.user_id}\u0000${row.mount_id}`
    const group = byMount.get(key) ?? { userId: row.user_id, mountId: row.mount_id, ids: [] }
    group.ids.push(row.id)
    byMount.set(key, group)
  }
  const now = Date.now()
  let deleted = 0
  for (const group of byMount.values()) {
    deleted += await trashEntries(c.env.DB, group.userId, group.mountId, group.ids, now)
  }
  return c.json({ deleted, onlyRecord, notFound: ids.size - rows.length })
})

interface IndexStateRow {
  mount_id: string
  last_indexed_at: number | null
  status: string
  error: string | null
  updated_at: number
}

async function indexStates(db: D1Database, userId: string): Promise<Map<string, IndexStateRow>> {
  const { results } = await db.prepare(
    `SELECT mount_id, last_indexed_at, status, error, updated_at
       FROM CloudDrive_index_state WHERE user_id = ?`,
  ).bind(userId).all<IndexStateRow>()
  return new Map((results ?? []).map((row) => [row.mount_id, row]))
}

async function indexCounts(
  db: D1Database,
  userId: string,
  mountId: string,
  lastIndexedAt: number,
): Promise<{ pending: number; indexed: number }> {
  const row = await db.prepare(
    `SELECT
       SUM(CASE WHEN updated_at > ? OR name_initials = '' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN name_initials <> '' THEN 1 ELSE 0 END) AS indexed
     FROM CloudDrive_files
     WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL`,
  ).bind(lastIndexedAt, userId, mountId).first<{ pending: number | null; indexed: number | null }>()
  return { pending: row?.pending ?? 0, indexed: row?.indexed ?? 0 }
}

clouddriveAdminRoutes.get('/admin/index', async (c) => {
  const userId = userIdOf(c)
  const [mounts, states] = await Promise.all([
    listMounts(c.env.DB, userId),
    indexStates(c.env.DB, userId),
  ])
  let totalPending = 0
  let totalIndexed = 0
  const view = []
  for (const mount of mounts) {
    const state = states.get(mount.id)
    const external = mount.storageId !== 'primary'
    const lastIndexedAt = state?.last_indexed_at ?? null
    const counts = external
      ? { pending: 0, indexed: 0 }
      : await indexCounts(c.env.DB, userId, mount.id, lastIndexedAt ?? 0)
    totalPending += counts.pending
    totalIndexed += counts.indexed
    view.push({
      mountId: mount.id,
      name: mount.name,
      mountPath: mount.mountPath,
      storageType: mount.storageType,
      external,
      pending: counts.pending,
      indexed: counts.indexed,
      lastIndexedAt,
      status: state?.status ?? 'idle',
      error: state?.error ?? null,
      updatedAt: state?.updated_at ?? null,
    })
  }
  return c.json({
    mounts: view.map((mount) => ({
      mountId: mount.mountId,
      mountName: mount.name,
      mountPath: mount.mountPath,
      external: mount.external,
      status: mount.status,
      pending: mount.pending,
      lastIndexedAt: mount.lastIndexedAt,
      lastError: mount.error,
    })),
    pending: totalPending,
    lastIndexedAt: view.reduce<number | null>((latest, mount) => mount.lastIndexedAt && (!latest || mount.lastIndexedAt > latest) ? mount.lastIndexedAt : latest, null),
    generatedAt: Date.now(),
  })
})

async function mountForIndex(c: Context<AppBindings>, body: { mountId?: unknown }): Promise<CloudDriveMountInfo> {
  const mountId = typeof body.mountId === 'string' && body.mountId.length > 0
    ? body.mountId
    : 'primary'
  const mount = await resolveMount(c.env.DB, userIdOf(c), mountId)
  if (mount.storageId !== 'primary') {
    throw ApiError.badRequest('External mounts are not indexed')
  }
  return mount
}

async function markIndexSucceeded(
  db: D1Database,
  userId: string,
  mountId: string,
  now: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO CloudDrive_index_state (user_id, mount_id, last_indexed_at, status, error, updated_at)
     VALUES (?, ?, ?, 'idle', NULL, ?)
     ON CONFLICT(user_id, mount_id)
     DO UPDATE SET last_indexed_at = excluded.last_indexed_at, status = 'idle', error = NULL,
                   updated_at = excluded.updated_at`,
  ).bind(userId, mountId, now, now).run()
}

/**
 * A resumable index task. The row carries the last id it wrote, so an isolate that runs out of time
 * or memory hands the rest of the tree to the next call instead of starting over.
 */
interface IndexTaskRow {
  id: string
  user_id: string
  status: string
  payload: string
  progress: string
}

const INDEX_TIME_BUDGET_MS = 6_000
const INDEX_LOCK_MS = 90_000

function indexTaskCursor(progress: string): { cursor: string; done: number } {
  try {
    const value = JSON.parse(progress) as { cursor?: unknown; done?: unknown }
    return {
      cursor: typeof value.cursor === 'string' ? value.cursor : '',
      done: typeof value.done === 'number' && Number.isFinite(value.done) ? value.done : 0,
    }
  } catch {
    return { cursor: '', done: 0 }
  }
}

/** One batch of initials, starting after the cursor. Returns the new cursor and how many it wrote. */
async function indexStep(
  db: D1Database,
  userId: string,
  mountId: string,
  rebuild: boolean,
  lastIndexedAt: number,
  afterId: string,
): Promise<{ rows: number; cursor: string; updated: number }> {
  const clauses = ['user_id = ?', 'mount_id = ?', 'deleted_at IS NULL', 'id > ?']
  const params: unknown[] = [userId, mountId, afterId]
  if (!rebuild) {
    clauses.push("(updated_at > ? OR name_initials = '')")
    params.push(lastIndexedAt)
  }
  const { results } = await db.prepare(
    `SELECT id, name FROM CloudDrive_files
      WHERE ${clauses.join(' AND ')}
      ORDER BY id
      LIMIT ${INDEX_BATCH}`,
  ).bind(...params).all<{ id: string; name: string }>()
  const rows = results ?? []
  const statements = rows.map((row) => db.prepare(
    `UPDATE CloudDrive_files SET name_folded = ?, name_initials = ?
      WHERE user_id = ? AND mount_id = ? AND id = ?`,
  ).bind(foldedName(row.name), initialsOf(row.name), userId, mountId, row.id))
  for (let offset = 0; offset < statements.length; offset += WRITE_BATCH) {
    await db.batch(statements.slice(offset, offset + WRITE_BATCH))
  }
  return { rows: rows.length, cursor: rows.length > 0 ? rows[rows.length - 1]!.id : afterId, updated: rows.length }
}

/**
 * Works the queued reindex tasks of one account until the time budget runs out, then leaves the rest
 * to the next call. The cron sweep runs the same function, so a rebuild survives a closed tab, a
 * redeploy, or an isolate that is killed mid-run.
 */
async function runIndexTask(env: Env, task: IndexTaskRow, now: number): Promise<'completed' | 'handed-off' | 'cancelled'> {
  const payload = safeParse(task.payload)
  const mountId = typeof payload.mountId === 'string' ? payload.mountId : 'primary'
  const rebuild = payload.mode !== 'incremental'
  const state = await env.DB.prepare(
    `SELECT last_indexed_at FROM CloudDrive_index_state WHERE user_id = ? AND mount_id = ?`,
  ).bind(task.user_id, mountId).first<{ last_indexed_at: number | null }>()
  const lastIndexedAt = state?.last_indexed_at ?? 0
  const started = now
  let { cursor, done } = indexTaskCursor(task.progress)

  for (;;) {
    const fresh = await env.DB.prepare(
      `SELECT status FROM CloudDrive_tasks WHERE user_id = ? AND id = ?`,
    ).bind(task.user_id, task.id).first<{ status: string }>()
    // The reader may have cancelled while a batch was in flight; the next step must not resume it.
    if (!fresh || fresh.status === 'cancelled') return 'cancelled'

    const step = await indexStep(env.DB, task.user_id, mountId, rebuild, lastIndexedAt, cursor)
    cursor = step.cursor
    done += step.updated
    const finished = step.rows < INDEX_BATCH
    await env.DB.prepare(
      `UPDATE CloudDrive_tasks
          SET status = ?, progress = ?, error = NULL, locked_until = ?, finished_at = ?, updated_at = ?
        WHERE user_id = ? AND id = ?`,
    ).bind(
      finished ? 'completed' : 'running',
      JSON.stringify({ cursor: finished ? '' : cursor, done, failed: 0 }),
      finished ? null : now + INDEX_LOCK_MS,
      finished ? Date.now() : null,
      Date.now(),
      task.user_id, task.id,
    ).run()
    if (finished) {
      await markIndexSucceeded(env.DB, task.user_id, mountId, Date.now())
      return 'completed'
    }
    if (Date.now() - started > INDEX_TIME_BUDGET_MS) return 'handed-off'
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * The cron's share of the work: pick up any reindex task that is queued, or running with an expired
 * lock (the isolate that held it is gone), and take it as far as the budget allows.
 */
export async function resumeCloudDriveIndexTasks(env: Env, now = Date.now(), limit = 4): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, status, payload, progress FROM CloudDrive_tasks
      WHERE type = 'reindex'
        AND (status = 'queued' OR (status = 'running' AND (locked_until IS NULL OR locked_until < ?)))
      ORDER BY created_at
      LIMIT ?`,
  ).bind(now, Math.max(1, Math.min(20, limit))).all<IndexTaskRow>()
  let resumed = 0
  for (const task of results ?? []) {
    try {
      await runIndexTask(env, task, now)
      resumed++
    } catch (error) {
      console.warn('[clouddrive] a reindex task could not continue:', task.id, error)
      await env.DB.prepare(
        `UPDATE CloudDrive_tasks SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
          WHERE user_id = ? AND id = ?`,
      ).bind(error instanceof Error ? error.message.slice(0, 500) : 'unknown', Date.now(), Date.now(), task.user_id, task.id).run()
    }
  }
  return resumed
}

for (const mode of ['rebuild', 'incremental'] as const) {
  clouddriveAdminRoutes.post(`/admin/index/${mode}`, async (c) => {
    const userId = userIdOf(c)
    const body = await readOptionalJson<{ mountId?: unknown }>(c, JSON_BODY_LIMITS.small, {})
    const mount = await mountForIndex(c, body)
    const now = Date.now()
    const running = await c.env.DB.prepare(
      `SELECT id FROM CloudDrive_tasks
        WHERE user_id = ? AND type = 'reindex' AND status IN ('queued', 'running')
          AND (locked_until IS NULL OR locked_until > ?)`,
    ).bind(userId, now).first<{ id: string }>()
    if (running) throw ApiError.conflict('An index task is already running')

    const taskId = newId()
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_tasks
         (id, user_id, type, status, payload, progress, error, locked_until,
          created_at, started_at, finished_at, updated_at)
       VALUES (?, ?, 'reindex', 'queued', ?, '{"cursor":"","done":0}', NULL, NULL, ?, NULL, NULL, ?)`,
    ).bind(taskId, userId, JSON.stringify({ mountId: mount.id, mode }), now, now).run()
    await c.env.DB.prepare(
      `INSERT INTO CloudDrive_index_state (user_id, mount_id, last_indexed_at, status, error, updated_at)
       VALUES (?, ?, 0, 'running', NULL, ?)
       ON CONFLICT(user_id, mount_id)
       DO UPDATE SET status = 'running', error = NULL, updated_at = excluded.updated_at`,
    ).bind(userId, mount.id, now).run()

    const task: IndexTaskRow = { id: taskId, user_id: userId, status: 'queued', payload: JSON.stringify({ mountId: mount.id, mode }), progress: '{"cursor":"","done":0}' }
    // Start it now and let the request finish; whatever the time budget does not cover, the cron
    // sweep picks up on the next tick.
    c.executionCtx.waitUntil(runIndexTask(c.env, task, now).catch((error) => {
      console.warn('[clouddrive] the started reindex task failed:', taskId, error)
    }))
    return c.json({ mountId: mount.id, taskId, started: true }, 202)
  })
}

clouddriveAdminRoutes.post('/admin/index/clear', async (c) => {
  const userId = userIdOf(c)
  const body = await readOptionalJson<{ mountId?: unknown }>(c, JSON_BODY_LIMITS.small, {})
  const mount = await mountForIndex(c, body)
  const result = await c.env.DB.prepare(
    `UPDATE CloudDrive_files SET name_initials = ''
      WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL AND name_initials <> ''`,
  ).bind(userId, mount.id).run()
  const now = Date.now()
  // Only the pinyin index is dropped; `name_folded` still backs search, sorting and uniqueness.
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_index_state (user_id, mount_id, last_indexed_at, status, error, updated_at)
     VALUES (?, ?, NULL, 'idle', NULL, ?)
     ON CONFLICT(user_id, mount_id)
     DO UPDATE SET status = 'idle', error = NULL, updated_at = excluded.updated_at`,
  ).bind(userId, mount.id, now).run()
  return c.json({ mountId: mount.id, cleared: result.meta.changes ?? 0 })
})
