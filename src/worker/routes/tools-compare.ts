/**
 * Compare tool API (`/api/tools/compare/*`).
 *
 * Uploads land in R2 under `tools/compare/<kind>/<user>/<assetId>` and only the metadata goes to D1,
 * so listing projects never reads bytes. Every route is scoped by the signed-in reader; the public
 * share surface lives in `tools-compare-public.ts` and takes the slug as its only grant.
 */
import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import {
  AssetKindSchema,
  CreateProjectSchema,
  ListProjectsQuerySchema,
  RunSchema,
  StatsQuerySchema,
  UpdateProjectSchema,
  assetLimit,
  mimeAllowed,
} from '@shared/tools/compare/schemas'
import { TEXT_ENCODINGS } from '@shared/tools/compare/encoding'
import type { DirManifest } from '@shared/tools/compare/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { createMinuteBudget } from '../lib/rate-limit'
import { newSlug } from '../lib/id'
import { requireAuth } from '../middleware/auth'
import { CompareStore } from '../tools/compare/store'
import { compareR2Key } from '../tools/compare/r2'

export const toolsCompareRoutes = new Hono<AppBindings>()

toolsCompareRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function getStore(c: Context<AppBindings>): CompareStore {
  return new CompareStore(c.env.DB, getUserId(c))
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

function parseQuery<T>(c: Context<AppBindings>, schema: z.ZodType<T>): T {
  const raw: Record<string, string> = {}
  for (const [key, value] of new URL(c.req.url).searchParams) raw[key] = value
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query')
  }
  return result.data
}

const uploadBudget = createMinuteBudget(30, 'Too many uploads in one minute, try again shortly')
const writeBudget = createMinuteBudget(60, 'Too many changes in one minute, try again shortly')

function r2(c: Context<AppBindings>): R2Bucket {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  return c.env.FILES
}

/** A manifest is the one upload that is JSON rather than a file the reader picked directly. */
function assertManifest(text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw ApiError.badRequest('The directory manifest is not valid JSON')
  }
  const manifest = parsed as DirManifest
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw ApiError.badRequest('The directory manifest has no entries')
  }
  if (manifest.entries.length > 4_000) {
    throw ApiError.badRequest('The directory has too many files to compare')
  }
  for (const entry of manifest.entries) {
    if (typeof entry?.path !== 'string' || typeof entry?.sha256 !== 'string' || typeof entry?.size !== 'number') {
      throw ApiError.badRequest('The directory manifest has a malformed entry')
    }
  }
}

toolsCompareRoutes.post('/assets', async (c) => {
  const userId = getUserId(c)
  uploadBudget(userId)
  const contentType = c.req.header('Content-Type') ?? ''
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw ApiError.badRequest('An upload has to be multipart/form-data')
  }
  const form = await c.req.formData()
  const kindResult = AssetKindSchema.safeParse(form.get('kind'))
  if (!kindResult.success) throw ApiError.badRequest('Unknown comparison kind')
  const kind = kindResult.data
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('No file uploaded')
  const limit = assetLimit(kind)
  if (file.size > limit) throw ApiError.tooLarge(`The file exceeds the ${Math.round(limit / 1024 / 1024)} MB limit for this kind`)
  if (file.size === 0) throw ApiError.badRequest('The file is empty')

  const mime = file.type || 'application/octet-stream'
  if (!mimeAllowed(kind, mime)) throw ApiError.badRequest(`This file type cannot be compared as ${kind}`)
  const bytes = new Uint8Array(await file.arrayBuffer())

  let encoding: string | null = null
  if (kind === 'text' || kind === 'file') {
    const declared = form.get('encoding')
    if (typeof declared === 'string' && (TEXT_ENCODINGS as readonly string[]).includes(declared)) encoding = declared
  }
  if (kind === 'dir') assertManifest(new TextDecoder().decode(bytes))

  const assetId = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  const filename = (file.name || 'file').slice(0, 255)
  const key = compareR2Key(kind, userId, assetId, filename)
  const store = getStore(c)
  const { r2_key, ...data } = await store.createAsset({
    id: assetId,
    kind,
    filename,
    mime,
    size: bytes.byteLength,
    encoding,
    sha256: await sha256Hex(bytes),
    r2Key: key,
  })
  void r2_key
  await r2(c).put(key, bytes, { httpMetadata: { contentType: mime } })
  return c.json({ ok: true, data })
})

toolsCompareRoutes.get('/assets/:id/content', async (c) => {
  const asset = await getStore(c).getAsset(c.req.param('id'))
  if (!asset) throw ApiError.notFound('Attachment not found')
  const object = await r2(c).get(asset.r2_key)
  if (!object) throw ApiError.notFound('Attachment content is missing')
  return new Response(object.body, {
    headers: {
      'Content-Type': asset.mime,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename="${asset.filename.replace(/["\\]/g, '_')}"`,
    },
  })
})

toolsCompareRoutes.get('/projects', async (c) => {
  const query = parseQuery(c, ListProjectsQuerySchema)
  const data = await getStore(c).listProjects({
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
    kind: query.kind ?? null,
    search: query.search?.trim() || null,
  })
  return c.json({ ok: true, data })
})

toolsCompareRoutes.post('/projects', async (c) => {
  writeBudget(getUserId(c))
  const input = await parseBody(c, CreateProjectSchema)
  const project = await getStore(c).createProject(input)
  return c.json({ ok: true, data: project })
})

toolsCompareRoutes.get('/projects/:id', async (c) => {
  const project = await getStore(c).getProject(Number(c.req.param('id')))
  if (!project) throw ApiError.notFound('Comparison not found')
  return c.json({ ok: true, data: project })
})

toolsCompareRoutes.patch('/projects/:id', async (c) => {
  writeBudget(getUserId(c))
  const patch = await parseBody(c, UpdateProjectSchema)
  const project = await getStore(c).updateProject(Number(c.req.param('id')), patch)
  return c.json({ ok: true, data: project })
})

toolsCompareRoutes.delete('/projects/:id', async (c) => {
  writeBudget(getUserId(c))
  const keys = await getStore(c).deleteProject(Number(c.req.param('id')))
  if (keys.length) await r2(c).delete(keys)
  return c.json({ ok: true, data: { removed: keys.length } })
})

toolsCompareRoutes.post('/projects/:id/share', async (c) => {
  writeBudget(getUserId(c))
  const store = getStore(c)
  const id = Number(c.req.param('id'))
  const project = await store.getProject(id)
  if (!project) throw ApiError.notFound('Comparison not found')
  if (project.share_slug) return c.json({ ok: true, data: { slug: project.share_slug } })
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = newSlug()
    try {
      await store.setShareSlug(id, slug)
      return c.json({ ok: true, data: { slug } })
    } catch {
      // A collision on the unique index is the one expected failure; mint another address.
    }
  }
  throw new ApiError(500, 'internal', 'Could not allocate a share address')
})

toolsCompareRoutes.delete('/projects/:id/share', async (c) => {
  writeBudget(getUserId(c))
  await getStore(c).clearShareSlug(Number(c.req.param('id')))
  return c.json({ ok: true, data: { shared: false } })
})

toolsCompareRoutes.post('/runs', async (c) => {
  const input = await parseBody(c, RunSchema)
  await getStore(c).recordRun(input)
  return c.json({ ok: true, data: { recorded: true } })
})

toolsCompareRoutes.get('/stats', async (c) => {
  const query = parseQuery(c, StatsQuerySchema)
  const stats = await getStore(c).stats(query.range)
  return c.json({ ok: true, data: stats })
})
