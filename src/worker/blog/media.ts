import type { BlogMediaItem } from '@shared/blog/model'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024

function extensionFor(mime: string, filename: string): string {
  const fromName = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
    'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'video/mp4': 'mp4', 'video/webm': 'webm',
  }
  return map[mime] ?? 'bin'
}

function mediaKind(mime: string): 'image' | 'audio' | 'video' | 'file' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

function imageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/gif') return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  if (mime === 'image/webp') return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  if (mime === 'image/avif') return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  return false
}

function allowedMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')
    || ['application/pdf', 'text/plain', 'application/zip'].includes(mime)
}

function itemUrl(id: string): string {
  return `/api/blog/assets/${id}`
}

function toItem(row: {
  id: string
  kind: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  created_at: number
  variants: string
}): BlogMediaItem {
  let variants: BlogMediaItem['variants'] = []
  try {
    const parsed = JSON.parse(row.variants)
    if (Array.isArray(parsed)) variants = parsed
  } catch {
    // older rows have no variants; an empty list is the honest answer
  }
  return {
    id: row.id, kind: row.kind, url: itemUrl(row.id), filename: row.filename, mime: row.mime,
    size: row.size, width: row.width, height: row.height, createdAt: row.created_at, variants,
  }
}

export async function listMedia(
  db: D1Database,
  userId: string,
  page = 1,
  limit = 30,
  kind = '',
  q = '',
): Promise<{ items: BlogMediaItem[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const where = ['user_id = ?1']
  const binds: (string | number)[] = [userId]
  if (kind) { binds.push(kind); where.push(`kind = ?${binds.length}`) }
  if (q) { binds.push(`%${q.replace(/[%_]/g, '\\$&')}%`); where.push(`filename LIKE ?${binds.length} ESCAPE '\\'`)}
  const text = where.join(' AND ')
  const [rows, total] = await Promise.all([
    db.prepare(
      `SELECT id, kind, filename, mime, size, width, height, created_at, variants
       FROM blog_assets WHERE ${text} ORDER BY created_at DESC, id DESC
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    ).bind(...binds, safeLimit, offset).all<{
      id: string; kind: string; filename: string; mime: string; size: number;
      width: number | null; height: number | null; created_at: number; variants: string;
    }>(),
    db.prepare(`SELECT COUNT(*) AS total FROM blog_assets WHERE ${text}`).bind(...binds).first<{ total: number }>(),
  ])
  return { items: rows.results.map(toItem), total: total?.total ?? 0 }
}

export async function uploadMedia(
  env: { FILES?: R2Bucket },
  db: D1Database,
  userId: string,
  file: File,
  now = Date.now(),
): Promise<BlogMediaItem> {
  if (!env.FILES) throw new Error('media_storage_unavailable')
  if (file.size <= 0 || file.size > MEDIA_MAX_BYTES) throw new Error('media_too_large')
  const mime = file.type || 'application/octet-stream'
  if (!allowedMime(mime)) throw new Error('media_type_not_allowed')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (mime.startsWith('image/') && !imageSignature(bytes, mime)) throw new Error('media_type_not_allowed')
  const hash = await sha256Hex(bytes)
  const kind = mediaKind(mime)
  const existing = await db
    .prepare(`SELECT id, kind, filename, mime, size, width, height, created_at, variants FROM blog_assets WHERE user_id = ?1 AND hash = ?2 AND kind = ?3`)
    .bind(userId, hash, kind)
    .first<{ id: string; kind: string; filename: string; mime: string; size: number; width: number | null; height: number | null; created_at: number; variants: string }>()
  if (existing) return toItem(existing)
  const id = newId()
  const ext = extensionFor(mime, file.name)
  const folder = kind === 'image' ? 'images' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'files'
  const year = new Date(now).getUTCFullYear()
  const objectKey = `blog/${folder}/${year}/${id}.${ext}`
  await env.FILES.put(objectKey, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { userId, kind, hash },
  })
  const filename = file.name.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 160) || `upload.${ext}`
  await db.prepare(
    `INSERT INTO blog_assets (id,user_id,kind,object_key,variants,filename,mime,size,width,height,hash,created_at)
     VALUES (?1,?2,?3,?4,'[]',?5,?6,?7,NULL,NULL,?8,?9)`,
  ).bind(id, userId, kind, objectKey, filename, mime, file.size, hash, now).run()
  return {
    id, kind, url: itemUrl(id), filename, mime, size: file.size, width: null, height: null,
    createdAt: now, variants: [],
  }
}

export async function deleteMedia(
  env: { FILES?: R2Bucket },
  db: D1Database,
  userId: string,
  id: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT object_key FROM blog_assets WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<{ object_key: string }>()
  if (!row) throw new Error('media_missing')
  const [postAssets, covers] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM blog_post_assets WHERE user_id = ?1 AND asset_id = ?2`).bind(userId, id).first<{ total: number }>(),
    db.prepare(`SELECT COUNT(*) AS total FROM blog_posts WHERE user_id = ?1 AND cover_asset_id = ?2`).bind(userId, id).first<{ total: number }>(),
  ])
  if ((postAssets?.total ?? 0) > 0 || (covers?.total ?? 0) > 0) throw new Error('media_in_use')
  if (env.FILES) await env.FILES.delete(row.object_key)
  await db.prepare(`DELETE FROM blog_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
}
