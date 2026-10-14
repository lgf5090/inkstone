import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { readBytesWithinLimit, readJson } from '../lib/request'
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
  try {
    return new TextDecoder().decode(await readBytesWithinLimit(res.body, maxBytes))
  } catch (error) {
    // `readBytesWithinLimit` answers a body-cap breach as an ApiError; this route reports it as an
    // upstream failure instead, so the library-specific message is kept.
    if (error instanceof ApiError) throw new Error(`Library exceeds the ${maxBytes / 1024 / 1024} MB limit`)
    throw error
  }
}

interface CatalogCache {
  timestamp: number
  data: unknown[]
}

let cachedCatalog: CatalogCache | null = null
const CATALOG_TTL = 3600_000
const CATALOG_HEADERS = { 'Cache-Control': 'public, max-age=300' }

/**
 * `itemNames` is roughly half of libraries.json - one string per stencil, and 232 libraries carry
 * 38k characters of them - while the browser only ever matches on name, description and author.
 * Dropping it here halves both the upstream body and what the client has to parse.
 */
export function trimOfficialCatalog(raw: unknown): unknown[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { libraries?: unknown } | null)?.libraries)
      ? (raw as { libraries: unknown[] }).libraries
      : []
  return list.map((entry) => {
    const { itemNames, ...rest } = (entry ?? {}) as Record<string, unknown>
    return rest
  })
}

async function fetchOfficialCatalog(): Promise<unknown[]> {
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
  return trimOfficialCatalog(await res.json())
}

/**
 * One refresh per isolate. Without this, every request that arrives after the window closes would
 * schedule its own upstream fetch, so a busy minute would turn into a burst of identical fetches.
 */
let catalogRefresh: Promise<void> | null = null

function refreshCatalogInBackground(): Promise<void> {
  if (catalogRefresh) return catalogRefresh
  catalogRefresh = fetchOfficialCatalog().then(
    (data) => { cachedCatalog = { timestamp: Date.now(), data } },
    () => {},
  ).finally(() => { catalogRefresh = null })
  return catalogRefresh
}

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
    } catch (err) {
      // Best-effort read: R2 is the primary store, but a failure here falls through to the D1 copy
      // and then the default manifest rather than failing the whole request.
      console.warn('[inkstone] Failed to read library manifest from R2:', err)
    }
  }

  try {
    const raw = await getMeta(c.env.DB, manifestDbKey(userId))
    if (raw) {
      return c.json({ ok: true, manifest: JSON.parse(raw) })
    }
  } catch (err) {
    // Same fallback chain as above: a missing or unreadable D1 copy still answers with a manifest.
    console.warn('[inkstone] Failed to read library manifest from D1:', err)
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
    } catch (err) {
      // Best-effort archive: the D1 copy below is the fallback, so a failed R2 write must not fail
      // a save the account can still recover from.
      console.error('[inkstone] Failed to put library manifest to R2:', err)
    }
  }

  try {
    await setMeta(c.env.DB, manifestDbKey(userId), manifestStr)
  } catch (err) {
    // Best-effort mirror: the manifest is already in R2, so a failed D1 write is logged, not fatal.
    console.warn('[inkstone] Failed to put library manifest to D1:', err)
  }

  return c.json({ ok: true, updatedAt: Date.now() })
})

excalidrawLibraryRoutes.get('/official-catalog', async (c) => {
  const now = Date.now()
  if (cachedCatalog) {
    // Past its window the cache still answers right away; refreshing runs behind the response so a
    // slow upstream never lands on the reader's critical path again.
    if (now - cachedCatalog.timestamp >= CATALOG_TTL) {
      c.executionCtx?.waitUntil(refreshCatalogInBackground())
    }
    return c.json({ ok: true, libraries: cachedCatalog.data }, 200, CATALOG_HEADERS)
  }

  try {
    const data = await fetchOfficialCatalog()
    cachedCatalog = { timestamp: now, data }
    return c.json({ ok: true, libraries: data }, 200, CATALOG_HEADERS)
  } catch (err) {
    console.warn('[inkstone] Official Excalidraw catalog fetch failed:', err)
    throw new ApiError(502, 'internal', 'The official library catalog is unavailable')
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
      // Archiving the raw file is bookkeeping the importer does not wait for, so it runs behind the
      // response instead of adding an R2 round trip to every one-click import.
      c.executionCtx?.waitUntil(
        r2.put(libraryR2Key(userId, safeLibraryName(filename)), text, {
          httpMetadata: { contentType: 'application/json' },
        }).catch(() => {}),
      )
    }

    return c.json({ ok: true, data, filename })
  } catch (err) {
    console.warn('[inkstone] Official Excalidraw library download failed:', err)
    throw new ApiError(502, 'internal', 'The official library could not be downloaded')
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
