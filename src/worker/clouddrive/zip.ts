/**
 * Streaming ZIP downloads for CloudDrive.
 *
 * The archive is assembled as a `ReadableStream` and never buffered: a folder can hold gigabytes, and
 * the isolate's memory is the same 128 MB whether the reader asked for one file or for a whole tree.
 * `client-zip` already ships for the backup archive, so this is a second caller of one library rather
 * than a second zip engine.
 *
 * Two ceilings keep the response honest: `zipMaxItems` bounds how many rows are walked and
 * `zipMaxBytes` bounds the uncompressed total, because a ZIP of a petabyte folder is not something a
 * browser should be asked to wait for. Both refuse up front with 413 instead of truncating silently.
 */
import { makeZip } from 'client-zip'
import { CLOUDDRIVE_LIMITS } from '@shared/clouddrive/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { contentDisposition } from '../lib/http-range'
import { fileParts, distributedStream } from './distributed'
import type { CloudDriveMountInfo } from './lib'

interface ZipRow {
  id: string
  parent_id: string
  path: string
  name: string
  kind: 'folder' | 'file'
  mime: string
  size: number
  storage_key: string | null
  storage_kind: string
  modified_at: number
}

export interface ZipSource {
  name: string
  lastModified: number
  input: ReadableStream | Blob | Uint8Array
}

export interface FolderZip {
  filename: string
  items: number
  bytes: number
  stream: ReadableStream<Uint8Array>
}

/**
 * Collect the subtree under `rootPath` (or the single row addressed by id) and pack it.
 *
 * `skip` is the caller's visibility filter — hidden patterns and folder locks are the route's business,
 * not the archiver's, so this module only sees rows it has been told may be packed.
 */
export async function buildFolderZip(
  env: Env,
  db: D1Database,
  userId: string,
  mount: CloudDriveMountInfo,
  rootPath: string,
  skip: (row: ZipRow) => boolean | Promise<boolean>,
): Promise<FolderZip> {
  // The `substr` prefix test cannot be spoofed by a `%` in a folder name, but it also cannot describe
  // the drive root (which is not a prefix of its own children in that form), so the root takes the
  // unconditional branch.
  const limit = CLOUDDRIVE_LIMITS.zipMaxItems + 1
  const { results } = rootPath === '/'
    ? await db.prepare(
      `SELECT id, parent_id, path, name, kind, mime, size, storage_key, storage_kind, modified_at
         FROM CloudDrive_files
        WHERE user_id = ?1 AND mount_id = ?2 AND deleted_at IS NULL
        ORDER BY path
        LIMIT ?3`,
    ).bind(userId, mount.id, limit).all<ZipRow>()
    : await db.prepare(
      `SELECT id, parent_id, path, name, kind, mime, size, storage_key, storage_kind, modified_at
         FROM CloudDrive_files
        WHERE user_id = ?1 AND mount_id = ?2 AND deleted_at IS NULL
          AND (path = ?3 OR substr(path, 1, length(?3) + 1) = ?3 || '/')
        ORDER BY path
        LIMIT ?4`,
    ).bind(userId, mount.id, rootPath, limit).all<ZipRow>()
  const rows = results ?? []
  if (rows.length > CLOUDDRIVE_LIMITS.zipMaxItems) {
    throw new ApiError(413, 'clouddrive_folder_too_large', `A download holds at most ${CLOUDDRIVE_LIMITS.zipMaxItems} entries`)
  }
  const visible: ZipRow[] = []
  for (const row of rows) {
    if (await skip(row)) continue
    visible.push(row)
  }
  const files = visible.filter((row) => row.kind === 'file')
  const bytes = files.reduce((sum, row) => sum + row.size, 0)
  if (bytes > CLOUDDRIVE_LIMITS.zipMaxBytes) {
    throw new ApiError(413, 'clouddrive_folder_too_large', 'The download is larger than the archive limit')
  }
  const rootName = rootPath === '/' ? mount.name : rootPath.slice(rootPath.lastIndexOf('/') + 1)
  const prefix = rootPath === '/' ? '' : `${rootName}/`
  const sources: ZipSource[] = []
  for (const row of visible) {
    // A ZIP entry may not start with `/`: that would name an absolute path rather than a member of the
    // archive, and the root of the drive has no directory of its own to name.
    const relative = row.path.slice(rootPath === '/' ? 1 : rootPath.length + 1)
    const name = `${prefix}${relative}`
    if (row.kind === 'folder') {
      sources.push({ name: `${name}/`, lastModified: row.modified_at, input: new Uint8Array(0) })
      continue
    }
    sources.push({ name, lastModified: row.modified_at, input: await openRow(env, db, userId, row) })
  }
  if (files.length === 0) {
    // An empty folder still has to answer with something a reader can open, not a 404.
    sources.push({ name: `${rootName}/`, lastModified: Date.now(), input: new Uint8Array(0) })
  }
  return {
    filename: `${rootName || 'download'}.zip`,
    items: files.length,
    bytes,
    stream: makeZip(sources, { buffersAreUTF8: true }),
  }
}

async function openRow(
  env: Env,
  db: D1Database,
  userId: string,
  row: ZipRow,
): Promise<ReadableStream | Uint8Array> {
  if (row.storage_kind === 'distributed') {
    const parts = await fileParts(db, userId, row.id)
    if (parts.length === 0) throw new ApiError(404, 'not_found', `The parts of ${row.name} are missing`)
    return await distributedStream(env, db, userId, parts, 0, row.size)
  }
  if (!row.storage_key || !env.FILES) throw new ApiError(404, 'not_found', `The content of ${row.name} is missing`)
  const object = await env.FILES.get(row.storage_key)
  if (!object?.body) throw new ApiError(404, 'not_found', `The content of ${row.name} is missing`)
  return object.body
}

export function zipDisposition(filename: string): string {
  return contentDisposition('application/zip', filename).replace(/^inline;/, 'attachment;')
}
