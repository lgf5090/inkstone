/**
 * Short Links Manager API routes (`/api/tools/shortlinks/*`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  AddBundleLinksSchema,
  AddSlugSchema,
  AnalyticsRangeQuerySchema,
  BatchImportSchema,
  BreakdownQuerySchema,
  CreateApiKeySchema,
  CreateBundleSchema,
  CreateLinkSchema,
  CustomSlugSchema,
  ListLinksQuerySchema,
  RestoreBackupSchema,
  SlugStatusSchema,
  UpdateBundleSchema,
  UpdateLinkSchema,
  UpdateSettingsSchema,
} from '@shared/tools/shortlinks/schemas'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { ShortlinksStore } from '../tools/shortlinks/store'

export const toolsShortlinksRoutes = new Hono<AppBindings>()

const WRITE_SCOPE_DENIED = /\/(settings|backups|api-keys|export|import)(\/|$)/

function scopeAllows(scope: string, method: string, path: string): boolean {
  if (scope === 'admin') return true
  if (scope === 'read') return method === 'GET'
  if (method === 'GET') return true
  return !WRITE_SCOPE_DENIED.test(path)
}

toolsShortlinksRoutes.use('*', async (c, next) => {
  const authorization = c.req.header('authorization') ?? ''
  if (!authorization.startsWith('Bearer sl_')) {
    return requireAuth(c, next)
  }

  const store = new ShortlinksStore(c.env.DB, '')
  const resolved = await store.resolveApiKey(authorization.slice('Bearer '.length).trim())
  if (!resolved) {
    throw ApiError.unauthenticated('Invalid API key')
  }
  if (!scopeAllows(resolved.scope, c.req.method, c.req.path)) {
    throw ApiError.forbidden('This API key is not allowed to call this endpoint')
  }
  c.set('userId', resolved.userId)
  await next()
})

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) {
    throw ApiError.unauthenticated()
  }
  return userId
}

function getStore(c: Context<AppBindings>): ShortlinksStore {
  return new ShortlinksStore(c.env.DB, getUserId(c))
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

function parseQuery<T>(c: Context<AppBindings>, schema: z.ZodType<T>): T {
  const raw: Record<string, string> = {}
  for (const [key, value] of new URL(c.req.url).searchParams) raw[key] = value
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query'
    throw ApiError.badRequest(message)
  }
  return result.data
}

function idParam(c: Context<AppBindings>, name = 'id'): number {
  const id = Number(c.req.param(name))
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(`Invalid ${name}`)
  }
  return id
}

function slugParam(c: Context<AppBindings>): string {
  const slug = c.req.param('slug') ?? ''
  const parsed = CustomSlugSchema.safeParse(slug)
  if (!parsed.success) {
    throw ApiError.badRequest('Invalid slug')
  }
  return parsed.data
}

// ---------------------------------------------------------------- Dashboard
toolsShortlinksRoutes.get('/dashboard', async (c) => {
  const store = getStore(c)
  const { range } = parseQuery(c, AnalyticsRangeQuerySchema)
  const stats = await store.getDashboardStats(range)
  return c.json({ ok: true, data: stats })
})

// ---------------------------------------------------------------- Links
toolsShortlinksRoutes.get('/links', async (c) => {
  const store = getStore(c)
  const query = parseQuery(c, ListLinksQuerySchema)

  const res = await store.listLinks({
    filter: query.status,
    sort: query.sort_by,
    sort_order: query.sort_order,
    bundle_id: query.bundle_id,
    search: query.search,
    range: query.range,
    offset: query.offset,
    limit: query.limit,
  })
  return c.json({ ok: true, data: res })
})

toolsShortlinksRoutes.post('/links', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateLinkSchema)
  const link = await store.createLink(body)
  if (!link.label) {
    // The title sniff is a second network hop; creating a link must not wait on the target site.
    const fill = store.fillMissingLabel(link.id).catch(() => {})
    try {
      c.executionCtx.waitUntil(fill)
    } catch {
      void fill
    }
  }
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.get('/links/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const link = await store.getLinkById(id)
  if (!link) {
    throw ApiError.notFound('Link not found')
  }
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const body = await parseBody(c, UpdateLinkSchema)
  const link = await store.updateLink(id, body)
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.delete('/links/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  await store.deleteLink(id)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Slugs
toolsShortlinksRoutes.post('/links/:id/slugs', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const body = await parseBody(c, AddSlugSchema)
  const slug = await store.addSlug(id, body.slug)
  return c.json({ ok: true, data: slug })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id/slugs/:slug/primary', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const slug = slugParam(c)
  await store.setPrimarySlug(id, slug)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id/slugs/:slug/status', async (c) => {
  const store = getStore(c)
  idParam(c)
  const slug = slugParam(c)
  const body = await parseBody(c, SlugStatusSchema)
  if (body.is_active) {
    await store.enableSlug(slug)
  } else {
    await store.disableSlug(slug)
  }
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/links/:id/slugs/:slug', async (c) => {
  const store = getStore(c)
  idParam(c)
  const slug = slugParam(c)
  await store.deleteSlug(slug)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Link Analytics & Breakdown
toolsShortlinksRoutes.get('/links/:id/stats', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const { range } = parseQuery(c, AnalyticsRangeQuerySchema)
  const analytics = await store.getLinkAnalytics(id, range)
  return c.json({ ok: true, data: analytics })
})

toolsShortlinksRoutes.get('/links/:id/timeline', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const { range } = parseQuery(c, AnalyticsRangeQuerySchema)
  const timeline = await store.getTimeline(id, undefined, range)
  return c.json({ ok: true, data: timeline })
})

toolsShortlinksRoutes.get('/links/:id/breakdown', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const query = parseQuery(c, BreakdownQuerySchema)

  const res = await store.getBreakdownPage({
    linkId: id,
    dimension: query.dimension,
    range: query.range,
    offset: query.offset,
    limit: query.limit,
  })
  return c.json({ ok: true, data: res })
})

// ---------------------------------------------------------------- Bundles
toolsShortlinksRoutes.get('/bundles', async (c) => {
  const store = getStore(c)
  const bundles = await store.listBundles()
  return c.json({ ok: true, data: bundles })
})

toolsShortlinksRoutes.post('/bundles', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateBundleSchema)
  const bundle = await store.createBundle(body)
  return c.json({ ok: true, data: bundle })
})

toolsShortlinksRoutes.get('/bundles/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const bundle = await store.getBundleById(id)
  if (!bundle) {
    throw ApiError.notFound('Bundle not found')
  }
  const links = await store.getBundleLinks(id)
  return c.json({ ok: true, data: { ...bundle, links } })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/bundles/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const body = await parseBody(c, UpdateBundleSchema)
  const bundle = await store.updateBundle(id, body)
  return c.json({ ok: true, data: bundle })
})

toolsShortlinksRoutes.delete('/bundles/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  await store.deleteBundle(id)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.get('/bundles/:id/links', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const links = await store.getBundleLinks(id)
  return c.json({ ok: true, data: links })
})

toolsShortlinksRoutes.post('/bundles/:id/links', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const body = await parseBody(c, AddBundleLinksSchema)
  await store.addBundleLinks(id, body.link_ids)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/bundles/:id/links/:linkId', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const linkId = idParam(c, 'linkId')
  await store.removeBundleLink(id, linkId)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.get('/bundles/:id/stats', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const { range } = parseQuery(c, AnalyticsRangeQuerySchema)
  const analytics = await store.getBundleAnalytics(id, range)
  return c.json({ ok: true, data: analytics })
})

toolsShortlinksRoutes.get('/bundles/:id/breakdown', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  const query = parseQuery(c, BreakdownQuerySchema)

  const res = await store.getBreakdownPage({
    bundleId: id,
    dimension: query.dimension,
    range: query.range,
    offset: query.offset,
    limit: query.limit,
  })
  return c.json({ ok: true, data: res })
})

// ---------------------------------------------------------------- Settings
toolsShortlinksRoutes.get('/settings', async (c) => {
  const store = getStore(c)
  const settings = await store.getSettings()
  return c.json({ ok: true, data: settings })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/settings', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, UpdateSettingsSchema)
  const updated = await store.updateSettings(body)
  return c.json({ ok: true, data: updated })
})

// ---------------------------------------------------------------- Backups & Import/Export
toolsShortlinksRoutes.get('/backups', async (c) => {
  const store = getStore(c)
  const backups = await store.listBackups()
  return c.json({ ok: true, data: backups })
})

toolsShortlinksRoutes.post('/backups', async (c) => {
  const store = getStore(c)
  const backup = await store.createBackup(c.env.FILES)
  return c.json({ ok: true, data: backup })
})

toolsShortlinksRoutes.post('/backups/restore', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, RestoreBackupSchema)
  const res = await store.restoreBackup(body.backup_id, c.env.FILES)
  return c.json({ ok: true, data: res })
})

toolsShortlinksRoutes.get('/export/download', async (c) => {
  const key = c.req.query('key')
  const filename = c.req.query('filename') || 'export.txt'
  if (!key) throw ApiError.badRequest('Missing key')
  const userId = getUserId(c)
  const parts = key.split('/')
  const isOwnedExport =
    parts.length === 5 &&
    parts[0] === 'tools' &&
    parts[1] === 'shortlinks' &&
    (parts[2] === 'txt' || parts[2] === 'csv' || parts[2] === 'backup') &&
    parts[3] === userId
  if (!isOwnedExport) {
    throw ApiError.forbidden('Access denied to requested export file')
  }
  const obj = await c.env.FILES?.get(key)
  if (!obj) throw ApiError.notFound('Export file not found')
  const fallbackName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return new Response(obj.body, {
    headers: {
      'content-type': filename.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'x-content-type-options': 'nosniff',
    },
  })
})

toolsShortlinksRoutes.get('/export/txt', async (c) => {
  const store = getStore(c)
  const res = await store.exportData('txt', c.env.FILES)
  const downloadUrl = `/api/tools/shortlinks/export/download?key=${encodeURIComponent(res.key)}&filename=${encodeURIComponent(res.filename)}`
  return c.json({ ok: true, data: { ...res, r2_key: res.key, url: downloadUrl } })
})

toolsShortlinksRoutes.get('/export/csv', async (c) => {
  const store = getStore(c)
  const res = await store.exportData('csv', c.env.FILES)
  const downloadUrl = `/api/tools/shortlinks/export/download?key=${encodeURIComponent(res.key)}&filename=${encodeURIComponent(res.filename)}`
  return c.json({ ok: true, data: { ...res, r2_key: res.key, url: downloadUrl } })
})

toolsShortlinksRoutes.post('/import', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, BatchImportSchema)
  const res = await store.batchImportLinks(body.items)
  return c.json({ ok: true, data: { imported: res.imported, errors: res.failed > 0 ? [`${res.failed} links failed`] : [] } })
})

// ---------------------------------------------------------------- API Keys
toolsShortlinksRoutes.get('/api-keys', async (c) => {
  const store = getStore(c)
  const keys = await store.listApiKeys()
  return c.json({ ok: true, data: keys })
})

toolsShortlinksRoutes.post('/api-keys', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateApiKeySchema)
  const res = await store.createApiKey(body.title, body.scope)
  return c.json({ ok: true, data: { ...res, api_key: res.apiKey } })
})

toolsShortlinksRoutes.delete('/api-keys/:id', async (c) => {
  const store = getStore(c)
  const id = idParam(c)
  await store.deleteApiKey(id)
  return c.json({ ok: true })
})
