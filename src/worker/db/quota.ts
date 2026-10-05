import { LIMITS } from '@shared/constants'
import { ApiError } from '../lib/errors'

export async function countLiveNotes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function assertNoteQuota(db: D1Database, userId: string, adding = 1): Promise<void> {
  assertQuotaRoom(await countLiveNotes(db, userId), adding)
}

export function assertQuotaRoom(liveNotes: number, adding = 1): void {
  if (liveNotes + adding > LIMITS.notesMaxPerUser) {
    throw new ApiError(
      403,
      'note_quota_exceeded',
      `This account already holds ${LIMITS.notesMaxPerUser} notes; the quota is exhausted`,
    )
  }
}

/**
 * Import runs hold a per-account import lease, so one count per request can budget every
 * note it inserts instead of paying a COUNT round trip per note.
 */
export interface NoteQuotaBudget {
  remaining: number
}

export async function openNoteQuotaBudget(db: D1Database, userId: string): Promise<NoteQuotaBudget> {
  return { remaining: LIMITS.notesMaxPerUser - await countLiveNotes(db, userId) }
}

export function consumeNoteQuota(budget: NoteQuotaBudget): void {
  if (--budget.remaining < 0) {
    throw new ApiError(
      403,
      'note_quota_exceeded',
      `This account already holds ${LIMITS.notesMaxPerUser} notes; the quota is exhausted`,
    )
  }
}
