import { countText, deriveExcerpt, readingMinutes } from '@shared/markdown-utils'
import { blogMetaFromNote, readBlogFrontMatter, slugifyBlogTitle } from '@shared/blog/frontmatter'
import { mergeBlogSettings, type BlogSettingKey, type BlogSettings } from '@shared/blog/settings'
import type {
  BlogPostRow,
  BlogPostSummary,
  BlogRenderSnapshot,
  BlogSitePublic,
} from '@shared/blog/model'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { hashPassword } from '../lib/password'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'

const POST_COLUMNS = `p.id, p.user_id, p.note_id, p.slug, p.title, p.excerpt, p.description,
  p.cover_asset_id, p.category_id, p.series_id, p.series_order, p.status, p.pinned,
  p.comments_enabled, p.language, p.license, p.encrypted, p.password_hash, p.password_hint,
  p.hide_home_content, p.alias, p.permalink, p.word_count, p.reading_minutes, p.view_count,
  p.content_hash, p.render_key, p.render_hash, p.renderer_version, p.render_status,
  p.render_generated_at, p.published_at, p.created_at, p.updated_at, p.deleted_at,
  c.name AS category_name, s.title AS series_title`

export interface BlogPostWithNames extends BlogPostRow {
  category_name: string | null
  series_title: string | null
}

export interface BlogPostWithNote extends BlogPostWithNames {
  content: string | null
  note_deleted_at: number | null
}

export async function blogOwnerUserId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1`)
    .first<{ id: string }>()
  return row?.id ?? null
}

export async function loadBlogSettings(db: D1Database, userId: string): Promise<BlogSettings> {
  const { results } = await db
    .prepare(`SELECT key, value FROM blog_settings WHERE user_id = ?1`)
    .bind(userId)
    .all<{ key: string; value: string }>()
  return mergeBlogSettings(results)
}

export async function saveBlogSetting(
  db: D1Database,
  userId: string,
  key: BlogSettingKey,
  value: unknown,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blog_settings (user_id, key, value, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(userId, key, JSON.stringify(value), now)
    .run()
}

export async function blogCounts(db: D1Database, userId: string): Promise<BlogSitePublic['counts']> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1
            AND status IN ('published','scheduled') AND deleted_at IS NULL
            AND published_at IS NOT NULL AND published_at <= (strftime('%s','now') * 1000)) AS posts,
         (SELECT COUNT(*) FROM blog_categories WHERE user_id = ?1) AS categories,
         (SELECT COUNT(*) FROM blog_tags WHERE user_id = ?1) AS tags,
         (SELECT COUNT(*) FROM blog_series WHERE user_id = ?1) AS series,
         (SELECT COALESCE(SUM(view_count), 0) FROM blog_posts WHERE user_id = ?1) AS views`,
    )
    .bind(userId)
    .first<{ posts: number; categories: number; tags: number; series: number; views: number }>()
  return {
    posts: row?.posts ?? 0,
    categories: row?.categories ?? 0,
    tags: row?.tags ?? 0,
    series: row?.series ?? 0,
    views: row?.views ?? 0,
  }
}

export async function incrementPostView(db: D1Database, userId: string, postId: string): Promise<void> {
  await db
    .prepare('UPDATE blog_posts SET view_count = view_count + 1 WHERE id = ?1 AND user_id = ?2')
    .bind(postId, userId)
    .run()
}

function slugifyValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

async function resolveCategory(
  db: D1Database,
  userId: string,
  name: string,
  now: number,
): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  const slug = slugifyValue(trimmed) || 'category'
  const existing = await db
    .prepare(`SELECT id FROM blog_categories WHERE user_id = ?1 AND slug = ?2`)
    .bind(userId, slug)
    .first<{ id: string }>()
  if (existing) return existing.id
  const id = newId()
  await db
    .prepare(
      `INSERT INTO blog_categories (id, user_id, name, slug, description, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '', 0, ?5, ?5)`,
    )
    .bind(id, userId, trimmed, slug, now)
    .run()
  return id
}

async function resolveSeries(
  db: D1Database,
  userId: string,
  title: string,
  now: number,
): Promise<string | null> {
  const trimmed = title.trim()
  if (!trimmed) return null
  const slug = slugifyValue(trimmed) || 'series'
  const existing = await db
    .prepare(`SELECT id FROM blog_series WHERE user_id = ?1 AND slug = ?2`)
    .bind(userId, slug)
    .first<{ id: string }>()
  if (existing) return existing.id
  const id = newId()
  await db
    .prepare(
      `INSERT INTO blog_series (id, user_id, slug, title, description, overview, status, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '', '', 'ongoing', 0, ?5, ?5)`,
    )
    .bind(id, userId, slug, trimmed, now)
    .run()
  return id
}

function renderSnapshotKey(noteId: string, contentHash: string): string {
  return `blog/txt/renders/${noteId}/${contentHash}.json`
}

export async function readRenderSnapshot(
  bucket: R2Bucket | undefined,
  row: Pick<BlogPostRow, 'render_key'>,
): Promise<BlogRenderSnapshot | null> {
  if (!bucket || !row.render_key) return null
  const object = await bucket.get(row.render_key)
  if (!object) return null
  try {
    return JSON.parse(await object.text()) as BlogRenderSnapshot
  } catch {
    return null
  }
}

export async function writeRenderSnapshot(
  bucket: R2Bucket,
  noteId: string,
  snapshot: BlogRenderSnapshot,
): Promise<string> {
  const key = renderSnapshotKey(noteId, snapshot.contentHash)
  await bucket.put(key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
  })
  return key
}

