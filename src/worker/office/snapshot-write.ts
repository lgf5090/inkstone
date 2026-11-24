import { OFFICE_LIMITS, officeSnapshotKey } from '@shared/office/constants'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { deleteOfficeObjects, discardOfficeObjects, officeSnapshotExists, putOfficeSnapshot } from './storage'
import type { OfficeFileRow, OfficeStore } from './store'

/**
 * Move the file pointer to a freshly written revision.
 *
 * The R2 object is written first so the conditional update never publishes a key that does not
 * exist. A lost race (or a file deleted underneath) removes the orphan and answers 409/404.
 */
export async function writeSnapshot(
  env: Env,
  userId: string,
  s: OfficeStore,
  file: OfficeFileRow,
  baseRev: number,
  text: string,
  size: number,
): Promise<{ rev: number; size: number; updatedAt: number }> {
  const rev = baseRev + 1
  const key = officeSnapshotKey(userId, file.id, rev)
  // A revision object is immutable. If this one already exists the file's pointer is at or past
  // it, so this write lost the race before it began: refuse instead of overwriting a kept version.
  if (await officeSnapshotExists(env, key)) {
    const current = await s.fileRow(file.id)
    if (current && current.rev >= rev) {
      throw new ApiError(
        409,
        'conflict',
        'The file was changed elsewhere. Reload and try again',
        { currentRev: current.rev },
      )
    }
  }
  const contentHash = await sha256Hex(text)
  await putOfficeSnapshot(env, key, text)
  const now = Date.now()
  const result = await s.saveSnapshot({
    fileId: file.id,
    baseRev,
    rev,
    snapshotKey: key,
    size,
    contentHash,
    now,
  })
  if (!result.applied) {
    const current = await s.fileRow(file.id)
    // The object this write created is only garbage when nothing points at it; a concurrent
    // winner that committed the same revision keeps its object.
    if (!current || current.deleted_at !== null) {
      await discardOfficeObjects(env, [key])
      throw ApiError.notFound('File not found')
    }
    if (current.snapshot_key !== key) await discardOfficeObjects(env, [key])
    throw new ApiError(
      409,
      'conflict',
      'The file was changed elsewhere. Reload and try again',
      { currentRev: current.rev },
    )
  }
  await trimVersions(env, s, file.id)
  return { rev, size, updatedAt: now }
}

/**
 * Drop revisions past the per-file cap.
 *
 * Objects are deleted before their rows: a deleted object with a surviving row is a listed version
 * that cannot open, while a surviving object with no row is unreachable garbage. When R2 refuses,
 * the rows are kept and the next save retries the trim.
 */
async function trimVersions(env: Env, s: OfficeStore, fileId: string): Promise<void> {
  const keys = await s.versionKeysBeyond(fileId, OFFICE_LIMITS.versionsPerFile)
  if (!keys.length) return
  try {
    await deleteOfficeObjects(env, keys)
  } catch (error) {
    console.warn('[inkstone] Office version trim could not delete old objects; rows kept:', error)
    return
  }
  await s.deleteVersionsBeyond(fileId, OFFICE_LIMITS.versionsPerFile)
}

