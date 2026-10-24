/**
 * The upload surface for local music.
 *
 * Bodies here are the client's own bytes, never a path: the server names the R2 key from a fresh id.
 * Parts are capped while they stream in, so a client cannot make the isolate hold an arbitrary
 * request body; the service layer then checks the part number against the declared file size before
 * handing it to R2. All routes require a session, and a missing or foreign id is answered with 404.
 */
import { Hono } from 'hono'
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import {
  JSON_BODY_LIMITS,
  assertDeclaredBodySize,
  readBytesWithinLimit,
  readJson,
} from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  abortMusicUpload,
  completeMusicUpload,
  listMusicUploads,
  musicPartLength,
  readMusicUpload,
  startMusicUpload,
  storeMusicCover,
  uploadMusicPart,
} from '../music/upload-store'

export const musicUploadRoutes = new Hono<AppBindings>()

musicUploadRoutes.use('*', requireAuth)

musicUploadRoutes.get('/', async (c) => {
  return c.json({ items: await listMusicUploads(c.env, c.get('userId')) })
})

musicUploadRoutes.get('/:id', async (c) => {
  const snapshot = await readMusicUpload(c.env, c.get('userId'), uploadId(c.req.param('id')))
  if (!snapshot) throw ApiError.notFound('Upload not found')
  return c.json({
    upload: snapshot.upload,
    uploadedParts: snapshot.parts.map((part) => part.partNumber),
  })
})

musicUploadRoutes.post('/', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const init = await startMusicUpload(c.env, c.get('userId'), {
    filename: body.filename,
    mime: body.mime,
    size: body.size,
    format: body.format,
    metadata: body.metadata,
  })
  return c.json(init, 201)
})

musicUploadRoutes.put('/:id/parts/:n', async (c) => {
  const snapshot = await readMusicUpload(c.env, c.get('userId'), uploadId(c.req.param('id')))
  if (!snapshot) throw ApiError.notFound('Upload not found')
  if (snapshot.upload.status !== 'uploading') throw uploadClosed()
  const partNumber = partNumberParam(c.req.param('n'), snapshot.upload.size)

  assertDeclaredBodySize(c.req, MUSIC_LIMITS.uploadPartBytes)
  const bytes = await readBytesWithinLimit(c.req.raw.body, MUSIC_LIMITS.uploadPartBytes)
  const result = await uploadMusicPart(c.env, c.get('userId'), snapshot.upload.id, partNumber, bytes)
  return c.json(result)
})

musicUploadRoutes.put('/:id/cover', async (c) => {
  const id = uploadId(c.req.param('id'))
  const snapshot = await readMusicUpload(c.env, c.get('userId'), id)
  if (!snapshot) throw ApiError.notFound('Upload not found')
  if (snapshot.upload.status !== 'uploading') throw uploadClosed()

  assertDeclaredBodySize(c.req, MUSIC_LIMITS.coverMaxBytes)
  const bytes = await readBytesWithinLimit(c.req.raw.body, MUSIC_LIMITS.coverMaxBytes)
  const result = await storeMusicCover(
    c.env,
    c.get('userId'),
    id,
    bytes,
    c.req.header('content-type') ?? '',
  )
  return c.json(result)
})

musicUploadRoutes.post('/:id/complete', async (c) => {
  const result = await completeMusicUpload(c.env, c.get('userId'), uploadId(c.req.param('id')))
  return c.json(result)
})

musicUploadRoutes.delete('/:id', async (c) => {
  await abortMusicUpload(c.env, c.get('userId'), uploadId(c.req.param('id')))
  return c.json({ ok: true })
})

function uploadId(value: string | undefined): string {
  if (!value || !isValidId(value)) throw ApiError.notFound('Upload not found')
  return value
}

/** Validate the shape here so a malformed number is a 400 before any byte is read. */
function partNumberParam(value: string | undefined, size: number): number {
  if (!value || !/^\d{1,5}$/.test(value)) {
    throw new ApiError(400, 'music_upload_invalid', 'The part number is invalid')
  }
  const partNumber = Number(value)
  if (musicPartLength(size, partNumber) === null) {
    throw new ApiError(400, 'music_upload_invalid', `Part ${partNumber} is outside this upload`)
  }
  return partNumber
}

function uploadClosed(): ApiError {
  return new ApiError(409, 'music_upload_invalid', 'The upload is no longer accepting changes')
}
