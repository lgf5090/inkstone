import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  CreateCustomSpecSchema,
  UpdateCustomSpecSchema,
  CreateIdPhotoRecordSchema,
  RenameIdPhotoRecordSchema,
  MAX_RECORDS_PER_USER,
  QueryIdPhotoRecordsSchema,
  UpdateIdPhotoSettingsSchema,
} from '@shared/tools/id-photo/schemas'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { createMinuteBudget } from '../lib/rate-limit'
import {
  deleteIdPhotoFromR2,
  getIdPhotoContentType,
  readIdPhotoFromR2,
  uploadIdPhotoToR2,
} from '../tools/id-photo/r2'
import { IdPhotoStore } from '../tools/id-photo/store'

export const toolsIdPhotoRoutes = new Hono<AppBindings>()

toolsIdPhotoRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) {
    throw ApiError.unauthenticated()
  }
  return userId
}

function getStore(c: Context<AppBindings>): IdPhotoStore {
  return new IdPhotoStore(c.env.DB, getUserId(c))
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed'
    throw ApiError.badRequest(message)
  }
  return result.data
}

const recordsWriteBudget = createMinuteBudget(24, 'Too many archived photos in one minute, try again shortly')
const specsWriteBudget = createMinuteBudget(30, 'Too many specifications created in one minute, try again shortly')

/**
 * The declared fileType is a client claim, so the bytes decide what a stored portrait really is:
 * a mislabelled upload would otherwise be served back with a content type it does not match.
 */
function sniffImageFormat(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (bytes.length > 12 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes.length > 15 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp'
  return null
}

function decodeBase64OrDataUrl(data: string): { bytes: Uint8Array; contentType?: string } {
  let raw = data
  let contentType: string | undefined
  const match = data.match(/^data:([^;]+);base64,(.*)$/s)
  if (match) {
    contentType = match[1]
    raw = match[2]
  }

  try {
    const binary = atob(raw.trim())
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return { bytes, contentType }
  } catch {
    throw ApiError.badRequest('Invalid base64 payload')
  }
}

function fileHeaders(c: Context<AppBindings>, name: string, fileType: string): Headers {
  const headers = new Headers()
  headers.set('Content-Type', getIdPhotoContentType(fileType))
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  if (c.req.query('download')) {
    headers.set('Content-Disposition', `attachment; filename="idphoto-${name}.${fileType}"`)
  }
  return headers
}

toolsIdPhotoRoutes.get('/records', async (c) => {
  const store = getStore(c)
  const query = QueryIdPhotoRecordsSchema.safeParse(c.req.query())
  if (!query.success) {
    const issue = query.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query parameters'
    throw ApiError.badRequest(message)
  }

  const result = await store.listRecords(query.data)
  return c.json({ ok: true, data: result })
})

toolsIdPhotoRoutes.post('/records', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateIdPhotoRecordSchema)
  const userId = getUserId(c)

  recordsWriteBudget(userId)
  if ((await store.countRecords()) >= MAX_RECORDS_PER_USER) {
    throw new ApiError(409, 'conflict', `The archive holds at most ${MAX_RECORDS_PER_USER} photos`)
  }

  const photo = decodeBase64OrDataUrl(body.fileData)
  const format = sniffImageFormat(photo.bytes)
  if (!format) {
    throw ApiError.badRequest('Only PNG, JPEG and WebP images can be archived')
  }

  const recordId = `idp_${crypto.randomUUID()}`
  const fileSize = photo.bytes.byteLength
  let r2Key = ''
  let printR2Key = ''

  try {
    r2Key = (await uploadIdPhotoToR2(c.env.FILES, userId, recordId, format, photo.bytes, false)).key

    if (body.printFileData) {
      const printPhoto = decodeBase64OrDataUrl(body.printFileData)
      if (sniffImageFormat(printPhoto.bytes) !== format) {
        throw ApiError.badRequest('The print sheet must use the same image format as the photo')
      }
      printR2Key = (
        await uploadIdPhotoToR2(c.env.FILES, userId, recordId, format, printPhoto.bytes, true)
      ).key
    }

    const record = await store.createRecord({
      id: recordId,
      title: body.title || `${body.specName || 'ID Photo'} - ${new Date().toLocaleDateString()}`,
      specId: body.specId,
      specName: body.specName,
      widthPx: body.widthPx,
      heightPx: body.heightPx,
      widthMm: body.widthMm,
      heightMm: body.heightMm,
      dpi: body.dpi,
      bgColor: body.bgColor,
      optionsJson: JSON.stringify(body.options),
      r2Key,
      printR2Key,
      fileType: format,
      fileSize,
    })

    return c.json({ ok: true, data: record }, 201)
  } catch (error) {
    await Promise.allSettled([
      r2Key ? deleteIdPhotoFromR2(c.env.FILES, r2Key) : Promise.resolve(),
      printR2Key ? deleteIdPhotoFromR2(c.env.FILES, printR2Key) : Promise.resolve(),
    ])
    throw error
  }
})

