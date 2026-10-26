import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  CreateCustomSpecSchema,
  CreateIdPhotoRecordSchema,
  QueryIdPhotoRecordsSchema,
  UpdateIdPhotoSettingsSchema,
} from '@shared/tools/id-photo/schemas'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import {
  deleteIdPhotoFromR2,
  getIdPhotoContentType,
  normalizeIdPhotoFormat,
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

  const recordId = `idp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  const userId = getUserId(c)
  const format = normalizeIdPhotoFormat(body.fileType)

  let r2Key = ''
  let printR2Key = ''
  let fileSize = 0

  if (body.fileData) {
    const decoded = decodeBase64OrDataUrl(body.fileData)
    const uploaded = await uploadIdPhotoToR2(
      c.env.FILES,
      userId,
      recordId,
      format,
      decoded.bytes,
      false,
    )
    r2Key = uploaded.key
    fileSize = uploaded.size
  }

  if (body.printFileData) {
    const decodedPrint = decodeBase64OrDataUrl(body.printFileData)
    const uploadedPrint = await uploadIdPhotoToR2(
      c.env.FILES,
      userId,
      recordId,
      format,
      decodedPrint.bytes,
      true,
    )
    printR2Key = uploadedPrint.key
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

  if (keys.r2Key) {
    await deleteIdPhotoFromR2(c.env.FILES, keys.r2Key)
  }
  if (keys.printR2Key) {
    await deleteIdPhotoFromR2(c.env.FILES, keys.printR2Key)
  }

  return c.json({ ok: true, data: { deleted: true } })
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

  const contentType = getIdPhotoContentType(record.fileType)
  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set(
    'Content-Disposition',
    `attachment; filename="idphoto-${record.id}.${record.fileType}"`,
  )

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

  const contentType = getIdPhotoContentType(record.fileType)
  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set(
    'Content-Disposition',
    `attachment; filename="idphoto-${record.id}-print.${record.fileType}"`,
  )

  return new Response(obj.body, { status: 200, headers })
})

toolsIdPhotoRoutes.get('/specs', async (c) => {
  const store = getStore(c)
  const specs = await store.listSpecs()
  return c.json({ ok: true, data: specs })
})

toolsIdPhotoRoutes.post('/specs', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateCustomSpecSchema)
  const specId = `spec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`

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
