/**
 * Cloud Drive tools for the assistant.
 *
 * Every tool here speaks the same vocabulary the drive's own routes do: the mount is resolved with
 * `resolveMount`, a mutation asks `assertWritable`, and every path or id is looked up inside the
 * session's own account. A folder carrying a password is refused rather than read: the dock has no
 * unlock cookie, and a model that could enter a locked folder would make that password decorative.
 *
 * Deletion is the trash, never the erasure. `drive_trash` and `drive_empty_trash` are destructive tools,
 * so the executor runs `prepare` during the turn (which resolves exactly what would go and writes the
 * pending card) and `commit` only after the reader presses Approve.
 */
import {
  CLOUDDRIVE_CATEGORIES,
  foldedName,
  parentPathOf,
  type CloudDriveCategory,
  type CloudDriveSortDirection,
  type CloudDriveSortKey,
} from '@shared/clouddrive/model'
import { parseLocalTime } from '@shared/assistant-time'
import { newSlug } from '../lib/id'
import {
  PRIMARY_MOUNT,
  assertMemberAllowed,
  assertWritable,
  parseName,
  parsePath,
  resolveEntry,
  resolveMount,
  type CloudDriveFileRow,
  type CloudDriveMountInfo,
} from '../clouddrive/lib'
import { effectiveMeta, effectiveMetas, hiddenByPatterns } from '../clouddrive/meta'
import { cloudDriveUsage, listMounts, readCloudDriveSettings } from '../clouddrive/store'
import {
  createFolder,
  folderSize,
  moveEntries,
  purgeAllTrash,
  purgeTrashEntries,
  renameEntry,
  trashEntries,
} from '../clouddrive/store-files'
import { ToolError, type ToolContext, type ToolDefinition } from './tools'

const DAY_MS = 86_400_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_MOVE_PATHS = 20
const MAX_TRASH_PATHS = 50
const MAX_LIST_DAYS = 3650

type SortKey = CloudDriveSortKey | 'viewed'

function mountIdOf(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : PRIMARY_MOUNT
}

async function mountFor(ctx: ToolContext, mountId: string): Promise<CloudDriveMountInfo> {
  return await resolveMount(ctx.env.DB, ctx.store.userId, mountId)
}

/** The drive's own D1 rows are the primary mount; a driver-backed mount has no rows to answer with. */
function assertPrimaryMount(mount: CloudDriveMountInfo): void {
  if (mount.storageId !== PRIMARY_MOUNT) {
    throw new ToolError(`"${mount.name}" is an external mount. The assistant can only read and change the primary Cloud Drive.`)
  }
}

/**
 * A password-protected folder is not entered at all.
 *
 * The reader unlocks it in the app, and the unlock lives in an httpOnly cookie the assistant request
 * does not carry. Treating an absent cookie as "unlocked" would be the one bypass that makes the
 * folder's password meaningless, so the honest answer is that the assistant cannot go in.
 */
async function assertFolderUnlocked(
  ctx: ToolContext,
  mount: CloudDriveMountInfo,
  path: string,
): Promise<void> {
  const meta = await effectiveMeta(ctx.env.DB, ctx.store.userId, mount.id, path)
  if (meta.passwordHash) {
    throw new ToolError(`"${path}" is password protected. Unlock it in the Cloud Drive app and ask again; the assistant cannot enter a locked folder.`)
  }
}

/** The live row a path names, with the password lock its containing folder carries checked first. */
async function resolveUnlockedEntry(
  ctx: ToolContext,
  mount: CloudDriveMountInfo,
  rawPath: unknown,
  options: { allowRoot?: boolean } = {},
): Promise<CloudDriveFileRow> {
  const path = parsePath(rawPath)
  if (path === '/' && !options.allowRoot) throw new ToolError('The drive root cannot be moved, renamed, shared or trashed.')
  const row = await resolveEntry(ctx.env.DB, ctx.store.userId, mount.id, path)
  await assertFolderUnlocked(ctx, mount, row.kind === 'folder' ? row.path : parentPathOf(row.path))
  return row
}

