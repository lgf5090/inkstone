/**
 * Short Links Manager API routes (`/api/tools/shortlinks/*`).
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  AddBundleLinksSchema,
  AddSlugSchema,
  BatchImportSchema,
  CreateApiKeySchema,
  CreateBundleSchema,
  CreateLinkSchema,
  ExportOptionsSchema,
  UpdateBundleSchema,
  UpdateLinkSchema,
  UpdateSettingsSchema,
} from '@shared/tools/shortlinks/schemas'
import type { TimelineRange } from '@shared/tools/shortlinks/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { ShortlinksStore } from '../tools/shortlinks/store'

export const toolsShortlinksRoutes = new Hono<AppBindings>()

toolsShortlinksRoutes.use('*', requireAuth)

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

// ---------------------------------------------------------------- Dashboard
toolsShortlinksRoutes.get('/dashboard', async (c) => {
  const store = getStore(c)
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const stats = await store.getDashboardStats(range)
  return c.json({ ok: true, data: stats })
})

// ---------------------------------------------------------------- Links
toolsShortlinksRoutes.get('/links', async (c) => {
  const store = getStore(c)
  const filter = (c.req.query('status') || c.req.query('filter') || 'all') as 'all' | 'active' | 'disabled'
  const sort = (c.req.query('sort_by') || c.req.query('sort') || 'created_at') as 'created_at' | 'clicks'
  const sortOrder = (c.req.query('sort_order') || 'desc') as 'asc' | 'desc'
  const bundleId = c.req.query('bundle_id') ? Number(c.req.query('bundle_id')) : undefined
  const search = c.req.query('search')
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const offset = Number(c.req.query('offset')) || 0
  const limit = Number(c.req.query('limit')) || 20

  const res = await store.listLinks({ filter, sort, sort_order: sortOrder, bundle_id: bundleId, search, range, offset, limit })
  return c.json({ ok: true, data: res })
})

toolsShortlinksRoutes.post('/links', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateLinkSchema)
  const link = await store.createLink(body)
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.get('/links/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  if (isNaN(id) || id <= 0) {
    throw ApiError.badRequest('Invalid link id')
  }
  const link = await store.getLinkById(id)
  if (!link) {
    throw ApiError.notFound('Link not found')
  }
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  if (isNaN(id) || id <= 0) {
    throw ApiError.badRequest('Invalid link id')
  }
  const body = await parseBody(c, UpdateLinkSchema)
  const link = await store.updateLink(id, body, c.env.SHORTLINKS_KV)
  return c.json({ ok: true, data: link })
})

toolsShortlinksRoutes.post('/links/:id/disable', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.disableLink(id, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.post('/links/:id/enable', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.enableLink(id, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/links/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.deleteLink(id, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Slugs
toolsShortlinksRoutes.post('/links/:id/slugs', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const body = await parseBody(c, AddSlugSchema)
  const slug = await store.addSlug(id, body.slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true, data: slug })
})

toolsShortlinksRoutes.put('/links/:id/slugs/primary', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ slug: string }>()
  if (!body.slug) {
    throw ApiError.badRequest('Missing slug')
  }
  await store.setPrimarySlug(id, body.slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id/slugs/:slug/primary', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const slug = c.req.param('slug')
  if (!slug) {
    throw ApiError.badRequest('Missing slug')
  }
  await store.setPrimarySlug(id, slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/links/:id/slugs/:slug/status', async (c) => {
  const store = getStore(c)
  const slug = c.req.param('slug')
  const body = await c.req.json<{ is_active?: boolean; active?: boolean }>().catch(() => ({} as { is_active?: boolean; active?: boolean }))
  const active = body.is_active ?? body.active ?? true
  if (active) {
    await store.enableSlug(slug, c.env.SHORTLINKS_KV)
  } else {
    await store.disableSlug(slug, c.env.SHORTLINKS_KV)
  }
  return c.json({ ok: true })
})

toolsShortlinksRoutes.post('/links/:id/slugs/:slug/disable', async (c) => {
  const store = getStore(c)
  const slug = c.req.param('slug')
  await store.disableSlug(slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.post('/links/:id/slugs/:slug/enable', async (c) => {
  const store = getStore(c)
  const slug = c.req.param('slug')
  await store.enableSlug(slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/links/:id/slugs/:slug', async (c) => {
  const store = getStore(c)
  const slug = c.req.param('slug')
  await store.deleteSlug(slug, c.env.SHORTLINKS_KV)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- Link Analytics & Breakdown
toolsShortlinksRoutes.get('/links/:id/analytics', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const analytics = await store.getLinkAnalytics(id, range)
  const timeline = await store.getTimeline(id, undefined, range)
  return c.json({ ok: true, data: { ...analytics, timeline } })
})

toolsShortlinksRoutes.get('/links/:id/stats', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const analytics = await store.getLinkAnalytics(id, range)
  return c.json({ ok: true, data: analytics })
})

toolsShortlinksRoutes.get('/links/:id/timeline', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const timeline = await store.getTimeline(id, undefined, range)
  return c.json({ ok: true, data: timeline })
})

toolsShortlinksRoutes.get('/links/:id/breakdown', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const dimension = c.req.query('dimension') || 'country'
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const offset = Number(c.req.query('offset')) || 0
  const limit = Number(c.req.query('limit')) || 10

  const res = await store.getBreakdownPage({ linkId: id, dimension, range, offset, limit })
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
  const id = Number(c.req.param('id'))
  const bundle = await store.getBundleById(id)
  if (!bundle) {
    throw ApiError.notFound('Bundle not found')
  }
  const links = await store.getBundleLinks(id)
  return c.json({ ok: true, data: { ...bundle, links } })
})

toolsShortlinksRoutes.on(['PUT', 'PATCH'], '/bundles/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const body = await parseBody(c, UpdateBundleSchema)
  const bundle = await store.updateBundle(id, body)
  return c.json({ ok: true, data: bundle })
})

toolsShortlinksRoutes.delete('/bundles/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.deleteBundle(id)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.post('/bundles/:id/archive', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.archiveBundle(id)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.post('/bundles/:id/unarchive', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.unarchiveBundle(id)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.get('/bundles/:id/links', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const links = await store.getBundleLinks(id)
  return c.json({ ok: true, data: links })
})

toolsShortlinksRoutes.post('/bundles/:id/links', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const body = await parseBody(c, AddBundleLinksSchema)
  await store.addBundleLinks(id, body.link_ids)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/bundles/:id/links/:linkId', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const linkId = Number(c.req.param('linkId'))
  await store.removeBundleLink(id, linkId)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.get('/bundles/:id/analytics', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const analytics = await store.getBundleAnalytics(id, range)
  return c.json({ ok: true, data: analytics })
})

toolsShortlinksRoutes.get('/bundles/:id/stats', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const analytics = await store.getBundleAnalytics(id, range)
  return c.json({ ok: true, data: analytics })
})

toolsShortlinksRoutes.get('/bundles/:id/breakdown', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const dimension = c.req.query('dimension') || 'country'
  const range = (c.req.query('range') as TimelineRange) || '30d'
  const offset = Number(c.req.query('offset')) || 0
  const limit = Number(c.req.query('limit')) || 10

  const res = await store.getBreakdownPage({ bundleId: id, dimension, range, offset, limit })
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
  const body = await c.req.json<{ backup_id: string }>()
  const res = await store.restoreBackup(String(body.backup_id), c.env.FILES)
  return c.json({ ok: true, data: res })
})

toolsShortlinksRoutes.post('/export', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, ExportOptionsSchema)
  const res = await store.exportData(body.format, c.env.FILES)
  const downloadUrl = `/api/tools/shortlinks/export/download?key=${encodeURIComponent(res.key)}&filename=${encodeURIComponent(res.filename)}`
  return c.json({ ok: true, data: { ...res, r2_key: res.key, url: downloadUrl } })
})

toolsShortlinksRoutes.get('/export/download', async (c) => {
  const key = c.req.query('key')
  const filename = c.req.query('filename') || 'export.txt'
  if (!key) throw ApiError.badRequest('Missing key')
  const userId = c.get('userId')
  if (!key.startsWith('tools/shortlinks/') || !key.includes(`/${userId}/`)) {
    throw ApiError.forbidden('Access denied to requested export file')
  }
  const obj = await c.env.FILES?.get(key)
  if (!obj) throw ApiError.notFound('Export file not found')
  return new Response(obj.body, {
    headers: {
      'content-type': filename.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
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
toolsShortlinksRoutes.get('/keys', async (c) => {
  const store = getStore(c)
  const keys = await store.listApiKeys()
  return c.json({ ok: true, data: keys })
})

toolsShortlinksRoutes.get('/api-keys', async (c) => {
  const store = getStore(c)
  const keys = await store.listApiKeys()
  return c.json({ ok: true, data: keys })
})

toolsShortlinksRoutes.post('/keys', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateApiKeySchema)
  const res = await store.createApiKey(body.title, body.scope)
  return c.json({ ok: true, data: { ...res, api_key: res.apiKey } })
})

toolsShortlinksRoutes.post('/api-keys', async (c) => {
  const store = getStore(c)
  const body = await parseBody(c, CreateApiKeySchema)
  const res = await store.createApiKey(body.title, body.scope)
  return c.json({ ok: true, data: { ...res, api_key: res.apiKey } })
})

toolsShortlinksRoutes.delete('/keys/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.deleteApiKey(id)
  return c.json({ ok: true })
})

toolsShortlinksRoutes.delete('/api-keys/:id', async (c) => {
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  await store.deleteApiKey(id)
  return c.json({ ok: true })
})
