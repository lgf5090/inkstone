import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { requireAuth } from '../middleware/auth'
import { newId } from '../lib/id'
import { hasExpectedImageSignature, readImageSize } from '../lib/image'
import { NAV_LIMITS, isNavId, isSafeIconValue } from '@shared/nav/model'
import { NavFaviconSchema, NavIconCaptureSchema } from '@shared/nav/validation'
import { guardedFetch, readGuardedBytes } from './safe-fetch'
import { deleteNavObject, getNavObject, navIconObjectKey, putNavObject, selectNavStorage, type NavStorageKind } from './storage'

export const navIconRoutes = new Hono<AppBindings>()
navIconRoutes.use('*', requireAuth)

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

interface IconRow {
  id: string
  user_id: string
  object_key: string
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  source: string
  source_url: string | null
  created_at: number
}

function iconUrl(id: string): string {
  return `/api/nav/icons/${id}`
}

interface Sniffed {
  contentType: string
  extension: string
  width: number | null
  height: number | null
}

function sniffIcon(bytes: Uint8Array): Sniffed | null {
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    const count = bytes.length >= 6 ? bytes[4]! | (bytes[5]! << 8) : 0
    let width = 0
    let height = 0
    if (count > 0 && bytes.length >= 16) {
      width = bytes[6] === 0 ? 256 : bytes[6]!
      height = bytes[7] === 0 ? 256 : bytes[7]!
    }
    return { contentType: 'image/x-icon', extension: 'ico', width: width || null, height: height || null }
  }
  for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const) {
    if (!hasExpectedImageSignature(bytes, contentType)) continue
    const size = readImageSize(bytes, contentType)
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1]!.replace('svg+xml', 'svg')
    return { contentType, extension, width: size?.width ?? null, height: size?.height ?? null }
  }
  return null
}