function isoOrNull(value: number | null | undefined): string | null {
  return value === undefined || value === null ? null : new Date(value).toISOString()
}

function entryView(row: CloudDriveFileRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    category: row.category,
    mime: row.mime,
    size: row.size,
    uploadedAt: isoOrNull(row.uploaded_at),
    modifiedAt: isoOrNull(row.modified_at),
    lastViewedAt: isoOrNull(row.last_viewed_at),
    starred: row.starred_at !== null,
  }
}

/** A `YYYY-MM-DD` or ISO date-time, read in the reader's own timezone. */
function dateBound(value: unknown, ctx: ToolContext, field: string, endOfDay: boolean): number | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`"${field}" must be YYYY-MM-DD or an ISO date-time.`)
  const text = value.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const source = dateOnly && !endOfDay ? `${text}T00:00` : text
  const instant = parseLocalTime(source, ctx.timezone)
  if (instant === null) throw new ToolError(`Could not understand "${field}" as a date. Use YYYY-MM-DD.`)
  return instant
}

function positiveInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ToolError(`"${field}" must be a whole number between ${min} and ${max}.`)
  }
  return number
}

function nameOfCategory(value: unknown): CloudDriveCategory | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(CLOUDDRIVE_CATEGORIES as readonly string[]).includes(value)) {
    throw new ToolError(`"type" must be one of: ${CLOUDDRIVE_CATEGORIES.join(', ')}.`)
  }
  return value as CloudDriveCategory
}

function sortOf(value: unknown): SortKey {
  if (value === undefined) return 'name'
  const allowed: SortKey[] = ['name', 'size', 'uploaded', 'modified', 'viewed']
  if (typeof value !== 'string' || !allowed.includes(value as SortKey)) {
    throw new ToolError(`"sort" must be one of: ${allowed.join(', ')}.`)
  }
  return value as SortKey
}

function dirOf(value: unknown): CloudDriveSortDirection {
  if (value === undefined) return 'asc'
  if (value !== 'asc' && value !== 'desc') throw new ToolError('"dir" must be asc or desc.')
  return value
}

