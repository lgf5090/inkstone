/**
 * Hono RESTful API routes for the Color Assistant module (`/api/tools/color`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { COLOR_ASSET_MAX_BYTES, COLOR_HISTORY_WINDOW } from '@shared/tools/color/contract'
import {
  AddColorHistorySchema,
  AiPaletteGenerateSchema,
  AiPoeticInterpretSchema,
  CreateColorFavoriteSchema,
  CreateColorPaletteSchema,
  UpdateColorFavoriteSchema,
  UpdateColorPaletteSchema,
  UpdateColorSettingsSchema,
  UploadColorAssetSchema,
} from '@shared/tools/color/schemas'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { generateAiPalette, interpretAiPoeticColors } from '../tools/color/ai'
import {
  colorAssetLooksValid,
  deleteColorAssetFromR2,
  getColorContentType,
  readColorAssetFromR2,
  uploadColorAssetToR2,
} from '../tools/color/r2'
import { ColorStore } from '../tools/color/store'

export const toolsColorRoutes = new Hono<AppBindings>()

toolsColorRoutes.use('*', requireAuth)

/**
 * Per-isolate brakes on the two endpoints that cost something to someone else.
 *
 * The assistant's daily ceiling already meters the model itself; these keep one browser tab from holding
 * twenty-five-second streams or multi-megabyte poster writes open at once.
 */
const AI_CALLS_PER_MINUTE = 6
const ASSET_UPLOADS_PER_MINUTE = 10
const takeAiBudget = createMinuteBudget(AI_CALLS_PER_MINUTE, 'That is as many color requests as this account makes in a minute.')
const takeUploadBudget = createMinuteBudget(ASSET_UPLOADS_PER_MINUTE, 'That is as many posters as this account uploads in a minute.')

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) {
    throw ApiError.unauthenticated()
  }
  return userId
}

function getStore(c: Context<AppBindings>): ColorStore {
  return new ColorStore(c.env.DB, getUserId(c))
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

/**
 * Decodes the poster payload.
 *
 * The MIME the client put in its data URL is deliberately thrown away: it used to be stored as the object's
 * content type and echoed back on download, which let a caller with a session turn an application-origin
 * URL into any document type it liked.
 */
function decodeBase64OrDataUrl(data: string): Uint8Array {
  if (data.includes('<svg') && !data.startsWith('data:')) {
    return new TextEncoder().encode(data)
  }

  const match = /^data:[^;,]+;base64,(.*)$/s.exec(data)
  const raw = match ? match[1] : data

  try {
    const binary = atob(raw.trim())
    if (binary.length > COLOR_ASSET_MAX_BYTES) {
      throw ApiError.tooLarge(`Color assets are limited to ${Math.floor(COLOR_ASSET_MAX_BYTES / 1024 / 1024)} MB`)
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid base64 payload')
  }
}

// ==========================================
// Settings
// ==========================================

toolsColorRoutes.get('/settings', async (c) => {
  const store = getStore(c)
  const settings = await store.getSettings()
  return c.json({ ok: true, data: settings })
})

toolsColorRoutes.put('/settings', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateColorSettingsSchema)
  const updated = await store.updateSettings(body)
  return c.json({ ok: true, data: updated })
})

// ==========================================
// Favorites (Single Colors)
// ==========================================

toolsColorRoutes.get('/favorites', async (c) => {
  const store = getStore(c)
  const tag = c.req.query('tag')
  const list = await store.listFavorites(tag)
  return c.json({ ok: true, data: list })
})

toolsColorRoutes.post('/favorites', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateColorFavoriteSchema)
  try {
    const created = await store.createFavorite(body)
    return c.json({ ok: true, data: created })
  } catch (error) {
    if (isUniqueConstraint(error)) throw ApiError.conflict('That color id is already saved')
    throw error
  }
})

/**
 * A duplicate id is the reader picking the same row twice, not a server fault.
 *
 * `createFavorite`/`createPalette` insert, so without this the constraint violation surfaced as a 500 and
 * the toast showed the raw SQLite text.
 */
function isUniqueConstraint(error: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((error as Error)?.message ?? error))
}

toolsColorRoutes.put('/favorites/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const body = await parseBody(c, UpdateColorFavoriteSchema)
  const updated = await store.updateFavorite(id, body)
  if (!updated) {
    throw ApiError.notFound('Favorite color not found')
  }
  return c.json({ ok: true, data: updated })
})

toolsColorRoutes.delete('/favorites/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const ok = await store.deleteFavorite(id)
  if (!ok) {
    throw ApiError.notFound('Favorite color not found')
  }
  return c.json({ ok: true, message: 'Deleted' })
})

// ==========================================
// Palettes (Multi-color Palette Sets)
// ==========================================

toolsColorRoutes.get('/palettes', async (c) => {
  const store = getStore(c)
  const sourceType = c.req.query('sourceType')
  const tag = c.req.query('tag')
  const onlyFavorites = c.req.query('onlyFavorites') === 'true'

  const list = await store.listPalettes({
    sourceType,
    tag,
    onlyFavorites,
  })
  return c.json({ ok: true, data: list })
})