async function insertIcon(
  c: Context<AppBindings>,
  bytes: Uint8Array,
  source: 'upload' | 'captured',
  sourceUrl: string | null,
): Promise<{ id: string; url: string; width: number | null; height: number | null }> {
  const kind = selectNavStorage(c.env)
  if (!kind) throw new ApiError(503, 'storage_unavailable', 'Icon storage is not configured')
  const sniffed = sniffIcon(bytes)
  if (!sniffed) throw new ApiError(415, 'nav_icon_invalid', 'Icon must be a PNG, JPEG, GIF, WebP, AVIF or ICO image')
  if (sniffed.width && sniffed.height && (sniffed.width > NAV_LIMITS.iconDimension || sniffed.height > NAV_LIMITS.iconDimension)) {
    throw new ApiError(413, 'payload_too_large', 'Icon dimensions are too large')
  }
  const id = newId()
  const key = navIconObjectKey(id, sniffed.extension)
  await putNavObject(c.env, kind, key, bytes, sniffed.contentType)
  try {
    await c.env.DB.prepare(`INSERT INTO nav_icons (id, user_id, object_key, content_type, byte_size, width, height, source, source_url, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(id, userId(c), key, sniffed.contentType, bytes.byteLength, sniffed.width, sniffed.height, source, sourceUrl, Date.now())
      .run()
  } catch (error) {
    await deleteNavObject(c.env, kind, key).catch(() => {})
    throw error
  }
  return { id, url: iconUrl(id), width: sniffed.width, height: sniffed.height }
}

navIconRoutes.post('/icons', async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('A file field is required')
  if (file.size <= 0 || file.size > NAV_LIMITS.iconBytes) throw new ApiError(413, 'payload_too_large', 'Icon is too large')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const icon = await insertIcon(c, bytes, 'upload', null)
  return c.json({ icon })
})

navIconRoutes.post('/icons/capture', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = NavIconCaptureSchema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest('A valid url is required')
  const result = await guardedFetch(parsed.data.url, { method: 'GET', timeoutMs: 8000, maxRedirects: 3 })
  if (result.error) {
    const status = result.error === 'blocked_target' ? 400 : 502
    throw new ApiError(status as 400 | 502, result.error === 'blocked_target' ? 'nav_blocked_target' : 'internal', `Icon fetch failed: ${result.error}`)
  }
  if (!result.response.ok) throw new ApiError(502, 'internal', `Icon fetch failed: HTTP ${result.response.status}`)
  const bytes = await readGuardedBytes(result.response, NAV_LIMITS.capturedIconBytes)
  if (!bytes || !bytes.byteLength) throw new ApiError(413, 'payload_too_large', 'Icon is too large or empty')
  const icon = await insertIcon(c, bytes, 'captured', parsed.data.url)
  return c.json({ icon })
})

navIconRoutes.get('/icons/:id', async (c) => {
  const id = c.req.param('id')
  if (!isNavId(id)) throw ApiError.notFound('Icon not found')
  const row = await c.env.DB.prepare('SELECT * FROM nav_icons WHERE user_id = ?1 AND id = ?2').bind(userId(c), id).first<IconRow>()
  if (!row) throw ApiError.notFound('Icon not found')
  const kind = selectNavStorage(c.env)
  if (!kind) throw new ApiError(503, 'storage_unavailable', 'Icon storage is not configured')
  const object = await getNavObject(c.env, kind, row.object_key)
  if (!object) throw ApiError.notFound('Icon not found')
  if (object.etag && c.req.header('if-none-match') === object.etag) return new Response(null, { status: 304 })
  const headers = new Headers({
    'Content-Type': row.content_type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
  if (object.size !== null) headers.set('Content-Length', String(object.size))
  if (object.etag) headers.set('ETag', object.etag)
  return new Response(object.body as BodyInit, { headers })
})

navIconRoutes.delete('/icons/:id', async (c) => {
  const id = c.req.param('id')
  if (!isNavId(id)) throw ApiError.notFound('Icon not found')
  const user = userId(c)
  const row = await c.env.DB.prepare('SELECT * FROM nav_icons WHERE user_id = ?1 AND id = ?2').bind(user, id).first<IconRow>()
  if (!row) throw ApiError.notFound('Icon not found')
  const url = iconUrl(id)
  const used = await c.env.DB.prepare(`SELECT 1 FROM nav_links WHERE user_id = ?1 AND icon = ?2
    UNION ALL SELECT 1 FROM nav_categories WHERE user_id = ?1 AND icon = ?2 LIMIT 1`).bind(user, url).first()
  if (used) throw ApiError.conflict('Icon is still in use')
  await c.env.DB.prepare('DELETE FROM nav_favicons WHERE user_id = ?1 AND icon = ?2').bind(user, url).run()
  await c.env.DB.prepare('DELETE FROM nav_icons WHERE user_id = ?1 AND id = ?2').bind(user, id).run()
  const kind = selectNavStorage(c.env)
  if (kind) await deleteNavObject(c.env, kind, row.object_key).catch(() => {})
  return c.json({ ok: true })
})

navIconRoutes.get('/favicon', async (c) => {
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase()
  if (!/^[a-z0-9.-]{1,253}$/.test(domain)) throw ApiError.badRequest('Invalid domain')
  const row = await c.env.DB.prepare('SELECT icon FROM nav_favicons WHERE user_id = ?1 AND domain = ?2').bind(userId(c), domain).first<{ icon: string }>()
  if (!row) return c.json({ icon: null })
  const match = /^\/api\/nav\/icons\/([0-9a-hjkmnp-tv-z]{26})$/.exec(row.icon)
  if (match) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM nav_icons WHERE user_id = ?1 AND id = ?2').bind(userId(c), match[1]).first()
    if (!exists) {
      await c.env.DB.prepare('DELETE FROM nav_favicons WHERE user_id = ?1 AND domain = ?2').bind(userId(c), domain).run()
      return c.json({ icon: null })
    }
  }
  return c.json({ icon: row.icon })
})

navIconRoutes.post('/favicon', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = NavFaviconSchema.safeParse(raw)
  if (!parsed.success) throw ApiError.badRequest('Invalid favicon cache entry')
  if (!isSafeIconValue(parsed.data.icon)) throw ApiError.badRequest('Unsupported icon')
  await c.env.DB.prepare(`INSERT INTO nav_favicons (user_id, domain, icon, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(user_id, domain) DO UPDATE SET icon = excluded.icon, updated_at = excluded.updated_at`)
    .bind(userId(c), parsed.data.domain.toLowerCase(), parsed.data.icon, Date.now())
    .run()
  return c.json({ ok: true })
})

export async function pruneOrphanIcons(env: AppBindings['Bindings']): Promise<number> {
  const kind: NavStorageKind | null = selectNavStorage(env)
  if (!kind) return 0
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const { results } = await env.DB.prepare(`SELECT i.user_id, i.id, i.object_key FROM nav_icons i
    WHERE i.created_at < ?1
      AND NOT EXISTS (SELECT 1 FROM nav_links l WHERE l.user_id = i.user_id AND l.icon = '/api/nav/icons/' || i.id)
      AND NOT EXISTS (SELECT 1 FROM nav_categories c WHERE c.user_id = i.user_id AND c.icon = '/api/nav/icons/' || i.id)
    LIMIT 100`).bind(cutoff).all<{ user_id: string; id: string; object_key: string }>()
  for (const row of results) {
    await deleteNavObject(env, kind, row.object_key).catch(() => {})
    await env.DB.prepare("DELETE FROM nav_favicons WHERE icon = ?1").bind(`/api/nav/icons/${row.id}`).run().catch(() => {})
    await env.DB.prepare('DELETE FROM nav_icons WHERE user_id = ?1 AND id = ?2').bind(row.user_id, row.id).run().catch(() => {})
  }
  return results.length
}
