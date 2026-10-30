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
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM blog_categories WHERE user_id = ?1) AS categories,
         (SELECT COUNT(*) FROM blog_tags WHERE user_id = ?1) AS tags,
         (SELECT COUNT(*) FROM blog_series WHERE user_id = ?1) AS series`,
    )
    .bind(userId)
    .first<{ posts: number; categories: number; tags: number; series: number }>()
  return {
    posts: row?.posts ?? 0,
    categories: row?.categories ?? 0,
    tags: row?.tags ?? 0,
    series: row?.series ?? 0,
  }
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

export async function listPublishedPosts(
  db: D1Database,
  userId: string,
  page = 1,
  limit = 10,
): Promise<{ rows: BlogPostWithNames[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 50)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const [rows, count] = await Promise.all([
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM blog_posts p
         LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
         LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
         WHERE p.user_id = ?1 AND p.status = 'published' AND p.deleted_at IS NULL
         ORDER BY p.pinned DESC, COALESCE(p.published_at, p.created_at) DESC, p.id DESC
         LIMIT ?2 OFFSET ?3`,
      )
      .bind(userId, safeLimit, offset)
      .all<BlogPostWithNames>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM blog_posts
         WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL`,
      )
      .bind(userId)
      .first<{ total: number }>(),
  ])
  return { rows: rows.results, total: count?.total ?? 0 }
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
       WHERE p.user_id = ?1 AND p.slug = ?2 AND p.status = 'published' AND p.deleted_at IS NULL`,
    )
    .bind(userId, slug)
    .first<BlogPostWithNote>()
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
  if (note.deleted_at !== null) {
    if (!existing) return null
    await db
      .prepare(`UPDATE blog_posts SET status = 'withdrawn', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, existing.id, now)
      .run()
    return { ...existing, status: 'withdrawn', updated_at: now }
  }

  const meta = blogMetaFromNote(note.title, note.content)
  if (!meta.isPublished) {
    if (!existing) return null
    await db
      .prepare(`UPDATE blog_posts SET status = 'withdrawn', updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, existing.id, now)
      .run()
    return { ...existing, status: 'withdrawn', updated_at: now }
  }

  const contentHash = await sha256Hex(note.content)
  const { words } = countText(note.content)
  const minutes = readingMinutes(words)
  const categoryId = await resolveCategory(db, userId, meta.category, now)
  const seriesId = await resolveSeries(db, userId, meta.series, now)
  const postId = existing?.id ?? newId()
  const slug = existing?.slug ?? await uniqueBlogSlug(db, userId, meta.slug || slugifyBlogTitle(note.title), postId)
  const wasPublished = existing?.status === 'published'
  const renderMatches = Boolean(existing?.render_key && existing.content_hash === contentHash)
  const status = wasPublished || renderMatches ? 'published' : 'pending_snapshot'
  const renderStatus = existing?.render_key
    ? renderMatches
      ? existing.render_status
      : 'stale'
    : 'missing'
  const excerpt = meta.excerpt || deriveExcerpt(note.content)
  const publishedAt = existing?.published_at ?? now

  await db
    .prepare(
      `INSERT INTO blog_posts (
         id, user_id, note_id, slug, title, excerpt, description, cover_asset_id, category_id,
         series_id, series_order, status, pinned, comments_enabled, language, license, encrypted,
         password_hint, hide_home_content, alias, permalink, word_count, reading_minutes,
         content_hash, render_status, published_at, created_at, updated_at, deleted_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
         ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?26, NULL
       )
       ON CONFLICT(user_id, note_id) DO UPDATE SET
         slug = excluded.slug,
         title = excluded.title,
         excerpt = excluded.excerpt,
         description = excluded.description,
         category_id = excluded.category_id,
         series_id = excluded.series_id,
         series_order = excluded.series_order,
         status = excluded.status,
         pinned = excluded.pinned,
         comments_enabled = excluded.comments_enabled,
         language = excluded.language,
         license = excluded.license,
         encrypted = excluded.encrypted,
         password_hint = excluded.password_hint,
         hide_home_content = excluded.hide_home_content,
         alias = excluded.alias,
         permalink = excluded.permalink,
         word_count = excluded.word_count,
         reading_minutes = excluded.reading_minutes,
         content_hash = excluded.content_hash,
         render_status = excluded.render_status,
         published_at = COALESCE(blog_posts.published_at, excluded.published_at),
         updated_at = excluded.updated_at`,
    )
    .bind(
      postId, userId, note.id, slug, note.title, excerpt, existing?.cover_asset_id ?? null,
      categoryId, seriesId, meta.seriesOrder, status, meta.pinned ? 1 : 0, meta.comments ? 1 : 0,
      meta.language, meta.license || '{}', meta.protected ? 1 : 0, meta.passwordHint,
      meta.hideHomeContent ? 1 : 0, meta.alias, meta.permalink, words, minutes, contentHash,
      renderStatus, publishedAt, now,
    )
    .run()
  await syncPostTags(db, userId, postId, note.id, now)
  return db
    .prepare(`SELECT * FROM blog_posts WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, postId)
    .first<BlogPostRow>()
}

export function toBlogSummary(
  row: BlogPostWithNames,
  tags: string[],
): BlogPostSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    description: row.description,
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
  await db
    .prepare(
      `UPDATE blog_posts SET
         render_key = ?3, render_hash = ?4, renderer_version = ?5, render_status = 'ready',
         render_generated_at = ?6, content_hash = ?7, status = 'published',
         published_at = COALESCE(published_at, ?6), updated_at = ?6
       WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, post.id, renderKey, renderHash, snapshot.rendererVersion, now, snapshot.contentHash)
    .run()
  const updated = await findPostById(db, userId, post.id)
  if (!updated) throw new Error('blog_post_missing')
  return updated
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

