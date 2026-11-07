/**
 * R2 storage helpers for Short Links backups and exported files.
 *
 * Path invariants:
 * - Backups: `tools/shortlinks/backup/${userId}/${backupId}.json`
 * - Plaintext TXT: `tools/shortlinks/txt/${userId}/${fileId}.txt`
 * - Protected TXT: `tools/shortlinks/txt/${userId}/protected_${fileId}.txt`
 * - Plaintext CSV: `tools/shortlinks/csv/${userId}/${fileId}.csv`
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
