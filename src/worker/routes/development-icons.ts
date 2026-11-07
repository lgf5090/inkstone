import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { newId } from '../lib/id'
import { sha256Hex } from '../lib/encoding'
import { readImageSize } from '../lib/image'
import {
  hasReasonableImageDimensions,
  hasExpectedImageSignature,
} from '../lib/image'
import {
  IconBatchSchema,
  IconCollectionInputSchema,
  IconCollectionPatchSchema,
  IconExportCreateSchema,
  IconJobCreateSchema,
  IconLimitsPatchSchema,
  IconListQuerySchema,
  IconSettingsPatchSchema,
  IconTagInputSchema,
  IconTagPatchSchema,
  IconUsageSchema,
} from '@shared/development/icons/schemas'
import { ICON_FORMATS, ICON_MAX_PIXELS } from '@shared/development/icons/limits'
import type { IconFormat, IconUploadResult } from '@shared/development/icons/types'
import {
  bootstrap,
  createCollection,
  createExportRow,
  createJob,
  createTag,
  deleteAsset,
  deleteCollection,
  deleteTag,
  getAsset,
  getJob,
  getJobItems,
  listAssets,
  listExports,
  listImports,
  recordUsage,
  setAsset,
  setAssetTags,
  setJobStatus,
  setState,
  stats,
  updateCollection,
  updateSettings,
  updateTag,
  updateLimits,
  ensureSettings,
  ensureLimits,
} from '../development/icons/store'
import {
  deleteIconObject,
  getIconObject,
  iconObjectKey,
  objectHeaders,
  putIconObject,
  userShard,
} from '../development/icons/r2'
import { sanitizeSvgText } from '../development/icons/svg-sanitize'

export const developmentIconsRoutes = new Hono<AppBindings>()

developmentIconsRoutes.get('/objects/:format/:shard/:h2/:h4/:file', async (c) => {
  const format = c.req.param('format')
  const shard = c.req.param('shard')
  const h2 = c.req.param('h2')
  const h4 = c.req.param('h4')
  const file = c.req.param('file')
  if (!ICON_FORMATS.includes(format as IconFormat)) throw ApiError.badRequest('Unsupported object format')
  if (!/^u[0-9a-f]{8}$/.test(shard) || !/^[0-9a-f]{2}$/.test(h2) || !/^[0-9a-f]{2}$/.test(h4)) throw ApiError.badRequest('Invalid object path')
  if (!/^[0-9a-f]{64}(?:-w(?:96|192))?\.(?:svg|png|jpg|webp)$/.test(file)) throw ApiError.badRequest('Invalid object name')
  const key = `development/icons/${format}/${shard}/${h2}/${h4}/${file}`
  const object = await getIconObject(c.env, key)
  if (!object) throw ApiError.notFound('The icon object was not found')
  const contentType = object.httpMetadata?.contentType ?? (format === 'svg' ? 'image/svg+xml' : `image/${format}`)
  const etag = file.split('.')[0] ?? file
  const headers = objectHeaders(contentType, etag)
  if (c.req.header('if-none-match') === headers.get('ETag')) return new Response(null, { status: 304, headers })
  return new Response(object.body, { headers })
})

developmentIconsRoutes.use('*', requireAuth)

function userId(c: { get: (key: 'userId') => string }): string {
  return c.get('userId')
}

developmentIconsRoutes.get('/bootstrap', async (c) => c.json({ ok: true, data: await bootstrap(c.env.DB, userId(c)) }))

developmentIconsRoutes.get('/assets', async (c) => {
  const url = new URL(c.req.url)
  const parsed = IconListQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) throw ApiError.badRequest('The icon query is not valid')
  const data = await listAssets(c.env.DB, userId(c), parsed.data)
  return c.json({ ok: true, data })
})

developmentIconsRoutes.get('/assets/:id', async (c) => c.json({ ok: true, data: await getAsset(c.env.DB, userId(c), c.req.param('id')) }))

