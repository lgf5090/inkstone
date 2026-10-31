import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson, requestClientIp } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { sha256Hex } from '../lib/encoding'
import { publicBlogSite } from '@shared/blog/settings'
import { normalizeLinkUrl } from '@shared/nav/model'
import type { BlogPostDetail } from '@shared/blog/model'
import { verifyPassword } from '../lib/password'
import { requireBlogProxy } from './guard'
import {
  clearUnlockAttempts,
  guardUnlockAttempt,
  issueUnlockToken,
  unlockExpiry,
  unlockNotConfigured,
  unlockSecret,
  verifyUnlockToken,
} from './unlock'
import {
  createBlogComment,
  discussionSettings,
  listApprovedComments,
} from './comments'
import { applyFriend, listPublicFriends, resolveFriendIcon } from './friends'
import { uploadMedia } from './media'
import { renderSVG } from 'uqr'
import { getPublishedPage, listPublishedPages } from './pages'
import { sanitizeBlogHtml } from './sanitize'
import { listPublicCollection } from './collections'
import {
  blogArchive,
  blogCounts,
  blogOwnerUserId,
  findAdjacentPosts,
  findPublishedPost,
  findPublishedPostByPermalink,
  incrementPostView,
  listPostTags,
  listPublishedPostsFiltered,
  loadBlogSettings,
  searchPublishedPosts,
  readRenderSnapshot,
  toBlogSummary,
} from './store'

export const blogPublicRoutes = new Hono<AppBindings>()

blogPublicRoutes.use('*', requireBlogProxy)

async function ownerId(c: Context<AppBindings>): Promise<string> {
  const id = await blogOwnerUserId(c.env.DB)
  if (!id) throw ApiError.notFound('The blog owner has not been configured')
  return id
}

function publicSite(settings: Parameters<typeof publicBlogSite>[0], counts: Parameters<typeof publicBlogSite>[1]) {
  const site = publicBlogSite(settings, counts)
  site.widgets = site.widgets.map((widget) => widget.type === 'custom'
    ? { ...widget, config: { ...widget.config, html: sanitizeBlogHtml(String(widget.config.html ?? '')) } }
    : widget)
  site.footer = { ...site.footer, html: sanitizeBlogHtml(site.footer.html) }
  return site
}

function pageQuery(c: Context<AppBindings>): { page: number; limit: number } {
  const rawPage = Number(c.req.query('page') ?? '1')
  const rawLimit = Number(c.req.query('limit') ?? '10')
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1,
    limit: Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 10,
  }
}

