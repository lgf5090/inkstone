import type { Env } from '../../env'
import { newId } from '../../lib/id'
import { sha256Hex } from '../../lib/encoding'
import {
  ICON_ICONIFY_MAX_BYTES,
  ICON_ICONIFY_SOURCE,
  ICON_ICONIFY_TIMEOUT_MS,
} from '@shared/development/icons/limits'
import { ensureSettings, usageFor } from './store'
import { iconObjectKey, iconThumbKey, putIconObject, userShard } from './r2'
import { sanitizeSvgText } from './svg-sanitize'
import { webpThumbnail } from './raster'
import type { IconImport } from '@shared/development/icons/types'

interface IconifyCollection {
  prefix?: string
  info?: { name?: string; license?: { title?: string; spdx?: string }; author?: { name?: string; url?: string } }
  width?: number
  height?: number
  icons?: Record<string, { body: string; width?: number; height?: number }>
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'iconify'
}

/**
 * Brands and duotone collections paint several colours; monochrome sets paint one. The filter panel
 * offers this as a facet, so it is recorded once at import time rather than guessed per request.
 */
export function detectColorMode(body: string): 'mono' | 'multi' {
  const colors = new Set<string>()
  for (const match of body.matchAll(/(?:fill|stroke)=["']([^"']+)["']/gi)) {
    const value = match[1]!.trim().toLowerCase()
    if (!value || value === 'none' || value === 'currentcolor' || value === 'transparent') continue
    if (value.startsWith('url(')) return 'multi'
    colors.add(value)
    if (colors.size > 1) return 'multi'
  }
  return colors.size > 1 ? 'multi' : 'mono'
}

interface IconifyMeta {
  name?: string
  license?: { title?: string; spdx?: string; url?: string }
  author?: { name?: string; url?: string }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ICON_ICONIFY_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`The Iconify collection returned ${response.status}`)
  const text = await response.text()
  if (text.length > ICON_ICONIFY_MAX_BYTES) throw new Error('The Iconify collection is too large')
  return JSON.parse(text) as T
}

async function fetchCollection(prefix: string): Promise<IconifyCollection> {
  const [collection, info] = await Promise.all([
    fetchJson<IconifyCollection>(`${ICON_ICONIFY_SOURCE}/${prefix}/icons.json`),
    fetchJson<IconifyMeta>(`${ICON_ICONIFY_SOURCE}/${prefix}/info.json`).catch(() => ({} as IconifyMeta)),
  ])
  return {
    ...collection,
    info: {
      name: info.name ?? collection.info?.name,
      license: info.license ?? collection.info?.license,
      author: info.author ?? collection.info?.author,
    },
  }
}

