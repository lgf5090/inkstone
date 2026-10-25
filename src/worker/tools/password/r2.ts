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