export interface PublicPostQuery {
  page?: number
  limit?: number
  category?: string
  tag?: string
  series?: string
  q?: string
  year?: number
  pinned?: boolean
  excludeEncrypted?: boolean
}

export async function listPublishedPostsFiltered(
  db: D1Database,
  userId: string,
  query: PublicPostQuery = {},
): Promise<{ rows: BlogPostWithNames[]; total: number }> {
  const safeLimit = Math.min(Math.max(query.limit ?? 10, 1), 100)
  const offset = (Math.max(query.page ?? 1, 1) - 1) * safeLimit
  const where = [
    'p.user_id = ?',
    "p.status IN ('published','scheduled')",
    'p.deleted_at IS NULL',
    'p.published_at IS NOT NULL',
    'p.published_at <= ?',
  ]
  const binds: unknown[] = [userId, Date.now()]
  if (query.category) {
    where.push('c.slug = ?')
    binds.push(query.category)
  }
  if (query.series) {
    where.push('s.slug = ?')
    binds.push(query.series)
  }
  if (query.tag) {
    where.push('EXISTS (SELECT 1 FROM blog_post_tags pt JOIN blog_tags bt ON bt.id = pt.tag_id AND bt.user_id = pt.user_id WHERE pt.user_id = p.user_id AND pt.post_id = p.id AND bt.slug = ?)')
    binds.push(query.tag)
  }
  const needle = query.q?.trim().slice(0, 200)
  if (needle) {
    where.push('(p.title LIKE ? OR p.excerpt LIKE ? OR p.description LIKE ?)')
    binds.push(`%${needle}%`, `%${needle}%`, `%${needle}%`)
  }
  if (query.year) {
    where.push("strftime('%Y', p.published_at / 1000, 'unixepoch') = ?")
    binds.push(String(query.year))
  }
  if (query.pinned) where.push('p.pinned = 1')
  if (query.excludeEncrypted) where.push('p.encrypted = 0')
  const joins = `LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
    LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id`
  const whereSql = where.join(' AND ')
  const [rows, count] = await Promise.all([
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM blog_posts p
         ${joins}
         WHERE ${whereSql}
         ORDER BY p.pinned DESC, COALESCE(p.published_at, p.created_at) DESC, p.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, safeLimit, offset)
      .all<BlogPostWithNames>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM blog_posts p ${joins} WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
  ])
  return { rows: rows.results, total: count?.total ?? 0 }
}

export async function listPublishedPosts(
  db: D1Database,
  userId: string,
  page = 1,
  limit = 10,
): Promise<{ rows: BlogPostWithNames[]; total: number }> {
  return listPublishedPostsFiltered(db, userId, { page, limit })
}

export async function blogArchive(
  db: D1Database,
  userId: string,
): Promise<{ year: string; count: number; months: { month: string; count: number }[] }[]> {
  const { results } = await db
    .prepare(
      `SELECT strftime('%Y', p.published_at / 1000, 'unixepoch') AS year,
              strftime('%m', p.published_at / 1000, 'unixepoch') AS month,
              COUNT(*) AS total
       FROM blog_posts p
       WHERE p.user_id = ? AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL
         AND p.published_at IS NOT NULL AND p.published_at <= ?
       GROUP BY year, month
       ORDER BY year DESC, month DESC`,
    )
    .bind(userId, Date.now())
    .all<{ year: string; month: string; total: number }>()
  const years = new Map<string, { year: string; count: number; months: { month: string; count: number }[] }>()
  for (const row of results) {
    const entry = years.get(row.year) ?? { year: row.year, count: 0, months: [] }
    entry.count += row.total
    entry.months.push({ month: row.month, count: row.total })
    years.set(row.year, entry)
  }
  return [...years.values()]
}

export async function findAdjacentPosts(
  db: D1Database,
  userId: string,
  current: Pick<BlogPostRow, 'id' | 'published_at'>,
): Promise<{ previous: BlogPostWithNames | null; next: BlogPostWithNames | null }> {
  const now = Date.now()
  const base = `SELECT ${POST_COLUMNS} FROM blog_posts p
    LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
    LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
    WHERE p.user_id = ? AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL
      AND p.published_at IS NOT NULL AND p.published_at <= ?`
  const [previous, next] = await Promise.all([
    db.prepare(`${base} AND (p.published_at < ? OR (p.published_at = ? AND p.id < ?))
      ORDER BY p.published_at DESC, p.id DESC LIMIT 1`)
      .bind(userId, now, current.published_at, current.published_at, current.id)
      .first<BlogPostWithNames>(),
    db.prepare(`${base} AND (p.published_at > ? OR (p.published_at = ? AND p.id > ?))
      ORDER BY p.published_at ASC, p.id ASC LIMIT 1`)
      .bind(userId, now, current.published_at, current.published_at, current.id)
      .first<BlogPostWithNames>(),
  ])
  return { previous: previous ?? null, next: next ?? null }
}