function orderClause(sort: SortKey, dir: CloudDriveSortDirection): string {
  const direction = dir === 'desc' ? 'DESC' : 'ASC'
  switch (sort) {
    case 'size':
      return `f.size ${direction}, f.id ${direction}`
    case 'uploaded':
      return `f.uploaded_at ${direction}, f.id ${direction}`
    case 'modified':
      return `f.modified_at ${direction}, f.id ${direction}`
    case 'viewed':
      return `COALESCE(f.last_viewed_at, 0) ${direction}, f.id ${direction}`
    case 'name':
    default:
      return `f.name_folded ${direction}, f.id ${direction}`
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** Every live folder inside the walked subtree, so the walk can ask what each one protects. */
async function subtreeFolderPaths(
  ctx: ToolContext,
  mount: CloudDriveMountInfo,
  subtree: { sql: string; binds: string[] } | null,
): Promise<string[]> {
  const scope = subtree ? " AND (substr(path, 1, length(?3) + 1) = ?4 || '/')" : ''
  const { results } = await ctx.env.DB.prepare(
    `SELECT path FROM CloudDrive_files
      WHERE user_id = ?1 AND mount_id = ?2 AND kind = 'folder' AND deleted_at IS NULL${scope}`,
  ).bind(ctx.store.userId, mount.id, ...(subtree?.binds ?? [])).all<{ path: string }>()
  return (results ?? []).map((row) => row.path)
}

/** The `drive_list` statement: one folder or its whole subtree, narrowed by every filter at once. */
async function listDrive(
  ctx: ToolContext,
  mount: CloudDriveMountInfo,
  folder: CloudDriveFileRow,
  args: Record<string, unknown>,
): Promise<{ rows: CloudDriveFileRow[]; truncated: boolean }> {
  const clauses = [
    'f.user_id = ?',
    'f.mount_id = ?',
    'f.deleted_at IS NULL',
    "f.name_folded <> '.keep'",
  ]
  const params: unknown[] = [ctx.store.userId, mount.id]

  const recursive = args.recursive === true
  const subtree = folder.path === '/'
    ? null
    : {
        sql: "substr(path, 1, length(?) + 1) = ? || '/'",
        binds: [folder.path, folder.path],
      }
  if (recursive) {
    if (subtree) {
      clauses.push(`substr(f.path, 1, length(?) + 1) = ? || '/'`)
      params.push(...subtree.binds)
    }
  } else {
    clauses.push('f.parent_id = ?')
    params.push(folder.id)
  }

  // A recursive walk is the only read that can cross a password folder without the reader opening
  // it. The `effectiveMeta` per folder is what keeps the tool's promise: a lock anywhere in the
  // subtree refuses the walk instead of returning a quietly incomplete answer.
  const folderPaths = recursive
    ? [folder.path, ...(await subtreeFolderPaths(ctx, mount, subtree))]
    : [folder.path]
  const metas = await effectiveMetas(ctx.env.DB, ctx.store.userId, mount.id, folderPaths)
  if (recursive) {
    const locked = folderPaths.find((path) => metas.get(path)?.passwordHash)
    if (locked) {
      throw new ToolError(`"${locked}" is password protected. Unlock it in the Cloud Drive app and ask again; the assistant cannot enter a locked folder.`)
    }
  }

  const q = typeof args.q === 'string' ? foldedName(args.q.trim()) : ''
  if (q) {
    clauses.push("f.name_folded LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(q)}%`)
  }
  const type = nameOfCategory(args.type)
  if (type) {
    clauses.push('f.category = ?')
    params.push(type)
  }
  const from = dateBound(args.from, ctx, 'from', false)
  if (from !== null) {
    clauses.push('f.uploaded_at >= ?')
    params.push(from)
  }
  const to = dateBound(args.to, ctx, 'to', true)
  if (to !== null) {
    clauses.push('f.uploaded_at <= ?')
    params.push(to)
  }
  const minSize = positiveInt(args.minSize, 'minSize', 0, Number.MAX_SAFE_INTEGER)
  if (minSize !== undefined) {
    clauses.push('f.size >= ?')
    params.push(minSize)
  }
  const maxSize = positiveInt(args.maxSize, 'maxSize', 0, Number.MAX_SAFE_INTEGER)
  if (maxSize !== undefined) {
    clauses.push('f.size <= ?')
    params.push(maxSize)
  }
  const unviewedDays = positiveInt(args.unviewedDays, 'unviewedDays', 1, MAX_LIST_DAYS)
  if (unviewedDays !== undefined) {
    clauses.push("f.kind = 'file'")
    clauses.push('(f.last_viewed_at IS NULL OR f.last_viewed_at <= ?)')
    params.push(Date.now() - unviewedDays * DAY_MS)
  }

  const limit = positiveInt(args.limit, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT
  const { results } = await ctx.env.DB.prepare(
    `SELECT f.* FROM CloudDrive_files f
      WHERE ${clauses.join(' AND ')}
      ORDER BY ${orderClause(sortOf(args.sort), dirOf(args.dir))}
      LIMIT ?`,
  ).bind(...params, limit + 1).all<CloudDriveFileRow>()
  const rows = (results ?? []).filter((row) => {
    const patterns = metas.get(parentPathOf(row.path))?.hidePatterns ?? []
    return !hiddenByPatterns(row.name, patterns)
  })
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

function pathsOf(value: unknown, max: number, field = 'paths'): string[] {
  if (!Array.isArray(value)) throw new ToolError(`"${field}" must be a list of paths.`)
  const paths = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => parsePath(entry))
  if (paths.length === 0) throw new ToolError(`"${field}" must name at least one path.`)
  if (paths.length > max) throw new ToolError(`"${field}" holds at most ${max} paths.`)
  return [...new Set(paths)]
}

async function assertEntriesWritable(
  ctx: ToolContext,
  mount: CloudDriveMountInfo,
  paths: readonly string[],
): Promise<CloudDriveFileRow[]> {
  assertWritable(mount)
  const rows: CloudDriveFileRow[] = []
  for (const path of paths) rows.push(await resolveUnlockedEntry(ctx, mount, path))
  return rows
}

function approvalLabel(verb: string, rows: readonly CloudDriveFileRow[]): string {
  if (rows.length === 1) return `${verb} ${rows[0]?.name ?? '1 item'}`
  const names = rows.slice(0, 3).map((row) => row.name).join(', ')
  return rows.length <= 3
    ? `${verb} ${rows.length} items: ${names}`
    : `${verb} ${rows.length} items: ${names}…`
}

function shareExpiry(
  requested: number | undefined,
  settings: { shareDefaultExpiryDays: number; shareMaxExpiryDays: number },
  now: number,
): number | null {
  const days = requested === undefined ? settings.shareDefaultExpiryDays : requested
  if (days <= 0) return null
  if (days > settings.shareMaxExpiryDays) {
    throw new ToolError(`A share link can last at most ${settings.shareMaxExpiryDays} days.`)
  }
  return now + days * DAY_MS
}

export const CLOUDDRIVE_TOOLS: ToolDefinition[] = [
  {
    name: 'drive_list',
    permission: 'read',
    maxCallsPerTurn: 6,
    description: 'List files and folders in the Cloud Drive. Defaults to the primary mount and the root folder; pass path for one folder, recursive for its whole subtree. q matches a file or folder name, from/to narrow the upload dates, minSize/maxSize are bytes, type is one of the drive categories, and unviewedDays returns only files not opened in that many days (never-opened counts). This is how "files in Archive I have not opened for 30 days" is answered: path="/Archive", recursive=true, unviewedDays=30.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      path: { type: 'string', description: 'Folder path such as "/Archive". Defaults to "/".', maxLength: 1024, optional: true },
      recursive: { type: 'boolean', description: 'Include everything under the folder, not just its direct children.', optional: true },
      q: { type: 'string', description: 'Match part of a file or folder name.', maxLength: 200, optional: true },
      from: { type: 'string', description: 'Earliest upload date, YYYY-MM-DD or an ISO date-time.', maxLength: 40, optional: true },
      to: { type: 'string', description: 'Latest upload date, YYYY-MM-DD or an ISO date-time.', maxLength: 40, optional: true },
      type: { type: 'string', description: `One of: ${CLOUDDRIVE_CATEGORIES.join(', ')}.`, enum: CLOUDDRIVE_CATEGORIES, optional: true },
      minSize: { type: 'integer', description: 'Smallest size in bytes.', minimum: 0, optional: true },
      maxSize: { type: 'integer', description: 'Largest size in bytes.', minimum: 0, optional: true },
      unviewedDays: { type: 'integer', description: 'Only files not opened in this many days; a file never opened counts.', minimum: 1, maximum: MAX_LIST_DAYS, optional: true },
      sort: { type: 'string', description: 'name, size, uploaded, modified or viewed.', enum: ['name', 'size', 'uploaded', 'modified', 'viewed'], optional: true },
      dir: { type: 'string', description: 'asc or desc.', enum: ['asc', 'desc'], optional: true },
      limit: { type: 'integer', description: `Rows to return, at most ${MAX_LIMIT}.`, minimum: 1, maximum: MAX_LIMIT, optional: true },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertPrimaryMount(mount)
      const folder = await resolveEntry(ctx.env.DB, ctx.store.userId, mount.id, parsePath(args.path ?? '/'))
      if (folder.kind !== 'folder') throw new ToolError('The path is not a folder. Pass the folder that holds the files you mean.')
      await assertFolderUnlocked(ctx, mount, folder.path)
      const { rows, truncated } = await listDrive(ctx, mount, folder, args)
      return {
        mount: mount.name,
        path: folder.path,
        recursive: args.recursive === true,
        count: rows.length,
        truncated,
        files: rows.map(entryView),
        ...(rows.length === 0 ? { hint: 'Nothing matched. Try a shorter q or a different path.' } : {}),
      }
    },
  },
  {
    name: 'drive_info',
    permission: 'read',
    maxCallsPerTurn: 5,
    description: 'Read one file or folder: its size (a folder\'s is the whole subtree), how many items a folder directly holds, when it was last opened, and the access summary — whether the mount is writable, how many ACL grants are live and how many share links point at it. A folder can hold files of zero bytes, so use itemCount rather than sizeBytes to decide whether it is empty.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      path: { type: 'string', description: 'File or folder path such as "/Archive/2024 report.pdf".', maxLength: 1024 },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertPrimaryMount(mount)
      const row = await resolveUnlockedEntry(ctx, mount, args.path, { allowRoot: true })
      const bytes = row.kind === 'file'
        ? row.size
        : await folderSize(ctx.env.DB, ctx.store.userId, mount.id, row.id)
      const viewed = row.kind === 'file'
        ? row.last_viewed_at
        : (await ctx.env.DB.prepare(
          row.path === '/'
            ? `SELECT MAX(last_viewed_at) AS viewed FROM CloudDrive_files
                WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL`
            : `SELECT MAX(last_viewed_at) AS viewed FROM CloudDrive_files
                WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL
                  AND substr(path, 1, length(?) + 1) = ? || '/'`,
        ).bind(...(row.path === '/' ? [ctx.store.userId, mount.id] : [ctx.store.userId, mount.id, row.path, row.path]))
          .first<{ viewed: number | null }>())?.viewed ?? null
      const counts = row.kind === 'folder'
        ? await ctx.env.DB.prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS files,
                  SUM(CASE WHEN kind = 'folder' THEN 1 ELSE 0 END) AS folders
             FROM CloudDrive_files
            WHERE user_id = ? AND mount_id = ? AND parent_id = ? AND deleted_at IS NULL
              AND name_folded <> '.keep'`,
        ).bind(ctx.store.userId, mount.id, row.id).first<{ total: number; files: number; folders: number }>()
        : null
      const [grants, shares] = await Promise.all([
        ctx.env.DB.prepare(
          `SELECT COUNT(*) AS count FROM CloudDrive_acl
            WHERE owner_id = ? AND file_id = ? AND revoked_at IS NULL`,
        ).bind(ctx.store.userId, row.id).first<{ count: number }>(),
        ctx.env.DB.prepare(
          row.path === '/'
            ? `SELECT COUNT(*) AS count FROM CloudDrive_shares
                WHERE user_id = ? AND revoked_at IS NULL AND is_enabled = 1`
            : `SELECT COUNT(*) AS count FROM CloudDrive_shares
                WHERE user_id = ? AND revoked_at IS NULL AND is_enabled = 1
                  AND (file_id = ? OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/')`,
        ).bind(...(row.path === '/' ? [ctx.store.userId] : [ctx.store.userId, row.id, row.path, row.path, row.path]))
          .first<{ count: number }>(),
      ])
      return {
        mount: mount.name,
        entry: entryView(row),
        sizeBytes: bytes,
        ...(counts
          ? {
            itemCount: Number(counts.total ?? 0),
            fileCount: Number(counts.files ?? 0),
            folderCount: Number(counts.folders ?? 0),
          }
          : {}),
        lastViewedAt: isoOrNull(viewed),
        acl: {
          writable: !mount.readOnly && mount.storageId === PRIMARY_MOUNT,
          activeGrants: Number(grants?.count ?? 0),
          activeShareLinks: Number(shares?.count ?? 0),
        },
      }
    },
  },
  {
    name: 'drive_storage_stats',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Report how much the Cloud Drive holds: used bytes, trash bytes, the quota, file and folder counts, and every mount with its read-only state. Use this before asking whether something will fit.',
    fields: {},
    async run(_args, ctx) {
      const usage = await cloudDriveUsage(ctx.env.DB, ctx.store.userId, ctx.env)
      const mounts = await listMounts(ctx.env.DB, ctx.store.userId)
      const [counts, categories] = await Promise.all([
        ctx.env.DB.prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN kind = 'file' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS files,
             SUM(CASE WHEN kind = 'folder' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS folders,
             SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed
           FROM CloudDrive_files WHERE user_id = ?`,
        ).bind(ctx.store.userId).first<{ total: number; files: number; folders: number; trashed: number }>(),
        ctx.env.DB.prepare(
          `SELECT category, COALESCE(SUM(size), 0) AS bytes FROM CloudDrive_files
            WHERE user_id = ? AND kind = 'file' AND deleted_at IS NULL
            GROUP BY category ORDER BY bytes DESC LIMIT 12`,
        ).bind(ctx.store.userId).all<{ category: string; bytes: number }>(),
      ])
      return {
        usedBytes: usage.usedBytes,
        trashBytes: usage.trashBytes,
        quotaBytes: usage.quotaBytes,
        freeBytes: usage.quotaBytes === null
          ? null
          : Math.max(0, usage.quotaBytes - usage.usedBytes - usage.trashBytes),
        primaryAvailable: usage.primaryAvailable,
        counts: {
          files: Number(counts?.files ?? 0),
          folders: Number(counts?.folders ?? 0),
          trashed: Number(counts?.trashed ?? 0),
        },
        byCategory: (categories.results ?? []).map((row) => ({ category: row.category, bytes: Number(row.bytes ?? 0) })),
        mounts: mounts.map((mount) => ({
          id: mount.id,
          name: mount.name,
          mountPath: mount.mountPath,
          storageType: mount.storageType,
          readOnly: mount.readOnly,
          enabled: mount.enabled,
        })),
      }
    },
  },
  {
    name: 'drive_create_folder',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Create a folder. parentPath defaults to the drive root. A name already in use is refused with the free name that would work instead.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      parentPath: { type: 'string', description: 'Folder that will hold the new folder. Defaults to "/".', maxLength: 1024, optional: true },
      name: { type: 'string', description: 'New folder name.', minLength: 1, maxLength: 255 },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertWritable(mount)
      const parentPath = parsePath(args.parentPath ?? '/')
      const parent = await resolveEntry(ctx.env.DB, ctx.store.userId, mount.id, parentPath)
      if (parent.kind !== 'folder') throw new ToolError('The parent path is not a folder.')
      await assertFolderUnlocked(ctx, mount, parent.path)
      const name = parseName(args.name)
      const created = await createFolder(ctx.env.DB, ctx.store.userId, mount.id, parent, name, Date.now())
      if (!created.entry) {
        throw new ToolError(`A file or folder named "${name}" already exists here. The free name is "${created.conflict}".`)
      }
      return {
        created: { id: created.entry.id, name: created.entry.name, path: created.entry.path },
        parent: parent.path,
      }
    },
  },
  {
    name: 'drive_move',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Move up to 20 files or folders into another folder. conflict decides what happens when the destination already holds the name: rename keeps both, overwrite sends the existing one to the trash, skip leaves it.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      paths: { type: 'array', items: 'string', maxItems: MAX_MOVE_PATHS, description: 'Paths of the files or folders to move.' },
      toPath: { type: 'string', description: 'Destination folder path.', minLength: 1, maxLength: 1024 },
      conflict: { type: 'string', description: 'rename (default), overwrite or skip.', enum: ['rename', 'overwrite', 'skip'], optional: true },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertWritable(mount)
      const paths = pathsOf(args.paths, MAX_MOVE_PATHS)
      const rows = await assertEntriesWritable(ctx, mount, paths)
      const target = await resolveEntry(ctx.env.DB, ctx.store.userId, mount.id, parsePath(args.toPath))
      if (target.kind !== 'folder') throw new ToolError('The destination is not a folder.')
      await assertFolderUnlocked(ctx, mount, target.path)
      const mode = args.conflict === 'overwrite' || args.conflict === 'skip' ? args.conflict : 'rename'
      const results = await moveEntries(ctx.env.DB, ctx.store.userId, mount.id, rows.map((row) => row.id), target, { mode }, Date.now())
      const moved = results.filter((result) => result.ok).length
      if (moved === 0) throw new ToolError('Nothing was moved: the destination already holds those names.')
      return {
        moved,
        failed: results.length - moved,
        toPath: target.path,
        paths: results.map((result, index) => ({
          from: paths[index],
          ok: result.ok,
          ...(result.toPath ? { to: result.toPath } : {}),
        })),
      }
    },
  },
  {
    name: 'drive_rename',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Rename one file or folder. The path stays in the same folder; only the last name changes. A name already in use is refused with the free name that would work instead.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      path: { type: 'string', description: 'Current path of the file or folder.', minLength: 1, maxLength: 1024 },
      name: { type: 'string', description: 'New last name.', minLength: 1, maxLength: 255 },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertWritable(mount)
      const row = await resolveUnlockedEntry(ctx, mount, args.path)
      const renamed = await renameEntry(ctx.env.DB, ctx.store.userId, mount.id, row, parseName(args.name), Date.now())
      if (renamed.tooLarge) throw new ToolError('The folder is too large to rename synchronously.')
      if (!renamed.entry) {
        throw new ToolError(`A file or folder named "${String(args.name)}" already exists here. The free name is "${renamed.conflict}".`)
      }
      return { renamed: { id: renamed.entry.id, name: renamed.entry.name, path: renamed.entry.path } }
    },
  },
  {
    name: 'drive_share_link',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create a public share link for one file or folder and return the real URL that can be opened in a browser. expiresInDays defaults to the drive setting; 0 means the link never expires.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      path: { type: 'string', description: 'Path of the file or folder to share.', minLength: 1, maxLength: 1024 },
      expiresInDays: { type: 'integer', description: 'How long the link stays valid; 0 means never.', minimum: 0, maximum: 3650, optional: true },
    },
    async run(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertPrimaryMount(mount)
      const row = await resolveUnlockedEntry(ctx, mount, args.path)
      const role = (await ctx.env.DB.prepare('SELECT role FROM users WHERE id = ?')
        .bind(ctx.store.userId).first<{ role: string }>())?.role
      await assertMemberAllowed(ctx.env.DB, ctx.store.userId, role, 'shareAllowMemberShares')
      const settings = await readCloudDriveSettings(ctx.env.DB, ctx.store.userId)
      const now = Date.now()
      const expiresAt = shareExpiry(positiveInt(args.expiresInDays, 'expiresInDays', 0, MAX_LIST_DAYS), settings, now)
      const slug = newSlug()
      await ctx.env.DB.prepare(
        `INSERT INTO CloudDrive_shares
           (slug, user_id, target_kind, file_id, mount_id, path, name, size, mime, password_hash,
            expires_at, max_views, views, max_downloads, downloads, allow_download, allow_list, is_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL, 0, 1, 1, 1, ?)`,
      ).bind(
        slug, ctx.store.userId, row.kind, row.id, mount.id, row.path, row.name,
        row.kind === 'file' ? row.size : null,
        row.kind === 'file' ? row.mime : null,
        expiresAt, now,
      ).run()
      return {
        url: `${ctx.origin.replace(/\/+$/, '')}/d/${slug}`,
        slug,
        target: { kind: row.kind, name: row.name, path: row.path },
        expiresAt: isoOrNull(expiresAt),
        unlimited: expiresAt === null,
      }
    },
  },
  {
    name: 'drive_trash',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    keepArgs: true,
    description: 'Move up to 50 files or folders to the trash. Nothing moves until the reader approves the card, and the trash keeps them restorable.',
    fields: {
      mountId: { type: 'string', description: 'Mount id; defaults to the primary drive.', maxLength: 64, optional: true },
      paths: { type: 'array', items: 'string', maxItems: MAX_TRASH_PATHS, description: 'Paths of the files or folders to trash.' },
    },
    async prepare(args, ctx) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertWritable(mount)
      const rows = await assertEntriesWritable(ctx, mount, pathsOf(args.paths, MAX_TRASH_PATHS))
      return {
        targetId: rows.map((row) => row.id).join(','),
        targetLabel: approvalLabel('Move to trash', rows),
      }
    },
    async commit(targetId, ctx, args) {
      const mount = await mountFor(ctx, mountIdOf(args.mountId))
      assertWritable(mount)
      const ids = targetId.split(',').filter(Boolean)
      if (ids.length === 0) throw new ToolError('Nothing was named to trash.')
      // Only still-live rows: a file the reader already trashed in the meantime needs no second move.
      const live = (await ctx.env.DB.prepare(
        `SELECT id FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND deleted_at IS NULL AND id IN (${
          ids.map(() => '?').join(', ')
        })`,
      ).bind(ctx.store.userId, mount.id, ...ids).all<{ id: string }>()).results ?? []
      if (live.length === 0) throw new ToolError('Those files are no longer in the drive; nothing was trashed.')
      const deleted = await trashEntries(ctx.env.DB, ctx.store.userId, mount.id, live.map((row) => row.id), Date.now())
      return { trashed: deleted, restorable: true }
    },
  },
  {
    name: 'drive_empty_trash',
    permission: 'destructive',
    maxCallsPerTurn: 1,
    description: 'Permanently erase everything in the trash, or the trash of one mount. This cannot be undone, so it only happens after the reader approves a card that names how many items will go.',
    fields: {
      mountId: { type: 'string', description: 'Limit this to one mount; omit to erase the whole trash.', maxLength: 64, optional: true },
    },
    async prepare(args, ctx) {
      const mountId = args.mountId === undefined ? null : mountIdOf(args.mountId)
      if (mountId) {
        const mount = await mountFor(ctx, mountId)
        assertWritable(mount)
      } else {
        assertWritable(await mountFor(ctx, PRIMARY_MOUNT))
      }
      const count = await ctx.env.DB.prepare(
        mountId
          ? 'SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND deleted_at IS NOT NULL'
          : 'SELECT COUNT(*) AS count FROM CloudDrive_files WHERE user_id = ? AND deleted_at IS NOT NULL',
      ).bind(...(mountId ? [ctx.store.userId, mountId] : [ctx.store.userId])).first<{ count: number }>()
      const total = Number(count?.count ?? 0)
      if (total === 0) throw new ToolError('The trash is already empty; there is nothing to erase.')
      return {
        targetId: mountId ? `mount:${mountId}` : 'all',
        targetLabel: `Erase ${total} item${total === 1 ? '' : 's'} from the trash for good`,
      }
    },
    async commit(targetId, ctx) {
      if (targetId === 'all') {
        const purged = await purgeAllTrash(ctx.env.DB, ctx.store.userId, ctx.env)
        if (purged.deleted === 0) throw new ToolError('The trash was already empty.')
        return { deleted: purged.deleted, failed: purged.failed }
      }
      const mount = await mountFor(ctx, targetId.replace(/^mount:/, ''))
      assertWritable(mount)
      const rows = (await ctx.env.DB.prepare(
        'SELECT id FROM CloudDrive_files WHERE user_id = ? AND mount_id = ? AND deleted_at IS NOT NULL',
      ).bind(ctx.store.userId, mount.id).all<{ id: string }>()).results ?? []
      if (rows.length === 0) throw new ToolError('The trash was already empty.')
      const purged = await purgeTrashEntries(ctx.env.DB, ctx.store.userId, mount.id, rows.map((row) => row.id), ctx.env)
      return { deleted: purged.deleted, failed: purged.failed }
    },
  },
]
