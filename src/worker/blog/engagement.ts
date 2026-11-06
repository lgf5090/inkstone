import type { BlogEngagementState, BlogSavedPost } from '@shared/blog/model'
import { sha256Hex } from '../lib/encoding'
import { toBlogSummary, type BlogPostWithNames } from './store'

export const BLOG_VISITOR_COOKIE = 'inkstone_blog_visitor'
const VISITOR_PATTERN = /^[A-Za-z0-9_-]{16,80}$/

export function validVisitorId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return VISITOR_PATTERN.test(trimmed) ? trimmed : null
}

export function visitorHash(userId: string, visitorId: string): Promise<string> {
  return sha256Hex(`${userId}|${visitorId}|blog-visitor`)
}

export async function likeCounts(
  db: D1Database,
  userId: string,
  postIds: string[],
): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map()
  const placeholders = postIds.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db
    .prepare(
      `SELECT post_id, COUNT(*) AS total FROM blog_post_likes
       WHERE user_id = ?1 AND post_id IN (${placeholders})
       GROUP BY post_id`,
    )
    .bind(userId, ...postIds)
    .all<{ post_id: string; total: number }>()
  return new Map(results.map((row) => [row.post_id, row.total]))
}

export async function oneLikeCount(db: D1Database, userId: string, postId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM blog_post_likes WHERE user_id = ?1 AND post_id = ?2`)
    .bind(userId, postId)
    .first<{ total: number }>()
  return row?.total ?? 0
}

export async function readEngagement(
  db: D1Database,
  userId: string,
  postId: string,
  hash: string | null,
): Promise<BlogEngagementState> {
  const [likeCount, liked, favorited] = await Promise.all([
    oneLikeCount(db, userId, postId),
    hash
      ? db
        .prepare(`SELECT 1 AS present FROM blog_post_likes WHERE user_id = ?1 AND post_id = ?2 AND visitor_hash = ?3`)
        .bind(userId, postId, hash)
        .first<{ present: number }>()
      : Promise.resolve(null),
    hash
      ? db
        .prepare(`SELECT 1 AS present FROM blog_post_favorites WHERE user_id = ?1 AND post_id = ?2 AND visitor_hash = ?3`)
        .bind(userId, postId, hash)
        .first<{ present: number }>()
      : Promise.resolve(null),
  ])
  return { likeCount, liked: Boolean(liked), favorited: Boolean(favorited) }
}

export interface EngagementPatch {
  like?: boolean
  favorite?: boolean
}

export async function applyEngagement(
  db: D1Database,
  userId: string,
  postId: string,
  hash: string,
  patch: EngagementPatch,
  now = Date.now(),
): Promise<BlogEngagementState> {
  if (patch.like !== undefined) {
    if (patch.like) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO blog_post_likes (user_id, post_id, visitor_hash, created_at)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(userId, postId, hash, now)
        .run()
    } else {
      await db
        .prepare(`DELETE FROM blog_post_likes WHERE user_id = ?1 AND post_id = ?2 AND visitor_hash = ?3`)
        .bind(userId, postId, hash)
        .run()
    }
  }
  if (patch.favorite !== undefined) {
    if (patch.favorite) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO blog_post_favorites (user_id, post_id, visitor_hash, created_at)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(userId, postId, hash, now)
        .run()
    } else {
      await db
        .prepare(`DELETE FROM blog_post_favorites WHERE user_id = ?1 AND post_id = ?2 AND visitor_hash = ?3`)
        .bind(userId, postId, hash)
        .run()
    }
  }
  return readEngagement(db, userId, postId, hash)
}

export async function listSavedPosts(
  db: D1Database,
  userId: string,
  hash: string,
  page: number,
  limit: number,
): Promise<{ items: BlogSavedPost[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 50)
  const offset = (Math.max(page, 1) - 1) * safeLimit
  const where = `f.user_id = ?1 AND f.visitor_hash = ?2 AND p.encrypted = 0
       AND p.status IN ('published','scheduled') AND p.deleted_at IS NULL
       AND p.published_at IS NOT NULL AND p.published_at <= ?3`
  const [rows, totalRow] = await Promise.all([
    db
      .prepare(
        `SELECT p.*, c.name AS category_name, s.title AS series_title, f.created_at AS saved_at
         FROM blog_post_favorites f
         JOIN blog_posts p ON p.id = f.post_id AND p.user_id = f.user_id
         LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
         LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
         WHERE ${where}
         ORDER BY f.created_at DESC, p.id
         LIMIT ?4 OFFSET ?5`,
      )
      .bind(userId, hash, Date.now(), safeLimit, offset)
      .all<BlogPostWithNames & { saved_at: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM blog_post_favorites f
         JOIN blog_posts p ON p.id = f.post_id AND p.user_id = f.user_id
         WHERE ${where}`,
      )
      .bind(userId, hash, Date.now())
      .first<{ total: number }>(),
  ])
  const tags = rows.results.length
    ? await db
      .prepare(
        `SELECT pt.post_id, t.name FROM blog_post_tags pt
         JOIN blog_tags t ON t.id = pt.tag_id AND t.user_id = pt.user_id
         WHERE pt.user_id = ?1 AND pt.post_id IN (${rows.results.map((_, index) => `?${index + 2}`).join(', ')})
         ORDER BY pt.position, t.name`,
      )
      .bind(userId, ...rows.results.map((row) => row.id))
      .all<{ post_id: string; name: string }>()
    : { results: [] as { post_id: string; name: string }[] }
  const tagMap = new Map<string, string[]>()
  for (const row of tags.results) {
    const list = tagMap.get(row.post_id) ?? []
    list.push(row.name)
    tagMap.set(row.post_id, list)
  }
  const counts = await likeCounts(db, userId, rows.results.map((row) => row.id))
  return {
    items: rows.results.map((row) => ({
      ...toBlogSummary(row, tagMap.get(row.id) ?? [], counts.get(row.id) ?? 0),
      savedAt: row.saved_at,
    })),
    total: totalRow?.total ?? 0,
  }
}