export async function searchPublishedPosts(
  db: D1Database,
  userId: string,
  rawQuery: string,
  page = 1,
  limit = 10,
): Promise<{ rows: BlogPostWithNames[]; total: number; engine: 'fts' | 'like' }> {
  const safeLimit = Math.min(Math.max(limit, 1), 50)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (tokens.length === 0) return { rows: [], total: 0, engine: 'fts' }
  const match = tokens.map((token) => `"${token.replace(/"/g, ' ')}"`).join(' AND ')
  const joins = `LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
    LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id`
  const where = `notes_fts.user_id = ? AND notes_fts MATCH ?
    AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL
    AND p.encrypted = 0
    AND p.published_at IS NOT NULL AND p.published_at <= ?`
  try {
    const [rows, count] = await Promise.all([
      db.prepare(`SELECT ${POST_COLUMNS} FROM notes_fts
        JOIN blog_posts p ON p.note_id = notes_fts.note_id AND p.user_id = notes_fts.user_id
        ${joins}
        WHERE ${where}
        ORDER BY rank LIMIT ? OFFSET ?`)
        .bind(userId, match, Date.now(), safeLimit, offset)
        .all<BlogPostWithNames>(),
      db.prepare(`SELECT COUNT(*) AS total FROM notes_fts
        JOIN blog_posts p ON p.note_id = notes_fts.note_id AND p.user_id = notes_fts.user_id
        WHERE ${where}`)
        .bind(userId, match, Date.now())
        .first<{ total: number }>(),
    ])
    return { rows: rows.results, total: count?.total ?? 0, engine: 'fts' }
  } catch (error) {
    console.warn('[inkstone] blog search fell back to LIKE:', error)
    const fallback = await listPublishedPostsFiltered(db, userId, { q: rawQuery, page, limit: safeLimit, excludeEncrypted: true })
    return { ...fallback, engine: 'like' }
  }
}

export async function findPublishedPost(
  db: D1Database,
  userId: string,
  slug: string,
): Promise<BlogPostWithNote | null> {
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, n.content, n.deleted_at AS note_deleted_at
       FROM blog_posts p
       LEFT JOIN notes n ON n.id = p.note_id AND n.user_id = p.user_id
       LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
       LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE p.user_id = ?1 AND p.slug = ?2 AND p.status IN ('published','scheduled')
         AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= ?3`,
    )
    .bind(userId, slug, Date.now())
    .first<BlogPostWithNote>()
  return row ?? null
}

export async function findPublishedPostByPermalink(
  db: D1Database,
  userId: string,
  permalink: string,
): Promise<{ slug: string } | null> {
  const row = await db
    .prepare(
      `SELECT p.slug FROM blog_posts p
       WHERE p.user_id = ?1 AND p.permalink = ?2 AND p.status IN ('published','scheduled')
         AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= ?3
       LIMIT 1`,
    )
    .bind(userId, permalink, Date.now())
    .first<{ slug: string }>()
  return row ?? null
}

export async function listPostTags(db: D1Database, userId: string, postIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (postIds.length === 0) return result
  const placeholders = postIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT pt.post_id, t.name FROM blog_post_tags pt
       JOIN blog_tags t ON t.id = pt.tag_id AND t.user_id = pt.user_id
       WHERE pt.user_id = ?1 AND pt.post_id IN (${placeholders})
       ORDER BY pt.position, t.name`,
    )
    .bind(userId, ...postIds)
    .all<{ post_id: string; name: string }>()
  for (const row of results) {
    const list = result.get(row.post_id) ?? []
    list.push(row.name)
    result.set(row.post_id, list)
  }
  return result
}

export interface BlogNoteInput {
  id: string
  title: string
  content: string
  deleted_at: number | null
}

async function uniqueBlogSlug(
  db: D1Database,
  userId: string,
  requested: string,
  currentPostId: string | null,
): Promise<string> {
  const base = slugifyValue(requested) || slugifyBlogTitle(requested)
  for (let index = 1; index <= 100; index++) {
    const candidate = index === 1 ? base : `${base}-${index}`
    const row = await db
      .prepare(`SELECT id FROM blog_posts WHERE user_id = ?1 AND slug = ?2`)
      .bind(userId, candidate)
      .first<{ id: string }>()
    if (!row || row.id === currentPostId) return candidate
  }
  return `${base}-${Date.now()}`
}

async function syncPostTags(
  db: D1Database,
  userId: string,
  postId: string,
  noteId: string,
  now: number,
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT t.name, t.color FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?2
       WHERE nt.note_id = ?1
       ORDER BY t.name`,
    )
    .bind(noteId, userId)
    .all<{ name: string; color: string | null }>()
  const names = results.length > 0
    ? results
    : []
  await db.prepare(`DELETE FROM blog_post_tags WHERE user_id = ?1 AND post_id = ?2`).bind(userId, postId).run()
  let position = 0
  for (const tag of names) {
    const slug = slugifyValue(tag.name) || tag.name.toLowerCase()
    const id = newId()
    await db
      .prepare(
        `INSERT INTO blog_tags (id, user_id, name, slug, color, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, slug) DO UPDATE SET
           name = excluded.name,
           color = COALESCE(excluded.color, blog_tags.color)`,
      )
      .bind(id, userId, tag.name, slug, tag.color, position, now)
      .run()
    const saved = await db
      .prepare(`SELECT id FROM blog_tags WHERE user_id = ?1 AND slug = ?2`)
      .bind(userId, slug)
      .first<{ id: string }>()
    if (!saved) continue
    await db
      .prepare(
        `INSERT OR IGNORE INTO blog_post_tags (user_id, post_id, tag_id, position)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(userId, postId, saved.id, position)
      .run()
    position += 1
  }
}