toolsColorRoutes.post('/palettes', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateColorPaletteSchema)
  try {
    const created = await store.createPalette(body)
    return c.json({ ok: true, data: created })
  } catch (error) {
    if (isUniqueConstraint(error)) throw ApiError.conflict('That palette id is already saved')
    throw error
  }
})

toolsColorRoutes.put('/palettes/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const body = await parseBody(c, UpdateColorPaletteSchema)
  const updated = await store.updatePalette(id, body)
  if (!updated) {
    throw ApiError.notFound('Palette not found')
  }
  return c.json({ ok: true, data: updated })
})

toolsColorRoutes.delete('/palettes/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const ok = await store.deletePalette(id)
  if (!ok) {
    throw ApiError.notFound('Palette not found')
  }
  return c.json({ ok: true, message: 'Deleted' })
})

toolsColorRoutes.post('/palettes/:id/favorite', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const existing = await store.getPalette(id)
  if (!existing) {
    throw ApiError.notFound('Palette not found')
  }
  const nextFav = !existing.isFavorite
  const updated = await store.updatePalette(id, { isFavorite: nextFav })
  return c.json({ ok: true, data: updated })
})

// ==========================================
// History
// ==========================================

toolsColorRoutes.get('/history', async (c) => {
  const store = getStore(c)
  const limit = Number(c.req.query('limit')) || COLOR_HISTORY_WINDOW
  const history = await store.listHistory(limit)
  return c.json({ ok: true, data: history })
})

toolsColorRoutes.post('/history', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, AddColorHistorySchema)
  const added = await store.addHistory(body.hex, body.source)
  return c.json({ ok: true, data: added })
})

toolsColorRoutes.delete('/history', async (c) => {
  const store = getStore(c)
  await store.clearHistory()
  return c.json({ ok: true, message: 'History cleared' })
})

// ==========================================
// AI Palette Studio & Poetic Interpretation
// ==========================================

toolsColorRoutes.post('/ai/generate', async (c) => {
  const userId = getUserId(c)
  takeAiBudget(userId)
  const body = await parseBody(c, AiPaletteGenerateSchema)
  const result = await generateAiPalette(c.env, userId, body)
  return c.json({ ok: true, data: result })
})

toolsColorRoutes.post('/ai/interpret', async (c) => {
  const userId = getUserId(c)
  takeAiBudget(userId)
  const body = await parseBody(c, AiPoeticInterpretSchema)
  const result = await interpretAiPoeticColors(c.env, userId, body.colors, body.theme)
  return c.json({ ok: true, data: result })
})

// ==========================================
// Assets (R2 upload / download)
// ==========================================

toolsColorRoutes.post('/assets/upload', async (c) => {
  const store = getStore(c)
  const userId = getUserId(c)
  takeUploadBudget(userId)
  const body = await parseBody(c, UploadColorAssetSchema)

  const assetId = crypto.randomUUID()
  const bytes = decodeBase64OrDataUrl(body.data)
  if (!colorAssetLooksValid(body.fileFormat, bytes)) {
    throw ApiError.badRequest(`The uploaded bytes are not a ${body.fileFormat.toUpperCase()} file`)
  }

  const r2Key = await uploadColorAssetToR2(
    c.env.FILES,
    userId,
    assetId,
    body.fileFormat,
    bytes,
  )

  await store.recordAsset(
    assetId,
    body.assetType,
    body.fileFormat,
    bytes.byteLength,
    r2Key,
    body.metadata,
  )

  return c.json({
    ok: true,
    data: {
      id: assetId,
      r2Key,
      fileSize: bytes.byteLength,
      fileFormat: body.fileFormat,
      downloadUrl: `/api/tools/color/assets/${assetId}`,
    },
  })
})

toolsColorRoutes.get('/assets/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const asset = await store.getAsset(id)
  if (!asset) {
    throw ApiError.notFound('Asset not found')
  }

  const file = await readColorAssetFromR2(c.env.FILES, asset.r2Key)
  if (!file) {
    throw ApiError.notFound('Asset file not found in storage')
  }

  const contentType = getColorContentType(asset.fileFormat)
  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(file.data.byteLength),
      // The rest of the API answers `no-store`; this one said `public, immutable` for a per-user object
      // behind a session cookie, which let a shared cache hold a reader's poster for a year — and keep
      // serving it after the delete that was supposed to take it away.
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

toolsColorRoutes.delete('/assets/:id', async (c) => {
  const store = getStore(c)
  const id = c.req.param('id')
  const r2Key = await store.deleteAsset(id)
  if (!r2Key) {
    throw ApiError.notFound('Asset not found')
  }
  await deleteColorAssetFromR2(c.env.FILES, r2Key)
  return c.json({ ok: true, message: 'Asset deleted' })
})
