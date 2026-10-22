import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { LIMITS } from '@shared/constants'
import { extractAttachmentIds } from '@shared/markdown-utils'
import type { Attachment } from '@shared/types'
import {
  hasAttachmentStorage,
  readAttachmentObjectStream,
} from '../attachments/backend'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { collectAttachmentReferences } from '../attachments/references'
import { attachmentObjectKey } from '../attachments/keys'
import { persistAttachmentWithinQuota } from '../attachments/storage'
import {
  attachmentById,
  AttachmentsStore,
  shareForAsset,
  type AttachmentListCursor,
  type AttachmentRow,
} from '../attachments/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newId } from '../lib/id'
import { isInlineSafe } from '../lib/image'
import { FORM_BODY_LIMITS, readFormDataWithinLimit } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { shareAssetCookieName, verifyShareAssetSession } from '../lib/share-asset-session'
import { requireAuth } from '../middleware/auth'

export const filesRoutes = new Hono<AppBindings>()

// Anonymous share reads get a tighter work budget than the delete/backup paths:
// an unfinished scan here only withholds one asset, which is the safe direction.
const SHARE_ASSET_SCAN_LIMITS = { maxDepth: 2, maxChars: 200_000 }

function readShareAttachmentIds(content: string): string[] {
  return extractAttachmentIds(content, SHARE_ASSET_SCAN_LIMITS)
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function parseAttachmentListCursor(value: string | undefined): AttachmentListCursor | null {
  if (!value) return null
  const match = /^(\d{1,16})\.([0-9a-hjkmnp-tv-z]{26})$/.exec(value)
  const createdAt = Number(match?.[1])
  if (!match || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw ApiError.badRequest('Invalid attachment cursor')
  }
  return { createdAt, id: match[2]! }
}

function store(c: Context<AppBindings>): AttachmentsStore {
  return new AttachmentsStore(c.env.DB, c.get('userId'))
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    noteId: row.note_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
    createdAt: row.created_at,
  }
}

filesRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('userId')
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
  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
  if (noteId && !(await store(c).noteIsLive(noteId))) {
    throw ApiError.badRequest('The associated note does not exist')
  }
  const now = Date.now()
  const stored = await persistAttachmentWithinQuota(c.env, {
    id,
    userId,
    scope: 'notes',
    noteId,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    createdAt: now,
  })

  const attachment: Attachment = {
    id,
    noteId,
    filename: stored.filename,
    mime: stored.mime,
    size: bytes.byteLength,
    width: stored.width,
    height: stored.height,
    url: `/api/files/${id}`,
    createdAt: now,
  }
  return c.json(attachment, 201)
})


filesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const shareSlug = c.req.query('share')

  const row = await attachmentById(c.env.DB, id)
  if (!row) throw ApiError.notFound('Attachment not found')

  const userId = c.get('userId')
  let allowed = Boolean(userId && userId === row.user_id)
  if (!allowed && isValidSlug(shareSlug)) {
    const share = await shareForAsset(c.env.DB, shareSlug, row.user_id)
    allowed = Boolean(
      share &&
        (share.content.includes(row.id) && readShareAttachmentIds(share.content).includes(row.id)) &&
        (!share.password_hash ||
          (await verifyShareAssetSession(
            c.env.DB,
            getCookie(c, shareAssetCookieName(shareSlug)),
            share.slug,
            share.password_hash,
          ))),
    )
  }
  if (!allowed) throw ApiError.unauthenticated('You do not have access to this attachment')

  const etag = `"${row.sha256}"`
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && matchesETag(ifNoneMatch, row.sha256)) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': etag,
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  }

  const headers = new Headers({
    'Content-Type': row.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'ETag': etag,
    'Content-Disposition': `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
  })

  if (!hasAttachmentStorage(c.env, row.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the attachment cannot be read`,
    )
  }
  const object = await readAttachmentObjectStream(c.env, row.storage, attachmentObjectKey(row))
  if (!object) throw ApiError.notFound('Attachment data is missing')
  return new Response(object.body as BodyInit, { headers })
})


filesRoutes.get('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  const wanted = c.req.query('name')?.trim().toLowerCase()
  if (wanted) {
    const row = await store(c).byFilename(wanted)
    return c.json({ files: row ? [toAttachment(row)] : [] })
  }
  const cursor = parseAttachmentListCursor(c.req.query('cursor'))
  const { rows: page, hasMore } = await store(c).listPage(cursor)
  const references = await collectAttachmentReferences(
    c.env.DB,
    userId,
    new Set(page.map((row) => row.id)),
  )
  return c.json({
    files: page.map((row) => ({
      ...toAttachment(row),
      references: references.get(row.id) ?? 0,
    })),
    nextCursor: hasMore
      ? `${page[page.length - 1]!.created_at}.${page[page.length - 1]!.id}`
      : null,
  })
})

filesRoutes.delete('/:id', requireAuth, async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const library = store(c)
  const row = await library.forDeletion(id)
  if (!row) throw ApiError.notFound('Attachment not found')
  if (!(await library.delete(row))) throw ApiError.notFound('Attachment not found')

  const cleanup = drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment deletion will retry later:', error)
  })
  if (c.executionCtx) c.executionCtx.waitUntil(cleanup)
  else await cleanup
  return c.json({ ok: true, cleanupPending: true })
})

filesRoutes.post('/prune', requireAuth, async (c) => {
  const userId = c.get('userId')
  const library = store(c)
  const start = await library.pruneStart()
  if (!start) return c.json({ removed: 0, freedBytes: 0 })
  const attachmentIds = await library.idsThroughBoundary(start.boundary)
  const referenced = await collectAttachmentReferences(c.env.DB, userId, attachmentIds)
  const { removed, freedBytes } = await library.pruneUnreferenced(start, referenced)

  const cleanup = drainAttachmentCleanup(c.env, userId).catch((error) => {
    console.warn('[inkstone] Attachment cleanup will retry later:', error)
  })
  if (c.executionCtx) c.executionCtx.waitUntil(cleanup)
  else await cleanup
  return c.json({ removed, freedBytes, cleanupPending: true })
})

export function matchesETag(header: string, tag: string): boolean {
  const cleanTarget = tag.replace(/^W\//i, '').replace(/^"|"$/g, '')
  return header.split(',').some((item) => {
    const trimmed = item.trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
    return trimmed === '*' || trimmed === cleanTarget
  })
}