export async function syncBlogPostFromNote(
  db: D1Database,
  userId: string,
  note: BlogNoteInput,
  now = Date.now(),
): Promise<BlogPostRow | null> {
  const existing = await db
    .prepare(`SELECT * FROM blog_posts WHERE user_id = ?1 AND note_id = ?2`)
    .bind(userId, note.id)
    .first<BlogPostRow>()
  if (existing && existing.deleted_at !== null && note.deleted_at === null) return existing
  if (note.deleted_at !== null) {
    if (!existing) return null
    await db
      .prepare(`UPDATE blog_posts SET status = 'withdrawn', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, existing.id, now)
      .run()
    return { ...existing, status: 'withdrawn', updated_at: now }
  }

  const meta = blogMetaFromNote(note.title, note.content)
  const scheduledAt = parseBlogDate(meta.publishedAt)
  if (!meta.isPublished && !existing && !meta.type) return null

  const contentHash = await sha256Hex(note.content)
  const { words } = countText(note.content)
  const minutes = readingMinutes(words)
  const categoryId = existing?.category_id ?? await resolveCategory(db, userId, meta.category, now)
  const seriesId = existing?.series_id ?? await resolveSeries(db, userId, meta.series, now)
  const postId = existing?.id ?? newId()
  const slug = existing?.slug ?? await uniqueBlogSlug(db, userId, meta.slug || slugifyBlogTitle(note.title), postId)
  const renderMatches = Boolean(existing?.render_key && existing.content_hash === contentHash)
  let status: BlogPostRow['status']
  if (!meta.isPublished) {
    status = 'draft'
  } else if (scheduledAt !== null && scheduledAt > now) {
    status = 'scheduled'
  } else {
    status = existing?.status === 'published' || renderMatches ? 'published' : 'pending_snapshot'
  }
  const renderStatus = existing?.render_key
    ? renderMatches
      ? existing.render_status
      : 'stale'
    : 'missing'
  const derivedExcerpt = meta.excerpt || deriveExcerpt(note.content)
  const excerpt = existing?.excerpt || derivedExcerpt
  const publishedAt = meta.isPublished
    ? (scheduledAt ?? existing?.published_at ?? now)
    : (existing?.published_at ?? null)

  const postBinds: unknown[] = [
    postId, userId, note.id, slug, note.title, excerpt, meta.description || excerpt,
    existing?.cover_asset_id ?? (meta.cover || null), categoryId, seriesId,
    existing?.series_order ?? meta.seriesOrder, status,
    existing?.pinned ?? (meta.pinned ? 1 : 0),
    existing?.comments_enabled ?? (meta.comments ? 1 : 0),
    existing?.language || meta.language, existing?.license || meta.license || '{}',
    existing?.encrypted ?? (meta.protected ? 1 : 0), existing?.password_hint || meta.passwordHint,
    existing?.hide_home_content ?? (meta.hideHomeContent ? 1 : 0),
    existing?.alias || meta.alias, existing?.permalink || meta.permalink,
    words, minutes, contentHash, renderStatus, publishedAt, now,
  ]
  const insertPost = () => db
    .prepare(`INSERT INTO blog_posts (
         id, user_id, note_id, slug, title, excerpt, description, cover_asset_id, category_id,
         series_id, series_order, status, pinned, comments_enabled, language, license, encrypted,
         password_hint, hide_home_content, alias, permalink, word_count, reading_minutes,
         content_hash, render_status, published_at, created_at, updated_at, deleted_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
         ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?27, NULL
       )
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         title = excluded.title,
         excerpt = CASE WHEN blog_posts.excerpt = '' THEN excluded.excerpt ELSE blog_posts.excerpt END,
         description = CASE WHEN blog_posts.description = '' THEN excluded.description ELSE blog_posts.description END,
         word_count = excluded.word_count,
         reading_minutes = excluded.reading_minutes,
         content_hash = excluded.content_hash,
         render_status = excluded.render_status,
         status = excluded.status,
         published_at = COALESCE(blog_posts.published_at, excluded.published_at),
         updated_at = excluded.updated_at`)
    .bind(...postBinds)
    .run()
  try {
    await insertPost()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('UNIQUE constraint failed: blog_posts.user_id, blog_posts.slug')) throw error
    postBinds[3] = `${slug}-${Date.now().toString(36).slice(-4)}`
    await insertPost()
  }
  await syncPostTags(db, userId, postId, note.id, now)
  return db
    .prepare(`SELECT * FROM blog_posts WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, postId)
    .first<BlogPostRow>()
}

function parseBlogDate(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function toBlogSummary(
  row: BlogPostWithNames,
  tags: string[],
): BlogPostSummary {
  const protectedPost = row.encrypted === 1
  return {
    id: row.id,
    slug: row.slug,
    permalink: row.permalink,
    title: row.title,
    // A locked article's excerpt and description come from the note body; a listing, feed or search
    // result must not hand a reader the first lines the unlock page is protecting.
    excerpt: protectedPost ? '' : row.excerpt,
    description: protectedPost ? '' : row.description,
    coverUrl: row.cover_asset_id ? `/api/blog/assets/${row.cover_asset_id}` : null,
    category: row.category_name,
    series: row.series_title,
    seriesOrder: row.series_order,
    tags,
    pinned: row.pinned === 1,
    language: row.language,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    wordCount: row.word_count,
    readingMinutes: row.reading_minutes,
    encrypted: row.encrypted === 1,
    hideHomeContent: row.hide_home_content === 1,
  }
}

export async function findPostByNoteId(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<BlogPostWithNote | null> {
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, n.content, n.deleted_at AS note_deleted_at
       FROM blog_posts p
       LEFT JOIN notes n ON n.id = p.note_id AND n.user_id = p.user_id
       LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
       LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE p.user_id = ?1 AND p.note_id = ?2`,
    )
    .bind(userId, noteId)
    .first<BlogPostWithNote>()
  return row ?? null
}

export async function findPostById(
  db: D1Database,
  userId: string,
  postId: string,
): Promise<BlogPostWithNote | null> {
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, n.content, n.deleted_at AS note_deleted_at
       FROM blog_posts p
       LEFT JOIN notes n ON n.id = p.note_id AND n.user_id = p.user_id
       LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
       LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE p.user_id = ?1 AND p.id = ?2`,
    )
    .bind(userId, postId)
    .first<BlogPostWithNote>()
  return row ?? null
}

export async function publishPostSnapshot(
  db: D1Database,
  bucket: R2Bucket | undefined,
  userId: string,
  noteId: string,
  snapshot: BlogRenderSnapshot,
  now = Date.now(),
): Promise<BlogPostRow> {
  if (!bucket) throw new Error('blog_r2_unavailable')
  const post = await findPostByNoteId(db, userId, noteId)
  if (!post || post.deleted_at !== null) throw new Error('blog_post_missing')
  if (post.note_deleted_at !== null) throw new Error('blog_note_deleted')
  if (post.content === null) throw new Error('blog_note_missing')
  if (snapshot.noteId !== noteId) throw new Error('blog_snapshot_note_mismatch')
  const meta = readBlogFrontMatter(post.content)
  if (!meta.isPublished) throw new Error('blog_not_published')
  const noteHash = await sha256Hex(post.content)
  if (noteHash !== snapshot.contentHash) throw new Error('blog_content_changed')
  const renderKey = await writeRenderSnapshot(bucket, noteId, snapshot)
  const renderHash = await sha256Hex(snapshot.html)
  const scheduledAt = meta.publishedAt ? Date.parse(meta.publishedAt) : NaN
  const publishedAt = post.published_at ?? (Number.isFinite(scheduledAt) ? scheduledAt : now)
  const status = publishedAt > now ? 'scheduled' : 'published'
  await db
    .prepare(
      `UPDATE blog_posts SET
         render_key = ?3, render_hash = ?4, renderer_version = ?5, render_status = 'ready',
         render_generated_at = ?6, content_hash = ?7, status = ?8,
         published_at = ?9, updated_at = ?6
       WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, post.id, renderKey, renderHash, snapshot.rendererVersion, now, snapshot.contentHash, status, publishedAt)
    .run()
  await linkPostAssets(db, userId, post.id, snapshot.assets, now)
  const updated = await findPostById(db, userId, post.id)
  if (!updated) throw new Error('blog_post_missing')
  return updated
}

/**
 * Replaces the media library's view of what one published article uses.
 *
 * The ids arrive from the owner's snapshot, but the table is still the trust boundary: every id is
 * checked against the owner's assets so a snapshot cannot make a post claim (and thereby pin) someone
 * else's file. An id that no longer exists is dropped; the body already carries a placeholder.
 */
async function linkPostAssets(
  db: D1Database,
  userId: string,
  postId: string,
  assets: BlogRenderSnapshot['assets'],
  now: number,
): Promise<void> {
  await db.prepare(`DELETE FROM blog_post_assets WHERE user_id = ?1 AND post_id = ?2`).bind(userId, postId).run()
  const seen = new Set<string>()
  for (const asset of assets) {
    const assetId = asset.blogAssetId
    if (!assetId || seen.has(assetId)) continue
    seen.add(assetId)
    const owned = await db
      .prepare(`SELECT id FROM blog_assets WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, assetId)
      .first<{ id: string }>()
    if (!owned) continue
    await db
      .prepare(
        `INSERT OR REPLACE INTO blog_post_assets (user_id, post_id, asset_id, source_ref, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(userId, postId, assetId, asset.attachmentId ?? '', now)
      .run()
  }
}

export async function unpublishPost(
  db: D1Database,
  userId: string,
  postId: string,
  now = Date.now(),
): Promise<BlogPostRow | null> {
  await db
    .prepare(`UPDATE blog_posts SET status = 'withdrawn', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, postId, now)
    .run()
  return findPostById(db, userId, postId)
}

async function markDueScheduledPublished(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE blog_posts SET status = 'published', updated_at = ?3
       WHERE user_id = ?1 AND status = 'scheduled' AND render_status = 'ready'
         AND deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= ?2`,
    )
    .bind(userId, now, now)
    .run()
}

export interface AdminPostQuery {
  status?: string
  q?: string
  categoryId?: string
  tagId?: string
  seriesId?: string
  page?: number
  limit?: number
  sort?: string
}

export async function listAdminPosts(
  db: D1Database,
  userId: string,
  options: AdminPostQuery = {},
): Promise<{ rows: BlogPostWithNames[]; total: number }> {
  await markDueScheduledPublished(db, userId, Date.now())
  const safeLimit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const page = Math.max(options.page ?? 1, 1)
  const offset = (page - 1) * safeLimit
  const where = ['p.user_id = ?1']
  const binds: unknown[] = [userId]
  const bind = (value: unknown) => {
    binds.push(value)
    return `?${binds.length}`
  }
  const status = options.status ?? 'all'
  if (status === 'trash') {
    where.push('p.deleted_at IS NOT NULL')
  } else {
    where.push('p.deleted_at IS NULL')
    if (status === 'published') {
      where.push("p.status = 'published'")
      where.push('(p.published_at IS NULL OR p.published_at <= ?)')
      binds.push(Date.now())
    } else if (status === 'scheduled') {
      where.push("(p.status = 'scheduled' OR (p.status = 'published' AND p.published_at > ?))")
      binds.push(Date.now())
    } else if (status === 'draft') {
      where.push("p.status IN ('draft','pending_snapshot','withdrawn')")
    } else if (status === 'pending') {
      where.push("p.status = 'pending_snapshot'")
    }
  }
  const q = options.q?.trim().slice(0, 200)
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`
    const placeholder = bind(like)
    where.push(`(p.title LIKE ${placeholder} OR p.slug LIKE ${placeholder})`)
  }
  if (options.categoryId) where.push(`p.category_id = ${bind(options.categoryId)}`)
  if (options.seriesId) where.push(`p.series_id = ${bind(options.seriesId)}`)
  if (options.tagId) {
    where.push(`EXISTS (SELECT 1 FROM blog_post_tags pt WHERE pt.user_id = p.user_id AND pt.post_id = p.id AND pt.tag_id = ${bind(options.tagId)})`)
  }
  const order = options.sort === 'title'
    ? 'p.title COLLATE NOCASE ASC, p.id DESC'
    : options.sort === 'published'
      ? 'COALESCE(p.published_at, p.created_at) DESC, p.id DESC'
      : options.sort === 'created'
        ? 'p.created_at DESC, p.id DESC'
        : 'p.updated_at DESC, p.id DESC'
  const whereSql = where.join(' AND ')
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM blog_posts p
         LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
         LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
         WHERE ${whereSql}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, safeLimit, offset)
      .all<BlogPostWithNames>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM blog_posts p WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
  ])
  return { rows: rows.results, total: total?.total ?? 0 }
}

