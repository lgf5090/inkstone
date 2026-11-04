/**
 * The authenticated ScriptsHub API (`/api/scriptshub/*`).
 *
 * The routes parse and validate; the store owns every statement. Two things are deliberately
 * outside the store because they reach another service: an asset upload writes R2 and then records
 * the object key, and a publication may ask the existing short-link module for an address instead of
 * inventing a second shortener.
 */

import { Hono, type Context } from 'hono'
import { isScriptLanguage } from '@shared/scriptshub/languages'
import { publicationUrlPath } from '@shared/scriptshub/path'
import { serializeScriptExport } from '@shared/scriptshub/import'
import type {
  ScriptBatchInput,
  ScriptImportInput,
  ScriptListQuery,
  ScriptPublicationInput,
  ScriptPublicationPatch,
  ScriptSnippetInput,
  ScriptSnippetSaveInput,
  ScriptTagInput,
  ScriptStatsRange,
} from '@shared/scriptshub/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readFormDataWithinLimit, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { newId, isValidId } from '../lib/id'
import { ShortlinksStore } from '../tools/shortlinks/store'
import { ScriptsHubStore } from './store'

const BODY_MAX = 8 * 1024 * 1024
const ASSET_MAX_BYTES = 10 * 1024 * 1024
const ASSET_MIME = /^(image\/(?!svg)[a-z0-9.+-]+|application\/(pdf|zip|octet-stream)|text\/plain|application\/json)$/i

export const scriptshubRoutes = new Hono<AppBindings>()

function store(c: Context<AppBindings>): ScriptsHubStore {
  return new ScriptsHubStore(c.env.DB, c.get('userId'))
}

scriptshubRoutes.use('*', requireAuth)

scriptshubRoutes.get('/overview', async (c) => c.json(await store(c).overview()))

scriptshubRoutes.get('/folders', async (c) => c.json({ folders: await store(c).listFolders() }))

scriptshubRoutes.post('/folders', async (c) => {
  const body = await readJson<{ name?: string; parentId?: string | null; icon?: string | null; color?: string | null }>(c, JSON_BODY_LIMITS.small)
  const folder = await store(c).createFolder({
    name: body.name ?? '',
    parentId: body.parentId ?? null,
    icon: body.icon,
    color: body.color,
  })
  return c.json(folder, 201)
})

scriptshubRoutes.patch('/folders/:id', async (c) => {
  const body = await readJson<{ name?: string; parentId?: string | null; icon?: string | null; color?: string | null }>(c, JSON_BODY_LIMITS.small)
  return c.json(await store(c).updateFolder(c.req.param('id'), body))
})

scriptshubRoutes.delete('/folders/:id', async (c) => {
  await store(c).deleteFolder(c.req.param('id'))
  return c.json({ ok: true })
})

scriptshubRoutes.get('/tags', async (c) => c.json({ tags: await store(c).listTags() }))

scriptshubRoutes.post('/tags', async (c) => {
  const body = await readJson<ScriptTagInput>(c, JSON_BODY_LIMITS.small)
  return c.json(await store(c).createTag(body), 201)
})

scriptshubRoutes.patch('/tags/:id', async (c) => {
  const body = await readJson<Partial<ScriptTagInput>>(c, JSON_BODY_LIMITS.small)
  return c.json(await store(c).updateTag(c.req.param('id'), body))
})

scriptshubRoutes.delete('/tags/:id', async (c) => {
  await store(c).deleteTag(c.req.param('id'))
  return c.json({ ok: true })
})

function queryOf(c: Context<AppBindings>): ScriptListQuery {
  const quick = c.req.query('quick')
  const sort = c.req.query('sort')
  return {
    search: c.req.query('search') ?? '',
    folderId: c.req.query('folderId') || null,
    tagId: c.req.query('tagId') || null,
    quick: quick === 'favorites' || quick === 'pinned' || quick === 'deprecated' || quick === 'published'
      ? quick
      : 'all',
    sort: sort === 'created' || sort === 'title' || sort === 'uses' ? sort : 'updated',
    limit: Number(c.req.query('limit') ?? 50),
    offset: Number(c.req.query('offset') ?? 0),
  }
}

scriptshubRoutes.get('/snippets', async (c) => c.json(await store(c).listSnippets(queryOf(c))))

scriptshubRoutes.post('/snippets', async (c) => {
  const body = await readJson<ScriptSnippetInput>(c, JSON_BODY_LIMITS.small)
  if (!body.language || !isScriptLanguage(body.language)) body.language = 'shell'
  return c.json(await store(c).createSnippet(body), 201)
})

scriptshubRoutes.get('/snippets/:id', async (c) => c.json(await store(c).getSnippet(c.req.param('id'))))

