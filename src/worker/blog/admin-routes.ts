import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { BlogPublishSchema, BlogSettingPatchSchema } from '@shared/blog/validation'
import { BLOG_SETTING_KEYS } from '@shared/blog/settings'
import {
  BLOG_COLLECTION_KINDS,
  BLOG_COMMENT_STATUSES,
  type BlogCommentStatus,
  type BlogPostAdminItem,
  type BlogPostAdminDetail,
} from '@shared/blog/model'
import { sanitizeBlogHtml } from './sanitize'
import { newId } from '../lib/id'
import {
  bulkSetCommentStatus,
  commentStats,
  listAdminComments,
  setCommentStatus,
} from './comments'
import { createTaxonomy, deleteTaxonomy, listTaxonomy, updateTaxonomy } from './taxonomy'
import { deleteMedia, listMedia, MEDIA_MAX_BYTES, uploadMedia } from './media'
import {
  deletePage,
  getPage,
  getPageByNote,
  listPages,
  savePage,
  savePageNote,
  setPagePublished,
} from './pages'
import {
  blogAdminOverview,
  blogDashboard,
  blogHealth,
  bulkAdminPosts,
  findPostById,
  findPostByNoteId,
  listAdminPosts,
  listBlogAudit,
  listCalendarPosts,
  listPostTags,
  listPostsNeedingRender,
  loadBlogSettings,
  publishPostSnapshot,
  recordBlogAudit,
  saveBlogSetting,
  syncBlogPostFromNote,
  toBlogSummary,
  unpublishPost,
  updateAdminPostMeta,
  type AdminPostMetaPatch,
} from './store'
import {
  deleteAlbumPhoto,
  deleteCollectionItem,
  deleteCompassEntry,
  listAlbumPhotos,
  listCollectionItems,
  listCompassEntries,
  saveAlbumPhoto,
  saveCollectionItem,
  saveCompassEntry,
} from './collections'

export const blogAdminRoutes = new Hono<AppBindings>()

blogAdminRoutes.use('*', requireAuth, requireOwner)

const SNAPSHOT_BODY_LIMIT = 8 * 1024 * 1024

function userId(c: Context<AppBindings>): string {
  const id = c.get('userId') ?? c.get('user')?.id
  if (!id) throw ApiError.unauthenticated()
  return id
}

function pageQuery(c: Context<AppBindings>): { page: number; limit: number } {
  const rawPage = Number(c.req.query('page') ?? '1')
  const rawLimit = Number(c.req.query('limit') ?? '20')
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1,
    limit: Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20,
  }
}

function mapBlogError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  switch (message) {
    case 'blog_content_changed':
      throw ApiError.conflict('The note changed after the snapshot was rendered')
    case 'blog_not_published':
      throw ApiError.badRequest('Set isPublished in the note before publishing')
    case 'blog_post_missing':
    case 'blog_note_missing':
      throw ApiError.notFound('Post or note not found')
    case 'blog_note_deleted':
      throw ApiError.conflict('The note is in the trash')
    case 'blog_snapshot_note_mismatch':
      throw ApiError.badRequest('The snapshot belongs to another note')
    case 'blog_r2_unavailable':
      throw new ApiError(503, 'storage_unavailable', 'Blog storage is not configured')
    default:
      throw error
  }
}

async function noteFor(c: Context<AppBindings>, noteId: string) {
  const note = await c.env.DB
    .prepare(`SELECT id, title, content, deleted_at FROM notes WHERE id = ?1 AND user_id = ?2`)
    .bind(noteId, userId(c))
    .first<{ id: string; title: string; content: string; deleted_at: number | null }>()
  if (!note) throw ApiError.notFound('Note not found')
  return note
}

async function commentCounts(db: D1Database, userId: string, postIds: string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map()
  const placeholders = postIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db.prepare(
    `SELECT post_id, COUNT(*) AS total FROM blog_comments
     WHERE user_id = ?1 AND status = 'approved' AND deleted_at IS NULL AND post_id IN (${placeholders})
     GROUP BY post_id`,
  ).bind(userId, ...postIds).all<{ post_id: string; total: number }>()
  return new Map(results.map((row) => [row.post_id, row.total]))
}

function toAdminItem(
  row: Parameters<typeof toBlogSummary>[0] & {
    note_id: string
    status: BlogPostAdminItem['status']
    render_status: BlogPostAdminItem['renderStatus']
    render_hash: string
    created_at: number
    view_count: number
  },
  tags: string[],
  comments: number,
): BlogPostAdminItem {
  return {
    ...toBlogSummary(row, tags),
    noteId: row.note_id,
    status: row.status,
    renderStatus: row.render_status,
    renderHash: row.render_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    viewCount: row.view_count,
    commentCount: comments,
  }
}