export async function blogAdminOverview(
  db: D1Database,
  userId: string,
): Promise<{
  posts: number
  published: number
  drafts: number
  pending: number
  scheduled: number
  trash: number
  stale: number
  views: number
  moments: number
  albums: number
  tasks: number
  commentsPending: number
  commentsApproved: number
  commentsSpam: number
}> {
  const now = Date.now()
  await markDueScheduledPublished(db, userId, now)
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL
            AND (published_at IS NULL OR published_at <= ?2)) AS published,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status IN ('draft','withdrawn') AND deleted_at IS NULL) AS drafts,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'pending_snapshot' AND deleted_at IS NULL) AS pending,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NOT NULL) AS trash,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL
            AND (status = 'scheduled' OR (status = 'published' AND published_at > ?2))) AS scheduled,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL
            AND (render_status = 'stale' OR renderer_version <> ?3)) AS stale,
         (SELECT COALESCE(SUM(view_count), 0) FROM blog_posts WHERE user_id = ?1) AS views,
         (SELECT COUNT(*) FROM blog_moments WHERE user_id = ?1 AND deleted_at IS NULL) AS moments,
         (SELECT COUNT(*) FROM blog_albums WHERE user_id = ?1) AS albums,
         (SELECT COUNT(*) FROM blog_tasks WHERE user_id = ?1 AND status IN ('pending','running')) AS tasks,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'pending' AND deleted_at IS NULL) AS commentsPending,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'approved' AND deleted_at IS NULL) AS commentsApproved,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'spam' AND deleted_at IS NULL) AS commentsSpam`,
    )
    .bind(userId, now, BLOG_RENDERER_VERSION)
    .first<{
      posts: number
      published: number
      drafts: number
      pending: number
      scheduled: number
      trash: number
      stale: number
      views: number
      moments: number
      albums: number
      tasks: number
      commentsPending: number
      commentsApproved: number
      commentsSpam: number
    }>()
  return row ?? {
    posts: 0, published: 0, drafts: 0, pending: 0, scheduled: 0, trash: 0, stale: 0, views: 0,
    moments: 0, albums: 0, tasks: 0, commentsPending: 0, commentsApproved: 0, commentsSpam: 0,
  }
}

export async function listCalendarPosts(
  db: D1Database,
  userId: string,
  from: number,
  to: number,
): Promise<BlogPostWithNames[]> {
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM blog_posts p
       LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
       LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE p.user_id = ?1 AND p.deleted_at IS NULL
         AND ((p.published_at IS NOT NULL AND p.published_at BETWEEN ?2 AND ?3)
           OR (p.published_at IS NULL AND p.updated_at BETWEEN ?2 AND ?3))
       ORDER BY COALESCE(p.published_at, p.updated_at) ASC, p.id ASC
       LIMIT 500`,
    )
    .bind(userId, from, to)
    .all<BlogPostWithNames>()
  return results
}

