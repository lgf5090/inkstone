import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { buildEntry, resolveMount, tagsForFiles, type CloudDriveFileRow } from './lib'
import { storageKeyReferenced } from './store-files'

export const clouddriveVersionRoutes = new Hono<AppBindings>()

clouddriveVersionRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const VERSION_KEEP = 10

interface VersionRow {
  version: number
  storage_key: string
  size: number
  mime: string
  etag: string | null
  checksum: string | null
  created_at: number
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

async function liveFile(c: Context<AppBindings>, id: string): Promise<CloudDriveFileRow> {
  if (!isValidId(id)) throw ApiError.notFound('File not found')
  const row = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND id = ? AND kind = 'file' AND deleted_at IS NULL`,
  ).bind(userIdOf(c), id).first<CloudDriveFileRow>()
  if (!row) throw ApiError.notFound('File not found')
  return row
}

async function versionOf(c: Context<AppBindings>, fileId: string, version: number): Promise<VersionRow | null> {
  return await c.env.DB.prepare(
    `SELECT version, storage_key, size, mime, etag, checksum, created_at
       FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ? AND version = ?`,
  ).bind(userIdOf(c), fileId, version).first<VersionRow>()
}

async function entryOf(c: Context<AppBindings>, file: CloudDriveFileRow) {
  const mount = await resolveMount(c.env.DB, userIdOf(c), file.mount_id)
  const tags = await tagsForFiles(c.env.DB, userIdOf(c), [file.id])
  return buildEntry(file, mount, tags.get(file.id) ?? [])
}

async function nextVersion(c: Context<AppBindings>, fileId: string): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version FROM CloudDrive_file_versions
      WHERE user_id = ? AND file_id = ?`,
  ).bind(userIdOf(c), fileId).first<{ version: number }>()
  return (row?.version ?? 0) + 1
}

async function prune(c: Context<AppBindings>, fileId: string): Promise<void> {
  const { results } = await c.env.DB.prepare(
    `SELECT version, storage_key FROM CloudDrive_file_versions
      WHERE user_id = ? AND file_id = ? ORDER BY version DESC`,
  ).bind(userIdOf(c), fileId).all<{ version: number; storage_key: string }>()
  const extra = (results ?? []).slice(VERSION_KEEP)
  if (extra.length === 0) return
  await c.env.DB.batch(extra.map((row) => c.env.DB.prepare(
    `DELETE FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ? AND version = ?`,
  ).bind(userIdOf(c), fileId, row.version)))
  if (!c.env.FILES) return
  for (const key of new Set(extra.map((row) => row.storage_key))) {
    if (await storageKeyReferenced(c.env.DB, userIdOf(c), key)) continue
    try {
      await c.env.FILES.delete(key)
    } catch (error) {
      console.warn('[clouddrive] pruning an old file version left an orphan object:', key, error)
    }
  }
}

clouddriveVersionRoutes.get('/files/:id/versions', async (c) => {
  const file = await liveFile(c, c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT version, size, mime, created_at FROM CloudDrive_file_versions
      WHERE user_id = ? AND file_id = ? ORDER BY version DESC`,
  ).bind(userIdOf(c), file.id).all<{ version: number; size: number; mime: string; created_at: number }>()
  return c.json({
    versions: (results ?? []).map((row) => ({
      version: row.version,
      size: row.size,
      mime: row.mime,
      createdAt: row.created_at,
    })),
  })
})

clouddriveVersionRoutes.post('/files/:id/versions/:version/restore', async (c) => {
  const file = await liveFile(c, c.req.param('id'))
  const versionNumber = Number(c.req.param('version'))
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw ApiError.badRequest('version is invalid')
  const version = await versionOf(c, file.id, versionNumber)
  if (!version) throw ApiError.notFound('Version not found')
  if (!file.storage_key) throw new ApiError(503, 'clouddrive_mount_unavailable', 'This file has no object')

  const now = Date.now()
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO CloudDrive_file_versions
         (user_id, file_id, version, storage_key, size, mime, etag, checksum, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      userIdOf(c), file.id, await nextVersion(c, file.id), file.storage_key,
      file.size, file.mime, file.etag, file.checksum, now,
    ),
    c.env.DB.prepare(
      `UPDATE CloudDrive_files
          SET storage_key = ?3, size = ?4, mime = ?5, etag = ?6, checksum = ?7,
              updated_at = ?8, modified_at = ?8
        WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    ).bind(userIdOf(c), file.id, version.storage_key, version.size, version.mime, version.etag, version.checksum, now),
    c.env.DB.prepare(
      `DELETE FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ? AND version = ?`,
    ).bind(userIdOf(c), file.id, versionNumber),
  ]
  await c.env.DB.batch(statements)
  await prune(c, file.id)
  const updated = await liveFile(c, file.id)
  return c.json({ entry: await entryOf(c, updated) })
})

clouddriveVersionRoutes.delete('/files/:id/versions/:version', async (c) => {
  const file = await liveFile(c, c.req.param('id'))
  const versionNumber = Number(c.req.param('version'))
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw ApiError.badRequest('version is invalid')
  const version = await versionOf(c, file.id, versionNumber)
  if (!version) throw ApiError.notFound('Version not found')
  await c.env.DB.prepare(
    `DELETE FROM CloudDrive_file_versions WHERE user_id = ? AND file_id = ? AND version = ?`,
  ).bind(userIdOf(c), file.id, versionNumber).run()
  if (c.env.FILES && !(await storageKeyReferenced(c.env.DB, userIdOf(c), version.storage_key))) {
    try {
      await c.env.FILES.delete(version.storage_key)
    } catch (error) {
      console.warn('[clouddrive] deleting a file version left an orphan object:', version.storage_key, error)
    }
  }
  return c.json({ ok: true })
})
