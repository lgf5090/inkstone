/** File-tag assignments and their visible aggregates. */
import { CLOUDDRIVE_LIMITS, foldedName, type CloudDriveTagView } from '@shared/clouddrive/model'
import { ApiError } from '../lib/errors'

export interface CloudDriveTagAssignment {
  tag: string
  tagFolded: string
  color: string
  fileId: string
  name: string
  path: string
}

/**
 * Every tag assignment with the folder it hangs on, so the caller can drop the rows a locked or
 * hidden directory took off the listing before it counts them.
 */
export async function listTagAssignments(
  db: D1Database,
  userId: string,
  mountId: string,
): Promise<CloudDriveTagAssignment[]> {
  const { results } = await db.prepare(
    `SELECT t.tag AS tag, t.tag_folded AS tagFolded, t.color AS color, t.file_id AS fileId,
            f.name AS name, f.path AS path
       FROM CloudDrive_file_tags t
       JOIN CloudDrive_files f ON f.user_id = t.user_id AND f.id = t.file_id
      WHERE t.user_id = ? AND f.mount_id = ? AND f.deleted_at IS NULL
      ORDER BY t.tag_folded, t.tag`,
  ).bind(userId, mountId).all<CloudDriveTagAssignment>()
  return (results ?? []).map((row) => ({
    tag: row.tag,
    tagFolded: row.tagFolded,
    color: row.color ?? '',
    fileId: row.fileId,
    name: row.name,
    path: row.path,
  }))
}

export function countVisibleTags(assignments: readonly CloudDriveTagAssignment[]): { name: string; color: string; count: number }[] {
  const groups = new Map<string, { name: string; color: string; ids: Set<string> }>()
  for (const row of assignments) {
    const group = groups.get(row.tagFolded)
    if (group) {
      group.ids.add(row.fileId)
      if (row.tag > group.name) group.name = row.tag
      if (row.color > group.color) group.color = row.color
    } else {
      groups.set(row.tagFolded, { name: row.tag, color: row.color, ids: new Set([row.fileId]) })
    }
  }
  return [...groups.entries()]
    .map(([tagFolded, group]) => ({ name: group.name, color: group.color, count: group.ids.size, tagFolded }))
    .sort((left, right) => right.count - left.count || left.tagFolded.localeCompare(right.tagFolded))
    .map(({ name, color, count }) => ({ name, color, count }))
}

function normalizeTag(tag: string): { tag: string; tagFolded: string } {
  const trimmed = tag.normalize('NFC').trim()
  if (trimmed.length === 0 || trimmed.length > CLOUDDRIVE_LIMITS.tagMaxLength) {
    throw ApiError.badRequest(`A tag must contain 1 to ${CLOUDDRIVE_LIMITS.tagMaxLength} characters`)
  }
  if (/[\u0000-\u001f]/.test(trimmed)) throw ApiError.badRequest('A tag cannot contain a control character')
  return { tag: trimmed, tagFolded: foldedName(trimmed) }
}

export async function upsertTag(
  db: D1Database,
  userId: string,
  fileId: string,
  tag: string,
  color: string,
  now: number,
): Promise<void> {
  const normalized = normalizeTag(tag)
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ?`,
  ).bind(userId, fileId).first<{ count: number }>()
  const existing = await db.prepare(
    `SELECT 1 AS present FROM CloudDrive_file_tags
      WHERE user_id = ? AND file_id = ? AND tag_folded = ?`,
  ).bind(userId, fileId, normalized.tagFolded).first<{ present: number }>()
  if (!existing && (count?.count ?? 0) >= CLOUDDRIVE_LIMITS.tagsPerFileMax) {
    throw ApiError.badRequest(`A file can have at most ${CLOUDDRIVE_LIMITS.tagsPerFileMax} tags`)
  }
  await db.prepare(
    `INSERT INTO CloudDrive_file_tags (user_id, file_id, tag, tag_folded, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, file_id, tag_folded)
     DO UPDATE SET tag = excluded.tag, color = excluded.color`,
  ).bind(userId, fileId, normalized.tag, normalized.tagFolded, color, now).run()
}

export async function removeTag(db: D1Database, userId: string, fileId: string, tag: string): Promise<void> {
  const normalized = normalizeTag(tag)
  await db.prepare(
    `DELETE FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ? AND tag_folded = ?`,
  ).bind(userId, fileId, normalized.tagFolded).run()
}

export async function tagsOf(db: D1Database, userId: string, fileId: string): Promise<CloudDriveTagView[]> {
  const { results } = await db.prepare(
    `SELECT tag, color FROM CloudDrive_file_tags WHERE user_id = ? AND file_id = ? ORDER BY created_at, tag_folded`,
  ).bind(userId, fileId).all<{ tag: string; color: string }>()
  return (results ?? []).map((row) => ({ name: row.tag, color: row.color }))
}
