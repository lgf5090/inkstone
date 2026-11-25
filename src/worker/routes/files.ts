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
import { persistAttachmentWithinQuota, replaceNoteAttachment } from '../attachments/storage'
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

// An owner may keep a private copy, but replacement can change both bytes and encryption under the
// same id. Revalidation is therefore mandatory; an immutable response could outlive a migration.
const OWNER_ATTACHMENT_CACHE = 'private, no-cache'

// A share grant, however, is revocable — rotating the share password is documented to cut old asset
// sessions off at once, and a year-long cache in the visitor's browser would outlive both the
// rotation and the share itself. Same reasoning as the memos file route.
const SHARE_ATTACHMENT_CACHE = 'private, no-store'

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

async function assertAttachmentUploadBudget(db: D1Database, userId: string): Promise<void> {
  await assertAttemptBudget(() => consumeAttemptBudget(db, [{
    key: `attachment-upload:${userId}`,
    maxAttempts: LIMITS.attachmentUploadsPerHour,
    windowMs: 60 * 60 * 1000,
    lockMs: 60 * 60 * 1000,
  }]), 'Too many uploads')
}

function readAttachmentEncryption(
  form: FormData,
  bytes: Uint8Array,
): { encryption: 'none' | 'note-lock-v1'; plaintextSize?: number } {
  const rawEncryption = form.get('encryption')
  if (rawEncryption !== null && rawEncryption !== 'none' && rawEncryption !== 'note-lock-v1') {
    throw ApiError.badRequest('Unsupported attachment encryption')
  }
  const encryption = rawEncryption === 'note-lock-v1' ? 'note-lock-v1' : 'none'
  if (encryption === 'none') return { encryption }

  const rawPlaintextSize = form.get('plaintextSize')
  const plaintextSize = typeof rawPlaintextSize === 'string' && /^\d+$/.test(rawPlaintextSize)
    ? Number(rawPlaintextSize)
    : null
  if (plaintextSize === null || !Number.isSafeInteger(plaintextSize) || plaintextSize > LIMITS.attachmentMaxBytes || bytes.length !== plaintextSize + LIMITS.noteAttachmentEnvelopeOverheadBytes) {
    throw ApiError.badRequest('Invalid encrypted attachment length')
  }
  return { encryption, plaintextSize }
}

function assertAttachmentFileSize(size: number, encryption: 'none' | 'note-lock-v1'): void {
  const ceiling = LIMITS.attachmentMaxBytes + (encryption === 'note-lock-v1' ? LIMITS.noteAttachmentEnvelopeOverheadBytes : 0)
  if (size > ceiling) throw ApiError.tooLarge('The file exceeds the 25 MB limit')
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
    encryption: row.encryption,
    plaintextSize: row.plaintext_size ?? undefined,
    sha256: row.sha256,
  }
}

filesRoutes.post('/', requireAuth, async (c) => {
  const userId = c.get('userId')
  await assertAttachmentUploadBudget(c.env.DB, userId)

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)

  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')

  const bytes = new Uint8Array(await file.arrayBuffer())
  const { encryption, plaintextSize } = readAttachmentEncryption(form, bytes)
  assertAttachmentFileSize(file.size, encryption)
  const rawAttachmentId = form.get('attachmentId')
  const id = encryption === 'note-lock-v1' ? rawAttachmentId : newId()
  if (typeof id !== 'string' || !isValidId(id)) throw ApiError.badRequest('Invalid attachment id')
  const rawNoteId = form.get('noteId')
  const noteId = typeof rawNoteId === 'string' && rawNoteId ? rawNoteId.slice(0, 128) : null
  const noteState = noteId ? await store(c).noteUploadState(noteId) : null
  if (noteId && !noteState) throw ApiError.badRequest('The associated note does not exist')
  if (encryption === 'note-lock-v1' && (!noteId || !noteState?.isEncrypted)) {
    throw ApiError.badRequest('Encrypted attachments require a locked note')
  }
  if (encryption === 'none' && noteState?.isEncrypted) {
    throw ApiError.badRequest('Locked notes only accept encrypted attachments')
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
    encryption,
    plaintextSize: plaintextSize ?? undefined,
  })

  const attachment: Attachment = {
    id,
    noteId,
    filename: stored.filename,
    mime: stored.mime,
    size: stored.size,
    width: stored.width,
    height: stored.height,
    url: `/api/files/${id}`,
    createdAt: now,
    encryption: stored.encryption,
    plaintextSize: stored.plaintextSize ?? undefined,
    sha256: stored.sha256,
  }
  return c.json(attachment, 201)
})

