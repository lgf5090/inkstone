import { Hono } from 'hono'
import { zipSync } from 'fflate'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { newId } from '../lib/id'
import { sha256Hex } from '../lib/encoding'
import { readImageSize, hasReasonableImageDimensions, hasExpectedImageSignature } from '../lib/image'
import { createMinuteBudget } from '../lib/rate-limit'
import {
  IconBatchSchema,
  IconCollectionInputSchema,
  IconCollectionPatchSchema,
  IconExportCreateSchema,
  IconImportCreateSchema,
  IconJobCreateSchema,
  IconLimitsPatchSchema,
  IconListQuerySchema,
  IconSettingsPatchSchema,
  IconTagInputSchema,
  IconTagPatchSchema,
  IconUsageSchema,
} from '@shared/development/icons/schemas'
import { ICON_FORMATS, ICON_JOB_RATE_LIMIT, ICON_MAX_PIXELS } from '@shared/development/icons/limits'
import { iconFormatFromMime } from '@shared/development/icons/formats'
import type { IconExport, IconFormat, IconJobOptions, IconUploadResult } from '@shared/development/icons/types'
import {
  bootstrap,
  createCollection,
  createExportRow,
  createJob,
  createTag,
  deleteAsset,
  deleteCollection,
  deleteTag,
  ensureLimits,
  ensureSettings,
  getAsset,
  getAssetsByIds,
  getJob,
  getJobAssets,
  getJobItems,
  jobOutputRows,
  listAssets,
  listExports,
  listImports,
  listJobs,
  recordJobOutput,
  recordUsage,
  requestJobCancel,
  resetJobForRetry,
  setAsset,
  setAssetTags,
  setJobItemOutcome,
  setState,
  stats,
  syncJobProgress,
  updateCollection,
  updateLimits,
  updateSettings,
  updateTag,
  usageFor,
} from '../development/icons/store'
import {
  deleteIconObject,
  getIconObject,
  iconObjectKey,
  iconPublicUrl,
  iconThumbKey,
  objectHeaders,
  putIconObject,
  spriteObjectUrl,
  userShard,
} from '../development/icons/r2'
import { sanitizeSvgText } from '../development/icons/svg-sanitize'
import { inspectIco, icoSizesToken } from '../development/icons/ico'
import { webpThumbnail } from '../development/icons/raster'
import { buildExportArtifacts, finalizeBrowserJob } from '../development/icons/convert'
import { enqueueIconJob, iconQueueAvailable } from '../development/icons/queue'
import { importIconifyCollection } from '../development/icons/import'

export const developmentIconsRoutes = new Hono<AppBindings>()

/** A brake on a client that spams the conversion endpoint; it is per isolate, like the other budgets. */
const jobBudget = createMinuteBudget(ICON_JOB_RATE_LIMIT, 'Too many conversion tasks were created')

function publicObjectUrl(key: string): string {
  return iconPublicUrl(key)
}

developmentIconsRoutes.get('/objects/:format/:shard/:h2/:h4/:file', async (c) => {
  const format = c.req.param('format')
  const shard = c.req.param('shard')
  const h2 = c.req.param('h2')
  const h4 = c.req.param('h4')
  const file = c.req.param('file')
  if (![...ICON_FORMATS, 'ico'].includes(format as IconFormat)) throw ApiError.badRequest('Unsupported object format')
  if (!/^u[0-9a-f]{8}$/.test(shard) || !/^[0-9a-f]{2}$/.test(h2) || !/^[0-9a-f]{2}$/.test(h4)) throw ApiError.badRequest('Invalid object path')
  if (!/^[0-9a-f]{64}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.(?:svg|png|jpg|webp|ico)$/.test(file)) throw ApiError.badRequest('Invalid object name')
  const key = `development/icons/${format}/${shard}/${h2}/${h4}/${file}`
  const object = await getIconObject(c.env, key)
  if (!object) throw ApiError.notFound('The icon object was not found')
  const contentType = object.httpMetadata?.contentType
    ?? (format === 'svg' ? 'image/svg+xml' : format === 'ico' ? 'image/x-icon' : `image/${format}`)
  const etag = file.split('.')[0] ?? file
  const headers = objectHeaders(contentType, etag)
  if (c.req.header('if-none-match') === headers.get('ETag')) return new Response(null, { status: 304, headers })
  return new Response(object.body, { headers })
})

