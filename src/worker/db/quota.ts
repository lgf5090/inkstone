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

export async function assertOrganizerQuota(
  db: D1Database,
  userId: string,
  entity: 'folder' | 'tag',
): Promise<void> {
  const max = entity === 'folder' ? LIMITS.foldersMaxPerUser : LIMITS.tagsMaxPerUser
  const where = entity === 'folder'
    ? `SELECT COUNT(*) AS n FROM folders WHERE user_id = ?1 AND deleted_at IS NULL`
    : `SELECT COUNT(*) AS n FROM tags WHERE user_id = ?1`
  const row = await db.prepare(where).bind(userId).first<{ n: number }>()
  if ((row?.n ?? 0) + 1 > max) {
    throw new ApiError(
      403,
      'organizer_quota_exceeded',
      `This account already holds ${max} ${entity}s; the quota is exhausted`,
    )
  }
}