scriptshubRoutes.patch('/snippets/:id', async (c) => {
  const body = await readJson<Partial<ScriptSnippetInput> & {
    isFavorite?: boolean
    isPinned?: boolean
    isDeprecated?: boolean
  }>(c, BODY_MAX)
  return c.json(await store(c).updateSnippet(c.req.param('id'), body))
})

scriptshubRoutes.put('/snippets/:id', async (c) => {
  const body = await readJson<ScriptSnippetSaveInput>(c, BODY_MAX)
  if (!body.language || !isScriptLanguage(body.language)) body.language = 'shell'
  return c.json(await store(c).saveSnippet(c.req.param('id'), body))
})

scriptshubRoutes.delete('/snippets/:id', async (c) => {
  const s = store(c)
  const id = c.req.param('id')
  const keys = c.env.FILES ? await s.assetKeysForSnippet(id) : []
  await s.deleteSnippet(id)
  if (c.env.FILES && keys.length) {
    const removal = c.env.FILES.delete(keys).catch((error: unknown) => {
      console.warn('[inkstone] scriptshub asset cleanup failed:', error instanceof Error ? error.message : error)
    })
    try {
      c.executionCtx.waitUntil(removal)
    } catch {
      void removal
    }
  }
  return c.json({ ok: true })
})

scriptshubRoutes.post('/snippets/batch', async (c) => {
  const body = await readJson<ScriptBatchInput>(c, JSON_BODY_LIMITS.small)
  if (body.action !== 'tag' && body.action !== 'move' && body.action !== 'delete') {
    throw ApiError.badRequest('Unknown batch action')
  }
  return c.json(await store(c).batch(body))
})

scriptshubRoutes.post('/snippets/:id/copies', async (c) => {
  const body = await readJson<{ fileId?: string; surface?: string }>(c, JSON_BODY_LIMITS.small)
  const fileId = body.fileId && isValidId(body.fileId) ? body.fileId : null
  await store(c).recordCopy(c.req.param('id'), fileId, body.surface ?? 'app')
  return c.json({ ok: true })
})

scriptshubRoutes.get('/snippets/:id/revisions', async (c) => c.json({ revisions: await store(c).listRevisions(c.req.param('id')) }))

scriptshubRoutes.get('/snippets/:id/revisions/:version', async (c) => {
  const version = Number(c.req.param('version'))
  if (!Number.isSafeInteger(version) || version < 1) throw ApiError.badRequest('A revision number is a positive integer')
  return c.json(await store(c).readRevision(c.req.param('id'), version))
})

scriptshubRoutes.post('/snippets/:id/revisions/:version/restore', async (c) => {
  const version = Number(c.req.param('version'))
  if (!Number.isSafeInteger(version) || version < 1) throw ApiError.badRequest('A revision number is a positive integer')
  return c.json(await store(c).restoreRevision(c.req.param('id'), version))
})

scriptshubRoutes.get('/publications', async (c) => c.json({ publications: await store(c).listPublications() }))

scriptshubRoutes.post('/snippets/:id/publications', async (c) => {
  const body = await readJson<ScriptPublicationInput>(c, JSON_BODY_LIMITS.small)
  const s = store(c)
  const created = await s.createPublication(c.req.param('id'), body)
  let shortUrl: string | undefined
  if (body.createShortlink) {
    try {
      const absolute = new URL(publicationUrlPath(created.path), c.req.url).toString()
      const link = await new ShortlinksStore(c.env.DB, c.get('userId')).createLink({
        url: absolute,
        label: created.path,
        allow_duplicate: true,
        created_via: 'scriptshub',
      })
      const slug = link.slugs.find((entry) => entry.is_primary)?.slug ?? link.slugs[0]?.slug
      if (!slug) throw new Error('The short link answered without a slug')
      await s.setShortSlug(created.id, slug)
      created.shortSlug = slug
      shortUrl = `/l/${slug}`
    } catch (error) {
      // The publication is the durable promise; a short code is a convenience beside it. The route
      // says so rather than failing the publish the reader just asked for.
      console.warn('[inkstone] scriptshub shortlink creation failed:', error instanceof Error ? error.message : error)
    }
  }
  return c.json({ ...created, ...(shortUrl ? { shortUrl } : {}) }, 201)
})

scriptshubRoutes.patch('/publications/:id', async (c) => {
  const body = await readJson<ScriptPublicationPatch>(c, JSON_BODY_LIMITS.small)
  return c.json(await store(c).updatePublication(c.req.param('id'), body))
})

scriptshubRoutes.post('/publications/:id/token', async (c) => {
  const result = await store(c).rotatePublicationToken(c.req.param('id'))
  const absolute = new URL(publicationUrlPath(result.publication.path), c.req.url).toString()
  return c.json({ ...result, tokenUrl: `${absolute}?token=${encodeURIComponent(result.token)}` })
})