export async function listAdminPosts(
  db: D1Database,
  userId: string,
  page = 1,
  limit = 20,
): Promise<{ rows: BlogPostWithNames[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM blog_posts p
         LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
         LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
         WHERE p.user_id = ?1 AND p.deleted_at IS NULL
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT ?2 OFFSET ?3`,
      )
      .bind(userId, safeLimit, offset)
      .all<BlogPostWithNames>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL`)
      .bind(userId)
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
  stale: number
  views: number
  moments: number
  albums: number
  tasks: number
  commentsPending: number
  commentsApproved: number
  commentsSpam: number
}> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'published' AND deleted_at IS NULL) AS published,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status IN ('draft','withdrawn') AND deleted_at IS NULL) AS drafts,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND status = 'pending_snapshot' AND deleted_at IS NULL) AS pending,
         (SELECT COUNT(*) FROM blog_posts WHERE user_id = ?1 AND render_status = 'stale' AND status = 'published' AND deleted_at IS NULL) AS stale,
         (SELECT COALESCE(SUM(view_count), 0) FROM blog_posts WHERE user_id = ?1) AS views,
         (SELECT COUNT(*) FROM blog_moments WHERE user_id = ?1 AND deleted_at IS NULL) AS moments,
         (SELECT COUNT(*) FROM blog_albums WHERE user_id = ?1) AS albums,
         (SELECT COUNT(*) FROM blog_tasks WHERE user_id = ?1 AND status IN ('pending','running')) AS tasks,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'pending' AND deleted_at IS NULL) AS commentsPending,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'approved' AND deleted_at IS NULL) AS commentsApproved,
         (SELECT COUNT(*) FROM blog_comments WHERE user_id = ?1 AND status = 'spam' AND deleted_at IS NULL) AS commentsSpam`,
    )
    .bind(userId)
    .first<{
      posts: number
      published: number
      drafts: number
      pending: number
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
    posts: 0, published: 0, drafts: 0, pending: 0, stale: 0, views: 0, moments: 0, albums: 0, tasks: 0,
    commentsPending: 0, commentsApproved: 0, commentsSpam: 0,
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
