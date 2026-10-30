import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson } from '../lib/request'
import { requireAuth, requireOwner } from '../middleware/auth'
import { BlogPublishSchema, BlogSettingPatchSchema } from '@shared/blog/validation'
import { sanitizeBlogHtml } from './sanitize'
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
