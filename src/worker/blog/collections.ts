import type { BlogCollectionItem, BlogCollectionKind, BlogAlbumPhoto } from '@shared/blog/model'
import { slugifyBlogTitle } from '@shared/blog/frontmatter'
import { hashPassword } from '../lib/password'
import { newId } from '../lib/id'

import { BLOG_COLLECTION_DEFS, collectionKind } from '@shared/blog/collections'
import type { CollectionDef, FieldDef } from '@shared/blog/collections'

export { BLOG_COLLECTION_DEFS, collectionKind }

function parseJson(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return fallback
  }
}

function cleanValue(field: FieldDef, raw: unknown): string | number | null {
  if (field.type === 'boolean') return raw === true || raw === 1 || raw === 'true' ? 1 : 0
  if (field.type === 'number') {
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    return Number.isFinite(value) ? value : null
  }
  if (field.type === 'json') {
    const value = raw === undefined ? [] : raw
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length > (field.max ?? 20_000)) throw new Error('collection_value_too_large')
    return text
  }
  if (raw === undefined || raw === null) return ''
  return String(raw).slice(0, field.max ?? 5_000)
}

function itemTitle(kind: BlogCollectionKind, row: Record<string, unknown>, def: CollectionDef): string {
  if (kind === 'moments') {
    const content = typeof row.content === 'string' ? row.content : ''
    return content.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? 'Moment'
  }
  const value = row[def.titleField]
  return typeof value === 'string' ? value : ''
}

function itemStatus(kind: BlogCollectionKind, row: Record<string, unknown>): string {
  if (kind === 'moments') return row.draft === 1 ? 'draft' : 'published'
  if (kind === 'albums') return row.published_at ? 'published' : 'draft'
  if (kind === 'friends') return row.enabled === 1 ? 'published' : 'draft'
  return 'active'
}

function rowToItem(kind: BlogCollectionKind, row: Record<string, unknown>, photoCount = 0): BlogCollectionItem {
  const def = BLOG_COLLECTION_DEFS[kind]
  const data: Record<string, unknown> = {}
  for (const field of def.fields) {
    data[field.key] = field.type === 'json' ? parseJson(row[field.key], []) : row[field.key]
  }
  data.hasPassword = typeof row.password_hash === 'string' && row.password_hash.length > 0
  if (kind === 'albums') data.photoCount = photoCount
  const slug = def.slugField && typeof row[def.slugField] === 'string' ? String(row[def.slugField]) : ''
  const publishedAt = typeof row.published_at === 'number' ? row.published_at : null
  return {
    id: String(row.id),
    kind,
    title: itemTitle(kind, row, def),
    slug,
    status: itemStatus(kind, row),
    publishedAt,
    updatedAt: typeof row.created_at === 'number' ? row.created_at : 0,
    data,
  }
}

export async function listCollectionItems(
  db: D1Database,
  userId: string,
  rawKind: unknown,
): Promise<BlogCollectionItem[]> {
  const kind = collectionKind(rawKind)
  const def = BLOG_COLLECTION_DEFS[kind]
  const { results } = await db
    .prepare(`SELECT * FROM ${def.table} WHERE user_id = ?1 ORDER BY ${def.orderBy}`)
    .bind(userId)
    .all<Record<string, unknown>>()
  if (kind !== 'albums') return results.map((row) => rowToItem(kind, row))
  const { results: counts } = await db
    .prepare(`SELECT album_id, COUNT(*) AS total FROM blog_photos WHERE user_id = ?1 GROUP BY album_id`)
    .bind(userId)
    .all<{ album_id: string; total: number }>()
  const byAlbum = new Map(counts.map((row) => [row.album_id, row.total]))
  return results.map((row) => rowToItem(kind, row, byAlbum.get(String(row.id)) ?? 0))
}

async function uniqueSlug(db: D1Database, userId: string, requested: string, exceptId: string | null): Promise<string> {
  const base = slugifyBlogTitle(requested.trim()) || `album-${Date.now()}`
  for (let index = 1; index <= 100; index++) {
    const slug = index === 1 ? base : `${base}-${index}`
    const row = await db
      .prepare(`SELECT id FROM blog_albums WHERE user_id = ?1 AND slug = ?2`)
      .bind(userId, slug)
      .first<{ id: string }>()
    if (!row || row.id === exceptId) return slug
  }
  return `${base}-${Date.now()}`
}

