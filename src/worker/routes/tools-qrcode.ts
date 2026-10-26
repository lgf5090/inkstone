import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  CreateQrRecordSchema,
  CreateQrTemplateSchema,
  QueryQrRecordsSchema,
  UpdateQrSettingsSchema,
  UpdateQrTemplateSchema,
  UploadLogoSchema,
} from '@shared/tools/qrcode/schemas'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import {
  deleteQrCodeFromR2,
  getLogoR2Key,
  getQrContentType,
  normalizeQrFormat,
  readQrCodeFromR2,
  uploadLogoToR2,
  uploadQrCodeToR2,
} from '../tools/qrcode/r2'
import { QrCodeStore } from '../tools/qrcode/store'

export const toolsQrcodeRoutes = new Hono<AppBindings>()

toolsQrcodeRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) {
    throw ApiError.unauthenticated()
  }
  return userId
}

function getStore(c: Context<AppBindings>): QrCodeStore {
  return new QrCodeStore(c.env.DB, getUserId(c))
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
  if (data.includes('<svg') && !data.startsWith('data:')) {
    return {
      bytes: new TextEncoder().encode(data),
      contentType: 'image/svg+xml',
    }
  }

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

toolsQrcodeRoutes.get('/records', async (c) => {
  const store = getStore(c)
  const query = QueryQrRecordsSchema.safeParse(c.req.query())
  if (!query.success) {
    const issue = query.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query parameters'
    throw ApiError.badRequest(message)
  }

  const result = await store.listRecords(query.data)
  return c.json({ ok: true, data: result })
})

toolsQrcodeRoutes.post('/records', async (c) => {
  const store = getStore(c)
  const userId = getUserId(c)
  const body = await parseBody(c, CreateQrRecordSchema)

  const recordId = body.id || crypto.randomUUID()
  const optionsJson = body.options
    ? JSON.stringify(body.options)
    : body.optionsJson || '{}'

  let r2Key = ''
  let fileSize = body.fileSize || 0

  if (body.fileData) {
    const { bytes } = decodeBase64OrDataUrl(body.fileData)
    const uploaded = await uploadQrCodeToR2(
      c.env.FILES,
      userId,
      recordId,
      body.fileType,
      bytes,
    )
    r2Key = uploaded.key
    fileSize = uploaded.size
  }

  const record = await store.createRecord({
    id: recordId,
    title: body.title,
    contentType: body.contentType,
    contentRaw: body.contentRaw,
    optionsJson,
    r2Key,
    fileType: normalizeQrFormat(body.fileType),
    fileSize,
    width: body.width,
    height: body.height,
  })

  return c.json({ ok: true, data: record }, 201)
})

toolsQrcodeRoutes.get('/records/:id', async (c) => {
  const store = getStore(c)
  const record = await store.getRecord(c.req.param('id'))
  if (!record) {
    throw ApiError.notFound('Record not found')
  }
  return c.json({ ok: true, data: record })
})

toolsQrcodeRoutes.delete('/records/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const deleted = await store.deleteRecord(id)
  if (!deleted) {
    throw ApiError.notFound('Record not found')
  }

  if (deleted.r2Key && c.env.FILES) {
    await deleteQrCodeFromR2(c.env.FILES, deleted.r2Key)
  }

  return c.json({ ok: true })
})

toolsQrcodeRoutes.get('/records/:id/file', async (c) => {
  const store = getStore(c)
  const record = await store.getRecord(c.req.param('id'))
  if (!record) {
    throw ApiError.notFound('Record not found')
  }

  if (!record.r2Key) {
    throw ApiError.notFound('File not associated with this record')
  }

  const obj = await readQrCodeFromR2(c.env.FILES, record.r2Key)
  if (!obj) {
    throw ApiError.notFound('File not found in storage')
  }

  const contentType = getQrContentType(record.fileType)
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(obj.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

toolsQrcodeRoutes.get('/templates', async (c) => {
  const store = getStore(c)
  const category = c.req.query('category')
  const templates = await store.listTemplates(category)
  return c.json({ ok: true, data: templates })
})

toolsQrcodeRoutes.post('/templates', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateQrTemplateSchema)
  const optionsJson = body.options
    ? JSON.stringify(body.options)
    : body.optionsJson || '{}'

  const template = await store.createTemplate({
    id: body.id,
    name: body.name,
    category: body.category,
    previewSvg: body.previewSvg,
    optionsJson,
    sort: body.sort,
  })

  return c.json({ ok: true, data: template }, 201)
})

toolsQrcodeRoutes.put('/templates/:id', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateQrTemplateSchema)
  const optionsJson = body.options
    ? JSON.stringify(body.options)
    : body.optionsJson

  const template = await store.updateTemplate(c.req.param('id'), {
    name: body.name,
    category: body.category,
    previewSvg: body.previewSvg,
    optionsJson,
    sort: body.sort,
  })

  return c.json({ ok: true, data: template })
})

toolsQrcodeRoutes.delete('/templates/:id', async (c) => {
  const store = getStore(c)
  await store.deleteTemplate(c.req.param('id'))
  return c.json({ ok: true })
})

toolsQrcodeRoutes.get('/settings', async (c) => {
  const store = getStore(c)
  const settings = await store.getSettings()
  return c.json({ ok: true, data: settings })
})

toolsQrcodeRoutes.put('/settings', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateQrSettingsSchema)
  const settings = await store.saveSettings(body)
  return c.json({ ok: true, data: settings })
})

toolsQrcodeRoutes.post('/upload-logo', async (c) => {
  const userId = getUserId(c)
  const contentTypeHeader = c.req.header('Content-Type') || ''
  const logoId = crypto.randomUUID()

  let ext = 'png'
  let bytes: Uint8Array
  let mime = 'image/png'

  if (/^multipart\/form-data/i.test(contentTypeHeader)) {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw ApiError.badRequest('No file uploaded')
    }
    const nameParts = file.name.split('.')
    if (nameParts.length > 1) {
      ext = nameParts.pop()!.toLowerCase()
    }
    mime = file.type || getQrContentType(ext)
    bytes = new Uint8Array(await file.arrayBuffer())
  } else {
    const body = await parseBody(c, UploadLogoSchema)
    if (body.filename) {
      const parts = body.filename.split('.')
      if (parts.length > 1) {
        ext = parts.pop()!.toLowerCase()
      }
    }
    const decoded = decodeBase64OrDataUrl(body.fileData)
    bytes = decoded.bytes
    mime = body.contentType || decoded.contentType || getQrContentType(ext)
  }

  const uploaded = await uploadLogoToR2(
    c.env.FILES,
    userId,
    logoId,
    ext,
    bytes,
    mime,
  )

  return c.json(
    {
      ok: true,
      data: {
        key: uploaded.key,
        size: uploaded.size,
        logoId,
        url: `/api/tools/qrcode/logo/${logoId}`,
      },
    },
    201,
  )
})

toolsQrcodeRoutes.get('/logo/:id', async (c) => {
  const userId = getUserId(c)
  const logoId = c.req.param('id')
  const ext = c.req.query('ext') || 'png'
  const key = getLogoR2Key(userId, logoId, ext)

  const obj = await readQrCodeFromR2(c.env.FILES, key)
  if (!obj) {
    throw ApiError.notFound('Logo not found')
  }

  const contentType = getQrContentType(ext)
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(obj.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})