filesRoutes.put('/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const userId = c.get('userId')
  await assertAttachmentUploadBudget(c.env.DB, userId)

  const form = await readFormDataWithinLimit(c.req, FORM_BODY_LIMITS.attachment)
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing file field')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { encryption, plaintextSize } = readAttachmentEncryption(form, bytes)
  assertAttachmentFileSize(file.size, encryption)
  const rawExpectedSha256 = form.get('expectedSha256')
  if (rawExpectedSha256 !== null && (typeof rawExpectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawExpectedSha256))) {
    throw ApiError.badRequest('Invalid expected attachment checksum')
  }
  const expectedSha256 = typeof rawExpectedSha256 === 'string' ? rawExpectedSha256 : undefined
  const stored = await replaceNoteAttachment(c.env, {
    id,
    userId,
    filename: file.name || 'file',
    reportedMime: file.type,
    bytes,
    encryption,
    plaintextSize,
    expectedSha256,
  })

  const attachment: Attachment = {
    id,
    noteId: stored.noteId,
    filename: stored.filename,
    mime: stored.mime,
    size: stored.size,
    width: stored.width,
    height: stored.height,
    url: `/api/files/${id}`,
    createdAt: stored.createdAt,
    encryption: stored.encryption,
    plaintextSize: stored.plaintextSize ?? undefined,
    sha256: stored.sha256,
  }
  return c.json(attachment)
})

filesRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('Attachment not found')
  const shareSlug = c.req.query('share')

  const row = await attachmentById(c.env.DB, id)
  if (!row) throw ApiError.notFound('Attachment not found')

  const userId = c.get('userId')
  const owner = Boolean(userId && userId === row.user_id)
  let allowed = owner
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

  const encrypted = row.encryption === 'note-lock-v1'
  if (owner && row.note_id) {
    const noteState = await store(c).noteUploadState(row.note_id)
    if (noteState && noteState.isEncrypted !== encrypted) {
      throw ApiError.conflict('Attachment encryption does not match its note; migration is incomplete')
    }
  }

  const objectKey = attachmentObjectKey(row)
  const cacheControl = encrypted ? 'private, no-store' : owner ? OWNER_ATTACHMENT_CACHE : SHARE_ATTACHMENT_CACHE
  // The object key changes on replacement, so metadata-only changes and a plaintext-to-ciphertext
  // migration cannot receive a stale 304 for the previous representation.
  const etagTag = `${row.sha256}:${encodeURIComponent(objectKey)}`
  const etag = `"${etagTag}"`
  const ifNoneMatch = c.req.header('if-none-match')
  // Conditional revalidation only means something for a response the reader is allowed to keep, so
  // the share path answers the bytes every time rather than a 304 backed by a cache it must not have.
  if (!encrypted && owner && ifNoneMatch && matchesETag(ifNoneMatch, etagTag)) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': etag,
        'Cache-Control': cacheControl,
      },
    })
  }

  const headers = new Headers({
    'Content-Type': encrypted ? 'application/octet-stream' : row.mime,
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Content-Disposition': encrypted
      ? `attachment; filename*=UTF-8''${encodeContentDispositionFilename(`${row.filename}.enc`)}`
      : `${isInlineSafe(row.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFilename(row.filename)}`,
    'X-Content-Type-Options': 'nosniff',
  })
  if (encrypted) {
    headers.set('X-Inkstone-Attachment-Encryption', 'note-lock-v1')
    headers.set('X-Inkstone-Attachment-Type', row.mime)
    headers.set('X-Inkstone-Attachment-Filename', encodeURIComponent(row.filename))
  }

  if (!hasAttachmentStorage(c.env, row.storage)) {
    throw new ApiError(
      503,
      'storage_unavailable',
      `${row.storage === 'r2' ? 'R2' : 'Workers KV'} attachment storage is not bound, so the attachment cannot be read`,
    )
  }
  const object = await readAttachmentObjectStream(c.env, row.storage, objectKey)
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