export async function importIconifyCollection(env: Env, userId: string, prefix: string, limit: number): Promise<IconImport> {
  const collection = await fetchCollection(prefix)
  const icons = Object.entries(collection.icons ?? {}).slice(0, limit)
  if (!icons.length) throw new Error('The Iconify collection has no icons')
  const settings = await ensureSettings(env.DB, userId)
  const shard = await userShard(userId)
  const id = newId()
  const now = Date.now()
  const slugName = slug(prefix)
  const license = collection.info?.license?.spdx ?? collection.info?.license?.title ?? ''
  const homepage = collection.info?.author?.url ?? ''
  const name = collection.info?.name ?? prefix

  let collectionId = await env.DB.prepare(
    `SELECT id FROM development_icons_collections WHERE user_id=?1 AND slug=?2`,
  ).bind(userId, slugName).first<{ id: string }>().then((row) => row?.id ?? null)
  if (!collectionId) {
    collectionId = newId()
    await env.DB.prepare(
      `INSERT INTO development_icons_collections (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '', 'iconify', ?5, ?6, 0, ?7, ?7)`,
    ).bind(userId, collectionId, name, slugName, license, homepage, now).run()
  }

  await env.DB.prepare(
    `INSERT INTO development_icons_imports (user_id, id, kind, status, prefix, total_items, created_at, updated_at)
     VALUES (?1, ?2, 'iconify', 'running', ?3, ?4, ?5, ?5)`,
  ).bind(userId, id, prefix, icons.length, now).run()

  let processed = 0
  let failed = 0
  let skipped = 0
  let bytesTotal = 0
  let usage = await usageFor(env.DB, userId)

  for (const [iconName, icon] of icons) {
    const width = icon.width ?? collection.width ?? 24
    const height = icon.height ?? collection.height ?? 24
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${icon.body}</svg>`
    try {
      const sanitized = sanitizeSvgText(svg, settings.maxSvgBytes)
      const bytes = new TextEncoder().encode(sanitized)
      if (usage.usedBytes + bytes.byteLength > settings.quotaBytes) throw new Error('icons_quota_exceeded')
      const sha256 = await sha256Hex(bytes)
      const existing = await env.DB.prepare(
        `SELECT id FROM development_icons_assets WHERE user_id=?1 AND format='svg' AND sha256=?2`,
      ).bind(userId, sha256).first<{ id: string }>()
      if (existing) {
        skipped += 1
        await env.DB.prepare(
          `INSERT OR REPLACE INTO development_icons_import_items (user_id, import_id, item_key, filename, status, asset_id, error, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'skipped', ?5, '', ?6, ?6)`,
        ).bind(userId, id, iconName, `${prefix}/${iconName}.svg`, existing.id, Date.now()).run()
        processed += 1
        continue
      }
      const key = iconObjectKey('svg', shard, sha256)
      await putIconObject(env, key, bytes, 'image/svg+xml')
      let thumbKey: string | null = null
      try {
        const thumb = await webpThumbnail(env, bytes, 'image/svg+xml', 96)
        if (thumb) {
          thumbKey = iconThumbKey(shard, sha256, 96)
          await putIconObject(env, thumbKey, thumb, 'image/webp')
          const thumb2x = await webpThumbnail(env, bytes, 'image/svg+xml', 192)
          if (thumb2x) await putIconObject(env, iconThumbKey(shard, sha256, 192), thumb2x, 'image/webp')
        }
      } catch (error) {
        console.warn('[inkstone] icon import thumbnail failed:', error)
      }
      const assetId = newId()
      await env.DB.prepare(
        `INSERT INTO development_icons_assets
           (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256, r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'svg', 'image/svg+xml', ?6, ?7, ?8, ?9, ?10, ?11, ?12, '', ?13, ?14, ?15, 1, ?16, ?16)`,
      ).bind(
        userId, assetId, collectionId, iconName, iconName.toLowerCase(), bytes.byteLength,
        width, height, `0 0 ${width} ${height}`, sha256, key, thumbKey, detectColorMode(icon.body),
        license, `${prefix}/${iconName}`, now,
      ).run()
      await env.DB.prepare(
        `INSERT OR REPLACE INTO development_icons_import_items (user_id, import_id, item_key, filename, status, asset_id, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'done', ?5, '', ?6, ?6)`,
      ).bind(userId, id, iconName, `${prefix}/${iconName}.svg`, assetId, now).run()
      bytesTotal += bytes.byteLength
      usage = { ...usage, usedBytes: usage.usedBytes + bytes.byteLength }
      processed += 1
    } catch (error) {
      failed += 1
      processed += 1
      await env.DB.prepare(
        `INSERT OR REPLACE INTO development_icons_import_items (user_id, import_id, item_key, filename, status, asset_id, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'failed', NULL, ?5, ?6, ?6)`,
      ).bind(userId, id, iconName, `${prefix}/${iconName}.svg`, error instanceof Error ? error.message : 'Import failed', Date.now()).run()
    }
  }

  const finished = Date.now()
  const status = failed === icons.length ? 'failed' : 'done'
  await env.DB.prepare(
    `UPDATE development_icons_imports SET status=?3, processed_items=?4, failed_items=?5, skipped_items=?6,
       bytes_total=?7, error=?8, updated_at=?9, finished_at=?9 WHERE user_id=?1 AND id=?2`,
  ).bind(
    userId, id, status, processed, failed, skipped, bytesTotal,
    failed ? `${failed} icons could not be imported` : '', finished,
  ).run()

  return {
    id,
    kind: 'iconify',
    status,
    prefix,
    totalItems: icons.length,
    processedItems: processed,
    failedItems: failed,
    skippedItems: skipped,
    bytesTotal,
    error: failed ? `${failed} icons could not be imported` : '',
    createdAt: now,
    updatedAt: finished,
    finishedAt: finished,
  }
}