function toAdminDetail(
  row: NonNullable<Awaited<ReturnType<typeof findPostById>>>,
  tags: string[],
  comments: number,
): BlogPostAdminDetail {
  return {
    ...toAdminItem(row, tags, comments),
    noteTitle: row.title,
    noteUpdatedAt: row.updated_at,
    contentHash: row.content_hash,
    renderGeneratedAt: row.render_generated_at,
    rendererVersion: row.renderer_version,
    description: row.description,
    coverAssetId: row.cover_asset_id,
    categoryId: row.category_id,
    seriesId: row.series_id,
    seriesOrder: row.series_order,
    commentsEnabled: row.comments_enabled === 1,
    language: row.language,
    license: row.license,
    alias: row.alias,
    permalink: row.permalink,
    encrypted: row.encrypted === 1,
    passwordHint: row.password_hint,
    hideHomeContent: row.hide_home_content === 1,
  }
}

blogAdminRoutes.get('/overview', async (c) => {
  return c.json(await blogAdminOverview(c.env.DB, userId(c)))
})

blogAdminRoutes.get('/dashboard', async (c) => {
  return c.json(await blogDashboard(c.env.DB, userId(c)))
})

blogAdminRoutes.get('/health', async (c) => {
  return c.json(await blogHealth(c.env.DB, c.env.FILES, userId(c)))
})

blogAdminRoutes.get('/posts', async (c) => {
  const id = userId(c)
  const { page, limit } = pageQuery(c)
  const { rows, total } = await listAdminPosts(c.env.DB, id, {
    page,
    limit,
    status: c.req.query('status') ?? 'all',
    q: c.req.query('q') ?? '',
    categoryId: c.req.query('category') ?? undefined,
    tagId: c.req.query('tag') ?? undefined,
    seriesId: c.req.query('series') ?? undefined,
    sort: c.req.query('sort') ?? undefined,
  })
  const [tags, comments] = await Promise.all([
    listPostTags(c.env.DB, id, rows.map((row) => row.id)),
    commentCounts(c.env.DB, id, rows.map((row) => row.id)),
  ])
  return c.json({
    items: rows.map((row) => toAdminItem(row, tags.get(row.id) ?? [], comments.get(row.id) ?? 0)),
    page,
    limit,
    total,
  })
})

blogAdminRoutes.get('/posts/:id', async (c) => {
  const id = userId(c)
  const row = await findPostById(c.env.DB, id, c.req.param('id'))
  if (!row) throw ApiError.notFound('Post not found')
  const [tags, comments] = await Promise.all([
    listPostTags(c.env.DB, id, [row.id]),
    commentCounts(c.env.DB, id, [row.id]),
  ])
  return c.json(toAdminDetail(row, tags.get(row.id) ?? [], comments.get(row.id) ?? 0))
})

blogAdminRoutes.patch('/posts/:id', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 64 * 1024)
  const patch: AdminPostMetaPatch = {}
  const string = (key: keyof AdminPostMetaPatch, max: number) => {
    if (typeof payload[key] === 'string') (patch as Record<string, unknown>)[key] = (payload[key] as string).slice(0, max)
  }
  string('slug', 200)
  string('excerpt', 2_000)
  string('description', 2_000)
  string('language', 20)
  string('license', 500)
  string('alias', 200)
  string('permalink', 300)
  string('password', 200)
  string('passwordHint', 200)
  if ('coverAssetId' in payload) patch.coverAssetId = typeof payload.coverAssetId === 'string' ? payload.coverAssetId : null
  if ('categoryId' in payload) patch.categoryId = typeof payload.categoryId === 'string' ? payload.categoryId : null
  if ('seriesId' in payload) patch.seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : null
  if ('seriesOrder' in payload) patch.seriesOrder = typeof payload.seriesOrder === 'number' && Number.isFinite(payload.seriesOrder) ? Math.trunc(payload.seriesOrder) : null
  if (typeof payload.pinned === 'boolean') patch.pinned = payload.pinned
  if (typeof payload.commentsEnabled === 'boolean') patch.commentsEnabled = payload.commentsEnabled
  if (typeof payload.hideHomeContent === 'boolean') patch.hideHomeContent = payload.hideHomeContent
  if (payload.clearPassword === true) patch.clearPassword = true
  if ('publishedAt' in payload) {
    patch.publishedAt = typeof payload.publishedAt === 'number' && Number.isFinite(payload.publishedAt) ? Math.trunc(payload.publishedAt) : null
  }
  try {
    const row = await updateAdminPostMeta(c.env.DB, id, c.req.param('id'), patch)
    await recordBlogAudit(c.env.DB, id, 'post.update', 'post', row.id, { slug: row.slug })
    const [tags, comments] = await Promise.all([
      listPostTags(c.env.DB, id, [row.id]),
      commentCounts(c.env.DB, id, [row.id]),
    ])
    return c.json(toAdminDetail(row, tags.get(row.id) ?? [], comments.get(row.id) ?? 0))
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/posts/:id', async (c) => {
  const id = userId(c)
  const row = await findPostById(c.env.DB, id, c.req.param('id'))
  if (!row) throw ApiError.notFound('Post not found')
  const updated = await bulkAdminPosts(c.env.DB, id, [row.note_id], 'trash')
  await recordBlogAudit(c.env.DB, id, 'post.trash', 'post', row.id, {})
  return c.json({ ok: true, updated })
})

