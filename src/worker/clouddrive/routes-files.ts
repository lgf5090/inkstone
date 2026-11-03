/**
 * The authenticated CloudDrive file API.
 *
 * Every route resolves the mount and the entry through `lib.ts`, validates its inputs, and asks
 * `store-files.ts` for rows. Errors are `ApiError`s, so the app-level handler answers with the same
 * envelope as the rest of the product.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { CLOUDDRIVE_LIMITS, categoryFor, foldedName, parentPathOf, type CloudDriveCategory, type CloudDriveEntry, type CloudDriveListing } from '@shared/clouddrive/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { deleteExternalPath, externalCapacityBytes, externalFolderSize, listExternal, mkdirExternal, moveExternalPath, parseExternalEntryId, writeExternalFile } from './external'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import {
  assertWritable,
  buildEntry,
  deleteObjectQuietly,
  parseDir,
  parseFlag,
  parseLimit,
  parseFolderMeta,
  parseName,
  parsePath,
  parseSort,
  parseTimestamp,
  queryExternalEntries,
  requireBucket,
  resolveEntry,
  resolveMount,
  tagsForFiles,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from './lib'
import { fileParts } from './distributed'
import { effectiveMeta, effectiveMetas, hiddenByPatterns, isMetaUnlocked, metaCookieName, normalizeMetaPatterns, type EffectiveCloudDriveMeta } from './meta'
import { getCookie } from 'hono/cookie'
import { assertMetaAccess } from './routes-meta'
import {
  albumEntries,
  copyEntries,
  countVisibleTags,
  createFile,
  createFolder,
  folderHiddenPatterns,
  folderSize,
  getFileById,
  listFolder,
  markViewed,
  listTagAssignments,
  listTrash,
  moveEntries,
  purgeAllTrash,
  purgeTrashEntries,
  recentEntries,
  removeTag,
  renameEntry,
  restoreEntries,
  type AlbumKind,
  rowsByIds,
  rowsByPaths,
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
/** The reading of a folder nobody has annotated: no rules, no header, no password. */
const NO_META: EffectiveCloudDriveMeta = {
  header: '', footer: '', hidePatterns: [], passwordHash: '', passwordPath: null,
}
const EXTERNAL_UPLOAD_MAX_BYTES = 90 * 1024 * 1024
const EXTERNAL_WRITE_TYPES: ReadonlySet<string> = new Set(['s3', 'webdav'])

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function mountIdOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'primary'
}

async function mountFor(c: Context<AppBindings>, userId: string, mountId: string): Promise<CloudDriveMountInfo> {
  return await resolveMount(c.env.DB, userId, mountId)
}

async function writableExternalMount(c: Context<AppBindings>, userId: string, mountId: string): Promise<CloudDriveMountInfo> {
  const mount = await mountFor(c, userId, mountId)
  if (mount.storageId === 'primary') throw ApiError.badRequest('This is not an external mount')
  if (mount.readOnly) throw new ApiError(403, 'clouddrive_read_only', 'This mount is read-only')
  if (!EXTERNAL_WRITE_TYPES.has(mount.storageType)) throw new ApiError(403, 'clouddrive_read_only', 'This storage type does not support writes')
  return mount
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
  const paths = body.paths.map((item) => parsePath(item))
  const live = new Map((await rowsByPaths(db, userId, mountId, paths))
    .filter((row) => row.deleted_at === null)
    .map((row) => [row.path, row.id]))
  const ids: string[] = []
  for (const path of paths) {
    // One query resolved every path that names a live row; `resolveEntry` still answers the root and
    // the unknown paths, which is where the same 404 this loop used to raise comes from.
    ids.push(live.get(path) ?? (await resolveEntry(db, userId, mountId, path)).id)
  }
  if (ids.length === 0) throw ApiError.badRequest('paths must name at least one entry')
  return [...new Set(ids)]
}

function metadataObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
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

/**
 * Whether this reader may see inside a directory that carries a password. `cache` holds the answer per
 * locked path for the request, because a hundred rows can sit under the same lock and each check is a
 * D1 read plus a hash comparison.
 */