developmentIconsRoutes.get('/sprite/:shard/:setHash/:file', async (c) => {
  const shard = c.req.param('shard')
  const setHash = c.req.param('setHash')
  const file = c.req.param('file')
  if (!/^u[0-9a-f]{8}$/.test(shard) || !/^[0-9a-f]{64}$/.test(setHash)) throw ApiError.badRequest('Invalid sprite path')
  if (!/^sprite(?:@2x)?\.(?:svg|png|json|css|scss)$/.test(file)) throw ApiError.badRequest('Invalid sprite name')
  const key = `development/icons/sprite/${shard}/${setHash}/${file}`
  const object = await getIconObject(c.env, key)
  if (!object) throw ApiError.notFound('The sprite was not found')
  const contentType = object.httpMetadata?.contentType
    ?? (file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : 'text/x-scss')
  const headers = objectHeaders(contentType, setHash)
  if (c.req.header('if-none-match') === headers.get('ETag')) return new Response(null, { status: 304, headers })
  return new Response(object.body, { headers })
})

developmentIconsRoutes.use('*', requireAuth)

function userId(c: { get: (key: 'userId') => string }): string {
  return c.get('userId')
}

function isOwner(c: { get: (key: 'user') => { role: string } }): boolean {
  return c.get('user').role === 'owner'
}

developmentIconsRoutes.get('/bootstrap', async (c) => c.json({ ok: true, data: await bootstrap(c.env.DB, userId(c), isOwner(c)) }))

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
  const format = iconFormatFromMime(mime)
  if (!format) throw new ApiError(415, 'icons_invalid_format', 'Unsupported icon format')
  const limit = format === 'svg' ? settings.maxSvgBytes : settings.maxRasterBytes
  if (raw.byteLength > limit) throw new ApiError(413, 'icons_file_too_large', 'The icon exceeds the configured size limit')
  if (format !== 'svg' && !hasExpectedImageSignature(raw, mime)) throw new ApiError(415, 'icons_invalid_format', 'The image signature is not valid')
  const dimensions = format === 'svg' ? null : readImageSize(raw, mime)
  if (!hasReasonableImageDimensions(dimensions)) throw new ApiError(415, 'icons_invalid_format', 'The image dimensions are not valid')
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
  const usage = await usageFor(c.env.DB, userId(c))
  if (usage.usedBytes + content.byteLength > settings.quotaBytes) {
    throw new ApiError(413, 'icons_quota_exceeded', 'The icon storage quota is exceeded')
  }
  const shard = await userShard(userId(c))
  const key = iconObjectKey(format, shard, sha256)
  await putIconObject(c.env, key, content, format === 'svg' ? 'image/svg+xml' : mime)

  let thumbKey: string | null = null
  try {
    const thumb = await webpThumbnail(c.env, content, format === 'svg' ? 'image/svg+xml' : mime, 96)
    if (thumb) {
      const key96 = iconThumbKey(shard, sha256, 96)
      await putIconObject(c.env, key96, thumb, 'image/webp')
      thumbKey = key96
      const thumb2x = await webpThumbnail(c.env, content, format === 'svg' ? 'image/svg+xml' : mime, 192)
      if (thumb2x) await putIconObject(c.env, iconThumbKey(shard, sha256, 192), thumb2x, 'image/webp')
    }
  } catch (error) {
    console.warn('[inkstone] icon thumbnail generation failed:', error)
  }

  const id = newId()
  const now = Date.now()
  const name = String(form.get('name') ?? file.name.replace(/\.[^.]+$/, '')).slice(0, 200) || 'icon'
  const collectionId = String(form.get('collectionId') ?? '') || null
  await c.env.DB.prepare(
    `INSERT INTO development_icons_assets
       (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13, '', ?14, '', '', ?15, ?16, ?16)`,
  ).bind(
    userId(c), id, collectionId, name, name.toLowerCase(), format, mime, content.byteLength,
    dimensions?.width ?? null, dimensions?.height ?? null, sha256, key, thumbKey,
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
  if (deleted.thumbKey) {
    await deleteIconObject(c.env, deleted.thumbKey)
    await deleteIconObject(c.env, deleted.thumbKey.replace(/-w96\.webp$/, '-w192.webp'))
  }
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
        if (deleted.thumbKey) {
          await deleteIconObject(c.env, deleted.thumbKey)
          await deleteIconObject(c.env, deleted.thumbKey.replace(/-w96\.webp$/, '-w192.webp'))
        }
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

developmentIconsRoutes.get('/settings', async (c) => c.json({ ok: true, data: { settings: await ensureSettings(c.env.DB, userId(c)), limits: await ensureLimits(c.env.DB), usage: await usageFor(c.env.DB, userId(c)) } }))

developmentIconsRoutes.patch('/settings', async (c) => {
  const body = IconSettingsPatchSchema.parse(await readJson<unknown>(c, 16 * 1024))
  return c.json({ ok: true, data: await updateSettings(c.env.DB, userId(c), body) })
})

developmentIconsRoutes.patch('/settings/global', async (c) => {
  if (!isOwner(c)) throw ApiError.forbidden('Only the owner can change deployment limits')
  const body = IconLimitsPatchSchema.parse(await readJson<unknown>(c, 16 * 1024))
  return c.json({ ok: true, data: await updateLimits(c.env.DB, body) })
})

developmentIconsRoutes.get('/jobs', async (c) => c.json({ ok: true, data: await listJobs(c.env.DB, userId(c)) }))

developmentIconsRoutes.post('/jobs', async (c) => {
  const body = IconJobCreateSchema.parse(await readJson<unknown>(c, 64 * 1024))
  jobBudget(userId(c))
  const execution = iconQueueAvailable(c.env) ? 'queue' : 'browser'
  const job = await createJob(c.env.DB, userId(c), body.assetIds, body.options, execution)
  if (execution === 'queue') await enqueueIconJob(c.env, userId(c), job.id)
  return c.json({ ok: true, data: job }, 202)
})

developmentIconsRoutes.get('/jobs/:id', async (c) => c.json({ ok: true, data: await getJob(c.env.DB, userId(c), c.req.param('id')) }))

developmentIconsRoutes.get('/jobs/:id/items', async (c) => c.json({ ok: true, data: await getJobItems(c.env.DB, userId(c), c.req.param('id')) }))

developmentIconsRoutes.post('/jobs/:id/cancel', async (c) => {
  await requestJobCancel(c.env.DB, userId(c), c.req.param('id'))
  return c.json({ ok: true, data: { canceled: true } })
})

developmentIconsRoutes.post('/jobs/:id/retry', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  await resetJobForRetry(c.env.DB, userId(c), job.id)
  if (job.mode === 'queue') await enqueueIconJob(c.env, userId(c), job.id)
  return c.json({ ok: true, data: { queued: true, mode: job.mode } })
})

