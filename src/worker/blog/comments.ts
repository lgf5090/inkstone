import type { BlogSettings } from '@shared/blog/settings'
import type {
  AdminBlogComment,
  BlogCommentStatus,
  PublicBlogComment,
} from '@shared/blog/model'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'

export interface DiscussionSettings {
  enabled: boolean
  requireNameEmail: boolean
  requireApproval: boolean
  allowReplies: boolean
  maxLength: number
  rateLimitPerHour: number
  autoCloseDays: number
}

export function discussionSettings(settings: BlogSettings): DiscussionSettings {
  const raw = settings.discussion as Record<string, unknown>
  return {
    enabled: raw.enabled !== false,
    requireNameEmail: raw.requireNameEmail !== false,
    requireApproval: raw.requireApproval !== false,
    allowReplies: raw.allowReplies !== false,
    maxLength: Math.min(Math.max(Number(raw.maxLength) || 4000, 200), 10000),
    rateLimitPerHour: Math.min(Math.max(Number(raw.rateLimitPerHour) || 5, 1), 100),
    autoCloseDays: Math.max(Number(raw.autoCloseDays) || 0, 0),
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function publicComment(row: {
  id: string
  parent_id: string | null
  author_name: string
  author_url: string
  content: string
  created_at: number
}): PublicBlogComment {
  return {
    id: row.id,
    parentId: row.parent_id,
    authorName: row.author_name,
    authorUrl: row.author_url,
    content: row.content,
    createdAt: row.created_at,
    replies: [],
  }
}

export async function listApprovedComments(
  db: D1Database,
  userId: string,
  postId: string,
): Promise<PublicBlogComment[]> {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, author_name, author_url, content, created_at
       FROM blog_comments
       WHERE user_id = ?1 AND post_id = ?2 AND status = 'approved' AND deleted_at IS NULL
       ORDER BY created_at, id`,
    )
    .bind(userId, postId)
    .all<{
      id: string
      parent_id: string | null
      author_name: string
      author_url: string
      content: string
      created_at: number
    }>()
  const byId = new Map<string, PublicBlogComment>()
  const roots: PublicBlogComment[] = []
  for (const row of results) {
    const node = publicComment(row)
    byId.set(node.id, node)
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots
}

export interface CreateCommentInput {
  authorName: string
  email: string
  url: string
  content: string
  parentId: string | null
  ip: string
  userAgent: string
}

export async function createBlogComment(
  db: D1Database,
  userId: string,
  postId: string,
  input: CreateCommentInput,
  settings: DiscussionSettings,
  now = Date.now(),
): Promise<{ status: BlogCommentStatus; comment: PublicBlogComment | null }> {
  if (!settings.enabled) throw new Error('comment_closed')
  const authorName = input.authorName.trim().slice(0, 80)
  const email = input.email.trim()
  const url = input.url.trim().slice(0, 300)
  const content = input.content.trim()
  if (!content) throw new Error('comment_invalid')
  if (content.length > settings.maxLength) throw new Error('comment_too_long')
  if (settings.requireNameEmail && !authorName) throw new Error('comment_invalid')
  if (settings.requireNameEmail && !isEmail(email)) throw new Error('comment_invalid')
  if (email && !isEmail(email)) throw new Error('comment_invalid')
  if (url && !isHttpUrl(url)) throw new Error('comment_invalid')
  if (input.parentId && !settings.allowReplies) throw new Error('comment_replies_disabled')
  if (input.parentId) {
    const parent = await db
      .prepare(
        `SELECT id FROM blog_comments
         WHERE user_id = ?1 AND post_id = ?2 AND id = ?3 AND status = 'approved' AND deleted_at IS NULL`,
      )
      .bind(userId, postId, input.parentId)
      .first<{ id: string }>()
    if (!parent) throw new Error('comment_parent_missing')
  }

  const ipHash = await sha256Hex(`${input.ip}|${userId}|blog-comment-ip`)
  const userAgentHash = await sha256Hex(`${input.userAgent.slice(0, 512)}|${userId}`)
  const since = now - 60 * 60 * 1000
  const recent = await db
    .prepare(`SELECT COUNT(*) AS total FROM blog_comments WHERE user_id = ?1 AND ip_hash = ?2 AND created_at >= ?3`)
    .bind(userId, ipHash, since)
    .first<{ total: number }>()
  if ((recent?.total ?? 0) >= settings.rateLimitPerHour) throw new Error('comment_rate_limited')

  const emailHash = email ? await sha256Hex(`${userId}|${email.toLowerCase()}`) : ''
  const id = newId()
  const status: BlogCommentStatus = settings.requireApproval ? 'pending' : 'approved'
  await db
    .prepare(
      `INSERT INTO blog_comments (
         id, user_id, post_id, parent_id, author_name, author_email_hash, author_url, content,
         status, ip_hash, user_agent_hash, created_at, updated_at, deleted_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, NULL)`,
    )
    .bind(
      id, userId, postId, input.parentId, authorName, emailHash, url, content,
      status, ipHash, userAgentHash, now,
    )
    .run()
  return {
    status,
    comment: status === 'approved'
      ? publicComment({ id, parent_id: input.parentId, author_name: authorName, author_url: url, content, created_at: now })
      : null,
  }
}

export interface CommentQuery {
  status: BlogCommentStatus | 'all'
  q: string
  postId: string | null
  page: number
  limit: number
}

export async function listAdminComments(
  db: D1Database,
  userId: string,
  query: CommentQuery,
): Promise<{ items: AdminBlogComment[]; total: number; counts: Record<BlogCommentStatus, number> }> {
  const where = ['c.user_id = ?1', 'c.deleted_at IS NULL']
  const binds: (string | number)[] = [userId]
  if (query.status !== 'all') {
    binds.push(query.status)
    where.push(`c.status = ?${binds.length}`)
  }
  if (query.postId) {
    binds.push(query.postId)
    where.push(`c.post_id = ?${binds.length}`)
  }
  if (query.q) {
    const like = `%${query.q.replace(/[%_]/g, '\\$&')}%`
    binds.push(like, like)
    where.push(`(c.author_name LIKE ?${binds.length - 1} ESCAPE '\\' OR c.content LIKE ?${binds.length} ESCAPE '\\')`)
  }
  const limit = Math.min(Math.max(query.limit, 1), 100)
  const offset = (Math.max(query.page, 1) - 1) * limit
  const text = where.join(' AND ')
  const [rows, total, counts] = await Promise.all([
    db
      .prepare(
        `SELECT c.id, c.post_id, p.title AS post_title, p.slug AS post_slug, c.parent_id,
                c.author_name, c.author_email_hash, c.author_url, c.content, c.status,
                c.created_at, c.updated_at
         FROM blog_comments c
         LEFT JOIN blog_posts p ON p.id = c.post_id AND p.user_id = c.user_id
         WHERE ${text}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      )
      .bind(...binds, limit, offset)
      .all<{
        id: string
        post_id: string
        post_title: string | null
        post_slug: string | null
        parent_id: string | null
        author_name: string
        author_email_hash: string
        author_url: string
        content: string
        status: BlogCommentStatus
        created_at: number
        updated_at: number
      }>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM blog_comments c WHERE ${text}`)
      .bind(...binds)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS total FROM blog_comments
         WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY status`,
      )
      .bind(userId)
      .all<{ status: BlogCommentStatus; total: number }>(),
  ])
  const countMap: Record<BlogCommentStatus, number> = { pending: 0, approved: 0, spam: 0, trash: 0 }
  for (const row of counts.results) countMap[row.status] = row.total
  return {
    items: rows.results.map((row) => ({
      id: row.id,
      postId: row.post_id,
      postTitle: row.post_title,
      postSlug: row.post_slug,
      parentId: row.parent_id,
      authorName: row.author_name,
      authorEmailHash: row.author_email_hash,
      authorUrl: row.author_url,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    total: total?.total ?? 0,
    counts: countMap,
  }
}

export async function setCommentStatus(
  db: D1Database,
  userId: string,
  commentId: string,
  status: BlogCommentStatus,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE blog_comments SET status = ?3, updated_at = ?4, deleted_at = ?5
       WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, commentId, status, now, null)
    .run()
}

export async function bulkSetCommentStatus(
  db: D1Database,
  userId: string,
  commentIds: string[],
  status: BlogCommentStatus,
  now = Date.now(),
): Promise<number> {
  const ids = [...new Set(commentIds)].filter(Boolean).slice(0, 100)
  if (ids.length === 0) return 0
  await db.batch(ids.map((id) => db
    .prepare(
      `UPDATE blog_comments SET status = ?3, updated_at = ?4, deleted_at = ?5
       WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(userId, id, status, now, null)))
  return ids.length
}

export async function commentStats(
  db: D1Database,
  userId: string,
): Promise<Record<BlogCommentStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT status, COUNT(*) AS total FROM blog_comments
       WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY status`,
    )
    .bind(userId)
    .all<{ status: BlogCommentStatus; total: number }>()
  const counts: Record<BlogCommentStatus, number> = { pending: 0, approved: 0, spam: 0, trash: 0 }
  for (const row of results) counts[row.status] = row.total
  return counts
}
