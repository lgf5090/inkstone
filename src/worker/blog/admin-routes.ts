import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { BlogPublishSchema, BlogSettingPatchSchema } from '@shared/blog/validation'
import { BLOG_COMMENT_STATUSES, type BlogCommentStatus } from '@shared/blog/model'
import { sanitizeBlogHtml } from './sanitize'
import {
  bulkSetCommentStatus,
  commentStats,
  listAdminComments,
  setCommentStatus,
} from './comments'
import { createTaxonomy, deleteTaxonomy, listTaxonomy, updateTaxonomy } from './taxonomy'
import { deleteMedia, listMedia, MEDIA_MAX_BYTES, uploadMedia } from './media'
import { deletePage, getPage, listPages, savePage } from './pages'
import {
  blogAdminOverview,
  findPostById,
  findPostByNoteId,
  listAdminPosts,
  listPostTags,
  loadBlogSettings,
  publishPostSnapshot,
  recordBlogAudit,
  saveBlogSetting,
  syncBlogPostFromNote,
  toBlogSummary,
  unpublishPost,
} from './store'

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

blogAdminRoutes.get('/overview', async (c) => {
  return c.json(await blogAdminOverview(c.env.DB, userId(c)))
})

blogAdminRoutes.get('/posts', async (c) => {
  const id = userId(c)
  const { page, limit } = pageQuery(c)
  const { rows, total } = await listAdminPosts(c.env.DB, id, page, limit)
  const tags = await listPostTags(c.env.DB, id, rows.map((row) => row.id))
  return c.json({
    items: rows.map((row) => ({
      ...toBlogSummary(row, tags.get(row.id) ?? []),
      noteId: row.note_id,
      status: row.status,
      renderStatus: row.render_status,
      renderHash: row.render_hash,
    })),
    page,
    limit,
    total,
  })
})

blogAdminRoutes.get('/posts/by-note/:noteId', async (c) => {
  const id = userId(c)
  const row = await findPostByNoteId(c.env.DB, id, c.req.param('noteId'))
  if (!row) throw ApiError.notFound('Post not found')
  const tags = await listPostTags(c.env.DB, id, [row.id])
  return c.json({
    ...toBlogSummary(row, tags.get(row.id) ?? []),
    noteId: row.note_id,
    status: row.status,
    renderStatus: row.render_status,
    renderHash: row.render_hash,
  })
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