async function isMetaOpen(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  meta: EffectiveCloudDriveMeta,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (!meta.passwordHash || !meta.passwordPath) return true
  const known = cache.get(meta.passwordPath)
  if (known !== undefined) return known
  const cookie = getCookie(c, await metaCookieName(mountId, meta.passwordPath))
  const open = await isMetaUnlocked(c.env.DB, userId, mountId, meta.passwordPath, cookie)
  cache.set(meta.passwordPath, open)
  return open
}

async function filterMetaVisible<T extends { name: string; path: string }>(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return []
  const parents = rows.map((row) => parentPathOf(row.path))
  const [metas, folderRules] = await Promise.all([
    effectiveMetas(c.env.DB, userId, mountId, parents),
    folderHiddenPatterns(c.env.DB, userId, mountId, parents),
  ])
  // A folder's rules live in two places — the metadata table the mount-path view writes and the row's
  // own JSON the inspector writes — and the directory listing honours both, so anything that shows a
  // list has to as well or the same file hides in one view and not another.
  const unlocked = new Map<string, boolean>()
  const visible: T[] = []
  for (const row of rows) {
    const parent = parentPathOf(row.path)
    const meta = metas.get(parent) ?? NO_META
    if (hiddenByPatterns(row.name, [...meta.hidePatterns, ...(folderRules.get(parent) ?? [])])) continue
    if (await isMetaOpen(c, userId, mountId, meta, unlocked)) visible.push(row)
  }
  return visible
}

cloudDriveFilesRoutes.get('/files', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const path = parsePath(c.req.query('path') ?? '/')
  const meta = await effectiveMeta(c.env.DB, userId, mount.id, path)
  if (meta.passwordHash) await assertMetaAccess(c, userId, mount.id, path)
  if (mount.storageId !== 'primary') {
    const listing = await listExternal(c.env, c.env.DB, mount, path)
    // Search and sort run here rather than in SQL: an external mount has no rows. The driver's own
    // order is only the default, not an excuse for the toolbar to do nothing.
    const visible = (entries: CloudDriveEntry[]): CloudDriveEntry[] => entries
      .filter((entry) => !hiddenByPatterns(entry.name, meta.hidePatterns))
    const query = {
      q: c.req.query('q') || undefined,
      type: c.req.query('type') || undefined,
      sort: parseSort(c.req.query('sort')),
      dir: parseDir(c.req.query('dir')),
    }
    const externalFolders = queryExternalEntries(visible(listing.folders), query)
    const externalFiles = queryExternalEntries(visible(listing.files), query)
    const limit = parseLimit(c.req.query('limit'))
    const body: CloudDriveListing = {
      mountId: mount.id,
      path,
      folders: externalFolders.slice(0, CLOUDDRIVE_LIMITS.folderListMax),
      files: externalFiles.slice(0, limit),
      cursor: null,
      total: externalFiles.length,
      foldersTruncated: externalFolders.length > CLOUDDRIVE_LIMITS.folderListMax,
      note: meta.header || null,
      footer: meta.footer || null,
    }
    return c.json(body)
  }
  const parent = await resolveEntry(c.env.DB, userId, mount.id, path)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The path is not a folder')

  const sort = parseSort(c.req.query('sort'))
  const dir = parseDir(c.req.query('dir'))
  const parentMeta = parseFolderMeta(parent.metadata)
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
    hidden: parentMeta.hiddenPatterns,
  })
  const [folders, files] = await Promise.all([
    entriesOf(c.env.DB, userId, mount, result.folders),
    entriesOf(c.env.DB, userId, mount, result.files),
  ])
  const visibleFolders = folders.filter((entry) => !hiddenByPatterns(entry.name, meta.hidePatterns))
  const visibleFiles = files.filter((entry) => !hiddenByPatterns(entry.name, meta.hidePatterns))
  const hiddenFiles = files.length - visibleFiles.length
  const body: CloudDriveListing = {
    mountId: mount.id,
    path: parent.path,
    folders: visibleFolders,
    files: visibleFiles,
    cursor: result.cursor,
    total: result.total === null ? null : Math.max(0, result.total - hiddenFiles),
    foldersTruncated: result.foldersTruncated,
    note: meta.header || parentMeta.note,
    footer: meta.footer || null,
  }
  return c.json(body)
})