blogAdminRoutes.post('/posts/:id/restore', async (c) => {
  const id = userId(c)
  const row = await findPostById(c.env.DB, id, c.req.param('id'))
  if (!row) throw ApiError.notFound('Post not found')
  const updated = await bulkAdminPosts(c.env.DB, id, [row.note_id], 'restore')
  await recordBlogAudit(c.env.DB, id, 'post.restore', 'post', row.id, {})
  return c.json({ ok: true, updated })
})

blogAdminRoutes.delete('/posts/:id/permanent', async (c) => {
  const id = userId(c)
  const row = await findPostById(c.env.DB, id, c.req.param('id'))
  if (!row) throw ApiError.notFound('Post not found')
  if (row.deleted_at === null) throw ApiError.badRequest('Move the post to the trash first')
  const updated = await bulkAdminPosts(c.env.DB, id, [row.note_id], 'delete')
  await recordBlogAudit(c.env.DB, id, 'post.delete', 'post', row.id, {})
  return c.json({ ok: true, updated })
})

blogAdminRoutes.post('/posts/bulk', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 32 * 1024)
  const action = payload.action
  if (action !== 'unpublish' && action !== 'trash' && action !== 'restore' && action !== 'pin' && action !== 'unpin') {
    throw ApiError.badRequest('Invalid bulk action')
  }
  const noteIds = Array.isArray(payload.noteIds)
    ? payload.noteIds.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 100)
    : []
  const updated = await bulkAdminPosts(c.env.DB, id, noteIds, action)
  await recordBlogAudit(c.env.DB, id, `post.bulk_${action}`, 'post', action, { noteIds, updated })
  return c.json({ ok: true, updated })
})

blogAdminRoutes.get('/calendar', async (c) => {
  const from = Number(c.req.query('from'))
  const to = Number(c.req.query('to'))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw ApiError.badRequest('Invalid calendar range')
  }
  const span = to - from
  if (span > 366 * 24 * 60 * 60 * 1000) throw ApiError.badRequest('Calendar range is too wide')
  const rows = await listCalendarPosts(c.env.DB, userId(c), from, to)
  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      category: row.category_name,
    })),
  })
})

blogAdminRoutes.get('/posts/by-note/:noteId', async (c) => {
  const id = userId(c)
  const row = await findPostByNoteId(c.env.DB, id, c.req.param('noteId'))
  if (!row) throw ApiError.notFound('Post not found')
  const [tags, comments] = await Promise.all([
    listPostTags(c.env.DB, id, [row.id]),
    commentCounts(c.env.DB, id, [row.id]),
  ])
  return c.json(toAdminDetail(row, tags.get(row.id) ?? [], comments.get(row.id) ?? 0))
})

blogAdminRoutes.post('/posts/:noteId/sync', async (c) => {
  const id = userId(c)
  const note = await noteFor(c, c.req.param('noteId'))
  const row = await syncBlogPostFromNote(c.env.DB, id, note)
  await recordBlogAudit(c.env.DB, id, 'post.sync', 'post', note.id, { status: row?.status ?? null })
  return c.json(row)
})

blogAdminRoutes.post('/posts/:noteId/publish', async (c) => {
  const id = userId(c)
  const noteId = c.req.param('noteId')
  const payload = await readJson<unknown>(c, SNAPSHOT_BODY_LIMIT)
  const parsed = BlogPublishSchema.safeParse(payload)
  if (!parsed.success) {
    throw ApiError.badRequest('Invalid blog snapshot', parsed.error.flatten())
  }
  const snapshot = parsed.data.snapshot
  if (snapshot.noteId !== noteId) throw ApiError.badRequest('The snapshot belongs to another note')
  const sanitized = sanitizeBlogHtml(snapshot.html)
  if (!sanitized.trim()) throw ApiError.badRequest('The snapshot contains no renderable HTML')
  const note = await noteFor(c, noteId)
  try {
    await syncBlogPostFromNote(c.env.DB, id, note)
    const row = await publishPostSnapshot(c.env.DB, c.env.FILES, id, noteId, {
      ...snapshot,
      html: sanitized,
    })
    await recordBlogAudit(c.env.DB, id, 'post.publish', 'post', row.id, {
      slug: row.slug,
      rendererVersion: snapshot.rendererVersion,
    })
    return c.json(row)
  } catch (error) {
    mapBlogError(error)
  }
})

