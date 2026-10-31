/**
 * R2 storage helpers for Password Manager backups and export files.
 *
 * Path invariants:
 * - Backups: `tools/password/backup/${userId}/${backupId}.json`
 * - Plaintext TXT: `tools/password/txt/${userId}/${fileId}.txt`
 * - Plaintext CSV: `tools/password/csv/${userId}/${fileId}.csv`
 */

import { ApiError } from '../../lib/errors'

export function getBackupR2Key(userId: string, backupId: string): string {
  return `tools/password/backup/${userId}/${backupId}.json`
}

export function getExportTxtR2Key(userId: string, fileId: string): string {
  return `tools/password/txt/${userId}/${fileId}.txt`
}

export function getExportCsvR2Key(userId: string, fileId: string): string {
  return `tools/password/csv/${userId}/${fileId}.csv`
}

export async function uploadBackupToR2(
  r2: R2Bucket | undefined,
  userId: string,
  backupId: string,
  content: string,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const key = getBackupR2Key(userId, backupId)
  const bytes = new TextEncoder().encode(content)
  await r2.put(key, bytes, {
    httpMetadata: {
      contentType: 'application/json',
    },
  })

  return { key, size: bytes.byteLength }
}

export async function readBackupFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<string | null> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const obj = await r2.get(key)
  if (!obj) return null
  return await obj.text()
}

export async function deleteFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<void> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  await r2.delete(key)
}

export async function uploadExportToR2(
  r2: R2Bucket | undefined,
  userId: string,
  fileId: string,
  type: 'txt' | 'csv',
  content: string,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const key = type === 'txt' ? getExportTxtR2Key(userId, fileId) : getExportCsvR2Key(userId, fileId)
  const bytes = new TextEncoder().encode(content)
  await r2.put(key, bytes, {
    httpMetadata: {
      contentType: type === 'txt' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8',
    },
  })

  return { key, size: bytes.byteLength }
}

export async function readExportFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<string | null> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const obj = await r2.get(key)
  if (!obj) return null
  return await obj.text()
}

/** How long a plaintext export may sit in storage before the next export sweeps it. */
export const EXPORT_TTL_MS = 60 * 60 * 1000

/**
 * Deletes this user's exports of one format that are older than the TTL.
 *
 * A decrypted dump has no reason to outlive the download that produced it, and nothing used to
 * delete them: every export added a permanent plaintext object under the tenant's prefix.
 */
export async function purgeOldExports(
  r2: R2Bucket | undefined,
  userId: string,
  type: 'txt' | 'csv',
  now = Date.now(),
): Promise<number> {
  if (!r2) return 0

  const prefix = `tools/password/${type}/${userId}/`
  const cutoff = now - EXPORT_TTL_MS
  let purged = 0
  let cursor: string | undefined

  do {
    const listed = await r2.list({ prefix, cursor })
    for (const object of listed.objects) {
      if (object.uploaded.getTime() < cutoff) {
        await r2.delete(object.key)
        purged += 1
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return purged
}