export async function saveCollectionItem(
  db: D1Database,
  userId: string,
  rawKind: unknown,
  id: string | null,
  input: Record<string, unknown>,
  now = Date.now(),
): Promise<BlogCollectionItem> {
  const kind = collectionKind(rawKind)
  const def = BLOG_COLLECTION_DEFS[kind]
  const existing = id
    ? await db.prepare(`SELECT * FROM ${def.table} WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<Record<string, unknown>>()
    : null
  if (id && !existing) throw new Error('collection_item_missing')
  if (kind === 'projects' && !input.key && !existing) {
    input = { ...input, key: `project-${Date.now().toString(36)}` }
  }
  if (kind === 'compass' && !input.key && !existing) {
    input = { ...input, key: `shelf-${Date.now().toString(36)}` }
  }
  const values = new Map<string, string | number | null>()
  for (const field of def.fields) {
    if (field.key === 'password') continue
    if (!(field.key in input)) continue
    values.set(field.key, cleanValue(field, input[field.key]))
  }
  for (const field of def.fields) {
    if (!field.required) continue
    const value = values.get(field.key)
    const current = existing?.[field.key]
    if ((value === undefined || value === '' || value === null) && (current === undefined || current === '' || current === null)) {
      throw new Error('collection_field_required')
    }
  }
  if (kind === 'albums') {
    if (typeof input.slug === 'string') {
      values.set('slug', await uniqueSlug(db, userId, input.slug || String(values.get('title') ?? ''), id))
    } else if (!existing) {
      values.set('slug', await uniqueSlug(db, userId, String(values.get('title') ?? ''), null))
    }
    if (typeof input.password === 'string' && input.password.trim()) {
      values.set('password_hash', await hashPassword(input.password.trim()))
    }
    if (input.clearPassword === true) values.set('password_hash', null)
    if (values.get('columns') == null) values.set('columns', 3)
    if (!values.get('layout')) values.set('layout', 'grid')
    if (!existing && !values.has('published_at')) values.set('published_at', null)
  }
  if (kind === 'moments') {
    if (!existing) {
      if (!values.has('published_at')) values.set('published_at', now)
      if (!values.has('draft')) values.set('draft', 0)
    }
    if (input.draft === true && !values.has('published_at')) values.set('published_at', typeof existing?.published_at === 'number' ? existing.published_at : now)
  }
  if (kind === 'friends') {
    if (!existing && !values.has('enabled')) values.set('enabled', 1)
  }
  if (def.fields.some((field) => field.key === 'position') && values.get('position') == null) values.set('position', 0)
  if (kind === 'moments' || kind === 'albums') {
    if (!existing) values.set('created_at', now)
    values.set('updated_at', now)
  }
  if (id) {
    if (values.size > 0) {
      const assignments = [...values.keys()].map((key, index) => `${key} = ?${index + 3}`)
      await db
        .prepare(`UPDATE ${def.table} SET ${assignments.join(', ')} WHERE user_id = ?1 AND id = ?2`)
        .bind(userId, id, ...values.values())
        .run()
    }
  } else {
    const itemId = newId()
    const keys = ['id', 'user_id', ...values.keys()]
    const placeholders = keys.map((_, index) => `?${index + 1}`)
    await db
      .prepare(`INSERT INTO ${def.table} (${keys.join(', ')}) VALUES (${placeholders.join(', ')})`)
      .bind(itemId, userId, ...values.values())
      .run()
    id = itemId
  }
  const row = await db.prepare(`SELECT * FROM ${def.table} WHERE user_id = ?1 AND id = ?2`).bind(userId, id).first<Record<string, unknown>>()
  if (!row) throw new Error('collection_item_missing')
  return rowToItem(kind, row)
}

export async function deleteCollectionItem(db: D1Database, userId: string, rawKind: unknown, id: string): Promise<void> {
  const kind = collectionKind(rawKind)
  const def = BLOG_COLLECTION_DEFS[kind]
  if (kind === 'albums') await db.prepare(`DELETE FROM blog_photos WHERE user_id = ?1 AND album_id = ?2`).bind(userId, id).run()
  if (kind === 'compass') await db.prepare(`DELETE FROM blog_compass_entries WHERE user_id = ?1 AND shelf_id = ?2`).bind(userId, id).run()
  await db.prepare(`DELETE FROM ${def.table} WHERE user_id = ?1 AND id = ?2`).bind(userId, id).run()
}

export async function listAlbumPhotos(db: D1Database, userId: string, albumId: string): Promise<BlogAlbumPhoto[]> {
  const album = await db.prepare(`SELECT id FROM blog_albums WHERE user_id = ?1 AND id = ?2`).bind(userId, albumId).first<{ id: string }>()
  if (!album) throw new Error('collection_item_missing')
  const { results } = await db.prepare(
    `SELECT p.id, p.album_id, p.asset_id, p.caption, p.alt, p.taken_at, p.position
     FROM blog_photos p WHERE p.user_id = ?1 AND p.album_id = ?2 ORDER BY p.position, p.id`,
  ).bind(userId, albumId).all<{ id: string; album_id: string; asset_id: string; caption: string; alt: string; taken_at: string; position: number }>()
  return results.map((row) => ({
    id: row.id,
    albumId: row.album_id,
    assetId: row.asset_id,
    url: `/api/blog/assets/${row.asset_id}`,
    caption: row.caption,
    alt: row.alt,
    takenAt: row.taken_at,
    position: row.position,
  }))
}

export async function saveAlbumPhoto(
  db: D1Database,
  userId: string,
  albumId: string,
  id: string | null,
  input: Record<string, unknown>,
): Promise<BlogAlbumPhoto> {
  const album = await db.prepare(`SELECT id FROM blog_albums WHERE user_id = ?1 AND id = ?2`).bind(userId, albumId).first<{ id: string }>()
  if (!album) throw new Error('collection_item_missing')
  const assetId = typeof input.assetId === 'string' ? input.assetId : ''
  const caption = typeof input.caption === 'string' ? input.caption.slice(0, 2_000) : ''
  const alt = typeof input.alt === 'string' ? input.alt.slice(0, 500) : ''
  const takenAt = typeof input.takenAt === 'string' ? input.takenAt.slice(0, 40) : ''
  if (id) {
    await db.prepare(
      `UPDATE blog_photos SET caption = ?4, alt = ?5, taken_at = ?6 WHERE user_id = ?1 AND album_id = ?2 AND id = ?3`,
    ).bind(userId, albumId, id, caption, alt, takenAt).run()
  } else {
    if (!assetId) throw new Error('collection_field_required')
    const asset = await db.prepare(`SELECT id FROM blog_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, assetId).first<{ id: string }>()
    if (!asset) throw new Error('media_missing')
    const max = await db.prepare(`SELECT COALESCE(MAX(position), -1) AS position FROM blog_photos WHERE user_id = ?1 AND album_id = ?2`)
      .bind(userId, albumId).first<{ position: number }>()
    id = newId()
    await db.prepare(
      `INSERT INTO blog_photos (id, user_id, album_id, asset_id, caption, alt, taken_at, position)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, userId, albumId, assetId, caption, alt, takenAt, (max?.position ?? -1) + 1).run()
  }
  const photos = await listAlbumPhotos(db, userId, albumId)
  const saved = photos.find((photo) => photo.id === id)
  if (!saved) throw new Error('media_missing')
  return saved
}

export async function deleteAlbumPhoto(db: D1Database, userId: string, albumId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_photos WHERE user_id = ?1 AND album_id = ?2 AND id = ?3`).bind(userId, albumId, id).run()
}