blogAdminRoutes.post('/posts/:postId/unpublish', async (c) => {
  const id = userId(c)
  const postId = c.req.param('postId')
  const existing = await findPostById(c.env.DB, id, postId)
  if (!existing) throw ApiError.notFound('Post not found')
  const row = await unpublishPost(c.env.DB, id, postId)
  await recordBlogAudit(c.env.DB, id, 'post.unpublish', 'post', postId, {})
  return c.json(row)
})

blogAdminRoutes.get('/settings', async (c) => {
  return c.json(await loadBlogSettings(c.env.DB, userId(c)))
})

blogAdminRoutes.patch('/settings', async (c) => {
  const id = userId(c)
  const payload = await readJson<unknown>(c, 2 * 1024 * 1024)
  const parsed = BlogSettingPatchSchema.safeParse(payload)
  if (!parsed.success) throw ApiError.badRequest('Invalid blog setting', parsed.error.flatten())
  await saveBlogSetting(c.env.DB, id, parsed.data.key, parsed.data.value)
  await recordBlogAudit(c.env.DB, id, 'settings.update', 'setting', parsed.data.key, {})
  return c.json(await loadBlogSettings(c.env.DB, id))
})

function commentStatus(value: unknown): BlogCommentStatus {
  if (typeof value === 'string' && (BLOG_COMMENT_STATUSES as readonly string[]).includes(value)) {
    return value as BlogCommentStatus
  }
  throw ApiError.badRequest('Invalid comment status')
}

function mapContentError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  switch (message) {
    case 'taxonomy_kind_invalid': throw ApiError.badRequest('Invalid taxonomy kind')
    case 'taxonomy_name_required': throw ApiError.badRequest('A name is required')
    case 'taxonomy_in_use': throw ApiError.conflict('Move the posts that use this taxonomy first')
    case 'taxonomy_item_missing': throw ApiError.badRequest('The selected taxonomy does not exist')
    case 'blog_post_missing': throw ApiError.notFound('Post not found')
    case 'collection_item_missing': throw ApiError.notFound('Item not found')
    case 'collection_field_required': throw ApiError.badRequest('Fill in the required fields')
    case 'collection_value_too_large': throw ApiError.badRequest('One of the fields is too large')
    case 'invalid_json': throw ApiError.badRequest('One of the JSON fields is invalid')
    case 'media_storage_unavailable': throw new ApiError(503, 'storage_unavailable', 'Blog storage is not configured')
    case 'media_too_large': throw new ApiError(413, 'payload_too_large', `Files must be at most ${Math.floor(MEDIA_MAX_BYTES / 1024 / 1024)} MiB`)
    case 'media_type_not_allowed': throw new ApiError(415, 'bad_request', 'This file type is not allowed')
    case 'media_missing': throw ApiError.notFound('Media not found')
    case 'media_in_use': throw ApiError.conflict('This asset is still referenced by a post')
    case 'page_title_required': throw ApiError.badRequest('A page title is required')
    case 'page_missing': throw ApiError.notFound('Page not found')
    default: throw error
  }
}

blogAdminRoutes.get('/taxonomy', async (c) => {
  return c.json(await listTaxonomy(c.env.DB, userId(c)))
})