developmentIconsRoutes.get('/jobs/:id/manifest', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  const outputs = await jobOutputRows(c.env.DB, userId(c), job.id)
  return c.json({
    ok: true,
    data: {
      job,
      items: await getJobItems(c.env.DB, userId(c), job.id),
      files: outputs.map((row) => ({ name: row.name, bytes: row.bytes, url: publicObjectUrl(row.r2Key) })),
    },
  })
})

developmentIconsRoutes.post('/jobs/:id/finish', async (c) => {
  const status = await finalizeBrowserJob(c.env, userId(c), c.req.param('id'))
  return c.json({ ok: true, data: { status, job: await getJob(c.env.DB, userId(c), c.req.param('id')) } })
})

/**
 * The browser fallback's upload door.
 *
 * The client rasterizes with Canvas, then posts the produced files here. The bytes are re-checked
 * (PNG signature, ICO directory) and stored under content-addressed keys, so a job only reaches
 * `done` when a real artifact exists — never merely because a status column changed.
 */
developmentIconsRoutes.post('/jobs/:id/items/:assetId/outputs', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  const assetId = c.req.param('assetId')
  const form = await c.req.formData()
  const kind = String(form.get('kind') ?? '')
  if (kind !== 'png' && kind !== 'ico') throw ApiError.badRequest('Unsupported conversion kind')
  const shard = await userShard(userId(c))
  const outputs: Record<string, string> = {}
  const files: { name: string; bytes: Uint8Array; contentType: string }[] = []

  if (kind === 'png') {
    const reported = JSON.parse(String(form.get('sizes') ?? '[]')) as unknown
    const sizes = Array.isArray(reported) ? reported.map(Number) : []
    let index = 0
    for (const entry of form.entries()) {
      if (!(entry[1] instanceof File)) continue
      const file = entry[1] as File
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > 2 * 1024 * 1024) throw new ApiError(413, 'icons_file_too_large', 'A PNG output is too large')
      if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) throw new ApiError(415, 'icons_invalid_format', 'A PNG output is not a PNG')
      const size = Math.max(1, Math.min(512, Math.round(sizes[index] ?? 0) || 0))
      if (!size) throw ApiError.badRequest('A PNG output has no size')
      const info = readImageSize(bytes, 'image/png')
      if (!info || info.width !== size || info.height !== size) throw new ApiError(415, 'icons_invalid_format', 'A PNG output does not match its declared size')
      index += 1
      const sha = await sha256Hex(bytes)
      const key = `development/icons/png/u${shard}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}-w${size}.png`
      await putIconObject(c.env, key, bytes, 'image/png')
      await recordJobOutput(c.env.DB, userId(c), job.id, assetId, String(size), key, bytes.byteLength, sha)
      outputs[String(size)] = publicObjectUrl(key)
      files.push({ name: String(size), bytes, contentType: 'image/png' })
    }
  } else {
    const file = form.get('file')
    if (!(file instanceof File)) throw ApiError.badRequest('An ICO file is required')
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > 256 * 1024) throw new ApiError(413, 'icons_file_too_large', 'The ICO file is too large')
    const info = inspectIco(bytes)
    const token = icoSizesToken(info.sizes)
    const sha = await sha256Hex(bytes)
    const key = `development/icons/ico/u${shard}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}-ico-${token}.ico`
    await putIconObject(c.env, key, bytes, 'image/x-icon')
    await recordJobOutput(c.env.DB, userId(c), job.id, assetId, 'ico', key, bytes.byteLength, sha)
    outputs.ico = publicObjectUrl(key)
  }

  if (!files.length && !outputs.ico) throw ApiError.badRequest('No output files were uploaded')
  await setJobItemOutcome(c.env.DB, userId(c), job.id, assetId, 'done', outputs)
  const counts = await syncJobProgress(c.env.DB, userId(c), job.id)
  const status = counts.pending === 0 ? await finalizeBrowserJob(c.env, userId(c), job.id) : 'running'
  return c.json({ ok: true, data: { outputs, status } })
})

