import { officeBytesExceeded } from '@shared/office/quota'
import type { OfficeEditPlan } from '@shared/office/ai'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { applyPlanToSheetsSnapshot } from './plan-apply'
import { requireOfficeBucket } from './storage'
import { writeSnapshot } from './snapshot-write'
import type { OfficeFileRow, OfficeStore } from './store'

/**
 * Applies a plan to a file that is stored but not open, on behalf of a caller with no editor.
 *
 * The revision goes through the same writer the HTTP route uses, so a scheduled write is
 * indistinguishable from a saved edit: same conflict rules, same version trim, same quota ceiling.
 */
export async function applyPlanToStoredFile(
  env: Env,
  userId: string,
  store: OfficeStore,
  file: OfficeFileRow,
  plan: OfficeEditPlan,
): Promise<{ rev: number; size: number }> {
  if (file.type !== 'sheets') {
    throw ApiError.badRequest('A plan can only be applied without an editor to a sheet')
  }
  const bucket = requireOfficeBucket(env)
  const object = file.snapshot_key ? await bucket.get(file.snapshot_key) : null
  const current = object ? JSON.parse(await object.text()) as unknown : { sheets: {}, sheetOrder: [] }
  const next = applyPlanToSheetsSnapshot(current, plan)
  const text = JSON.stringify(next)
  if (officeBytesExceeded(await store.sumBytes(), text.length, file.size)) {
    throw ApiError.forbidden('Office storage is full')
  }
  const written = await writeSnapshot(env, userId, store, file, file.rev, text, text.length)
  return { rev: written.rev, size: written.size }
}