cloudDriveFilesRoutes.post('/external/:mountId/upload', async (c) => {
  const userId = userIdOf(c)
  const mount = await writableExternalMount(c, userId, c.req.param('mountId'))
  const path = parsePath(c.req.query('path') ?? '', { allowRoot: false })
  await assertMetaAccess(c, userId, mount.id, parentPathOf(path))
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw ApiError.badRequest('Content-Length is not a byte count')
    if (length > EXTERNAL_UPLOAD_MAX_BYTES) throw ApiError.tooLarge('The file is larger than the external upload limit')
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength > EXTERNAL_UPLOAD_MAX_BYTES) throw ApiError.tooLarge('The file is larger than the external upload limit')
  const capacity = await externalCapacityBytes(c.env.DB, mount)
  // Adding the mount up folder by folder is a background job's work: in front of every write it costs
  // a hundred driver round trips and times a large store out. What one upload can overshoot is the
  // per-file ceiling, so that is what is checked here; the total stays on the folder-size view.
  if (capacity !== null && bytes.byteLength > capacity) {
    throw new ApiError(403, 'clouddrive_quota_exceeded', 'This file is larger than the storage capacity limit', {
      fileSizeBytes: bytes.byteLength,
      quotaBytes: capacity,
    })
  }
  const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().slice(0, 120) || 'application/octet-stream'
  await writeExternalFile(c.env, c.env.DB, mount, path, bytes, mime)
  return c.json({ ok: true, path, size: bytes.byteLength }, 201)
})

cloudDriveFilesRoutes.post('/external/:mountId/folders', async (c) => {
  const userId = userIdOf(c)
  const mount = await writableExternalMount(c, userId, c.req.param('mountId'))
  const body = await readJson<{ path?: unknown }>(c, BODY_LIMIT)
  const path = parsePath(body.path ?? '', { allowRoot: false })
  await assertMetaAccess(c, userId, mount.id, parentPathOf(path))
  await mkdirExternal(c.env, c.env.DB, mount, path)
  return c.json({ ok: true, path }, 201)
})

cloudDriveFilesRoutes.post('/external/:mountId/move', async (c) => {
  const userId = userIdOf(c)
  const mount = await writableExternalMount(c, userId, c.req.param('mountId'))
  const body = await readJson<{ from?: unknown; to?: unknown }>(c, BODY_LIMIT)
  const from = parsePath(body.from ?? '', { allowRoot: false })
  const to = parsePath(body.to ?? '', { allowRoot: false })
  if (from === to) throw ApiError.badRequest('The source and destination are the same')
  await assertMetaAccess(c, userId, mount.id, parentPathOf(from))
  await assertMetaAccess(c, userId, mount.id, parentPathOf(to))
  await moveExternalPath(c.env, c.env.DB, mount, from, to)
  return c.json({ ok: true, from, to })
})

cloudDriveFilesRoutes.delete('/external/:mountId/files', async (c) => {
  const userId = userIdOf(c)
  const mount = await writableExternalMount(c, userId, c.req.param('mountId'))
  const body = await readJson<{ paths?: unknown }>(c, BODY_LIMIT)
  if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > MAX_BATCH) {
    throw ApiError.badRequest('paths must hold between 1 and 200 paths')
  }
  const paths = [...new Set(body.paths.map((value) => parsePath(value, { allowRoot: false })))]
  let deleted = 0
  let failed = 0
  for (const path of paths) {
    try {
      await assertMetaAccess(c, userId, mount.id, parentPathOf(path))
      await deleteExternalPath(c.env, c.env.DB, mount, path)
      deleted++
    } catch (error) {
      failed++
      console.warn('[inkstone] CloudDrive external delete failed', error)
    }
  }
  return c.json({ deleted, failed }, failed > 0 ? 207 : 200)
})