developmentIconsRoutes.post('/jobs/:id/sprite', async (c) => {
  const job = await getJob(c.env.DB, userId(c), c.req.param('id'))
  const form = await c.req.formData()
  const setHash = String(form.get('setHash') ?? '')
  if (!/^[0-9a-f]{64}$/.test(setHash)) throw ApiError.badRequest('The sprite set hash is not valid')
  const shard = await userShard(userId(c))
  const base = `development/icons/sprite/u${shard}/${setHash}`
  const outputs: Record<string, string> = {}
  const mapping: Record<string, string> = { sprite: 'sprite', index: 'sprite', css: 'sprite', scss: 'sprite', sprite2x: 'sprite' }
  for (const [field, label] of Object.entries(mapping)) {
    const file = form.get(field)
    if (!(file instanceof File)) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    const extension = field === 'index' ? 'json' : field === 'scss' ? 'scss' : field === 'css' ? 'css' : field === 'sprite2x' ? 'png' : (job.kind === 'sprite_svg' ? 'svg' : 'png')
    const filename = field === 'index' ? 'sprite.json' : field === 'sprite2x' ? 'sprite@2x.png' : `sprite.${extension}`
    const key = `${base}/${filename}`
    await putIconObject(c.env, key, bytes, file.type || 'application/octet-stream')
    await recordJobOutput(c.env.DB, userId(c), job.id, job.id, filename, key, bytes.byteLength, await sha256Hex(bytes))
    outputs[label === 'sprite' ? filename.replace(/\.|@/g, '_') : filename] = spriteObjectUrl(shard, setHash, filename)
  }
  const assets = await getJobAssets(c.env.DB, userId(c), job.id, true)
  for (const asset of assets) await setJobItemOutcome(c.env.DB, userId(c), job.id, asset.id, 'done', outputs)
  const status = await finalizeBrowserJob(c.env, userId(c), job.id)
  return c.json({ ok: true, data: { outputs, status } })
})

developmentIconsRoutes.get('/exports', async (c) => c.json({ ok: true, data: await listExports(c.env.DB, userId(c)) }))

function safeName(name: string, fallback: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback
}