blogAdminRoutes.post('/taxonomy/:kind', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 64 * 1024)
  try {
    const item = await createTaxonomy(c.env.DB, id, c.req.param('kind'), {
      name: typeof payload.name === 'string' ? payload.name : '',
      slug: typeof payload.slug === 'string' ? payload.slug : undefined,
      description: typeof payload.description === 'string' ? payload.description : '',
      color: typeof payload.color === 'string' ? payload.color : null,
      status: typeof payload.status === 'string' ? payload.status : undefined,
    })
    await recordBlogAudit(c.env.DB, id, 'taxonomy.create', 'taxonomy', item.id, { kind: item.kind, name: item.name })
    return c.json(item, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.patch('/taxonomy/:kind/:id', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 64 * 1024)
  try {
    await updateTaxonomy(c.env.DB, id, c.req.param('kind'), c.req.param('id'), {
      name: typeof payload.name === 'string' ? payload.name : '',
      slug: typeof payload.slug === 'string' ? payload.slug : undefined,
      description: typeof payload.description === 'string' ? payload.description : '',
      color: typeof payload.color === 'string' ? payload.color : null,
      status: typeof payload.status === 'string' ? payload.status : undefined,
    })
    await recordBlogAudit(c.env.DB, id, 'taxonomy.update', 'taxonomy', c.req.param('id'), { kind: c.req.param('kind') })
    return c.json({ ok: true })
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/taxonomy/:kind/:id', async (c) => {
  const id = userId(c)
  try {
    await deleteTaxonomy(c.env.DB, id, c.req.param('kind'), c.req.param('id'))
    await recordBlogAudit(c.env.DB, id, 'taxonomy.delete', 'taxonomy', c.req.param('id'), { kind: c.req.param('kind') })
    return c.json({ ok: true })
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.get('/media', async (c) => {
  return c.json(await listMedia(
    c.env.DB,
    userId(c),
    Number(c.req.query('page') ?? '1') || 1,
    Number(c.req.query('limit') ?? '30') || 30,
    c.req.query('kind') ?? '',
    (c.req.query('q') ?? '').trim().slice(0, 200),
  ))
})

blogAdminRoutes.post('/media', async (c) => {
  const id = userId(c)
  try {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) throw new Error('media_missing')
    const item = await uploadMedia(c.env, c.env.DB, id, file)
    await recordBlogAudit(c.env.DB, id, 'media.upload', 'media', item.id, { filename: item.filename, size: item.size })
    return c.json(item, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/media/:id', async (c) => {
  const id = userId(c)
  try {
    await deleteMedia(c.env, c.env.DB, id, c.req.param('id'))
    await recordBlogAudit(c.env.DB, id, 'media.delete', 'media', c.req.param('id'), {})
    return c.json({ ok: true })
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.get('/pages', async (c) => {
  return c.json({ items: await listPages(c.env.DB, userId(c)) })
})

blogAdminRoutes.get('/pages/:id', async (c) => {
  const page = await getPage(c.env.DB, userId(c), c.req.param('id'))
  if (!page) throw ApiError.notFound('Page not found')
  return c.json(page)
})

blogAdminRoutes.post('/pages', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 1024 * 1024)
  try {
    const page = await savePage(c.env.DB, id, null, {
      title: typeof payload.title === 'string' ? payload.title : '',
      slug: typeof payload.slug === 'string' ? payload.slug : undefined,
      kind: typeof payload.kind === 'string' ? payload.kind : 'custom',
      body: typeof payload.body === 'string' ? payload.body : '',
      publish: payload.publish === true,
    })
    await recordBlogAudit(c.env.DB, id, 'page.create', 'page', page.id, { slug: page.slug })
    return c.json(page, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.patch('/pages/:id', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 1024 * 1024)
  try {
    const page = await savePage(c.env.DB, id, c.req.param('id'), {
      title: typeof payload.title === 'string' ? payload.title : '',
      slug: typeof payload.slug === 'string' ? payload.slug : undefined,
      kind: typeof payload.kind === 'string' ? payload.kind : 'custom',
      body: typeof payload.body === 'string' ? payload.body : '',
      publish: payload.publish === true,
    })
    await recordBlogAudit(c.env.DB, id, 'page.update', 'page', page.id, { slug: page.slug })
    return c.json(page)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/pages/:id', async (c) => {
  const id = userId(c)
  await deletePage(c.env.DB, id, c.req.param('id'))
  await recordBlogAudit(c.env.DB, id, 'page.delete', 'page', c.req.param('id'), {})
  return c.json({ ok: true })
})

blogAdminRoutes.get('/comments', async (c) => {
  const id = userId(c)
  const { page, limit } = pageQuery(c)
  const rawStatus = c.req.query('status') ?? 'all'
  const status = rawStatus === 'all' ? 'all' : commentStatus(rawStatus)
  return c.json(await listAdminComments(c.env.DB, id, {
    status,
    q: (c.req.query('q') ?? '').trim().slice(0, 200),
    postId: c.req.query('postId') ?? null,
    page,
    limit,
  }))
})

blogAdminRoutes.get('/comments/stats', async (c) => {
  return c.json(await commentStats(c.env.DB, userId(c)))
})

blogAdminRoutes.post('/comments/:id/status', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 8 * 1024)
  const status = commentStatus(payload.status)
  await setCommentStatus(c.env.DB, id, c.req.param('id'), status)
  await recordBlogAudit(c.env.DB, id, 'comment.status', 'comment', c.req.param('id'), { status })
  return c.json({ ok: true, status })
})

blogAdminRoutes.delete('/comments/:id', async (c) => {
  const id = userId(c)
  await setCommentStatus(c.env.DB, id, c.req.param('id'), 'trash')
  await recordBlogAudit(c.env.DB, id, 'comment.trash', 'comment', c.req.param('id'), {})
  return c.json({ ok: true })
})

blogAdminRoutes.post('/comments/bulk', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  const status = commentStatus(payload.status)
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 100)
    : []
  const updated = await bulkSetCommentStatus(c.env.DB, id, ids, status)
  await recordBlogAudit(c.env.DB, id, 'comment.bulk_status', 'comment', status, { ids, updated })
  return c.json({ ok: true, updated })
})

function safePath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > 300) throw ApiError.badRequest('A path is required')
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) {
    throw ApiError.badRequest('Paths must be site-relative and start with a single slash')
  }
  return raw
}

blogAdminRoutes.get('/redirects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT from_slug, to_slug, status, created_at FROM blog_redirects
     WHERE user_id = ?1 ORDER BY created_at DESC`,
  ).bind(userId(c)).all<{ from_slug: string; to_slug: string; status: number; created_at: number }>()
  return c.json({
    items: results.map((row) => ({
      from: row.from_slug, to: row.to_slug, status: row.status, createdAt: row.created_at,
    })),
  })
})

blogAdminRoutes.post('/redirects', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  const from = safePath(payload.from)
  const to = safePath(payload.to)
  if (from === to) throw ApiError.badRequest('The source and target are identical')
  const status = payload.status === 302 ? 302 : 301
  await c.env.DB.prepare(
    `INSERT INTO blog_redirects (user_id, from_slug, to_slug, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id, from_slug) DO UPDATE SET to_slug = excluded.to_slug, status = excluded.status`,
  ).bind(id, from, to, status, Date.now()).run()
  await recordBlogAudit(c.env.DB, id, 'redirect.save', 'redirect', from, { to, status })
  return c.json({ from, to, status, createdAt: Date.now() }, 201)
})

blogAdminRoutes.delete('/redirects/:from', async (c) => {
  const id = userId(c)
  const from = safePath(decodeURIComponent(c.req.param('from')))
  await c.env.DB.prepare(`DELETE FROM blog_redirects WHERE user_id = ?1 AND from_slug = ?2`).bind(id, from).run()
  await recordBlogAudit(c.env.DB, id, 'redirect.delete', 'redirect', from, {})
  return c.json({ ok: true })
})

blogAdminRoutes.get('/collections/:kind', async (c) => {
  return c.json({ items: await listCollectionItems(c.env.DB, userId(c), c.req.param('kind')) })
})

blogAdminRoutes.post('/collections/:kind', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 64 * 1024)
  try {
    const item = await saveCollectionItem(c.env.DB, id, c.req.param('kind'), null, payload)
    await recordBlogAudit(c.env.DB, id, 'collection.create', item.kind, item.id, { title: item.title })
    return c.json(item, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.patch('/collections/:kind/:id', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 64 * 1024)
  try {
    const item = await saveCollectionItem(c.env.DB, id, c.req.param('kind'), c.req.param('id'), payload)
    await recordBlogAudit(c.env.DB, id, 'collection.update', item.kind, item.id, { title: item.title })
    return c.json(item)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/collections/:kind/:id', async (c) => {
  const id = userId(c)
  try {
    await deleteCollectionItem(c.env.DB, id, c.req.param('kind'), c.req.param('id'))
    await recordBlogAudit(c.env.DB, id, 'collection.delete', c.req.param('kind'), c.req.param('id'), {})
    return c.json({ ok: true })
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.get('/collections/albums/:id/photos', async (c) => {
  return c.json({ items: await listAlbumPhotos(c.env.DB, userId(c), c.req.param('id')) })
})

blogAdminRoutes.post('/collections/albums/:id/photos', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  try {
    const photo = await saveAlbumPhoto(c.env.DB, id, c.req.param('id'), null, payload)
    await recordBlogAudit(c.env.DB, id, 'album.photo_add', 'album', c.req.param('id'), { photoId: photo.id })
    return c.json(photo, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.patch('/collections/albums/:id/photos/:photoId', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  try {
    return c.json(await saveAlbumPhoto(c.env.DB, id, c.req.param('id'), c.req.param('photoId'), payload))
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/collections/albums/:id/photos/:photoId', async (c) => {
  const id = userId(c)
  await deleteAlbumPhoto(c.env.DB, id, c.req.param('id'), c.req.param('photoId'))
  await recordBlogAudit(c.env.DB, id, 'album.photo_remove', 'album', c.req.param('id'), { photoId: c.req.param('photoId') })
  return c.json({ ok: true })
})

blogAdminRoutes.get('/collections/compass/:id/entries', async (c) => {
  return c.json({ items: await listCompassEntries(c.env.DB, userId(c), c.req.param('id')) })
})

blogAdminRoutes.post('/collections/compass/:id/entries', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  try {
    await saveCompassEntry(c.env.DB, id, c.req.param('id'), null, payload)
    return c.json({ items: await listCompassEntries(c.env.DB, id, c.req.param('id')) }, 201)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.patch('/collections/compass/:id/entries/:entryId', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  try {
    await saveCompassEntry(c.env.DB, id, c.req.param('id'), c.req.param('entryId'), payload)
    return c.json({ items: await listCompassEntries(c.env.DB, id, c.req.param('id')) })
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.delete('/collections/compass/:id/entries/:entryId', async (c) => {
  const id = userId(c)
  await deleteCompassEntry(c.env.DB, id, c.req.param('id'), c.req.param('entryId'))
  return c.json({ ok: true })
})

blogAdminRoutes.post('/pages/:id/note', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 8 * 1024)
  const noteId = typeof payload.noteId === 'string' && payload.noteId ? payload.noteId : null
  try {
    const page = await savePageNote(c.env.DB, id, c.req.param('id'), noteId)
    await recordBlogAudit(c.env.DB, id, 'page.note', 'page', page.id, { noteId })
    return c.json(page)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.post('/pages/:id/publish', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 8 * 1024)
  try {
    const page = await setPagePublished(c.env.DB, id, c.req.param('id'), payload.published === true)
    await recordBlogAudit(c.env.DB, id, 'page.publish', 'page', page.id, { published: page.publishedAt !== null })
    return c.json(page)
  } catch (error) {
    mapContentError(error)
  }
})

blogAdminRoutes.get('/pages/by-note/:noteId', async (c) => {
  const page = await getPageByNote(c.env.DB, userId(c), c.req.param('noteId'))
  if (!page) throw ApiError.notFound('Page not found')
  return c.json(page)
})

blogAdminRoutes.get('/audit', async (c) => {
  return c.json({ items: await listBlogAudit(c.env.DB, userId(c), Number(c.req.query('limit') ?? '50') || 50) })
})

blogAdminRoutes.get('/tools/render-queue', async (c) => {
  return c.json({ items: await listPostsNeedingRender(c.env.DB, userId(c)) })
})

blogAdminRoutes.post('/tools/purge', async (c) => {
  const id = userId(c)
  const origin = c.env.BLOG_PUBLIC_ORIGIN?.trim()
  const secret = c.env.BLOG_PURGE_SECRET?.trim()
  if (!origin || !secret) {
    return c.json({
      configured: false,
      purged: false,
      message: 'Set BLOG_PUBLIC_ORIGIN and BLOG_PURGE_SECRET to purge the public site cache.',
    })
  }
  let response: Response
  try {
    response = await fetch(`${origin.replace(/\/+$/, '')}/_blog/purge`, {
      method: 'POST',
      headers: { 'x-blog-purge-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  } catch (error) {
    throw new ApiError(502, 'internal', `The blog worker could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new ApiError(502, 'internal', `The blog worker rejected the purge (${response.status})`)
  }
  await recordBlogAudit(c.env.DB, id, 'tools.purge', 'site', origin, {})
  return c.json({ configured: true, purged: true })
})

