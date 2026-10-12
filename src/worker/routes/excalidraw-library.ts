import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readJson } from '../lib/request'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

export const excalidrawLibraryRoutes = new Hono<AppBindings>()
excalidrawLibraryRoutes.use('*', requireAuth)

const OFFICIAL_LIBRARY_HOST = 'libraries.excalidraw.com'
const OFFICIAL_CATALOG_URL = `https://${OFFICIAL_LIBRARY_HOST}/libraries.json`
const OFFICIAL_FETCH_MAX_BYTES = 5 * 1024 * 1024

function manifestR2Key(userId: string): string {
  return `excalidraw/library/${userId}/manifest.json`
}

function manifestDbKey(userId: string): string {
  return `excalidraw_library_manifest_${userId}`
}

function libraryR2Key(userId: string, safeName: string): string {
  return `excalidraw/libraries/${userId}/${safeName}`
}

function safeLibraryName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'library.excalidrawlib'
}

/**
 * Only `libraries.excalidraw.com` may be fetched, and only for a `.excalidrawlib` path. The catalog and
 * the download endpoints both run with this app's credentials from Cloudflare's edge, so an unchecked URL
 * would turn them into a general-purpose proxy for whatever host a note or a hash fragment names.
 */
export function officialLibraryUrl(source: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== OFFICIAL_LIBRARY_HOST) return null
  if (parsed.username || parsed.search || parsed.hash) return null
  if (!/^\/libraries\/[^?#]+\.excalidrawlib$/.test(parsed.pathname)) return null
  return parsed
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel('payload_too_large')
      throw new Error(`Library exceeds the ${maxBytes / 1024 / 1024} MB limit`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

let cachedCatalog: { timestamp: number; data: unknown } | null = null

excalidrawLibraryRoutes.get('/manifest', async (c) => {
  const userId = c.get('userId')
  const r2 = c.env.FILES
  if (r2) {
    try {
      const obj = await r2.get(manifestR2Key(userId))
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
      .bind(manifestDbKey(userId))
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
  const userId = c.get('userId')
  const body = await readJson<{ manifest?: unknown }>(c, 10 * 1024 * 1024)
  if (!body.manifest || typeof body.manifest !== 'object') {
    throw ApiError.badRequest('Invalid library manifest')
  }

  const manifestStr = JSON.stringify(body.manifest)
  const r2 = c.env.FILES

  if (r2) {
    try {
      await r2.put(manifestR2Key(userId), manifestStr, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { updatedAt: String(Date.now()), userId },
      })
    } catch (err: any) {
      console.error('Failed to put library manifest to R2:', err)
    }
  }

  try {
    await c.env.DB.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)')
      .bind(manifestDbKey(userId), manifestStr)
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
    const res = await fetch(OFFICIAL_CATALOG_URL, {
      redirect: NO_REDIRECT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Inkstone-Excalidraw/1.0',
      },
    })
    if (isRedirectResponse(res)) {
      throw new Error('Upstream redirected, which catalog fetches refuse')
    }
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
  const userId = c.get('userId')
  const body = await readJson<{ source?: string; url?: string }>(c, 64 * 1024)
  const raw = (typeof body.url === 'string' ? body.url : '').trim()
    || (typeof body.source === 'string' ? body.source : '').trim()
  if (!raw) {
    throw ApiError.badRequest('Missing library source or url')
  }

  const named = /\.(?:excalidrawlib|json)$/i.test(raw) ? raw : `${raw}.excalidrawlib`
  const candidate = /^https?:\/\//i.test(raw)
    ? officialLibraryUrl(raw)
    : officialLibraryUrl(`https://${OFFICIAL_LIBRARY_HOST}/libraries/${named}`)
  if (!candidate) {
    throw ApiError.badRequest('Only official Excalidraw library files may be fetched')
  }
  const filename = candidate.pathname.split('/').pop() ?? 'library.excalidrawlib'

  try {
    const res = await fetch(candidate.toString(), {
      redirect: NO_REDIRECT,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Inkstone-Excalidraw/1.0',
      },
    })
    if (isRedirectResponse(res)) {
      throw new Error('Upstream redirected, which library fetches refuse')
    }
    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status}`)
    }
    const text = await readBodyCapped(res, OFFICIAL_FETCH_MAX_BYTES)
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('Downloaded content is not valid Excalidraw library JSON')
    }

    const r2 = c.env.FILES
    if (r2) {
      try {
        await r2.put(libraryR2Key(userId, safeLibraryName(filename)), text, {
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
  const userId = c.get('userId')
  const body = await readJson<{ filename?: string; content?: unknown }>(c, 20 * 1024 * 1024)
  const filename = body.filename?.trim() || `lib-${Date.now()}.excalidrawlib`
  const safeName = safeLibraryName(filename)
  const contentStr = typeof body.content === 'string' ? body.content : JSON.stringify(body.content ?? {})

  const r2 = c.env.FILES
  if (r2) {
    await r2.put(libraryR2Key(userId, safeName), contentStr, {
      httpMetadata: { contentType: 'application/json' },
    })
  }

  return c.json({ ok: true, path: libraryR2Key(userId, safeName) })
})

excalidrawLibraryRoutes.get('/file/:filename', async (c) => {
  const userId = c.get('userId')
  const filename = c.req.param('filename')
  const safeName = safeLibraryName(filename)
  const r2 = c.env.FILES

  if (!r2) {
    throw ApiError.notFound('R2 storage is not configured')
  }

  const obj = await r2.get(libraryR2Key(userId, safeName))
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