developmentIconsRoutes.post('/assets', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('A file is required')
  const settings = await ensureSettings(c.env.DB, userId(c))
  const raw = new Uint8Array(await file.arrayBuffer())
  const mime = file.type.toLowerCase()
  const format: IconFormat | null = mime === 'image/svg+xml' ? 'svg' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : null
  if (!format) throw new ApiError(415, 'bad_request', 'Unsupported icon format')
  const limit = format === 'svg' ? settings.maxSvgBytes : settings.maxRasterBytes
  if (raw.byteLength > limit) throw ApiError.tooLarge('The icon exceeds the configured size limit')
  if (format !== 'svg' && !hasExpectedImageSignature(raw, mime)) throw new ApiError(415, 'bad_request', 'The image signature is not valid')
  const dimensions = format === 'svg' ? null : readImageSize(raw, mime)
  if (!hasReasonableImageDimensions(dimensions)) throw new ApiError(415, 'bad_request', 'The image dimensions are not valid')
  if (dimensions && (dimensions.width > settings.maxDimension || dimensions.height > settings.maxDimension || dimensions.width * dimensions.height > ICON_MAX_PIXELS)) {
    throw ApiError.badRequest('The image dimensions exceed the configured limit')
  }
  const content = format === 'svg'
    ? new TextEncoder().encode(sanitizeSvgText(new TextDecoder().decode(raw), settings.maxSvgBytes))
    : raw
  const sha256 = await sha256Hex(content)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM development_icons_assets WHERE user_id = ?1 AND format = ?2 AND sha256 = ?3`,
  ).bind(userId(c), format, sha256).first<{ id: string }>()
  if (existing) {
    return c.json({ ok: true, data: { asset: await getAsset(c.env.DB, userId(c), existing.id), deduped: true } satisfies IconUploadResult })
  }
  const used = await c.env.DB.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM development_icons_assets WHERE user_id = ?1`).bind(userId(c)).first<{ bytes: number }>()
  if (Number(used?.bytes ?? 0) + content.byteLength > settings.quotaBytes) {
    throw new ApiError(413, 'icons_quota_exceeded', 'The icon storage quota is exceeded')
  }
  const shard = await userShard(userId(c))
  const key = iconObjectKey(format, shard, sha256)
  await putIconObject(c.env, key, content, format === 'svg' ? 'image/svg+xml' : mime)
  const id = newId()
  const now = Date.now()
  const name = String(form.get('name') ?? file.name.replace(/\.[^.]+$/, '')).slice(0, 200) || 'icon'
  const collectionId = String(form.get('collectionId') ?? '') || null
  await c.env.DB.prepare(
    `INSERT INTO development_icons_assets
       (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, NULL, '', ?13, '', '', ?14, ?15, ?15)`,
  ).bind(
    userId(c), id, collectionId, name, name.toLowerCase(), format, mime, content.byteLength,
    dimensions?.width ?? null, dimensions?.height ?? null, sha256, key,
    format === 'svg' ? 'mono' : 'multi', format === 'svg' ? 1 : 0, now,
  ).run()
  return c.json({ ok: true, data: { asset: await getAsset(c.env.DB, userId(c), id), deduped: false } satisfies IconUploadResult }, 201)
})

developmentIconsRoutes.patch('/assets/:id', async (c) => {
  const patch = await readJson<Record<string, unknown>>(c, 64 * 1024)
  await setAsset(c.env.DB, userId(c), c.req.param('id'), patch)
  return c.json({ ok: true, data: await getAsset(c.env.DB, userId(c), c.req.param('id')) })
})

developmentIconsRoutes.delete('/assets/:id', async (c) => {
  const deleted = await deleteAsset(c.env.DB, userId(c), c.req.param('id'))
  await deleteIconObject(c.env, deleted.r2Key)
  if (deleted.thumbKey) await deleteIconObject(c.env, deleted.thumbKey)
  return c.json({ ok: true, data: { deleted: true } })
})

