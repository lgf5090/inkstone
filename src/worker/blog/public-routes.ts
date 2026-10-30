import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { publicBlogSite } from '@shared/blog/settings'
import type { BlogPostDetail } from '@shared/blog/model'
import { requireBlogProxy } from './guard'
import {
  blogCounts,
  blogOwnerUserId,
  findPublishedPost,
  listPostTags,
  listPublishedPosts,
  loadBlogSettings,
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
  return c.json(publicBlogSite(settings, counts), 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts', async (c) => {
  const userId = await ownerId(c)
  const { page, limit } = pageQuery(c)
  const { rows, total } = await listPublishedPosts(c.env.DB, userId, page, limit)
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

blogPublicRoutes.get('/posts/:slug/render', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted === 1) throw new ApiError(403, 'forbidden', 'This post is protected', {
    protected: true,
    hint: row.password_hint,
  })
  const render = await readRenderSnapshot(c.env.FILES, row)
  if (!render) throw ApiError.notFound('This post has no render yet')
  const etag = `"${row.render_hash}"`
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
  return c.json(render, 200, {
    ETag: etag,
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/posts/:slug', async (c) => {
  const userId = await ownerId(c)
  const row = await findPublishedPost(c.env.DB, userId, c.req.param('slug'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.encrypted === 1) throw new ApiError(403, 'forbidden', 'This post is protected', {
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
  }
  return c.json(detail, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

blogPublicRoutes.get('/categories', async (c) => {
  const userId = await ownerId(c)
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.position, COUNT(p.id) AS count
       FROM blog_categories c
       LEFT JOIN blog_posts p ON p.category_id = c.id AND p.user_id = c.user_id
         AND p.status = 'published' AND p.deleted_at IS NULL
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
         AND p.status = 'published' AND p.deleted_at IS NULL
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
         AND p.status = 'published' AND p.deleted_at IS NULL
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