cloudDriveFilesRoutes.get('/files/:id/folder-size', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  const external = parseExternalEntryId(id)
  if (external) {
    const mount = await mountFor(c, userId, external.mountId)
    await assertMetaAccess(c, userId, mount.id, external.path)
    if (!mount.folderSummary) throw new ApiError(403, 'clouddrive_folder_summary_disabled', 'Folder size calculation is disabled for this mount')
    return c.json(await externalFolderSize(c.env, c.env.DB, mount, external.path))
  }
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  if (row.kind !== 'folder') throw ApiError.badRequest('The entry is not a folder')
  const mount = await mountFor(c, userId, row.mount_id)
  await assertMetaAccess(c, userId, mount.id, row.path)
  if (!mount.folderSummary) throw new ApiError(403, 'clouddrive_folder_summary_disabled', 'Folder size calculation is disabled for this mount')
  return c.json({ bytes: await folderSize(c.env.DB, userId, mount.id, row.id), truncated: false })
})

cloudDriveFilesRoutes.get('/files/:id', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  await assertMetaAccess(c, userId, row.mount_id, parentPathOf(row.path))
  const mount = await mountFor(c, userId, row.mount_id)
  const entry = await entryOf(c.env.DB, userId, mount, row)
  if (row.storage_kind === 'distributed') {
    const parts = await fileParts(c.env.DB, userId, row.id)
    return c.json({
      entry,
      parts: parts.map((part) => ({
        partNumber: part.part_number,
        mountId: part.mount_id,
        size: part.size,
        etag: part.etag,
      })),
    })
  }
  return c.json({ entry })
})