developmentIconsRoutes.post('/assets/batch', async (c) => {
  const body = IconBatchSchema.parse(await readJson<unknown>(c, 64 * 1024))
  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of body.ids) {
    try {
      if (body.action === 'delete') {
        const deleted = await deleteAsset(c.env.DB, userId(c), id)
        await deleteIconObject(c.env, deleted.r2Key)
        if (deleted.thumbKey) await deleteIconObject(c.env, deleted.thumbKey)
      } else if (body.action === 'move') {
        await setAsset(c.env.DB, userId(c), id, { collectionId: body.collectionId })
      } else if (body.action === 'tag') {
        await setAssetTags(c.env.DB, userId(c), id, body.tagIds)
      } else {
        await setState(c.env.DB, userId(c), id, {
          favorited: body.action === 'favorite' ? true : body.action === 'unfavorite' ? false : undefined,
          pinned: body.action === 'pin' ? true : body.action === 'unpin' ? false : undefined,
        })
      }
      results.push({ id, ok: true })
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : 'Failed' })
    }
  }
  return c.json({ ok: true, data: { results } })
})

developmentIconsRoutes.post('/assets/:id/usage', async (c) => {
  const body = IconUsageSchema.parse(await readJson<unknown>(c, 8 * 1024))
  const day = new Date().toISOString().slice(0, 10)
  await recordUsage(c.env.DB, userId(c), c.req.param('id'), body.action, day)
  return c.json({ ok: true, data: { recorded: true } })
})

developmentIconsRoutes.get('/stats', async (c) => {
  const days = Math.min(365, Math.max(1, Number(new URL(c.req.url).searchParams.get('days') ?? 365)))
  return c.json({ ok: true, data: await stats(c.env.DB, userId(c), days) })
})

developmentIconsRoutes.get('/collections', async (c) => c.json({ ok: true, data: (await bootstrap(c.env.DB, userId(c))).collections }))

developmentIconsRoutes.post('/collections', async (c) => {
  const body = IconCollectionInputSchema.parse(await readJson<unknown>(c, 32 * 1024))
  return c.json({ ok: true, data: await createCollection(c.env.DB, userId(c), body) }, 201)
})

developmentIconsRoutes.patch('/collections/:id', async (c) => {
  const body = IconCollectionPatchSchema.parse(await readJson<unknown>(c, 32 * 1024))
  await updateCollection(c.env.DB, userId(c), c.req.param('id'), body)
  return c.json({ ok: true, data: { updated: true } })
})

developmentIconsRoutes.delete('/collections/:id', async (c) => {
  await deleteCollection(c.env.DB, userId(c), c.req.param('id'))
  return c.json({ ok: true, data: { deleted: true } })
})

developmentIconsRoutes.get('/tags', async (c) => c.json({ ok: true, data: (await bootstrap(c.env.DB, userId(c))).tags }))

developmentIconsRoutes.post('/tags', async (c) => {
  const body = IconTagInputSchema.parse(await readJson<unknown>(c, 16 * 1024))
  return c.json({ ok: true, data: await createTag(c.env.DB, userId(c), body) }, 201)
})

developmentIconsRoutes.patch('/tags/:id', async (c) => {
  const body = IconTagPatchSchema.parse(await readJson<unknown>(c, 16 * 1024))
  await updateTag(c.env.DB, userId(c), c.req.param('id'), body)
  return c.json({ ok: true, data: { updated: true } })
})

developmentIconsRoutes.delete('/tags/:id', async (c) => {
  await deleteTag(c.env.DB, userId(c), c.req.param('id'))
  return c.json({ ok: true, data: { deleted: true } })
})

developmentIconsRoutes.get('/settings', async (c) => c.json({ ok: true, data: { settings: await ensureSettings(c.env.DB, userId(c)), limits: await ensureLimits(c.env.DB) } }))

