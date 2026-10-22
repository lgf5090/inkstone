import { Hono } from 'hono'
import {
  MEMO_ATTACHMENT_MAX_BYTES,
  MEMO_ATTACHMENT_UPLOADS_PER_HOUR,
  MEMO_MAX_PAGE_SIZE,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import type { MemoMediaMetadata, MemoMotionRole } from '@shared/memos/types'
import type { AppBindings } from '../../env'
import { ApiError, errorResponse } from '../../lib/errors'
import { fromBase64, toBase64 } from '../../lib/encoding'
import { isValidId, newId } from '../../lib/id'
import {
  JSON_BODY_LIMITS,
  clampInt,
  readFormDataWithinLimit,
  readJson,
} from '../../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../../lib/throttle'
import { requireMemoUser } from '../../memos/auth'
import {
  MEMO_ATTACHMENT_SCOPES,
  MemoAttachmentError,
  deleteMemoAttachments,
  getMemoAttachment,
  listMemoAttachments,
  pruneUnusedMemoAttachments,
  saveMemoAttachment,
  toMemoAttachmentView,
  type MemoAttachmentScope,
} from '../../memos/attachments'
import { parseMemoMediaMetadata } from '../../memos/media'

const UPLOAD_WINDOW_MS = 60 * 60 * 1000
const MEMO_UPLOAD_FORM_LIMIT = MEMO_ATTACHMENT_MAX_BYTES * 2 + 1024 * 1024
const MEDIA_METADATA_MAX_CHARS = 16 * 1024
const CURSOR_MAX_CHARS = 128
const BATCH_DELETE_MAX = 100

export const memoAttachmentRoutes = new Hono<AppBindings>()

memoAttachmentRoutes.use('*', requireMemoUser)

memoAttachmentRoutes.onError((err, c) => {
  if (err instanceof MemoAttachmentError) {
    return c.json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    }, err.status)
  }
  return errorResponse(c, err)
})

memoAttachmentRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [{
    key: `attachment-upload:${userId}`,
    maxAttempts: MEMO_ATTACHMENT_UPLOADS_PER_HOUR,
    windowMs: UPLOAD_WINDOW_MS,
    lockMs: UPLOAD_WINDOW_MS,
  }]), 'Too many uploads')

  const form = await readFormDataWithinLimit(c.req, MEMO_UPLOAD_FORM_LIMIT)

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  if (file.size > MEMO_ATTACHMENT_MAX_BYTES) {
    throw new MemoAttachmentError(
      413,
      'memo_attachment_too_large',
      `The file exceeds the ${MEMO_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }

  const thumbnailField = form.get('thumbnail')
  if (thumbnailField !== null && !(thumbnailField instanceof File)) {
    throw ApiError.badRequest('Invalid thumbnail field')
  }
  if (thumbnailField instanceof File && thumbnailField.size > MEMO_ATTACHMENT_MAX_BYTES) {
    throw new MemoAttachmentError(
      413,
      'memo_attachment_too_large',
      `The thumbnail exceeds the ${MEMO_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB limit`,
    )
  }

  const rawMemoId = form.get('memoId')
  if (rawMemoId !== null && typeof rawMemoId !== 'string') {
    throw ApiError.badRequest('Invalid memo id')
  }
  const memoId = typeof rawMemoId === 'string' && rawMemoId ? rawMemoId : null
  if (memoId && !isValidId(memoId)) throw ApiError.badRequest('Invalid memo id')

  const rawMetadata = form.get('metadata')
  let mediaMetadata: MemoMediaMetadata | null = null
  if (rawMetadata !== null) {
    if (typeof rawMetadata !== 'string') throw ApiError.badRequest('Invalid media metadata')
    if (rawMetadata.length > MEDIA_METADATA_MAX_CHARS) {
      throw ApiError.badRequest('The media metadata is too large')
    }
    if (rawMetadata) {
      mediaMetadata = parseMemoMediaMetadata(rawMetadata)
      if (!mediaMetadata) throw ApiError.badRequest('The media metadata is invalid')
    }
  }

  const rawMotionGroupId = form.get('motionGroupId')
  if (rawMotionGroupId !== null && typeof rawMotionGroupId !== 'string') {
    throw ApiError.badRequest('Invalid motion group id')
  }
  const motionGroupId = typeof rawMotionGroupId === 'string' && rawMotionGroupId
    ? rawMotionGroupId
    : null
  if (motionGroupId && !isValidId(motionGroupId)) {
    throw ApiError.badRequest('Invalid motion group id')
  }
  const rawMotionRole = form.get('motionRole')
  const motionRole: MemoMotionRole | null = rawMotionRole === 'still'
    || rawMotionRole === 'video'
    || rawMotionRole === 'container'
    ? rawMotionRole
    : null
  if (rawMotionRole !== null && motionRole === null) {
    throw ApiError.badRequest('Invalid motion role')
  }
  if (Boolean(motionGroupId) !== Boolean(motionRole)) {
    throw ApiError.badRequest('The motion group and role must be set together')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const thumbnail = thumbnailField instanceof File
    ? {
        filename: thumbnailField.name || 'thumbnail',
        reportedMime: thumbnailField.type,
        bytes: new Uint8Array(await thumbnailField.arrayBuffer()),
      }
    : null

  const id = newId()
  const createdAt = Math.floor(Date.now() / 1000)
  const saved = await saveMemoAttachment(c.env, {
    id,
    userId,
    memoId,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    thumbnail,
    mediaMetadata,
    motionGroupId,
    motionRole,
    createdAt,
  })
  const stored = await getMemoAttachment(c.env.DB, userId, saved.id)
  return c.json(toMemoAttachmentView(stored ?? saved), 201)
})

memoAttachmentRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const rawScope = c.req.query('scope') || 'all'
  if (!MEMO_ATTACHMENT_SCOPES.includes(rawScope as MemoAttachmentScope)) {
    throw ApiError.badRequest('Invalid attachment scope')
  }
  const memoId = c.req.query('memoId') ?? null
  if (memoId && !isValidId(memoId)) throw ApiError.badRequest('Invalid memo id')
  const spaceId = c.req.query('spaceId') ?? null
  if (spaceId && !isValidId(spaceId)) throw ApiError.badRequest('Invalid space id')

  const page = await listMemoAttachments(c.env.DB, userId, {
    scope: rawScope as MemoAttachmentScope,
    spaceId,
    memoId,
    offset: parseOffsetCursor(c.req.query('cursor')),
    limit: clampInt(c.req.query('limit'), 1, MEMO_MAX_PAGE_SIZE, MEMO_PAGE_SIZE),
  })
  return c.json({
    items: page.rows.map(toMemoAttachmentView),
    nextCursor: page.nextOffset === null ? null : encodeOffsetCursor(page.nextOffset),
  })
})

memoAttachmentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const row = await getMemoAttachment(c.env.DB, c.get('userId'), id)
  if (!row) throw ApiError.notFound('Attachment not found')
  return c.json(toMemoAttachmentView(row))
})

memoAttachmentRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const result = await deleteMemoAttachments(c.env, c.get('userId'), [id])
  if (!result.deleted) throw ApiError.notFound('Attachment not found')
  return c.json({ ok: true })
})

memoAttachmentRoutes.post('/batch-delete', async (c) => {
  const body = await readJson<{ ids?: unknown }>(c, JSON_BODY_LIMITS.small)
  const ids = body.ids
  if (
    !Array.isArray(ids)
    || ids.length === 0
    || ids.length > BATCH_DELETE_MAX
    || !ids.every((id): id is string => typeof id === 'string' && isValidId(id))
  ) {
    throw ApiError.badRequest(`Provide between 1 and ${BATCH_DELETE_MAX} attachment ids`)
  }
  const result = await deleteMemoAttachments(c.env, c.get('userId'), [...new Set(ids)])
  return c.json({ deleted: result.deleted, freedBytes: result.freedBytes })
})

memoAttachmentRoutes.post('/prune', async (c) => {
  const result = await pruneUnusedMemoAttachments(c.env, c.get('userId'))
  return c.json({ removed: result.deleted, freedBytes: result.freedBytes })
})

function encodeOffsetCursor(offset: number): string {
  return toBase64(new TextEncoder().encode(JSON.stringify({ offset })))
}

function parseOffsetCursor(value: string | undefined): number {
  if (!value) return 0
  if (value.length > CURSOR_MAX_CHARS) throw ApiError.badRequest('Invalid attachment cursor')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(value)))
  } catch {
    throw ApiError.badRequest('Invalid attachment cursor')
  }
  const offset = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as { offset?: unknown }).offset
    : undefined
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw ApiError.badRequest('Invalid attachment cursor')
  }
  return offset
}