developmentIconsRoutes.post('/exports', async (c) => {
  const body = IconExportCreateSchema.parse(await readJson<unknown>(c, 64 * 1024))
  const assets = await getAssetsByIds(c.env.DB, userId(c), body.assetIds)
  if (!assets.length) throw ApiError.notFound('No icons were found for the export')
  const usage = await usageFor(c.env.DB, userId(c))
  const exportId = newId()
  const shard = await userShard(userId(c))
  const files: Record<string, Uint8Array> = {}
  let bytes: Uint8Array
  let extension: string = body.format
  let contentType = 'application/octet-stream'
  const licenses = { generatedAt: new Date().toISOString(), assets: assets.map((asset) => ({ id: asset.id, name: asset.name, license: asset.license, sourceUrl: asset.sourceUrl })) }

  if (body.format === 'svg' || body.format === 'zip') {
    for (const asset of assets) {
      const object = await getIconObject(c.env, asset.r2Key)
      if (!object) continue
      files[`${safeName(asset.name, asset.id)}.${asset.format}`] = new Uint8Array(await object.arrayBuffer())
    }
    if (body.format === 'svg' && assets.length === 1) {
      const asset = assets[0]!
      const object = await getIconObject(c.env, asset.r2Key)
      if (!object) throw ApiError.notFound('The icon object was not found')
      bytes = new Uint8Array(await object.arrayBuffer())
      extension = asset.format
      contentType = asset.format === 'svg' ? 'image/svg+xml' : `image/${asset.format}`
    } else {
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify({ generatedAt: new Date().toISOString(), assets: assets.map((asset) => ({ id: asset.id, name: asset.name, format: asset.format })) }, null, 2))
      files['LICENSES.json'] = new TextEncoder().encode(JSON.stringify(licenses, null, 2))
      bytes = zipSync(files)
      extension = 'zip'
      contentType = 'application/zip'
    }
  } else {
    const options = body.options ?? defaultOptionsFor(body.format)
    const artifacts = await buildExportArtifacts(c.env, userId(c), assets, options)
    if ((body.format === 'png' || body.format === 'ico') && artifacts.files.length === 1) {
      bytes = artifacts.files[0]!.bytes
      extension = body.format
      contentType = artifacts.files[0]!.contentType
    } else {
      for (const artifact of artifacts.files) {
        const asset = assets.find((entry) => Object.values(artifacts.perAsset[entry.id] ?? {}).includes(publicObjectUrl(artifact.key)))
        const folder = body.format === 'png' ? `png/${artifact.name}` : body.format === 'ico' ? 'ico' : 'sprite'
        files[`${folder}/${asset ? safeName(asset.name, asset.id) : artifact.name}.${extensionFor(artifact.contentType)}`] = artifact.bytes
      }
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify({ generatedAt: new Date().toISOString(), format: body.format, options, shared: artifacts.shared, assets: artifacts.perAsset }, null, 2))
      files['LICENSES.json'] = new TextEncoder().encode(JSON.stringify(licenses, null, 2))
      bytes = zipSync(files)
      extension = 'zip'
      contentType = 'application/zip'
    }
  }

  if (usage.usedBytes + bytes.byteLength > usage.quotaBytes) {
    throw new ApiError(413, 'icons_quota_exceeded', 'The icon storage quota is exceeded')
  }
  const key = `development/icons/${body.format}/u${shard}/${exportId}.${extension}`
  await putIconObject(c.env, key, bytes, contentType, 'private, no-store')
  const data: IconExport = await createExportRow(c.env.DB, userId(c), {
    format: body.format,
    filename: `icons-${exportId}.${extension}`,
    r2Key: key,
    bytes: bytes.byteLength,
    assetCount: assets.length,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  return c.json({ ok: true, data }, 201)
})

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/x-icon') return 'ico'
  if (contentType === 'image/svg+xml') return 'svg'
  if (contentType === 'text/css') return 'css'
  if (contentType === 'text/x-scss') return 'scss'
  if (contentType === 'application/json') return 'json'
  return 'bin'
}

function defaultOptionsFor(format: string): IconJobOptions {
  if (format === 'png') return { kind: 'png', sizes: [24, 48, 96, 192, 512] }
  if (format === 'ico') return { kind: 'ico', sizes: [16, 32, 48, 256] }
  if (format === 'sprite_svg') return { kind: 'sprite_svg', padding: 2 }
  return { kind: 'sprite_png', padding: 2, scales: [1], scss: false }
}

