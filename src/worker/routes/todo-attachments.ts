/**
 * The HTTP surface of task attachments: upload a file to a task, list what the task shows, detach one.
 *
 * There is no second upload path here. The bytes go through the same `attachments/storage.ts` the note
 * files use — the same hourly `attachment-upload:<user>` budget, multipart ceiling, 25 MB limit, MIME
 * sniffing, filename cleanup, per-account quota and R2/KV choice — because a parallel reader of
 * `LIMITS` would be a second set of limits to keep in step. This file only adds the link row.
 *
 * Unlinking is not deleting: the `attachments` row and the stored object stay, and another task's link
 * to the same file is untouched. Nothing here cascades either, so trashing or purging a task leaves its
 * files and links in place, exactly as trashing a note leaves a note's attachments alone. Two existing
 * rules are worth stating because a task link reads like a retention promise and is not one:
 *  - the orphan sweep (`POST /api/files/prune`) scans note bodies and retained versions only and does
 *    not read `todos_attachments`, so a task link does not pin a file against that sweep;
 *  - backups export only the files a note references, so a task attachment is not a new export column
 *    and travels only when a note also embeds it.
 *
 * Every statement is scoped by the session's account, so another account's task or file is a 404.
 */
import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import type { Attachment } from '@shared/types'
import {
  persistAttachmentWithinQuota,
  rollbackPersistedAttachments,
} from '../attachments/storage'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import {
  linkTodoAttachment,
  listTodoAttachments,
  todoTaskIsLive,
  unlinkTodoAttachment,
  type TodoAttachmentRow,
} from '../todos/schema'

export const todoAttachmentRoutes = new Hono<AppBindings>()

function taskIdParam(value: string): string {
  if (!isValidId(value)) throw ApiError.notFound('Task not found')
  return value
}

type AttachmentFields = Pick<
  Attachment,
  'id' | 'filename' | 'mime' | 'size' | 'width' | 'height' | 'createdAt'
>

function toAttachment(fields: AttachmentFields): Attachment {
  return {
    id: fields.id,
    noteId: null,
    filename: fields.filename,
    mime: fields.mime,
    size: fields.size,
    width: fields.width,
    height: fields.height,
    url: `/api/files/${fields.id}`,
    createdAt: fields.createdAt,
  }
}

function toAttachmentRow(row: TodoAttachmentRow): Attachment {
  return toAttachment({
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  })
}

todoAttachmentRoutes.post('/:id/attachments', requireAuth, async (c) => {
  const userId = c.get('userId')
  const taskId = taskIdParam(c.req.param('id'))
  // Proven before the body is read: a task this account cannot see is a 404 even when the caller
  // brought a 25 MB upload with them.
  if (!(await todoTaskIsLive(c.env.DB, userId, taskId))) throw ApiError.notFound('Task not found')

  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `attachment-upload:${userId}`,
    maxAttempts: LIMITS.attachmentUploadsPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many uploads')

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  if (file.size > LIMITS.attachmentMaxBytes) {
    throw ApiError.tooLarge('The file exceeds the 25 MB limit')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = newId()
  const now = Date.now()
  // `noteId` stays null: a task is not a note, and the files listing and backup path key off notes.
  const stored = await persistAttachmentWithinQuota(c.env, {
    id,
    userId,
    scope: 'todos',
    noteId: null,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    createdAt: now,
  })

  try {
    if (!(await linkTodoAttachment(c.env.DB, userId, taskId, id, now))) {
      throw ApiError.notFound('Attachment not found')
    }
  } catch (error) {
    // The upload already landed; a link that cannot be written must not leave a file nothing names.
    await rollbackPersistedAttachments(c.env, [stored]).catch((rollbackError) => {
      console.warn('[inkstone] Task attachment rollback will retry later:', rollbackError)
    })
    throw error
  }

  return c.json({ attachment: toAttachment(stored) }, 201)
})

todoAttachmentRoutes.get('/:id/attachments', requireAuth, async (c) => {
  const userId = c.get('userId')
  const taskId = taskIdParam(c.req.param('id'))
  // A trashed task is not a list this app answers; its links stay, but they are not shown anywhere.
  if (!(await todoTaskIsLive(c.env.DB, userId, taskId))) throw ApiError.notFound('Task not found')

  const rows = await listTodoAttachments(c.env.DB, userId, taskId)
  return c.json({ attachments: rows.map(toAttachmentRow) })
})

todoAttachmentRoutes.delete('/:id/attachments/:attachmentId', requireAuth, async (c) => {
  const userId = c.get('userId')
  const taskId = taskIdParam(c.req.param('id'))
  const attachmentId = c.req.param('attachmentId')
  if (!isValidId(attachmentId)) throw ApiError.notFound('Attachment not found')
  if (!(await todoTaskIsLive(c.env.DB, userId, taskId))) throw ApiError.notFound('Task not found')
  if (!(await unlinkTodoAttachment(c.env.DB, userId, taskId, attachmentId))) {
    throw ApiError.notFound('Attachment not found')
  }
  return c.json({ deleted: true })
})
