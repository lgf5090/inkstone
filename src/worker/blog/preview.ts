import type { BlogPreviewDetail, BlogPreviewToken } from '@shared/blog/model'
import { sha256Hex } from '../lib/encoding'
import { listPostTags } from './store'

/** A preview link is valid for one hour; the owner can mint another when it runs out. */
export const BLOG_PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000
/** Expired and revoked rows stay readable in the admin for this long, then the next mint clears them. */
const PREVIEW_TOKEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface CreatedPreviewToken {
  token: string
  hash: string
  createdAt: number
  expiresAt: number
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Mints a preview link for one post.
 *
 * Only the SHA-256 of the token is stored: a database read cannot turn a row back into a working
 * link, and the plain token is handed to the owner once, at creation. The row is bound to the
 * owner and the post, so a token minted for one article cannot be replayed against another.
 */
export async function createBlogPreviewToken(
  db: D1Database,
  userId: string,
  postId: string,
  now = Date.now(),
): Promise<CreatedPreviewToken> {
  const token = randomToken()
  const hash = await sha256Hex(token)
  const expiresAt = now + BLOG_PREVIEW_TOKEN_TTL_MS
  await db
    .prepare(`DELETE FROM blog_preview_tokens WHERE user_id = ?1 AND expires_at < ?2`)
    .bind(userId, now - PREVIEW_TOKEN_KEEP_MS)
    .run()
  await db
    .prepare(
      `INSERT INTO blog_preview_tokens (token_hash, user_id, post_id, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(hash, userId, postId, expiresAt, now)
    .run()
  return { token, hash, createdAt: now, expiresAt }
}

export async function listBlogPreviewTokens(
  db: D1Database,
  userId: string,
  postId: string,
  now = Date.now(),
): Promise<BlogPreviewToken[]> {
  const { results } = await db
    .prepare(
      `SELECT token_hash, post_id, created_at, expires_at, used_at, revoked_at
       FROM blog_preview_tokens
       WHERE user_id = ?1 AND post_id = ?2
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .bind(userId, postId)
    .all<{
      token_hash: string
      post_id: string
      created_at: number
      expires_at: number
      used_at: number | null
      revoked_at: number | null
    }>()
  return results.map((row) => ({
    hash: row.token_hash,
    postId: row.post_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    status: row.revoked_at !== null
      ? 'revoked'
      : row.expires_at <= now
        ? 'expired'
        : row.used_at !== null
          ? 'used'
          : 'active',
  }))
}

export async function revokeBlogPreviewToken(
  db: D1Database,
  userId: string,
  postId: string,
  hash: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE blog_preview_tokens SET revoked_at = ?4
       WHERE user_id = ?1 AND post_id = ?2 AND token_hash = ?3 AND revoked_at IS NULL`,
    )
    .bind(userId, postId, hash, now)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Reads a draft through its preview token.
 *
 * The token is the only credential, so every failure answer is `null` and the route turns it into
 * the same 404: whether the link never existed, expired, was revoked or belongs to another owner
 * must not be distinguishable from outside. A successful read stamps `used_at` so the admin can see
 * the link was opened.
 */
export async function readBlogPreview(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<BlogPreviewDetail | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const hash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT t.user_id, t.expires_at, t.revoked_at, p.id, p.slug, p.title, p.excerpt, p.description,
              p.cover_asset_id, p.encrypted, p.published_at, p.updated_at, p.word_count, p.reading_minutes,
              c.name AS category_name, s.title AS series_title, n.content
       FROM blog_preview_tokens t
       JOIN blog_posts p ON p.id = t.post_id AND p.user_id = t.user_id
       LEFT JOIN notes n ON n.id = p.note_id AND n.user_id = p.user_id
       LEFT JOIN blog_categories c ON c.id = p.category_id AND c.user_id = p.user_id
       LEFT JOIN blog_series s ON s.id = p.series_id AND s.user_id = p.user_id
       WHERE t.token_hash = ?1`,
    )
    .bind(hash)
    .first<{
      user_id: string
      expires_at: number
      revoked_at: number | null
      id: string
      slug: string
      title: string
      excerpt: string
      description: string
      cover_asset_id: string | null
      encrypted: number
      published_at: number | null
      updated_at: number
      word_count: number
      reading_minutes: number
      category_name: string | null
      series_title: string | null
      content: string | null
    }>()
  if (!row || row.revoked_at !== null || row.expires_at <= now || row.content === null) return null
  const tags = await listPostTags(db, row.user_id, [row.id])
  await db
    .prepare(`UPDATE blog_preview_tokens SET used_at = COALESCE(used_at, ?3) WHERE user_id = ?1 AND token_hash = ?2`)
    .bind(row.user_id, hash, now)
    .run()
  return {
    preview: true,
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.encrypted === 1 ? '' : row.excerpt,
    description: row.encrypted === 1 ? '' : row.description,
    coverUrl: row.cover_asset_id ? `/api/blog/assets/${row.cover_asset_id}` : null,
    category: row.category_name,
    series: row.series_title,
    tags: tags.get(row.id) ?? [],
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    wordCount: row.word_count,
    readingMinutes: row.reading_minutes,
    encrypted: row.encrypted === 1,
    content: row.content,
  }
}