developmentIconsRoutes.get('/exports/:id/download', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT filename, r2_key, format, expires_at FROM development_icons_exports WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId(c), c.req.param('id')).first<{ filename: string; r2_key: string; format: string; expires_at: number }>()
  if (!row) throw new ApiError(404, 'icons_export_expired', 'The export was not found')
  if (row.expires_at < Date.now()) throw new ApiError(404, 'icons_export_expired', 'The export has expired')
  const object = await getIconObject(c.env, row.r2_key)
  if (!object) throw new ApiError(404, 'icons_not_found', 'The export object was not found')
  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
  headers.set('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`)
  headers.set('Cache-Control', 'private, no-store')
  return new Response(object.body, { headers })
})

developmentIconsRoutes.get('/imports', async (c) => c.json({ ok: true, data: await listImports(c.env.DB, userId(c)) }))

developmentIconsRoutes.post('/imports', async (c) => {
  const body = IconImportCreateSchema.parse(await readJson<unknown>(c, 16 * 1024))
  if (body.kind !== 'iconify' || !body.prefix) throw ApiError.badRequest('Only Iconify collections can be imported')
  const usage = await usageFor(c.env.DB, userId(c))
  if (usage.overQuota) throw new ApiError(413, 'icons_quota_exceeded', 'The icon storage quota is exceeded')
  try {
    const data = await importIconifyCollection(c.env, userId(c), body.prefix, body.limit)
    return c.json({ ok: true, data }, 201)
  } catch (error) {
    throw new ApiError(422, 'icons_import_incomplete', error instanceof Error ? error.message : 'The import failed')
  }
})

developmentIconsRoutes.get('/imports/:id', async (c) => {
  const rows = await listImports(c.env.DB, userId(c))
  const found = rows.find((row) => row.id === c.req.param('id'))
  if (!found) throw new ApiError(404, 'icons_not_found', 'The import was not found')
  return c.json({ ok: true, data: found })
})

developmentIconsRoutes.post('/maintenance/reconcile', async (c) => {
  if (!isOwner(c)) throw ApiError.forbidden('Only the owner can run reconciliation')
  return c.json({ ok: true, data: { scanned: 0, deleted: 0 } })
})

developmentIconsRoutes.post('/maintenance/thumbnails', async (c) => {
  if (!isOwner(c)) throw ApiError.forbidden('Only the owner can backfill thumbnails')
  const body = await readJson<{ limit?: number }>(c, 4 * 1024).catch(() => ({}) as { limit?: number })
  const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50)))
  const shard = await userShard(userId(c))
  const rows = await c.env.DB.prepare(
    `SELECT id, format, mime, sha256, r2_key FROM development_icons_assets
      WHERE user_id=?1 AND (thumb_key IS NULL OR thumb_key='') ORDER BY created_at DESC LIMIT ?2`,
  ).bind(userId(c), limit).all<{ id: string; format: string; mime: string; sha256: string; r2_key: string }>()
  let processed = 0
  let failed = 0
  const rowsToDo = rows.results ?? []
  for (let index = 0; index < rowsToDo.length; index += 8) {
    const slice = rowsToDo.slice(index, index + 8)
    const results = await Promise.all(slice.map(async (row) => {
      try {
        const key = iconThumbKey(shard, row.sha256, 96)
        const existing = await getIconObject(c.env, key)
        if (existing) {
          await c.env.DB.prepare(`UPDATE development_icons_assets SET thumb_key=?3 WHERE user_id=?1 AND id=?2`).bind(userId(c), row.id, key).run()
          return true
        }
        const object = await getIconObject(c.env, row.r2_key)
        if (!object) throw new Error('missing object')
        const bytes = new Uint8Array(await object.arrayBuffer())
        const thumb = await webpThumbnail(c.env, bytes, row.mime, 96)
        if (!thumb) throw new Error('thumbnail unavailable')
        await putIconObject(c.env, key, thumb, 'image/webp')
        const thumb2x = await webpThumbnail(c.env, bytes, row.mime, 192)
        if (thumb2x) await putIconObject(c.env, iconThumbKey(shard, row.sha256, 192), thumb2x, 'image/webp')
        await c.env.DB.prepare(`UPDATE development_icons_assets SET thumb_key=?3 WHERE user_id=?1 AND id=?2`).bind(userId(c), row.id, key).run()
        return true
      } catch {
        return false
      }
    }))
    for (const ok of results) {
      if (ok) processed += 1
      else failed += 1
    }
  }
  return c.json({ ok: true, data: { processed, failed, remaining: Math.max(0, rowsToDo.length - processed - failed) } })
})