/** The live child row with this name, used by a directory upload that re-enters a path it made. */
async function resolveChild(
  db: D1Database,
  userId: string,
  mountId: string,
  parent: CloudDriveFileRow,
  name: string,
): Promise<CloudDriveFileRow | null> {
  return await db.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND name_folded = ? AND deleted_at IS NULL`,
  ).bind(userId, mountId, parent.id, foldedName(name)).first<CloudDriveFileRow>()
}

cloudDriveFilesRoutes.post('/folders', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; parentPath?: unknown; name?: unknown; conflict?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const parentPath = parsePath(body.parentPath ?? '/')
  await assertMetaAccess(c, userId, mount.id, parentPath)
  const parent = await resolveEntry(c.env.DB, userId, mount.id, parentPath)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The parent path is not a folder')
  const name = parseName(body.name)

  // A directory upload walks the same path for every file inside it, so it asks for the folder it
  // already made instead of taking a 409 and inventing `docs (1)`.
  if (body.conflict === 'reuse') {
    const existing = await resolveChild(c.env.DB, userId, mount.id, parent, name)
    if (existing && existing.kind === 'folder') {
      return c.json({ entry: await entryOf(c.env.DB, userId, mount, existing), reused: true })
    }
  }

  const created = await createFolder(c.env.DB, userId, mount.id, parent, name, Date.now())
  if (!created.entry) {
    throw ApiError.conflict('A file with this name already exists', { suggestedName: created.conflict })
  }
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, created.entry) }, 201)
})

/**
 * The mime a file the drive created itself carries. An empty `.html` deliberately lands as plain
 * text: the extension is the reader's choice, not a promise that the bytes are safe to inline.
 */
function createdFileMime(category: CloudDriveCategory): string {
  return category === 'txt' || category === 'code' ? 'text/plain' : 'application/octet-stream'
}

cloudDriveFilesRoutes.post('/files', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; parentPath?: unknown; name?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const parentPath = parsePath(body.parentPath ?? '/')
  await assertMetaAccess(c, userId, mount.id, parentPath)
  const parent = await resolveEntry(c.env.DB, userId, mount.id, parentPath)
  if (parent.kind !== 'folder') throw ApiError.badRequest('The parent path is not a folder')
  const name = parseName(body.name)
  const category = categoryFor(name)
  const mime = createdFileMime(category)

  const bucket = await requireBucket(c)
  const fileId = newId()
  const storageKey = `CloudDrive/${category}/${fileId}`
  const object = await bucket.put(storageKey, new Uint8Array(0), {
    httpMetadata: { contentType: mime },
    customMetadata: { fileId, category },
  })
  const now = Date.now()
  const created = await createFile(c.env.DB, userId, mount.id, parent, name, { id: fileId, category, mime, storageKey, etag: object.etag }, now)
  if (!created.entry) {
    // The name was taken between the pre-check and the row, so the placeholder goes back the way it came.
    await deleteObjectQuietly(bucket, storageKey)
    throw ApiError.conflict('A file with this name already exists', { suggestedName: created.conflict })
  }
  return c.json({ entry: await entryOf(c.env.DB, userId, mount, created.entry) }, 201)
})

async function assertIdsMetaAccess(
  c: Context<AppBindings>,
  userId: string,
  mountId: string,
  ids: readonly string[],
): Promise<void> {
  // A batch move of two hundred items used to cost two hundred row reads and two hundred scans of the
  // metadata table; one read of each answers the same question for the whole set.
  const rows = await rowsByIds(c.env.DB, userId, mountId, ids)
  const metas = await effectiveMetas(c.env.DB, userId, mountId, rows.map((row) => parentPathOf(row.path)))
  const unlocked = new Map<string, boolean>()
  for (const row of rows) {
    const meta = metas.get(parentPathOf(row.path)) ?? NO_META
    if (await isMetaOpen(c, userId, mountId, meta, unlocked)) continue
    throw new ApiError(403, 'clouddrive_meta_locked', 'This folder is password protected')
  }
}

cloudDriveFilesRoutes.patch('/files/:id', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const body = await readJson<{ name?: unknown; starred?: unknown; color?: unknown; note?: unknown; hidePatterns?: unknown }>(c, BODY_LIMIT)
  const row = await getFileById(c.env.DB, userId, id)
  if (!row) throw ApiError.notFound('File not found')
  const mount = await mountFor(c, userId, row.mount_id)
  assertWritable(mount)
  await assertMetaAccess(c, userId, mount.id, parentPathOf(row.path))

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

  if (body.starred !== undefined || body.color !== undefined || body.note !== undefined || body.hidePatterns !== undefined) {
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
    let metadata: Record<string, unknown> | undefined
    if (body.note !== undefined || body.hidePatterns !== undefined) {
      if (current.kind !== 'folder') throw ApiError.badRequest('Only folders can have a note or hidden patterns')
      metadata = metadataObject(current.metadata)
      if (body.note !== undefined) {
        if (typeof body.note !== 'string' || body.note.length > 4000) throw ApiError.badRequest('note must be a string of at most 4000 characters')
        const note = body.note.trim()
        if (note) metadata.note = note
        else delete metadata.note
      }
      if (body.hidePatterns !== undefined) {
        try {
          metadata.hidePatterns = normalizeMetaPatterns(body.hidePatterns)
        } catch (error) {
          throw ApiError.badRequest(error instanceof Error ? error.message : 'hidePatterns holds * and ? wildcards')
        }
      }
    }
    current = await setEntryFlags(c.env.DB, userId, mount.id, current, {
      starred: body.starred as boolean | undefined,
      color,
      metadata,
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
  await assertMetaAccess(c, userId, mount.id, targetPath)
  await assertIdsMetaAccess(c, userId, mount.id, ids)
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
  await assertMetaAccess(c, userId, mount.id, targetPath)
  await assertIdsMetaAccess(c, userId, mount.id, ids)
  const results = await copyEntries(c.env.DB, userId, mount.id, ids, target, parseConflict(body.conflict), Date.now())
  return transferResponse(c, results)
})

cloudDriveFilesRoutes.delete('/files', async (c) => {
  const userId = userIdOf(c)
  const body = await readJson<{ mountId?: unknown; ids?: unknown; paths?: unknown }>(c, BODY_LIMIT)
  const mount = await mountFor(c, userId, mountIdOf(body.mountId))
  assertWritable(mount)
  const ids = await resolveIdList(c.env.DB, userId, mount.id, body)
  await assertIdsMetaAccess(c, userId, mount.id, ids)
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
  const roots = [...result.folders, ...result.files]
  const trashedWith = new Map(roots.map((row) => [row.id, row.descendantsTrashed]))
  const deletedWhen = new Map(roots.map((row) => [row.id, row.deleted_at]))
  const inTrash = (entry: CloudDriveEntry): CloudDriveEntry => ({
    ...entry,
    deletedAt: deletedWhen.get(entry.id) ?? null,
    descendantsTrashed: trashedWith.get(entry.id) ?? false,
  })
  const body: CloudDriveListing = {
    mountId: mount.id,
    path: '/',
    folders: folders.map(inTrash),
    files: files.map(inTrash),
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
  const visible = await filterMetaVisible(c, userId, mount.id, await listTagAssignments(c.env.DB, userId, mount.id))
  return c.json({ tags: countVisibleTags(visible) })
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
  await assertMetaAccess(c, userId, mount.id, parentPathOf(row.path))
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
  await assertMetaAccess(c, userId, mount.id, parentPathOf(row.path))
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
  const files = await filterMetaVisible(c, userId, mount.id, result.files)
  return c.json({
    q,
    files: await entriesOf(c.env.DB, userId, mount, files),
    cursor: result.cursor,
    total: result.total === null ? null : Math.max(0, result.total - (result.files.length - files.length)),
  })
})

/**
 * One line of write on purpose: the recent-view page has nothing to show until a read says it happened.
 * It is not a mutation of the file, so it takes the same read permission and no write grant.
 */
cloudDriveFilesRoutes.post('/files/:id/view', async (c) => {
  const userId = userIdOf(c)
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await getFileById(c.env.DB, userId, id)
  if (!row || row.kind !== 'file') throw ApiError.notFound('File not found')
  await assertMetaAccess(c, userId, row.mount_id, parentPathOf(row.path))
  await markViewed(c.env.DB, userId, id, Date.now())
  return c.json({ ok: true })
})

cloudDriveFilesRoutes.get('/recent', async (c) => {
  const userId = userIdOf(c)
  const kind = c.req.query('kind') ?? 'viewed'
  if (kind !== 'viewed' && kind !== 'uploaded' && kind !== 'starred') throw ApiError.badRequest('kind must be viewed, uploaded or starred')
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await recentEntries(c.env.DB, userId, mount.id, kind, {
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit')),
  })
  const files = await filterMetaVisible(c, userId, mount.id, result.files)
  return c.json({ files: await entriesOf(c.env.DB, userId, mount, files), cursor: result.cursor })
})

/** An unknown value falls back to stills, which is what the album showed before the filter existed. */
function albumKindOf(value: string | undefined): AlbumKind {
  return value === 'videos' || value === 'all' ? value : 'images'
}

cloudDriveFilesRoutes.get('/album', async (c) => {
  const userId = userIdOf(c)
  const mount = await mountFor(c, userId, mountIdOf(c.req.query('mount')))
  const result = await albumEntries(c.env.DB, userId, mount.id, {
    from: parseTimestamp(c.req.query('from')),
    to: parseTimestamp(c.req.query('to')),
    cursor: c.req.query('cursor') || undefined,
    limit: parseLimit(c.req.query('limit'), 60),
    kind: albumKindOf(c.req.query('kind')),
  })
  const tags = await tagsForFiles(c.env.DB, userId, result.groups.flatMap((group) => group.files.map((file) => file.id)))
  const groups = await Promise.all(result.groups.map(async (group) => ({
    month: group.month,
    files: (await filterMetaVisible(c, userId, mount.id, group.files)).map((file) => buildEntry(file, mount, tags.get(file.id) ?? [])),
  })))
  return c.json({ groups, cursor: result.cursor })
})