export async function listCompassEntries(db: D1Database, userId: string, shelfId: string): Promise<Record<string, unknown>[]> {
  const { results } = await db.prepare(
    `SELECT * FROM blog_compass_entries WHERE user_id = ?1 AND shelf_id = ?2 ORDER BY position, label`,
  ).bind(userId, shelfId).all<Record<string, unknown>>()
  return results
}

export async function saveCompassEntry(
  db: D1Database,
  userId: string,
  shelfId: string,
  id: string | null,
  input: Record<string, unknown>,
): Promise<void> {
  const shelf = await db.prepare(`SELECT id FROM blog_compass_shelves WHERE user_id = ?1 AND id = ?2`).bind(userId, shelfId).first<{ id: string }>()
  if (!shelf) throw new Error('collection_item_missing')
  const label = typeof input.label === 'string' ? input.label.slice(0, 200) : ''
  const href = typeof input.href === 'string' ? input.href.slice(0, 500) : ''
  if (!label || !href) throw new Error('collection_field_required')
  const note = typeof input.note === 'string' ? input.note.slice(0, 2_000) : ''
  const icon = typeof input.icon === 'string' ? input.icon.slice(0, 200) : ''
  const image = typeof input.image === 'string' ? input.image.slice(0, 500) : ''
  if (id) {
    await db.prepare(
      `UPDATE blog_compass_entries SET label=?4, href=?5, note=?6, icon=?7, image=?8 WHERE user_id=?1 AND shelf_id=?2 AND id=?3`,
    ).bind(userId, shelfId, id, label, href, note, icon, image).run()
  } else {
    const max = await db.prepare(`SELECT COALESCE(MAX(position), -1) AS position FROM blog_compass_entries WHERE user_id = ?1 AND shelf_id = ?2`)
      .bind(userId, shelfId).first<{ position: number }>()
    await db.prepare(
      `INSERT INTO blog_compass_entries (id,user_id,shelf_id,label,href,note,icon,image,position)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(newId(), userId, shelfId, label, href, note, icon, image, (max?.position ?? -1) + 1).run()
  }
}

export async function deleteCompassEntry(db: D1Database, userId: string, shelfId: string, id: string): Promise<void> {
  await db.prepare(`DELETE FROM blog_compass_entries WHERE user_id = ?1 AND shelf_id = ?2 AND id = ?3`).bind(userId, shelfId, id).run()
}

export async function listPublicCollection(
  db: D1Database,
  userId: string,
  rawKind: unknown,
): Promise<BlogCollectionItem[]> {
  const kind = collectionKind(rawKind)
  const items = await listCollectionItems(db, userId, kind)
  const visible = kind === 'moments'
    ? items.filter((item) => item.status === 'published')
    : kind === 'albums'
      ? items.filter((item) => item.status === 'published' && item.data.hasPassword === false)
      : kind === 'friends'
        ? items.filter((item) => item.status === 'published')
        : items
  return visible.map((item) => {
    const data = { ...item.data }
    delete data.password_hint
    delete data.password
    delete data.hasPassword
    return { ...item, data }
  })
}
