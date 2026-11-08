/**
 * R2 storage helpers for Password Manager backups.
 *
 * Backups are ciphertext snapshots. Plaintext exports never reach the server: the client already
 * holds the decrypted rows and downloads the file itself, so there is no export object to retain or
 * sweep.
 *
 * Path invariant: `tools/password/backup/${userId}/${backupId}.json`
 */

import { ApiError } from '../../lib/errors'

export function getBackupR2Key(userId: string, backupId: string): string {
  return `tools/password/backup/${userId}/${backupId}.json`
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