blogAdminRoutes.get('/export', async (c) => {
  const id = userId(c)
  const [settings, taxonomy, pages, collections] = await Promise.all([
    loadBlogSettings(c.env.DB, id),
    listTaxonomy(c.env.DB, id),
    listPages(c.env.DB, id),
    Promise.all(BLOG_COLLECTION_KINDS.map((kind) => listCollectionItems(c.env.DB, id, kind))),
  ])
  const { results: redirects } = await c.env.DB.prepare(
    `SELECT from_slug, to_slug, status, created_at FROM blog_redirects WHERE user_id = ?1 ORDER BY created_at`,
  ).bind(id).all<{ from_slug: string; to_slug: string; status: number; created_at: number }>()
  const { results: posts } = await c.env.DB.prepare(
    `SELECT id, note_id, slug, title, status, render_status, published_at, updated_at FROM blog_posts
     WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at`,
  ).bind(id).all<Record<string, unknown>>()
  return c.json({
    version: 1,
    exportedAt: Date.now(),
    settings,
    taxonomy,
    pages,
    collections: Object.fromEntries(collections.map((items) => [items[0]?.kind ?? 'empty', items])),
    redirects: redirects.map((row) => ({
      from: row.from_slug, to: row.to_slug, status: row.status, createdAt: row.created_at,
    })),
    posts,
  }, 200, { 'Content-Disposition': 'attachment; filename="inkstone-blog-export.json"' })
})

