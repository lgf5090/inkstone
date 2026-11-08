/**
 * Project attachments (F-8/D-9): bytes live in R2 under a four-segment `project/<category>/<user>/<id>`
 * key, rows in project_attachments. The category segment keeps images/pdf/text apart for browsing and
 * cleanup. Uploads are editor-only; reads follow the board's viewer boundary so a private board's
 * files stay private.
 */
import type { ProjectAttachment, ProjectAttachmentCategory } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'
import { extensionFor } from '../lib/image'
import { ApiError } from '../lib/errors'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

interface AttachmentRow {
  id: string
  user_id: string
  board_id: string
  card_id: string | null
  filename: string
  mime: string
  size: number
  storage: string
  object_key: string
  width: number | null
  height: number | null
  thumbnail_key: string | null
  created_at: number
  updated_at: number
}

function rowToAttachment(row: AttachmentRow): ProjectAttachment {
  return {
    id: row.id, userId: row.user_id, boardId: row.board_id, cardId: row.card_id,
    filename: row.filename, mime: row.mime, size: row.size, storage: row.storage as ProjectAttachment['storage'],
    objectKey: row.object_key, width: row.width, height: row.height, thumbnailKey: row.thumbnail_key,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function attachmentCategory(mime: string): ProjectAttachmentCategory {
  if (mime.startsWith('image/')) return 'images'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'txt'
  if (mime.includes('word') || mime.includes('document')) return 'docx'
  if (mime.includes('sheet') || mime.includes('excel')) return 'sheets'
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slides'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return 'archives'
  return 'other'
}

export async function listBoardAttachments(db: D1Database, boardId: string, cardId?: string): Promise<ProjectAttachment[]> {
  const { results } = cardId
    ? await db.prepare('SELECT * FROM project_attachments WHERE board_id = ?1 AND card_id = ?2 ORDER BY created_at DESC').bind(boardId, cardId).all<AttachmentRow>()
    : await db.prepare('SELECT * FROM project_attachments WHERE board_id = ?1 ORDER BY created_at DESC').bind(boardId).all<AttachmentRow>()
  return results.map(rowToAttachment)
}

export async function getProjectAttachment(db: D1Database, id: string): Promise<ProjectAttachment | null> {
  const row = await db.prepare('SELECT * FROM project_attachments WHERE id = ?1').bind(id).first<AttachmentRow>()
  return row ? rowToAttachment(row) : null
}

export async function uploadProjectAttachment(
  db: D1Database,
  r2: R2Bucket | undefined,
  input: { boardId: string, cardId: string | null, userId: string, filename: string, mime: string, bytes: Uint8Array },
  now: number,
): Promise<ProjectAttachment> {
  if (!r2) throw ApiError.badRequest('File storage is not configured')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw ApiError.tooLarge('File too large')
  const id = newProjectId('attachment')
  const category = attachmentCategory(input.mime)
  const objectKey = `project/${category}/${input.userId}/${id}.${extensionFor(input.mime, input.filename)}`
  await r2.put(objectKey, input.bytes, { httpMetadata: { contentType: input.mime } })
  await db.prepare(
    `INSERT INTO project_attachments (id, user_id, board_id, card_id, filename, mime, size, storage, object_key, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'r2', ?8, ?9, ?9)`,
  ).bind(id, input.userId, input.boardId, input.cardId, input.filename, input.mime, input.bytes.byteLength, objectKey, now).run()
  return {
    id, userId: input.userId, boardId: input.boardId, cardId: input.cardId, filename: input.filename, mime: input.mime,
    size: input.bytes.byteLength, storage: 'r2', objectKey, width: null, height: null, thumbnailKey: null, createdAt: now, updatedAt: now,
  }
}

export async function deleteProjectAttachment(db: D1Database, r2: R2Bucket | undefined, attachment: ProjectAttachment): Promise<void> {
  if (r2) await r2.delete(attachment.objectKey).catch(() => undefined)
  await db.prepare('DELETE FROM project_attachments WHERE id = ?1').bind(attachment.id).run()
}

export const PROJECT_UPLOAD_LIMIT = MAX_UPLOAD_BYTES