toolsIdPhotoRoutes.get('/records/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const record = await store.getRecord(id)
  if (!record) {
    throw ApiError.notFound('Record not found')
  }
  return c.json({ ok: true, data: record })
})

toolsIdPhotoRoutes.delete('/records/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const keys = await store.deleteRecord(id)
  if (!keys) {
    throw ApiError.notFound('Record not found')
  }

  const storage = await Promise.allSettled([
    keys.r2Key ? deleteIdPhotoFromR2(c.env.FILES, keys.r2Key) : Promise.resolve(),
    keys.printR2Key ? deleteIdPhotoFromR2(c.env.FILES, keys.printR2Key) : Promise.resolve(),
  ])

  return c.json({
    ok: true,
    data: { deleted: true, storageCleaned: storage.every((result) => result.status === 'fulfilled') },
  })
})

toolsIdPhotoRoutes.patch('/records/:id', async (c) => {
  const store = getStore(c)
  recordsWriteBudget(getUserId(c))
  const body = await parseBody(c, RenameIdPhotoRecordSchema)
  const record = await store.updateRecordTitle(c.req.param('id'), body.title)
  if (!record) {
    throw ApiError.notFound('Record not found')
  }
  return c.json({ ok: true, data: record })
})

toolsIdPhotoRoutes.get('/records/:id/file', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const record = await store.getRecord(id)
  if (!record || !record.r2Key) {
    throw ApiError.notFound('Record or file not found')
  }

  const obj = await readIdPhotoFromR2(c.env.FILES, record.r2Key)
  if (!obj) {
    throw ApiError.notFound('File not found in storage')
  }

  const headers = fileHeaders(c, record.id, record.fileType)
  return new Response(obj.body, { status: 200, headers })
})

toolsIdPhotoRoutes.get('/records/:id/print-file', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const record = await store.getRecord(id)
  if (!record || !record.printR2Key) {
    throw ApiError.notFound('Print sheet file not found')
  }

  const obj = await readIdPhotoFromR2(c.env.FILES, record.printR2Key)
  if (!obj) {
    throw ApiError.notFound('Print sheet not found in storage')
  }

  const headers = fileHeaders(c, `${record.id}-print`, record.fileType)
  return new Response(obj.body, { status: 200, headers })
})

toolsIdPhotoRoutes.get('/specs', async (c) => {
  const store = getStore(c)
  const specs = await store.listSpecs()
  return c.json({ ok: true, data: specs })
})

toolsIdPhotoRoutes.post('/specs', async (c) => {
  const store = getStore(c)
  specsWriteBudget(getUserId(c))
  const body = await parseBody(c, CreateCustomSpecSchema)
  const specId = `spec_${crypto.randomUUID()}`

  const widthPx = Math.round((body.widthMm / 25.4) * body.dpi)
  const heightPx = Math.round((body.heightMm / 25.4) * body.dpi)

  const spec = await store.createSpec({
    id: specId,
    name: body.name,
    category: body.category,
    countryCode: body.countryCode,
    widthMm: body.widthMm,
    heightMm: body.heightMm,
    widthPx,
    heightPx,
    dpi: body.dpi,
    recommendedBgColors: body.recommendedBgColors,
    faceRatioMin: body.faceRatioMin,
    faceRatioMax: body.faceRatioMax,
    fileSizeMaxKb: body.fileSizeMaxKb,
  })

  return c.json({ ok: true, data: spec }, 201)
})

toolsIdPhotoRoutes.patch('/specs/:id', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateCustomSpecSchema)
  const spec = await store.updateSpec(c.req.param('id'), body)
  if (!spec) {
    throw ApiError.notFound('Spec not found')
  }
  return c.json({ ok: true, data: spec })
})

toolsIdPhotoRoutes.delete('/specs/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const deleted = await store.deleteSpec(id)
  if (!deleted) {
    throw ApiError.notFound('Spec not found')
  }
  return c.json({ ok: true, data: { deleted: true } })
})

toolsIdPhotoRoutes.get('/settings', async (c) => {
  const store = getStore(c)
  const settings = await store.getSettings()
  return c.json({ ok: true, data: settings })
})

toolsIdPhotoRoutes.put('/settings', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateIdPhotoSettingsSchema)
  const updated = await store.updateSettings(body)
  return c.json({ ok: true, data: updated })
})
