import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { CalculatorStore } from '../tools/calculator/store'
import { fetchEcbRates } from '../tools/calculator/rates'
import {
  decodeAssetPayload,
  deleteCalculatorAsset,
  getCalculatorContentType,
  isCalculatorR2KeyOwnedBy,
  readCalculatorAsset,
  uploadCalculatorAsset,
} from '../tools/calculator/r2'
import {
  DeleteHistoryQuerySchema,
  GraphSessionSchema,
  HistoryEntrySchema,
  MemoryListSchema,
  UpdateCalculatorSettingsSchema,
  UnitPreferencesSchema,
  UploadAssetSchema,
} from '@shared/tools/calculator/schemas'
import type { CalculatorSettings } from '@shared/tools/calculator/types'

export const toolsCalculatorRoutes = new Hono<AppBindings>()

toolsCalculatorRoutes.use('*', requireAuth)

const STATE_WRITES_PER_MINUTE = 120
const ASSET_UPLOADS_PER_MINUTE = 10
const takeStateBudget = createMinuteBudget(STATE_WRITES_PER_MINUTE, 'That is as many calculator writes as this account makes in a minute.')
const takeUploadBudget = createMinuteBudget(ASSET_UPLOADS_PER_MINUTE, 'That is as many calculator assets as this account uploads in a minute.')
const takeRatesBudget = createMinuteBudget(6, 'That is as many exchange-rate refreshes as this account makes in a minute.')

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function getStore(c: Context<AppBindings>): CalculatorStore {
  return new CalculatorStore(c.env.DB, getUserId(c))
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
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed')
  }
  return result.data
}

toolsCalculatorRoutes.get('/settings', async (c) => {
  return c.json({ ok: true, data: await getStore(c).getSettings() })
})

toolsCalculatorRoutes.put('/settings', async (c) => {
  takeStateBudget(getUserId(c))
  const body = await parseBody(c, UpdateCalculatorSettingsSchema)
  return c.json({ ok: true, data: await getStore(c).updateSettings(body as Partial<CalculatorSettings>) })
})

toolsCalculatorRoutes.get('/history', async (c) => {
  const query = c.req.query('mode')
  if (query && query !== 'standard' && query !== 'scientific') throw ApiError.badRequest('Invalid mode')
  const mode = query as 'standard' | 'scientific' | undefined
  return c.json({ ok: true, data: await getStore(c).listHistory(mode) })
})

toolsCalculatorRoutes.post('/history', async (c) => {
  takeStateBudget(getUserId(c))
  const body = await parseBody(c, HistoryEntrySchema)
  return c.json({ ok: true, data: await getStore(c).appendHistory(body) })
})

toolsCalculatorRoutes.delete('/history/:id', async (c) => {
  takeStateBudget(getUserId(c))
  const id = c.req.param('id')
  if (!/^[a-z0-9][a-z0-9_-]{3,60}$/i.test(id)) throw ApiError.badRequest('Invalid id')
  const deleted = await getStore(c).deleteHistory(id)
  if (!deleted) throw ApiError.notFound('History item not found')
  return c.json({ ok: true })
})

toolsCalculatorRoutes.delete('/history', async (c) => {
  takeStateBudget(getUserId(c))
  const query = DeleteHistoryQuerySchema.safeParse({ mode: c.req.query('mode') })
  if (!query.success) throw ApiError.badRequest('Invalid mode')
  await getStore(c).clearHistory(query.data.mode)
  return c.json({ ok: true })
})

toolsCalculatorRoutes.get('/memory', async (c) => {
  return c.json({ ok: true, data: await getStore(c).listMemory() })
})

toolsCalculatorRoutes.put('/memory', async (c) => {
  takeStateBudget(getUserId(c))
  const body = await parseBody(c, MemoryListSchema)
  return c.json({ ok: true, data: await getStore(c).replaceMemory(body) })
})

toolsCalculatorRoutes.delete('/memory', async (c) => {
  takeStateBudget(getUserId(c))
  await getStore(c).clearMemory()
  return c.json({ ok: true })
})

toolsCalculatorRoutes.get('/graph', async (c) => {
  return c.json({ ok: true, data: await getStore(c).getGraph() })
})

toolsCalculatorRoutes.put('/graph', async (c) => {
  takeStateBudget(getUserId(c))
  const body = await parseBody(c, GraphSessionSchema)
  return c.json({ ok: true, data: await getStore(c).updateGraph(body) })
})