blogPublicRoutes.get('/site', async (c) => {
  const userId = await ownerId(c)
  const [settings, counts] = await Promise.all([
    loadBlogSettings(c.env.DB, userId),
    blogCounts(c.env.DB, userId),
  ])
  return c.json(publicSite(settings, counts), 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts', async (c) => {
  const userId = await ownerId(c)
  const { page, limit } = pageQuery(c)
  const year = Number(c.req.query('year'))
  const { rows, total } = await listPublishedPostsFiltered(c.env.DB, userId, {
    page,
    limit,
    category: c.req.query('category')?.trim().slice(0, 120) || undefined,
    tag: c.req.query('tag')?.trim().slice(0, 120) || undefined,
    series: c.req.query('series')?.trim().slice(0, 120) || undefined,
    q: c.req.query('q')?.trim().slice(0, 200) || undefined,
    year: Number.isFinite(year) && year > 0 ? Math.trunc(year) : undefined,
    pinned: c.req.query('pinned') === 'true',
  })
  const tags = await listPostTags(c.env.DB, userId, rows.map((row) => row.id))
  return c.json({
    items: rows.map((row) => toBlogSummary(row, tags.get(row.id) ?? [])),
    page,
    limit,
    total,
    nextCursor: null,
  }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/archive', async (c) => {
  const userId = await ownerId(c)
  return c.json({ years: await blogArchive(c.env.DB, userId) }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/search', async (c) => {
  const userId = await ownerId(c)
  const { page, limit } = pageQuery(c)
  const query = (c.req.query('q') ?? '').trim().slice(0, 200)
  const result = await searchPublishedPosts(c.env.DB, userId, query, page, limit)
  const tags = await listPostTags(c.env.DB, userId, result.rows.map((row) => row.id))
  return c.json({
    query,
    engine: result.engine,
    items: result.rows.map((row) => toBlogSummary(row, tags.get(row.id) ?? [])),
    page,
    limit,
    total: result.total,
    nextCursor: null,
  }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/feeds', async (c) => {
  const userId = await ownerId(c)
  const [settings, counts] = await Promise.all([
    loadBlogSettings(c.env.DB, userId),
    blogCounts(c.env.DB, userId),
  ])
  const { rows } = await listPublishedPostsFiltered(c.env.DB, userId, { page: 1, limit: 100 })
  const tags = await listPostTags(c.env.DB, userId, rows.map((row) => row.id))
  return c.json({
    site: publicSite(settings, counts),
    posts: rows.map((row) => toBlogSummary(row, tags.get(row.id) ?? [])),
  }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts/:slug/adjacent', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  const adjacent = await findAdjacentPosts(c.env.DB, userId, row)
  const ids = [adjacent.previous?.id, adjacent.next?.id].filter((id): id is string => Boolean(id))
  const tags = await listPostTags(c.env.DB, userId, ids)
  return c.json({
    previous: adjacent.previous ? toBlogSummary(adjacent.previous, tags.get(adjacent.previous.id) ?? []) : null,
    next: adjacent.next ? toBlogSummary(adjacent.next, tags.get(adjacent.next.id) ?? []) : null,
  }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts/:slug/render', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted === 1 && !(await verifyUnlockToken(c.env, row.id, c.req.header('x-blog-unlock')))) {
    throw new ApiError(403, 'forbidden', 'This post is protected', {
      protected: true,
      hint: row.password_hint,
    })
  }
  const render = await readRenderSnapshot(c.env.FILES, row)
  if (!render) throw ApiError.notFound('This post has no render yet')
  if (row.encrypted === 1) return c.json(render, 200, { 'Cache-Control': 'private, no-store' })
  const etag = `"${row.render_hash}"`
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
  return c.json(render, 200, {
    ETag: etag,
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/pages', async (c) => {
  const userId = await ownerId(c)
  return c.json({ items: await listPublishedPages(c.env.DB, userId) }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/pages/:slug', async (c) => {
  const userId = await ownerId(c)
  const page = await getPublishedPage(c.env.DB, userId, c.req.param('slug'))
  if (!page) throw ApiError.notFound('Page not found')
  return c.json(page, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts/:slug/comments', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted === 1 && !(await verifyUnlockToken(c.env, row.id, c.req.header('x-blog-unlock')))) {
    throw new ApiError(403, 'forbidden', 'This post is protected', {
      protected: true,
      hint: row.password_hint,
    })
  }
  const settings = discussionSettings(await loadBlogSettings(c.env.DB, userId))
  const closedByAge = settings.autoCloseDays > 0 && row.published_at !== null
    && row.published_at < Date.now() - settings.autoCloseDays * 24 * 60 * 60 * 1000
  const enabled = settings.enabled && row.comments_enabled === 1 && !closedByAge
  return c.json({
    enabled,
    discussion: {
      requireNameEmail: settings.requireNameEmail,
      requireApproval: settings.requireApproval,
      allowReplies: settings.allowReplies,
      maxLength: settings.maxLength,
    },
    items: enabled ? await listApprovedComments(c.env.DB, userId, row.id) : [],
  })
})

blogPublicRoutes.post('/posts/:slug/comments', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted === 1 && !(await verifyUnlockToken(c.env, row.id, c.req.header('x-blog-unlock')))) {
    throw new ApiError(403, 'forbidden', 'This post is protected', {
      protected: true,
      hint: row.password_hint,
    })
  }
  if (row.encrypted === 1) throw new ApiError(403, 'forbidden', 'This post is protected')
  const settings = discussionSettings(await loadBlogSettings(c.env.DB, userId))
  const closedByAge = settings.autoCloseDays > 0 && row.published_at !== null
    && row.published_at < Date.now() - settings.autoCloseDays * 24 * 60 * 60 * 1000
  if (!settings.enabled || row.comments_enabled === 0 || closedByAge) {
    throw ApiError.badRequest('Comments are closed on this post')
  }
  const body = await readJson<Record<string, unknown>>(c, 16 * 1024)
  if (typeof body.website === 'string' && body.website.trim()) {
    throw ApiError.badRequest('Invalid comment')
  }
  const string = (key: string, max: number): string =>
    typeof body[key] === 'string' ? body[key].slice(0, max) : ''
  try {
    const created = await createBlogComment(c.env.DB, userId, row.id, {
      authorName: string('authorName', 80),
      email: string('email', 254),
      url: string('url', 300),
      content: string('content', settings.maxLength + 1),
      parentId: typeof body.parentId === 'string' && body.parentId ? body.parentId : null,
      ip: requestClientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    }, settings)
    return c.json(created, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'comment_rate_limited') {
      throw new ApiError(429, 'too_many_attempts', 'Please wait before commenting again')
    }
    if (message === 'comment_too_long') throw ApiError.badRequest('The comment is too long')
    if (message === 'comment_closed') throw ApiError.badRequest('Comments are closed on this post')
    if (message === 'comment_replies_disabled') throw ApiError.badRequest('Replies are turned off')
    if (message === 'comment_parent_missing') throw ApiError.badRequest('The comment being replied to is gone')
    throw ApiError.badRequest('Check the name, email and comment fields')
  }
})

blogPublicRoutes.get('/posts/:slug', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  const unlocked = row.encrypted !== 1 || (await verifyUnlockToken(c.env, row.id, c.req.header('x-blog-unlock')))
  if (!unlocked) throw new ApiError(403, 'forbidden', 'This post is protected', {
    protected: true,
    hint: row.password_hint,
  })
  const tags = await listPostTags(c.env.DB, userId, [row.id])
  const render = await readRenderSnapshot(c.env.FILES, row)
  const detail: BlogPostDetail = {
    ...toBlogSummary(row, tags.get(row.id) ?? []),
    content: row.content,
    headings: render?.headings ?? [],
    render,
    renderStatus: row.render_status,
    commentsEnabled: row.comments_enabled === 1,
    license: row.license,
    alias: row.alias,
    permalink: row.permalink,
    viewCount: row.view_count + (row.encrypted === 1 ? 0 : 1),
  }
  if (row.encrypted !== 1) await incrementPostView(c.env.DB, userId, row.id)
  return c.json(detail, 200, {
    'Cache-Control': row.encrypted === 1
      ? 'private, no-store'
      : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.post('/posts/:slug/unlock', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted !== 1) return c.json({ token: null, expiresAt: null })
  if (!row.password_hash) throw unlockNotConfigured()
  if (!unlockSecret(c.env)) throw unlockNotConfigured()
  const body = await readJson<{ password?: unknown }>(c, 4096)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password || password.length > 200) throw ApiError.badRequest('Password required')
  const ip = requestClientIp(c)
  await guardUnlockAttempt(c.env.DB, row.id, ip)
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new ApiError(403, 'forbidden', 'Incorrect password', {
      protected: true,
      hint: row.password_hint,
    })
  }
  await clearUnlockAttempts(c.env.DB, row.id, ip)
  const token = await issueUnlockToken(c.env, row.id)
  if (!token) throw unlockNotConfigured()
  return c.json({ token, expiresAt: unlockExpiry() }, 200, { 'Cache-Control': 'private, no-store' })
})

blogPublicRoutes.get('/categories', async (c) => {
  const userId = await ownerId(c)
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.position, COUNT(p.id) AS count
       FROM blog_categories c
       LEFT JOIN blog_posts p ON p.category_id = c.id AND p.user_id = c.user_id
         AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= (strftime('%s','now') * 1000)
       WHERE c.user_id = ?1
       GROUP BY c.id
       ORDER BY c.position, c.name`,
    )
    .bind(userId)
    .all<{ id: string; name: string; slug: string; description: string; position: number; count: number }>()
  return c.json({ items: results })
})

blogPublicRoutes.get('/tags', async (c) => {
  const userId = await ownerId(c)
  const { results } = await c.env.DB
    .prepare(
      `SELECT t.id, t.name, t.slug, t.color, COUNT(pt.post_id) AS count
       FROM blog_tags t
       LEFT JOIN blog_post_tags pt ON pt.tag_id = t.id AND pt.user_id = t.user_id
       LEFT JOIN blog_posts p ON p.id = pt.post_id AND p.user_id = pt.user_id
         AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= (strftime('%s','now') * 1000)
       WHERE t.user_id = ?1
       GROUP BY t.id
       ORDER BY t.position, t.name`,
    )
    .bind(userId)
    .all<{ id: string; name: string; slug: string; color: string | null; count: number }>()
  return c.json({ items: results })
})

blogPublicRoutes.get('/series', async (c) => {
  const userId = await ownerId(c)
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.id, s.slug, s.title, s.description, s.overview, s.status, s.position,
              COUNT(p.id) AS count
       FROM blog_series s
       LEFT JOIN blog_posts p ON p.series_id = s.id AND p.user_id = s.user_id
         AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL AND p.published_at IS NOT NULL AND p.published_at <= (strftime('%s','now') * 1000)
       WHERE s.user_id = ?1
       GROUP BY s.id
       ORDER BY s.position, s.title`,
    )
    .bind(userId)
    .all<{
      id: string
      slug: string
      title: string
      description: string
      overview: string
      status: string
      position: number
      count: number
    }>()
  return c.json({ items: results.map((row) => ({ ...row, name: row.title })) })
})

blogPublicRoutes.get('/permalink', async (c) => {
  const userId = await ownerId(c)
  const settings = await loadBlogSettings(c.env.DB, userId)
  if ((settings.permalink as { enable?: boolean }).enable !== true) return c.json({ found: false })
  const raw = (c.req.query('path') ?? '').trim().slice(0, 320)
  const normalized = raw.replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.includes('?') || normalized.includes('#') || normalized.split('/').includes('..')) {
    return c.json({ found: false })
  }
  const row = await findPublishedPostByPermalink(c.env.DB, userId, normalized)
    ?? await findPublishedPostByPermalink(c.env.DB, userId, `/${normalized}`)
  return c.json(row ? { found: true, slug: row.slug } : { found: false })
})

blogPublicRoutes.get('/calendar', async (c) => {
  const userId = await ownerId(c)
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.slug, p.title, p.published_at AS publishedAt
       FROM blog_posts p
       WHERE p.user_id = ?1 AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL
         AND p.published_at IS NOT NULL AND p.published_at <= (strftime('%s','now') * 1000)
       ORDER BY p.published_at ASC
       LIMIT 2000`,
    )
    .bind(userId)
    .all<{ slug: string; title: string; publishedAt: number }>()
  return c.json({ items: results })
})

blogPublicRoutes.get('/assets/:id', async (c) => {
  const userId = await ownerId(c)
  const row = await c.env.DB
    .prepare(`SELECT object_key, mime FROM blog_assets WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, c.req.param('id'))
    .first<{ object_key: string; mime: string }>()
  if (!row) throw ApiError.notFound('Asset not found')
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Blog storage is not configured')
  const object = await c.env.FILES.get(row.object_key)
  if (!object) throw ApiError.notFound('Asset not found')
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': row.mime || object.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  })
})

blogPublicRoutes.get('/redirect', async (c) => {
  const userId = await ownerId(c)
  const from = c.req.query('path') ?? ''
  if (!from.startsWith('/')) return c.json({ found: false })
  const row = await c.env.DB.prepare(
    `SELECT to_slug, status FROM blog_redirects WHERE user_id = ?1 AND from_slug = ?2`,
  ).bind(userId, from.split('?')[0]).first<{ to_slug: string; status: number }>()
  if (!row) return c.json({ found: false })
  return c.json({ found: true, to: row.to_slug, status: row.status }, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60' })
})

blogPublicRoutes.post('/collections/albums/:slug/unlock', async (c) => {
  const userId = await ownerId(c)
  const album = await c.env.DB.prepare(
    `SELECT id, password_hash, password_hint FROM blog_albums WHERE user_id = ?1 AND slug = ?2 AND published_at IS NOT NULL AND published_at <= ?3`,
  ).bind(userId, c.req.param('slug'), Date.now()).first<{ id: string; password_hash: string | null; password_hint: string }>()
  if (!album) throw ApiError.notFound('Album not found')
  if (!album.password_hash) return c.json({ token: null, notProtected: true }, 200, { 'Cache-Control': 'no-store' })
  const body = await readJson<{ password?: unknown }>(c, 4096)
  const password = typeof body.password === 'string' ? body.password : ''
  const target = `album:${album.id}`
  const ip = requestClientIp(c)
  await guardUnlockAttempt(c.env.DB, target, ip)
  if (!(await verifyPassword(password, album.password_hash))) throw new ApiError(403, 'wrong_password', 'Incorrect password')
  await clearUnlockAttempts(c.env.DB, target, ip)
  const token = await issueUnlockToken(c.env, target)
  if (!token) throw unlockNotConfigured()
  return c.json({ token, expiresAt: unlockExpiry() }, 200, { 'Cache-Control': 'no-store' })
})

blogPublicRoutes.get('/collections/albums/:slug', async (c) => {
  const userId = await ownerId(c)
  const album = await c.env.DB.prepare(
    `SELECT * FROM blog_albums WHERE user_id = ?1 AND slug = ?2 AND published_at IS NOT NULL AND published_at <= ?3`,
  ).bind(userId, c.req.param('slug'), Date.now()).first<Record<string, unknown>>()
  if (!album) throw ApiError.notFound('Album not found')
  if (typeof album.password_hash === 'string' && album.password_hash
    && !(await verifyUnlockToken(c.env, `album:${album.id}`, c.req.header('x-blog-album-unlock')))) {
    throw new ApiError(403, 'forbidden', 'This album is protected', { protected: true, hint: album.password_hint })
  }
  const { results: photos } = await c.env.DB.prepare(
    `SELECT id, asset_id, caption, alt, taken_at, position FROM blog_photos
     WHERE user_id = ?1 AND album_id = ?2 ORDER BY position, id`,
  ).bind(userId, String(album.id)).all<{ id: string; asset_id: string; caption: string; alt: string; taken_at: string; position: number }>()
  return c.json({
    album: {
      id: album.id, slug: album.slug, title: album.title, description: album.description,
      coverUrl: album.cover_asset_id ? `/api/blog/assets/${album.cover_asset_id}` : null,
      date: album.date, location: album.location,
      tags: (() => { try { const parsed = JSON.parse(String(album.tags ?? '[]')) as unknown; return Array.isArray(parsed) ? parsed : [] } catch { return [] } })(),
      layout: typeof album.layout === 'string' && album.layout ? album.layout : 'grid',
      columns: album.columns, publishedAt: album.published_at,
    },
    photos: photos.map((photo) => ({
      id: photo.id, assetId: photo.asset_id, url: `/api/blog/assets/${photo.asset_id}`,
      caption: photo.caption, alt: photo.alt, takenAt: photo.taken_at, position: photo.position,
    })),
  }, 200, { 'Cache-Control': 'no-store' })
})

blogPublicRoutes.get('/collections/compass', async (c) => {
  const userId = await ownerId(c)
  const { results: shelves } = await c.env.DB.prepare(
    `SELECT id, key, name, icon, blurb, position FROM blog_compass_shelves WHERE user_id = ?1 ORDER BY position, name`,
  ).bind(userId).all<Record<string, unknown>>()
  const { results: entries } = await c.env.DB.prepare(
    `SELECT shelf_id, label, href, note, icon, image, position FROM blog_compass_entries
     WHERE user_id = ?1 ORDER BY position, label`,
  ).bind(userId).all<Record<string, unknown>>()
  const byShelf = new Map<string, Record<string, unknown>[]>()
  for (const entry of entries) {
    const key = String(entry.shelf_id)
    const list = byShelf.get(key) ?? []
    list.push(entry)
    byShelf.set(key, list)
  }
  return c.json({
    items: shelves.map((shelf) => ({ ...shelf, entries: byShelf.get(String(shelf.id)) ?? [] })),
  }, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' })
})

blogPublicRoutes.get('/friends', async (c) => {
  const userId = await ownerId(c)
  return c.json(await listPublicFriends(c.env.DB, userId), 200, {
    'Cache-Control': 'no-store',
  })
})

blogPublicRoutes.post('/friends/apply', async (c) => {
  const userId = await ownerId(c)
  const body = await readJson<Record<string, unknown>>(c, 16 * 1024)
  if (typeof body.website === 'string' && body.website.trim()) {
    throw ApiError.badRequest('Invalid friend application')
  }
  const ipKey = `blog-friend-apply:${await sha256Hex(`${requestClientIp(c)}|${userId}`)}`
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{ key: ipKey, maxAttempts: 5, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000 }]),
    'Too many friend requests',
  )
  try {
    return c.json(await applyFriend(c.env.DB, userId, body), 201)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest(error instanceof Error ? error.message : 'Check the friend application fields')
  }
})

blogPublicRoutes.post('/friends/icon', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, 4096)
  const url = typeof body.url === 'string' ? body.url : ''
  const ipKey = `blog-friend-icon:${await sha256Hex(`${requestClientIp(c)}|${url}`)}`
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{ key: ipKey, maxAttempts: 20, windowMs: 60 * 60 * 1000, lockMs: 10 * 60 * 1000 }]),
    'Too many icon requests',
  )
  try {
    return c.json({ icon: await resolveFriendIcon(url) })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('The icon could not be read')
  }
})