blogAdminRoutes.post('/import', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 4 * 1024 * 1024)
  if (payload.version !== 1) throw ApiError.badRequest('Unsupported export version')
  let settingsCount = 0
  let redirectCount = 0
  if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
    for (const [key, value] of Object.entries(payload.settings as Record<string, unknown>)) {
      if (!(BLOG_SETTING_KEYS as readonly string[]).includes(key)) continue
      await saveBlogSetting(c.env.DB, id, key as (typeof BLOG_SETTING_KEYS)[number], value)
      settingsCount += 1
    }
  }
  if (Array.isArray(payload.redirects)) {
    for (const raw of payload.redirects.slice(0, 500)) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      let from: string
      let to: string
      try {
        from = safePath(row.from)
        to = safePath(row.to)
      } catch {
        continue
      }
      if (from === to) continue
      await c.env.DB.prepare(
        `INSERT INTO blog_redirects (user_id, from_slug, to_slug, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, from_slug) DO UPDATE SET to_slug = excluded.to_slug, status = excluded.status`,
      ).bind(id, from, to, row.status === 302 ? 302 : 301, Date.now()).run()
      redirectCount += 1
    }
  }
  await recordBlogAudit(c.env.DB, id, 'tools.import', 'site', 'export', { settingsCount, redirectCount })
  return c.json({ ok: true, settings: settingsCount, redirects: redirectCount })
})

