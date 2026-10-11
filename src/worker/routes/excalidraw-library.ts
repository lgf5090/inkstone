import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'

export const excalidrawLibraryRoutes = new Hono<AppBindings>()
excalidrawLibraryRoutes.use('*', requireAuth)

const R2_MANIFEST_KEY = 'excalidraw/library/manifest.json'
const DB_FALLBACK_KEY = 'excalidraw_library_manifest'

let cachedCatalog: { timestamp: number; data: unknown } | null = null

excalidrawLibraryRoutes.get('/manifest', async (c) => {
  const r2 = c.env.FILES
  if (r2) {
    try {
      const obj = await r2.get(R2_MANIFEST_KEY)
      if (obj) {
        const text = await obj.text()
        const parsed = JSON.parse(text)
        return c.json({ ok: true, manifest: parsed })
      }
    } catch {
    }
  }

  try {
    const row = await c.env.DB.prepare('SELECT value FROM app_meta WHERE key = ?1')
      .bind(DB_FALLBACK_KEY)
      .first<{ value: string }>()
    if (row?.value) {
      const parsed = JSON.parse(row.value)
      return c.json({ ok: true, manifest: parsed })
    }
  } catch {
  }

  const defaultManifest = {
    version: 2,
    folders: [
      {
        id: 'folder-general',
        name: 'General',
        parentId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: 0,
      },
      {
        id: 'folder-diagrams',
        name: 'Diagrams',
        parentId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: 1,
      },
    ],
    items: [],
    updatedAt: Date.now(),
  }

  return c.json({ ok: true, manifest: defaultManifest })
})

excalidrawLibraryRoutes.put('/manifest', async (c) => {
  const body = await readJson<{ manifest?: unknown }>(c, 10 * 1024 * 1024)
  if (!body.manifest || typeof body.manifest !== 'object') {
    throw ApiError.badRequest('Invalid library manifest')
  }

  const manifestStr = JSON.stringify(body.manifest)
  const r2 = c.env.FILES

  if (r2) {
    try {
      await r2.put(R2_MANIFEST_KEY, manifestStr, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { updatedAt: String(Date.now()) },
      })
    } catch (err: any) {
      console.error('Failed to put library manifest to R2:', err)
    }
  }

  try {
    await c.env.DB.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)')
      .bind(DB_FALLBACK_KEY, manifestStr)
      .run()
  } catch {
  }

  return c.json({ ok: true, updatedAt: Date.now() })
})

excalidrawLibraryRoutes.get('/official-catalog', async (c) => {
  const now = Date.now()
  if (cachedCatalog && now - cachedCatalog.timestamp < 3600_000) {
    return c.json({ ok: true, libraries: cachedCatalog.data })
  }

  try {
    const res = await fetch('https://libraries.excalidraw.com/libraries.json', {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Inkstone-Excalidraw/1.0',
      },
    })
    if (!res.ok) {
      throw new Error(`Upstream returned ${res.status}`)
    }
    const data = await res.json()
    cachedCatalog = { timestamp: now, data }
    return c.json({ ok: true, libraries: data })
  } catch (err: any) {
    if (cachedCatalog) {
      return c.json({ ok: true, libraries: cachedCatalog.data })
    }
    return c.json({ ok: false, error: err?.message || String(err), libraries: [] }, 502)
  }
})

excalidrawLibraryRoutes.post('/official-download', async (c) => {
  const body = await readJson<{ source?: string; url?: string }>(c, 64 * 1024)
  let targetUrl = ''
  let filename = 'library.excalidrawlib'

  if (body.url && /^https?:\/\//i.test(body.url)) {
    targetUrl = body.url.trim()
    try {
      const parsedUrl = new URL(targetUrl)
      const cleanPath = parsedUrl.pathname.replace(/^\/libraries\//, '').replace(/^\/+/, '')
      filename = cleanPath.replace(/\//g, '_') || 'library.excalidrawlib'
    } catch {
      filename = 'library.excalidrawlib'
    }
  } else if (body.source) {
    const rawSource = body.source.trim()
    if (/^https?:\/\//i.test(rawSource)) {
      targetUrl = rawSource
      try {
        const parsedUrl = new URL(targetUrl)
        const cleanPath = parsedUrl.pathname.replace(/^\/libraries\//, '').replace(/^\/+/, '')
        filename = cleanPath.replace(/\//g, '_') || 'library.excalidrawlib'
      } catch {
        filename = 'library.excalidrawlib'
      }
    } else {
      const cleanSource = rawSource.endsWith('.excalidrawlib')
        ? rawSource
        : rawSource.endsWith('.json')
          ? rawSource
          : `${rawSource}.excalidrawlib`
      targetUrl = `https://libraries.excalidraw.com/libraries/${cleanSource}`
      filename = cleanSource.replace(/\//g, '_')
    }
  } else {
    throw ApiError.badRequest('Missing library source or url')
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Inkstone-Excalidraw/1.0',
      },
    })
    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status}`)
    }
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('Downloaded content is not valid Excalidraw library JSON')
    }

    const r2 = c.env.FILES
    if (r2) {
      try {
        const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
        await r2.put(`excalidraw/libraries/${safeName}`, text, {
          httpMetadata: { contentType: 'application/json' },
        })
      } catch {
      }
    }

    return c.json({ ok: true, data, filename })
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || String(err) }, 502)
  }
})

excalidrawLibraryRoutes.post('/save-file', async (c) => {
  const body = await readJson<{ filename?: string; content?: unknown }>(c, 20 * 1024 * 1024)
  const filename = body.filename?.trim() || `lib-${Date.now()}.excalidrawlib`
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const contentStr = typeof body.content === 'string' ? body.content : JSON.stringify(body.content ?? {})

  const r2 = c.env.FILES
  if (r2) {
    await r2.put(`excalidraw/libraries/${safeName}`, contentStr, {
      httpMetadata: { contentType: 'application/json' },
    })
  }

  return c.json({ ok: true, path: `excalidraw/libraries/${safeName}` })
})

excalidrawLibraryRoutes.get('/file/:filename', async (c) => {
  const filename = c.req.param('filename')
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const r2 = c.env.FILES

  if (!r2) {
    throw ApiError.notFound('R2 storage is not configured')
  }

  const obj = await r2.get(`excalidraw/libraries/${safeName}`)
  if (!obj) {
    throw ApiError.notFound('Library file not found in R2')
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${safeName}"`,
    },
  })
})