developmentIconsRoutes.patch('/settings', async (c) => {
  const body = IconSettingsPatchSchema.parse(await readJson<unknown>(c, 16 * 1024))
  return c.json({ ok: true, data: await updateSettings(c.env.DB, userId(c), body) })
})

developmentIconsRoutes.patch('/settings/global', async (c) => {
  if (c.get('user').role !== 'owner') throw ApiError.forbidden('Only the owner can change deployment limits')
  const body = IconLimitsPatchSchema.parse(await readJson<unknown>(c, 16 * 1024))
  return c.json({ ok: true, data: await updateLimits(c.env.DB, body) })
})

developmentIconsRoutes.get('/jobs', async (c) => c.json({ ok: true, data: await listExports(c.env.DB, userId(c)) }))

developmentIconsRoutes.post('/jobs', async (c) => {
  const body = IconJobCreateSchema.parse(await readJson<unknown>(c, 64 * 1024))
  return c.json({ ok: true, data: await createJob(c.env.DB, userId(c), body.assetIds, body.options) }, 202)
})

developmentIconsRoutes.get('/jobs/:id', async (c) => c.json({ ok: true, data: await getJob(c.env.DB, userId(c), c.req.param('id')) }))

developmentIconsRoutes.get('/jobs/:id/items', async (c) => c.json({ ok: true, data: await getJobItems(c.env.DB, userId(c), c.req.param('id')) }))

developmentIconsRoutes.post('/jobs/:id/cancel', async (c) => {
  await setJobStatus(c.env.DB, userId(c), c.req.param('id'), 'canceled')
  return c.json({ ok: true, data: { canceled: true } })
})

developmentIconsRoutes.post('/jobs/:id/retry', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  await setJobStatus(c.env.DB, userId(c), job.id, 'queued')
  return c.json({ ok: true, data: { queued: true } })
})

developmentIconsRoutes.get('/jobs/:id/manifest', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  return c.json({ ok: true, data: { job, items: await getJobItems(c.env.DB, userId(c), job.id) } })
})

developmentIconsRoutes.get('/exports', async (c) => c.json({ ok: true, data: await listExports(c.env.DB, userId(c)) }))

developmentIconsRoutes.post('/exports', async (c) => {
  const body = IconExportCreateSchema.parse(await readJson<unknown>(c, 64 * 1024))
  const items = await Promise.all(body.assetIds.map((id) => getAsset(c.env.DB, userId(c), id)))
  const content = JSON.stringify({ format: body.format, assets: items.map((item) => ({ id: item.id, name: item.name, format: item.format, rawUrl: item.rawUrl, license: item.license })) }, null, 2)
  const bytes = new TextEncoder().encode(content)
  const exportId = newId()
  const key = `development/icons/${body.format}/u${await userShard(userId(c))}/${exportId}.json`
  await putIconObject(c.env, key, bytes, 'application/json')
  const data = await createExportRow(c.env.DB, userId(c), {
    format: body.format,
    filename: `icons-${exportId}.${body.format === 'zip' ? 'zip' : 'json'}`,
    r2Key: key,
    bytes: bytes.byteLength,
    assetCount: items.length,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  return c.json({ ok: true, data }, 201)
})

developmentIconsRoutes.get('/imports', async (c) => c.json({ ok: true, data: await listImports(c.env.DB, userId(c)) }))

developmentIconsRoutes.get('/imports/:id', async (c) => {
  const rows = await listImports(c.env.DB, userId(c))
  const found = rows.find((row) => row.id === c.req.param('id'))
  if (!found) throw ApiError.notFound('The import was not found')
  return c.json({ ok: true, data: found })
})

developmentIconsRoutes.post('/maintenance/reconcile', async (c) => {
  if (c.get('user').role !== 'owner') throw ApiError.forbidden('Only the owner can run reconciliation')
  return c.json({ ok: true, data: { scanned: 0, deleted: 0 } })
})
