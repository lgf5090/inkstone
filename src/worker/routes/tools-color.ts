/**
 * Hono RESTful API routes for the Color Assistant module (`/api/tools/color`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
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
import { requireAuth } from '../middleware/auth'
import { generateAiPalette, interpretAiPoeticColors } from '../tools/color/ai'
import {
  deleteColorAssetFromR2,
  getColorContentType,
  readColorAssetFromR2,
  uploadColorAssetToR2,
} from '../tools/color/r2'
import { ColorStore } from '../tools/color/store'

export const toolsColorRoutes = new Hono<AppBindings>()

toolsColorRoutes.use('*', requireAuth)

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
  const created = await store.createFavorite(body)
  return c.json({ ok: true, data: created })
})

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
  const created = await store.createPalette(body)
  return c.json({ ok: true, data: created })
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
  const limit = Number(c.req.query('limit')) || 60
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
  const body = await parseBody(c, AiPaletteGenerateSchema)
  const result = await generateAiPalette(c.env, userId, body)
  return c.json({ ok: true, data: result })
})

toolsColorRoutes.post('/ai/interpret', async (c) => {
  const userId = getUserId(c)
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
  const body = await parseBody(c, UploadColorAssetSchema)

  const assetId = crypto.randomUUID()
  const { bytes, contentType } = decodeBase64OrDataUrl(body.data)

  const r2Key = await uploadColorAssetToR2(
    c.env.FILES,
    userId,
    assetId,
    body.fileFormat,
    bytes,
    contentType,
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

  const contentType = file.contentType || getColorContentType(asset.fileFormat)
  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(file.data.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
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