export async function blogDashboard(
  db: D1Database,
  userId: string,
): Promise<{
  overview: Awaited<ReturnType<typeof blogAdminOverview>>
  recentPosts: { id: string; noteId: string; title: string; status: string; updatedAt: number }[]
  recentComments: { id: string; postTitle: string | null; authorName: string; content: string; status: string; createdAt: number }[]
  viewsByDay: { day: string; views: number; visitors: number }[]
  storageBytes: number
  scheduled: number
  draftCount: number
}> {
  const [overview, recentPosts, recentComments, views, storage] = await Promise.all([
    blogAdminOverview(db, userId),
    db.prepare(
      `SELECT id, note_id, title, status, updated_at FROM blog_posts
       WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8`,
    ).bind(userId).all<{ id: string; note_id: string; title: string; status: string; updated_at: number }>(),
    db.prepare(
      `SELECT c.id, p.title AS post_title, c.author_name, c.content, c.status, c.created_at
       FROM blog_comments c LEFT JOIN blog_posts p ON p.id = c.post_id AND p.user_id = c.user_id
       WHERE c.user_id = ?1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 6`,
    ).bind(userId).all<{ id: string; post_title: string | null; author_name: string; content: string; status: string; created_at: number }>(),
    db.prepare(
      `SELECT day, views, visitors FROM blog_visit_daily WHERE user_id = ?1 ORDER BY day DESC LIMIT 30`,
    ).bind(userId).all<{ day: string; views: number; visitors: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM blog_assets WHERE user_id = ?1`,
    ).bind(userId).first<{ bytes: number }>(),
  ])
  return {
    overview,
    recentPosts: recentPosts.results.map((row) => ({
      id: row.id, noteId: row.note_id, title: row.title, status: row.status, updatedAt: row.updated_at,
    })),
    recentComments: recentComments.results.map((row) => ({
      id: row.id, postTitle: row.post_title, authorName: row.author_name,
      content: row.content, status: row.status, createdAt: row.created_at,
    })),
    viewsByDay: views.results.reverse(),
    storageBytes: storage?.bytes ?? 0,
    scheduled: overview.scheduled,
    draftCount: overview.drafts,
  }
}

export async function blogHealth(
  db: D1Database,
  bucket: R2Bucket | undefined,
  userId: string,
): Promise<import('@shared/blog/model').BlogHealth> {
  const now = Date.now()
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL) AS published,
       (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL
          AND (status = 'scheduled' OR (status = 'published' AND published_at > ?2))) AS scheduled,
       (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL
          AND (render_status = 'stale' OR renderer_version <> ?3)) AS stale,
       (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND render_status = 'missing' AND deleted_at IS NULL
          AND status IN ('published','scheduled','pending_snapshot')) AS missing,
       (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND render_status = 'failed' AND deleted_at IS NULL
          AND status IN ('published','scheduled','pending_snapshot')) AS failed,
       (SELECT COALESCE(SUM(size), 0) FROM blog_assets WHERE user_id = ?1) AS storage_bytes,
       (SELECT MAX(published_at) FROM blog_posts WHERE user_id = ?1 AND status = 'published') AS last_published`,
  ).bind(userId, now, BLOG_RENDERER_VERSION).first<{
    published: number; scheduled: number; stale: number; missing: number; failed: number;
    storage_bytes: number; last_published: number | null;
  }>()
  let storage = false
  if (bucket) {
    try {
      await bucket.head('blog/.healthcheck')
      storage = true
    } catch {
      storage = false
    }
  }
  return {
    database: true,
    storage,
    published: row?.published ?? 0,
    scheduled: row?.scheduled ?? 0,
    stale: row?.stale ?? 0,
    missing: row?.missing ?? 0,
    failed: row?.failed ?? 0,
    storageBytes: row?.storage_bytes ?? 0,
    lastPublishedAt: row?.last_published ?? null,
    checkedAt: now,
  }
}

export async function recordBlogAudit(
  db: D1Database,
  userId: string,
  action: string,
  entity: string,
  entityId: string,
  detail: unknown = {},
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blog_audit (id, user_id, action, entity, entity_id, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(newId(), userId, action, entity, entityId, JSON.stringify(detail), now)
    .run()
}

export interface AdminPostMetaPatch {
  slug?: string
  excerpt?: string
  description?: string
  coverAssetId?: string | null
  categoryId?: string | null
  seriesId?: string | null
  seriesOrder?: number | null
  pinned?: boolean
  commentsEnabled?: boolean
  language?: string
  license?: string
  alias?: string
  permalink?: string
  hideHomeContent?: boolean
  password?: string
  passwordHint?: string
  clearPassword?: boolean
  publishedAt?: number | null
}

export async function updateAdminPostMeta(
  db: D1Database,
  userId: string,
  postId: string,
  patch: AdminPostMetaPatch,
  now = Date.now(),
): Promise<BlogPostWithNote> {
  const existing = await findPostById(db, userId, postId)
  if (!existing) throw new Error('blog_post_missing')
  const sets: string[] = []
  const binds: unknown[] = []
  const set = (column: string, value: unknown) => {
    binds.push(value)
    sets.push(`${column} = ?${binds.length + 2}`)
  }
  if (patch.slug !== undefined) {
    const base = slugifyBlogTitle(patch.slug || existing.title)
    const taken = await db.prepare(`SELECT id FROM blog_posts WHERE user_id = ?1 AND slug = ?2 AND id <> ?3`)
      .bind(userId, base, postId).first<{ id: string }>()
    set('slug', taken ? await uniqueBlogSlug(db, userId, base, postId) : base)
  }
  if (patch.excerpt !== undefined) set('excerpt', patch.excerpt.slice(0, 2_000))
  if (patch.description !== undefined) set('description', patch.description.slice(0, 2_000))
  if (patch.coverAssetId !== undefined) {
    if (patch.coverAssetId) {
      const asset = await db.prepare(`SELECT id FROM blog_assets WHERE user_id = ?1 AND id = ?2`).bind(userId, patch.coverAssetId).first<{ id: string }>()
      if (!asset) throw new Error('media_missing')
    }
    set('cover_asset_id', patch.coverAssetId || null)
  }
  if (patch.categoryId !== undefined) {
    if (patch.categoryId) {
      const row = await db.prepare(`SELECT id FROM blog_categories WHERE user_id = ?1 AND id = ?2`).bind(userId, patch.categoryId).first<{ id: string }>()
      if (!row) throw new Error('taxonomy_item_missing')
    }
    set('category_id', patch.categoryId || null)
  }
  if (patch.seriesId !== undefined) {
    if (patch.seriesId) {
      const row = await db.prepare(`SELECT id FROM blog_series WHERE user_id = ?1 AND id = ?2`).bind(userId, patch.seriesId).first<{ id: string }>()
      if (!row) throw new Error('taxonomy_item_missing')
    }
    set('series_id', patch.seriesId || null)
  }
  if (patch.seriesOrder !== undefined) set('series_order', patch.seriesOrder ?? null)
  if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0)
  if (patch.commentsEnabled !== undefined) set('comments_enabled', patch.commentsEnabled ? 1 : 0)
  if (patch.language !== undefined) set('language', patch.language.slice(0, 20))
  if (patch.license !== undefined) set('license', patch.license.slice(0, 500))
  if (patch.alias !== undefined) set('alias', patch.alias.slice(0, 200))
  if (patch.permalink !== undefined) set('permalink', patch.permalink.slice(0, 300))
  if (patch.hideHomeContent !== undefined) set('hide_home_content', patch.hideHomeContent ? 1 : 0)
  if (patch.clearPassword === true) {
    sets.push('encrypted = 0')
    set('password_hash', null)
  }
  if (patch.password !== undefined && patch.password.trim()) {
    set('encrypted', 1)
    set('password_hash', await hashPassword(patch.password.trim()))
  }
  if (patch.passwordHint !== undefined) set('password_hint', patch.passwordHint.slice(0, 200))
  if (patch.publishedAt !== undefined) {
    set('published_at', patch.publishedAt)
    if (patch.publishedAt !== null && patch.publishedAt > now) {
      set('status', 'scheduled')
    } else if (existing.render_status === 'ready') {
      set('status', 'published')
    }
  }
  if (sets.length > 0) {
    await db.prepare(
      `UPDATE blog_posts SET ${sets.join(', ')}, updated_at = ?2 WHERE user_id = ?1 AND id = ?${binds.length + 3}`,
    ).bind(userId, now, ...binds, postId).run()
  }
  const updated = await findPostById(db, userId, postId)
  if (!updated) throw new Error('blog_post_missing')
  return updated
}

export async function bulkAdminPosts(
  db: D1Database,
  userId: string,
  noteIds: string[],
  action: 'unpublish' | 'trash' | 'restore' | 'pin' | 'unpin' | 'delete',
  now = Date.now(),
): Promise<number> {
  const ids = [...new Set(noteIds)].slice(0, 100)
  if (ids.length === 0) return 0
  const placeholders = ids.map((_, index) => `?${index + 3}`).join(', ')
  if (action === 'delete') {
    const deletePlaceholders = ids.map((_, index) => `?${index + 2}`).join(', ')
    const result = await db.prepare(
      `DELETE FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NOT NULL AND note_id IN (${deletePlaceholders})`,
    ).bind(userId, ...ids).run()
    return result.meta.changes ?? 0
  }
  const sets = action === 'unpublish'
    ? "status = 'withdrawn', updated_at = ?2"
    : action === 'trash'
      ? 'deleted_at = ?2, status = \'withdrawn\', updated_at = ?2'
      : action === 'restore'
        ? 'deleted_at = NULL, status = \'draft\', updated_at = ?2'
        : action === 'pin'
          ? 'pinned = 1, updated_at = ?2'
          : 'pinned = 0, updated_at = ?2'
  const result = await db.prepare(
    `UPDATE blog_posts SET ${sets} WHERE user_id = ?1 AND note_id IN (${placeholders})`,
  ).bind(userId, now, ...ids).run()
  return result.meta.changes ?? 0
}

export async function listBlogAudit(
  db: D1Database,
  userId: string,
  limit = 50,
): Promise<import('@shared/blog/model').BlogAuditEntry[]> {
  const { results } = await db.prepare(
    `SELECT id, action, entity, entity_id, detail, created_at FROM blog_audit
     WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2`,
  ).bind(userId, Math.min(Math.max(limit, 1), 200)).all<{
    id: string; action: string; entity: string; entity_id: string; detail: string; created_at: number
  }>()
  return results.map((row) => {
    let detail: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.detail) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>
    } catch {
      detail = {}
    }
    return {
      id: row.id, action: row.action, entity: row.entity, entityId: row.entity_id,
      detail, createdAt: row.created_at,
    }
  })
}

export async function listPostsNeedingRender(
  db: D1Database,
  userId: string,
): Promise<{ noteId: string; title: string; renderStatus: string }[]> {
  const { results } = await db.prepare(
    `SELECT note_id, title, render_status FROM blog_posts
     WHERE user_id = ?1 AND deleted_at IS NULL
       AND (render_status IN ('stale','missing','failed') OR renderer_version <> ?2)
       AND status IN ('published','scheduled','pending_snapshot')
     ORDER BY updated_at DESC LIMIT 100`,
  ).bind(userId, BLOG_RENDERER_VERSION).all<{ note_id: string; title: string; render_status: string }>()
  return results.map((row) => ({ noteId: row.note_id, title: row.title, renderStatus: row.render_status }))
}
