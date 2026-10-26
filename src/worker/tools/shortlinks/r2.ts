/**
 * R2 storage helpers for Short Links backups, exported files, and QR images.
 *
 * Path invariants:
 * - Backups: `tools/shortlinks/backup/${userId}/${backupId}.json`
 * - Plaintext TXT: `tools/shortlinks/txt/${userId}/${fileId}.txt`
 * - Protected TXT: `tools/shortlinks/txt/${userId}/protected_${fileId}.txt`
 * - Plaintext CSV: `tools/shortlinks/csv/${userId}/${fileId}.csv`
 * - QR Images: `tools/shortlinks/qr/${userId}/${slug}.png`
 */

import { ApiError } from '../../lib/errors'

export function getShortlinksBackupR2Key(userId: string, backupId: string): string {
  return `tools/shortlinks/backup/${userId}/${backupId}.json`
}

export function getShortlinksExportTxtR2Key(userId: string, fileId: string, isProtected = false): string {
  return isProtected
    ? `tools/shortlinks/txt/${userId}/protected_${fileId}.txt`
    : `tools/shortlinks/txt/${userId}/${fileId}.txt`
}

export function getShortlinksExportCsvR2Key(userId: string, fileId: string): string {
  return `tools/shortlinks/csv/${userId}/${fileId}.csv`
}

export function getShortlinksQrR2Key(userId: string, slug: string): string {
  return `tools/shortlinks/qr/${userId}/${slug}.png`
}

export async function uploadShortlinksFileToR2(
  r2: R2Bucket | undefined,
  key: string,
  content: string | Uint8Array,
  contentType: string,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  await r2.put(key, bytes, {
    httpMetadata: {
      contentType,
    },
  })

  return { key, size: bytes.byteLength }
}

export async function readShortlinksFileFromR2(
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

export async function deleteShortlinksFileFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<void> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  await r2.delete(key)
}
