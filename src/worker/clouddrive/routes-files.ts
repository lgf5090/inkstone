/**
 * The authenticated CloudDrive file API.
 *
 * Every route resolves the mount and the entry through `lib.ts`, validates its inputs, and asks
 * `store-files.ts` for rows. Errors are `ApiError`s, so the app-level handler answers with the same
 * envelope as the rest of the product.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { CloudDriveEntry, CloudDriveListing } from '@shared/clouddrive/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { listExternal } from './external'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  assertWritable,
  buildEntry,
  parseDir,
  parseFlag,
  parseLimit,
  parseName,
  parsePath,
  parseSort,
  parseTimestamp,
  resolveEntry,
  resolveMount,
  tagsForFiles,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from './lib'
import {
  albumEntries,
  copyEntries,
  createFolder,
  getFileById,
  listFolder,
  listTags,
  listTrash,
  moveEntries,
  purgeAllTrash,
  purgeTrashEntries,
  recentEntries,
  removeTag,
  renameEntry,
  restoreEntries,
  searchEntries,
  setEntryFlags,
  tagsOf,
  trashEntries,
  upsertTag,
  type TransferResult,
} from './store-files'

export const cloudDriveFilesRoutes = new Hono<AppBindings>()

cloudDriveFilesRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const BODY_LIMIT = 64 * 1024
const MAX_BATCH = 200

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function mountIdOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'primary'
}

async function mountFor(c: Context<AppBindings>, userId: string, mountId: string): Promise<CloudDriveMountInfo> {
  return await resolveMount(c.env.DB, userId, mountId)
}

async function entriesOf(
  db: D1Database,
  userId: string,
  mount: CloudDriveMountInfo,
  rows: readonly CloudDriveFileRow[],
): Promise<CloudDriveEntry[]> {
  const tags = await tagsForFiles(db, userId, rows.map((row) => row.id))
  return rows.map((row) => buildEntry(row, mount, tags.get(row.id) ?? []))
}

async function entryOf(
  db: D1Database,
  userId: string,
  mount: CloudDriveMountInfo,
  row: CloudDriveFileRow,
): Promise<CloudDriveEntry> {
  return buildEntry(row, mount, await tagsOf(db, userId, row.id))
}

function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of ids`)
  if (value.length > MAX_BATCH) throw ApiError.badRequest(`${field} holds at most ${MAX_BATCH} ids`)
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !isValidId(item)) throw ApiError.badRequest(`${field} contains an invalid id`)
    ids.add(item)
  }
  if (ids.size === 0) throw ApiError.badRequest(`${field} must name at least one entry`)
  return [...ids]
}

async function resolveIdList(
  db: D1Database,
  userId: string,
  mountId: string,
  body: { ids?: unknown; paths?: unknown },
): Promise<string[]> {
  if (body.ids !== undefined) return parseIdList(body.ids, 'ids')
  if (body.paths === undefined) throw ApiError.badRequest('ids or paths is required')
  if (!Array.isArray(body.paths)) throw ApiError.badRequest('paths must be an array of paths')
  if (body.paths.length > MAX_BATCH) throw ApiError.badRequest(`paths holds at most ${MAX_BATCH} paths`)
  const ids: string[] = []
  for (const item of body.paths) {
    const path = parsePath(item)
    const row = await resolveEntry(db, userId, mountId, path)
    ids.push(row.id)
  }
  if (ids.length === 0) throw ApiError.badRequest('paths must name at least one entry')
  return [...new Set(ids)]
}

function parseConflict(value: unknown): { mode: 'rename' | 'overwrite' | 'skip' } {
  if (value === undefined || value === 'rename') return { mode: 'rename' }
  if (value === 'overwrite' || value === 'skip') return { mode: value }
  throw ApiError.badRequest('conflict must be rename, overwrite or skip')
}

function transferResponse(c: { json: (body: unknown, status?: number) => Response }, results: TransferResult[]): Response {
  const partial = results.some((result) => !result.ok)
  return c.json({ results }, partial ? 207 : 200)
}

cloudDriveFilesRoutes.get('/files', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const path = parsePath(c.req.query('path') ?? '/')
  if (mount.storageId !== 'primary') {
    return c.json(await listExternal(c.env, c.env.DB, mount, path))
  }
  const parent = await resolveEntry(c.env.DB, userId, mount.id, path)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The path is not a folder')

  const sort = parseSort(c.req.query('sort'))
  const dir = parseDir(c.req.query('dir'))
  const result = await listFolder(c.env.DB, userId, mount.id, parent.id, {
    sort,
    dir,
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit')),
    q: c.req.query('q') || undefined,
    type: c.req.query('type') || undefined,
    starred: parseFlag(c.req.query('starred')),
    tag: c.req.query('tag') || undefined,
    color: c.req.query('color') || undefined,
    from: parseTimestamp(c.req.query('from')),
    to: parseTimestamp(c.req.query('to')),
  })
  const [folders, files] = await Promise.all([
    entriesOf(c.env.DB, userId, mount, result.folders),
    entriesOf(c.env.DB, userId, mount, result.files),
  ])
  const body: CloudDriveListing = {
    mountId: mount.id,
    path: parent.path,
    folders,
    files,
    cursor: result.cursor,
    total: result.total,
    foldersTruncated: result.foldersTruncated,
  }
  return c.json(body)
})

cloudDriveFilesRoutes.get('/files/:id', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  const mount = await mountFor(c, userId, row.mount_id)
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, row) })
})

cloudDriveFilesRoutes.post('/folders', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; parentPath?: unknown; name?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const parentPath = parsePath(body.parentPath ?? '/')
  const parent = await resolveEntry(c.env.DB, userId, mount.id, parentPath)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The parent path is not a folder')
  const name = parseName(body.name)

  const created = await createFolder(c.env.DB, userId, mount.id, parent, name, Date.now())
  if (!created.entry) {
    throw ApiError.conflict('A file with this name already exists', { suggestedName: created.conflict })
  }
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, created.entry) }, 201)
})

cloudDriveFilesRoutes.patch('/files/:id', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const body = await readJson<{ name?: unknown; starred?: unknown; color?: unknown }>(c, BODY_LIMIT)
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  const mount = await mountFor(c, userId, row.mount_id)
  assertWritable(mount)

  if (body.name !== undefined && typeof body.name !== 'string') throw ApiError.badRequest('name must be a string')
  if (body.starred !== undefined && typeof body.starred !== 'boolean') {
    throw ApiError.badRequest('starred must be a boolean')
  }
  if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
    throw ApiError.badRequest('color must be a string or null')
  }

  const now = Date.now()
  let current = row
  if (body.name !== undefined) {
    const renamed = await renameEntry(c.env.DB, userId, mount.id, current, parseName(body.name), now)
    if (renamed.tooLarge) throw ApiError.tooLarge('The folder is too large to rename synchronously')
    if (!renamed.entry) {
      throw ApiError.conflict('A file with this name already exists', { suggestedName: renamed.conflict })
    }
    current = renamed.entry
  }

  if (body.starred !== undefined || body.color !== undefined) {
    let color: string | null | undefined
    if (body.color !== undefined) {
      if (current.kind !== 'folder') throw ApiError.badRequest('Only folders can have a color')
      if (body.color === null || body.color === '') color = null
      else {
        const normalized = organizerColorOrNull(body.color)
        if (!normalized) throw ApiError.badRequest('The color is not supported')
        color = normalized
      }
    }
    current = await setEntryFlags(c.env.DB, userId, mount.id, current, {
      starred: body.starred as boolean | undefined,
      color,
    }, now)
  }
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, current) })
})

cloudDriveFilesRoutes.post('/files/move', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown; paths?: unknown; toPath?: unknown; conflict?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const ids = await resolveIdList(c.env.DB, userId, mount.id, body)
  const targetPath = parsePath(body.toPath)
  const target = await resolveEntry(c.env.DB, userId, mount.id, targetPath)
  if (target.kind !== 'folder') throw ApiError.badRequest('The destination is not a folder')
  const results = await moveEntries(c.env.DB, userId, mount.id, ids, target, parseConflict(body.conflict), Date.now())
  return transferResponse(c, results)
})

cloudDriveFilesRoutes.post('/files/copy', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown; paths?: unknown; toPath?: unknown; conflict?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const ids = await resolveIdList(c.env.DB, userId, mount.id, body)
  const targetPath = parsePath(body.toPath)
  const target = await resolveEntry(c.env.DB, userId, mount.id, targetPath)
  if (target.kind !== 'folder') throw ApiError.badRequest('The destination is not a folder')
  const results = await copyEntries(c.env.DB, userId, mount.id, ids, target, parseConflict(body.conflict), Date.now())
  return transferResponse(c, results)
})

cloudDriveFilesRoutes.delete('/files', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown; paths?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const ids = await resolveIdList(c.env.DB, userId, mount.id, body)
  const deleted = await trashEntries(c.env.DB, userId, mount.id, ids, Date.now())
  return c.json({ deleted })
})

cloudDriveFilesRoutes.get('/trash', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await listTrash(c.env.DB, userId, mount.id, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit')),
  })
  const [folders, files] = await Promise.all([
    entriesOf(c.env.DB, userId, mount, result.folders),
    entriesOf(c.env.DB, userId, mount, result.files),
  ])
  const body: CloudDriveListing = {
    mountId: mount.id,
    path: '/',
    folders,
    files,
    cursor: result.cursor,
    total: result.total,
    foldersTruncated: false,
  }
  return c.json(body)
})

cloudDriveFilesRoutes.post('/files/restore', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const ids = parseIdList(body.ids, 'ids')
  const results = await restoreEntries(c.env.DB, userId, mount.id, ids, Date.now())
  const tags = await tagsForFiles(c.env.DB, userId, results.flatMap((result) => result.entry ? [result.entry.id] : []))
  const payload = results.map((result) => ({
    id: result.id,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.entry
      ? { entry: buildEntry(result.entry, mount, tags.get(result.entry.id) ?? []) }
      : {}),
  }))
  return c.json({ results: payload }, results.some((result) => !result.ok) ? 207 : 200)
})

cloudDriveFilesRoutes.delete('/files/purge', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown; all?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  if (body.all === true) {
    const purged = await purgeAllTrash(c.env.DB, userId, c.env)
    return c.json(purged)
  }
  const ids = parseIdList(body.ids, 'ids')
  const purged = await purgeTrashEntries(c.env.DB, userId, mount.id, ids, c.env)
  return c.json(purged)
})

cloudDriveFilesRoutes.get('/tags', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  return c.json({ tags: await listTags(c.env.DB, userId, mount.id) })
})

cloudDriveFilesRoutes.post('/files/:id/tags', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const body = await readJson<{ tag?: unknown; color?: unknown }>(c, BODY_LIMIT)
  if (typeof body.tag !== 'string') throw ApiError.badRequest('tag must be a string')
  let color = ''
  if (body.color !== undefined && body.color !== null && body.color !== '') {
    if (typeof body.color !== 'string') throw ApiError.badRequest('color must be a string')
    color = organizerColorOrNull(body.color) ?? ''
    if (!color) throw ApiError.badRequest('The tag color is not supported')
  }
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  const mount = await mountFor(c, userId, row.mount_id)
  assertWritable(mount)
  await upsertTag(c.env.DB, userId, id, body.tag, color, Date.now())
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, row) })
})

cloudDriveFilesRoutes.delete('/files/:id/tags/:tag', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  const mount = await mountFor(c, userId, row.mount_id)
  assertWritable(mount)
  await removeTag(c.env.DB, userId, id, c.req.param('tag'))
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, row) })
})

cloudDriveFilesRoutes.get('/search', async (c) => {
  const userId = userIdOf(c)
  const q = c.req.query('q')
  if (typeof q !== 'string' || q.trim().length === 0) throw ApiError.badRequest('q is required')
  if (q.length > 100) throw ApiError.badRequest('q is too long')
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await searchEntries(c.env.DB, userId, mount.id, {
    q,
    type: c.req.query('type') || undefined,
    starred: parseFlag(c.req.query('starred')),
    from: parseTimestamp(c.req.query('from')),
    to: parseTimestamp(c.req.query('to')),
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit')),
  })
  return c.json({
    q,
    files: await entriesOf(c.env.DB, userId, mount, result.files),
    cursor: result.cursor,
    total: result.total,
  })
})

cloudDriveFilesRoutes.get('/recent', async (c) => {
  const userId = userIdOf(c)
  const kind = c.req.query('kind') ?? 'viewed'
  if (kind !== 'viewed' && kind !== 'uploaded') throw ApiError.badRequest('kind must be viewed or uploaded')
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await recentEntries(c.env.DB, userId, mount.id, kind, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit')),
  })
  return c.json({ files: await entriesOf(c.env.DB, userId, mount, result.files), cursor: result.cursor })
})

cloudDriveFilesRoutes.get('/album', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await albumEntries(c.env.DB, userId, mount.id, {
    from: parseTimestamp(c.req.query('from')),
    to: parseTimestamp(c.req.query('to')),
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit'), 60),
  })
  const tags = await tagsForFiles(c.env.DB, userId, result.groups.flatMap((group) => group.files.map((file) => file.id)))
  const groups = result.groups.map((group) => ({
    month: group.month,
    files: group.files.map((file) => buildEntry(file, mount, tags.get(file.id) ?? [])),
  }))
  return c.json({ groups, cursor: result.cursor })
})