blogPublicRoutes.post('/friends/icon-upload', async (c) => {
  const userId = await ownerId(c)
  const ipKey = `blog-friend-icon-upload:${await sha256Hex(`${requestClientIp(c)}|${userId}`)}`
  await assertAttemptBudget(
    () => consumeAttemptBudget(c.env.DB, [{ key: ipKey, maxAttempts: 10, windowMs: 60 * 60 * 1000, lockMs: 30 * 60 * 1000 }]),
    'Too many icon uploads',
  )
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Choose an image file')
  if (file.size <= 0 || file.size > 256 * 1024) throw ApiError.badRequest('The icon must be at most 256 KB')
  if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(file.type)) throw ApiError.badRequest('Choose a PNG, JPEG, GIF, WebP or AVIF image')
  try {
    const item = await uploadMedia({ FILES: c.env.FILES }, c.env.DB, userId, file)
    return c.json({ icon: item.url }, 201)
  } catch (error) {
    throw ApiError.badRequest(error instanceof Error ? error.message : 'The icon could not be stored')
  }
})

blogPublicRoutes.get('/friends/qr', async (c) => {
  const raw = (c.req.query('url') ?? '').trim().slice(0, 2048)
  const url = normalizeLinkUrl(raw)
  if (!url || !/^https?:\/\//i.test(url)) throw ApiError.badRequest('Enter a valid http(s) address')
  const svg = renderSVG(url, { ecc: 'M', border: 2 })
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  })
})

blogPublicRoutes.get('/collections/:kind', async (c) => {
  const userId = await ownerId(c)
  // Friend links moved to the nav app; only its dedicated projection above may serve them.
  if (c.req.param('kind') === 'friends') throw ApiError.notFound('Collection not found')
  return c.json({ items: await listPublicCollection(c.env.DB, userId, c.req.param('kind')) }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})
