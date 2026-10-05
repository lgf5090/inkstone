import { LIMITS } from '@shared/constants'
import { ApiError } from '../lib/errors'

export async function assertNoteQuota(db: D1Database, userId: string, adding = 1): Promise<void> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>()
  if ((row?.n ?? 0) + adding > LIMITS.notesMaxPerUser) {
    throw new ApiError(
      403,
      'note_quota_exceeded',
      `This account already holds ${LIMITS.notesMaxPerUser} notes; the quota is exhausted`,
    )
  }
}