toolsCalculatorRoutes.get('/rates', async (c) => {
  const userId = getUserId(c)
  const force = c.req.query('force') === '1'
  if (force) takeRatesBudget(userId)
  const store = getStore(c)
  const cached = await store.getCurrencyRates()
  const fresh = cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000
  if (cached && fresh && !force) return c.json({ ok: true, data: cached })
  try {
    const fetched = await fetchEcbRates()
    return c.json({ ok: true, data: await store.saveCurrencyRates(fetched) })
  } catch (error) {
    console.warn('[inkstone] ECB exchange-rate fetch failed:', error instanceof Error ? error.message : error)
    if (cached) return c.json({ ok: true, data: { ...cached, stale: true, source: 'cache' } })
    throw new ApiError(503, 'storage_unavailable', 'Exchange rates are unavailable right now')
  }
})

toolsCalculatorRoutes.get('/unit-preferences', async (c) => {
  return c.json({ ok: true, data: await getStore(c).listUnitPreferences() })
})

toolsCalculatorRoutes.put('/unit-preferences', async (c) => {
  takeStateBudget(getUserId(c))
  const body = await parseBody(c, UnitPreferencesSchema)
  return c.json({ ok: true, data: await getStore(c).replaceUnitPreferences(body) })
})

toolsCalculatorRoutes.get('/assets', async (c) => {
  const kind = c.req.query('kind')
  if (kind && !['graph_png', 'history_txt', 'backup_json'].includes(kind)) throw ApiError.badRequest('Invalid kind')
  return c.json({ ok: true, data: await getStore(c).listAssets(kind) })
})

toolsCalculatorRoutes.post('/assets', async (c) => {
  takeUploadBudget(getUserId(c))
  const userId = getUserId(c)
  const body = await parseBody(c, UploadAssetSchema)
  const expectedFormat = body.kind === 'graph_png' ? 'png' : body.kind === 'history_txt' ? 'txt' : 'json'
  if (body.fileFormat !== expectedFormat) throw ApiError.badRequest('The asset kind and format do not match')
  const bytes = decodeAssetPayload(body.dataBase64)
  const assetId = crypto.randomUUID().replace(/-/g, '')
  const uploaded = await uploadCalculatorAsset(c.env.FILES, userId, assetId, body.kind, body.fileFormat, bytes)
  const asset = {
    id: assetId,
    kind: body.kind,
    fileFormat: body.fileFormat,
    mimeType: getCalculatorContentType(body.fileFormat),
    fileSize: uploaded.size,
    r2Key: uploaded.key,
    metadata: body.metadata,
    createdAt: Date.now(),
  }
  try {
    await getStore(c).createAsset(asset)
  } catch (error) {
    try {
      await deleteCalculatorAsset(c.env.FILES, uploaded.key)
    } catch (cleanupError) {
      console.warn('[inkstone] Calculator asset row failed and R2 cleanup also failed:', cleanupError)
    }
    throw error
  }
  return c.json({ ok: true, data: asset })
})

toolsCalculatorRoutes.get('/assets/:id/file', async (c) => {
  const asset = await getStore(c).getAsset(c.req.param('id'))
  if (!asset) throw ApiError.notFound('Asset not found')
  if (!isCalculatorR2KeyOwnedBy(asset.r2Key, getUserId(c))) throw ApiError.notFound('Asset not found')
  const object = await readCalculatorAsset(c.env.FILES, asset.r2Key)
  if (!object) throw ApiError.notFound('Asset file not found')
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': asset.mimeType,
      'Content-Disposition': `attachment; filename="${asset.id}.${asset.fileFormat}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
})

toolsCalculatorRoutes.delete('/assets/:id', async (c) => {
  takeStateBudget(getUserId(c))
  const asset = await getStore(c).getAsset(c.req.param('id'))
  if (!asset) throw ApiError.notFound('Asset not found')
  if (!isCalculatorR2KeyOwnedBy(asset.r2Key, getUserId(c))) throw ApiError.notFound('Asset not found')
  try {
    await deleteCalculatorAsset(c.env.FILES, asset.r2Key)
  } catch (error) {
    console.warn('[inkstone] Calculator asset delete failed; the row is kept for retry:', error instanceof Error ? error.message : error)
    throw new ApiError(503, 'storage_unavailable', 'The asset could not be removed from storage; please retry')
  }
  await getStore(c).deleteAsset(asset.id)
  return c.json({ ok: true })
})