blogAdminRoutes.get('/account', async (c) => {
  const id = userId(c)
  const row = await c.env.DB.prepare(
    `SELECT id, username, name, avatar_url, role, created_at, last_seen_at FROM users WHERE id = ?1`,
  ).bind(id).first<{ id: string; username: string; name: string; avatar_url: string; role: string; created_at: number; last_seen_at: number }>()
  if (!row) throw ApiError.notFound('Account not found')
  const settings = await loadBlogSettings(c.env.DB, id)
  return c.json({
    id: row.id,
    username: row.username,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    profile: settings.profile,
  })
})

blogAdminRoutes.patch('/account', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 32 * 1024)
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : undefined
  const avatarUrl = typeof payload.avatarUrl === 'string' ? payload.avatarUrl.trim().slice(0, 500) : undefined
  if (avatarUrl && !/^https?:\/\//i.test(avatarUrl) && !avatarUrl.startsWith('/')) {
    throw ApiError.badRequest('The avatar must be an http(s) URL')
  }
  const settings = await loadBlogSettings(c.env.DB, id)
  const profile = { ...(settings.profile as Record<string, unknown>) }
  if (typeof payload.bio === 'string') profile.bio = payload.bio.slice(0, 2_000)
  if (Array.isArray(payload.links)) {
    profile.links = payload.links
      .slice(0, 12)
      .filter((link): link is { label: string; url: string } => Boolean(link) && typeof link === 'object')
      .map((link) => ({
        label: String((link as { label?: unknown }).label ?? '').slice(0, 80),
        url: String((link as { url?: unknown }).url ?? '').slice(0, 500),
      }))
  }
  if (name !== undefined) {
    await c.env.DB.prepare(`UPDATE users SET name = ?2 WHERE id = ?1`).bind(id, name).run()
    profile.name = name
  }
  if (avatarUrl !== undefined) {
    await c.env.DB.prepare(`UPDATE users SET avatar_url = ?2 WHERE id = ?1`).bind(id, avatarUrl).run()
    profile.avatar = avatarUrl
  }
  await saveBlogSetting(c.env.DB, id, 'profile', profile)
  await recordBlogAudit(c.env.DB, id, 'account.update', 'user', id, {})
  return c.json({ ok: true })
})

blogAdminRoutes.post('/comments/:id/reply', async (c) => {
  const id = userId(c)
  const payload = await readJson<Record<string, unknown>>(c, 16 * 1024)
  const content = typeof payload.content === 'string' ? payload.content.trim().slice(0, 4_000) : ''
  if (!content) throw ApiError.badRequest('A reply is required')
  const parent = await c.env.DB.prepare(
    `SELECT id, post_id FROM blog_comments WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(id, c.req.param('id')).first<{ id: string; post_id: string }>()
  if (!parent) throw ApiError.notFound('Comment not found')
  const [user, settings] = await Promise.all([
    c.env.DB.prepare(`SELECT name FROM users WHERE id = ?1`).bind(id).first<{ name: string }>(),
    loadBlogSettings(c.env.DB, id),
  ])
  const profile = settings.profile as { name?: string }
  const authorName = (user?.name || profile.name || 'Owner').slice(0, 80)
  const replyId = newId()
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO blog_comments (
       id, user_id, post_id, parent_id, author_name, author_email_hash, author_url, content,
       status, ip_hash, user_agent_hash, created_at, updated_at, deleted_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, '', '', ?6, 'approved', '', '', ?7, ?7, NULL)`,
  ).bind(replyId, id, parent.post_id, parent.id, authorName, content, now).run()
  await recordBlogAudit(c.env.DB, id, 'comment.reply', 'comment', parent.id, { replyId })
  return c.json({ ok: true, id: replyId }, 201)
})