scriptshubRoutes.delete('/publications/:id', async (c) => {
  await store(c).deletePublication(c.req.param('id'))
  return c.json({ ok: true })
})

scriptshubRoutes.get('/stats', async (c) => {
  const range = c.req.query('range') as ScriptStatsRange | undefined
  return c.json(await store(c).stats(range ?? '30d'))
})

scriptshubRoutes.get('/snippets/:id/assets', async (c) => c.json({ assets: await store(c).listAssets(c.req.param('id')) }))

scriptshubRoutes.post('/snippets/:id/assets', async (c) => {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Asset storage is not configured')
  const s = store(c)
  const snippetId = c.req.param('id')
  await s.getSnippet(snippetId)
  const form = await readFormDataWithinLimit({ raw: c.req.raw }, ASSET_MAX_BYTES + 512 * 1024)
  const upload = form.get('file')
  if (!(upload instanceof File)) throw ApiError.badRequest('An asset is expected in the "file" field')
  const name = upload.name.replace(/[\\/]/g, '_').trim().slice(0, 128)
  if (!name) throw ApiError.badRequest('The file needs a name')
  const type = upload.type || 'application/octet-stream'
  if (!ASSET_MIME.test(type)) throw new ApiError(415, 'bad_request', 'This asset type cannot be stored')
  if (upload.size > ASSET_MAX_BYTES) throw ApiError.tooLarge('An asset may hold at most 10 MB')
  const id = newId()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const folder = type.startsWith('image/') ? 'images' : 'files'
  const key = `scriptshub/${folder}/${c.get('userId')}/${id}${extension ? `.${extension}` : ''}`
  const bytes = await upload.arrayBuffer()
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType: type, contentDisposition: `inline; filename="${name.replace(/["\\]/g, '_')}"` },
  })
  await s.createAsset({ snippetId, id, fileName: name, contentType: type, byteSize: upload.size, r2Key: key })
  return c.json({
    asset: { id, snippetId, fileName: name, contentType: type, byteSize: upload.size, createdAt: Date.now() },
  }, 201)
})

scriptshubRoutes.get('/assets/:id', async (c) => {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Asset storage is not configured')
  const row = await store(c).assetRow(c.req.param('id'))
  if (!row) throw ApiError.notFound('Asset not found')
  const object = await c.env.FILES.get(row.r2_key)
  if (!object) throw ApiError.notFound('Asset not found')
  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type,
      'Content-Length': String(row.byte_size),
      'Content-Disposition': `inline; filename="${row.file_name.replace(/["\\]/g, '_')}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

scriptshubRoutes.delete('/assets/:id', async (c) => {
  const row = await store(c).deleteAsset(c.req.param('id'))
  if (!row) throw ApiError.notFound('Asset not found')
  if (c.env.FILES) {
    const removal = c.env.FILES.delete(row.r2_key).catch((error: unknown) => {
      console.warn('[inkstone] scriptshub asset delete failed:', error instanceof Error ? error.message : error)
    })
    try {
      c.executionCtx.waitUntil(removal)
    } catch {
      void removal
    }
  }
  return c.json({ ok: true })
})

scriptshubRoutes.post('/import', async (c) => {
  const body = await readJson<ScriptImportInput>(c, BODY_MAX)
  if (body.source !== 'masscode' && body.source !== 'vscode' && body.source !== 'generic') {
    throw ApiError.badRequest('Unknown import source')
  }
  if (body.conflict !== 'skip' && body.conflict !== 'rename' && body.conflict !== 'overwrite') {
    throw ApiError.badRequest('Unknown conflict policy')
  }
  if (!Array.isArray(body.entries)) throw ApiError.badRequest('The import carries no snippets')
  return c.json(await store(c).importEntries(body.entries, body.conflict, body.folderId ?? null))
})

scriptshubRoutes.get('/export', async (c) => {
  const format = c.req.query('format') === 'masscode' || c.req.query('format') === 'vscode'
    ? c.req.query('format')!
    : 'generic'
  const entries = await store(c).exportEntries()
  if (format === 'masscode') {
    return c.json(entries.map((entry) => ({
      name: entry.title,
      description: entry.description,
      tags: entry.tags,
      content: entry.files.map((file) => ({ language: file.language, value: file.content })),
    })))
  }
  if (format === 'vscode') {
    const out: Record<string, { scope?: string; body: string[]; description?: string }> = {}
    for (const entry of entries) {
      const file = entry.files[0]
      if (!file) continue
      out[entry.title] = {
        scope: file.language,
        body: file.content.split('\n'),
        ...(entry.description ? { description: entry.description } : {}),
      }
    }
    return c.json(out)
  }
  return new Response(serializeScriptExport(entries), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="scriptshub.json"' },
  })
})
