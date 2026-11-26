import { Hono, type Context } from 'hono'
import { parentPathOf } from '@shared/clouddrive/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { readJson } from '../lib/request'
import type { CloudDriveFileRow } from './lib'
import { assertMetaAccess } from './routes-meta'
import { aclFileForRole } from './acl-access'

export const clouddriveCommentRoutes = new Hono<AppBindings>()

clouddriveCommentRoutes.use('*', async (c, next) => {
  if (!c.get('userId')) throw ApiError.unauthenticated()
  await next()
})

const COMMENT_BODY_LIMIT = 64 * 1024
const COMMENT_MAX_LENGTH = 4000
const COMMENT_MAX_BYTES = 16 * 1024
const COMMENT_LIST_LIMIT = 200
const COMMENT_MENTIONS_MAX = 20
const MENTION_PATTERN = /(^|[^\p{L}\p{N}_@/.-])@([a-z0-9][a-z0-9_-]{2,31})(?![\p{L}\p{N}_-])/giu
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

interface CommentMention {
  userId: string
  username: string
  name: string
}

interface CommentRow {
  id: string
  owner_id: string
  file_id: string
  author_id: string
  body: string
  mentions: string
  created_at: number
  author_username: string | null
  author_name: string | null
  author_avatar_url: string | null
}

interface CommentUserRow {
  id: string
  username: string
  name: string
  avatar_url: string
}

function userIdOf(c: Context<AppBindings>): string {
  return c.get('userId')
}

function ownerIdOf(c: Context<AppBindings>): string {
  const requested = c.req.query('ownerId')
  if (!requested) return userIdOf(c)
  if (!isValidId(requested)) throw ApiError.badRequest('ownerId is invalid')
  return requested
}

/**
 * Comments belong to the owner's file row, not merely to a globally guessed id. A non-owner must have
 * an active grant on the file or one of its ancestor folders; the folder password remains an access
 * boundary for both listing and writing.
 */
async function visibleFile(c: Context<AppBindings>, ownerId: string, fileId: string): Promise<CloudDriveFileRow> {
  if (!isValidId(fileId)) throw ApiError.notFound('File not found')
  const file = await c.env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
  ).bind(ownerId, fileId).first<CloudDriveFileRow>()
  if (!file) throw ApiError.notFound('File not found')

  const viewerId = userIdOf(c)
  if (viewerId !== ownerId) await aclFileForRole(c, ownerId, file.id, viewerId, 'viewer')

  await assertMetaAccess(c, ownerId, file.mount_id, file.kind === 'folder' ? file.path : parentPathOf(file.path))
  return file
}

function parseMentions(value: string, commentId: string): CommentMention[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): CommentMention[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const mention = item as Record<string, unknown>
      if (typeof mention.userId !== 'string' || typeof mention.username !== 'string') return []
      return [{
        userId: mention.userId,
        username: mention.username,
        name: typeof mention.name === 'string' ? mention.name : '',
      }]
    })
  } catch (error) {
    console.warn('[clouddrive] stored comment mentions are invalid:', commentId, error)
    return []
  }
}

function commentView(row: CommentRow, viewerId: string) {
  return {
    id: row.id,
    fileId: row.file_id,
    body: row.body,
    author: {
      id: row.author_id,
      username: row.author_username ?? row.author_id,
      name: row.author_name ?? '',
      avatarUrl: row.author_avatar_url ?? '',
    },
    mentions: parseMentions(row.mentions, row.id),
    createdAt: row.created_at,
    canDelete: row.author_id === viewerId || row.owner_id === viewerId,
  }
}

function mentionedUsernames(body: string): string[] {
  const names = new Set<string>()
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const username = match[2]?.toLowerCase()
    if (username) names.add(username)
  }
  return [...names]
}

async function resolveMentions(c: Context<AppBindings>, body: string, authorId: string): Promise<CommentMention[]> {
  const usernames = mentionedUsernames(body)
  if (usernames.length > COMMENT_MENTIONS_MAX) {
    throw ApiError.badRequest(`A comment can mention at most ${COMMENT_MENTIONS_MAX} accounts`)
  }
  if (usernames.length === 0) return []
  const placeholders = usernames.map(() => '?').join(', ')
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, name FROM users WHERE lower(username) IN (${placeholders})`,
  ).bind(...usernames).all<{ id: string; username: string; name: string }>()
  const byUsername = new Map((results ?? []).map((row) => [row.username.toLowerCase(), row]))
  return usernames.flatMap((username): CommentMention[] => {
    const row = byUsername.get(username)
    return row && row.id !== authorId ? [{ userId: row.id, username: row.username, name: row.name }] : []
  })
}

async function commentById(c: Context<AppBindings>, ownerId: string, fileId: string, commentId: string): Promise<CommentRow> {
  if (!isValidId(commentId)) throw ApiError.notFound('Comment not found')
  const row = await c.env.DB.prepare(
    `SELECT c.*, u.username AS author_username, u.name AS author_name, u.avatar_url AS author_avatar_url
       FROM CloudDrive_file_comments c
       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.owner_id = ? AND c.file_id = ? AND c.id = ?`,
  ).bind(ownerId, fileId, commentId).first<CommentRow>()
  if (!row) throw ApiError.notFound('Comment not found')
  return row
}

clouddriveCommentRoutes.get('/files/:id/comments', async (c) => {
  const ownerId = ownerIdOf(c)
  const file = await visibleFile(c, ownerId, c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, u.username AS author_username, u.name AS author_name, u.avatar_url AS author_avatar_url
       FROM CloudDrive_file_comments c
       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.owner_id = ? AND c.file_id = ?
      ORDER BY c.created_at, c.id LIMIT ?`,
  ).bind(ownerId, file.id, COMMENT_LIST_LIMIT).all<CommentRow>()
  return c.json({ comments: (results ?? []).map((row) => commentView(row, userIdOf(c))) })
})

clouddriveCommentRoutes.post('/files/:id/comments', async (c) => {
  const ownerId = ownerIdOf(c)
  if (ownerId !== userIdOf(c)) await aclFileForRole(c, ownerId, c.req.param('id'), userIdOf(c), 'commenter')
  const file = await visibleFile(c, ownerId, c.req.param('id'))
  const body = await readJson<{ body?: unknown }>(c, COMMENT_BODY_LIMIT)
  if (typeof body.body !== 'string') throw ApiError.badRequest('A comment body is required')
  const text = body.body.normalize('NFC').trim()
  if (!text) throw ApiError.badRequest('A comment cannot be empty')
  if (text.length > COMMENT_MAX_LENGTH) throw ApiError.badRequest(`A comment can contain at most ${COMMENT_MAX_LENGTH} characters`)
  if (CONTROL_CHARACTERS.test(text) || new TextEncoder().encode(text).byteLength > COMMENT_MAX_BYTES) {
    throw ApiError.badRequest('The comment contains invalid characters or is too large')
  }

  const author = c.get('user')
  const mentions = await resolveMentions(c, text, author.id)
  const comment: CommentRow = {
    id: newId(),
    owner_id: ownerId,
    file_id: file.id,
    author_id: author.id,
    body: text,
    mentions: JSON.stringify(mentions),
    created_at: Date.now(),
    author_username: author.username,
    author_name: author.name,
    author_avatar_url: author.avatarUrl,
  }
  await c.env.DB.prepare(
    `INSERT INTO CloudDrive_file_comments
       (id, owner_id, file_id, author_id, body, mentions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(comment.id, ownerId, file.id, author.id, text, comment.mentions, comment.created_at).run()

  // Delivery is deliberately data-only for now: a later notifier can consume these stable, deduplicated
  // records without exposing the comment body to a recipient who cannot open the file.
  const notifications = mentions.map((mention) => ({
    id: `${comment.id}:${mention.userId}`,
    type: 'clouddrive_comment_mention' as const,
    recipientId: mention.userId,
    commentId: comment.id,
    ownerId,
    fileId: file.id,
    createdAt: comment.created_at,
  }))
  return c.json({ comment: commentView(comment, author.id), notifications }, 201)
})

clouddriveCommentRoutes.delete('/files/:id/comments/:commentId', async (c) => {
  const ownerId = ownerIdOf(c)
  const file = await visibleFile(c, ownerId, c.req.param('id'))
  const comment = await commentById(c, ownerId, file.id, c.req.param('commentId'))
  if (comment.author_id !== userIdOf(c) && ownerId !== userIdOf(c)) {
    throw ApiError.forbidden('Only the comment author or file owner can delete this comment')
  }
  await c.env.DB.prepare(
    `DELETE FROM CloudDrive_file_comments WHERE owner_id = ? AND file_id = ? AND id = ?`,
  ).bind(ownerId, file.id, comment.id).run()
  return c.json({ ok: true })
})

/** Suggestions are limited to people who can already open this file, avoiding account enumeration. */
clouddriveCommentRoutes.get('/files/:id/comments/people', async (c) => {
  const ownerId = ownerIdOf(c)
  const file = await visibleFile(c, ownerId, c.req.param('id'))
  const query = (c.req.query('q') ?? '').trim().replace(/^@/, '').toLowerCase()
  if (query.length > 32) throw ApiError.badRequest('The username query is too long')

  const [owner, grants] = await Promise.all([
    c.env.DB.prepare(`SELECT id, username, name, avatar_url FROM users WHERE id = ?`)
      .bind(ownerId).first<CommentUserRow>(),
    c.env.DB.prepare(
      `SELECT u.id, u.username, u.name, u.avatar_url
         FROM CloudDrive_acl a
         JOIN CloudDrive_files f ON f.user_id = a.owner_id AND f.id = a.file_id
         JOIN users u ON u.id = a.grantee_id
        WHERE a.owner_id = ?1 AND a.revoked_at IS NULL AND a.grantee_id <> ?2
          AND (a.expires_at IS NULL OR a.expires_at > ?6)
          AND f.deleted_at IS NULL AND f.mount_id = ?5
          AND (f.id = ?3 OR (f.kind = 'folder'
            AND (f.path = ?4 OR (f.path <> '/' AND substr(?4, 1, length(f.path) + 1) = f.path || '/'))))
        ORDER BY u.username LIMIT 100`,
    ).bind(ownerId, userIdOf(c), file.id, file.path, file.mount_id, Date.now()).all<CommentUserRow>(),
  ])
  const people = new Map<string, CommentUserRow>()
  if (owner) people.set(owner.id, owner)
  for (const person of grants.results ?? []) people.set(person.id, person)
  return c.json({
    users: [...people.values()]
      .filter((person) => !query || person.username.toLowerCase().includes(query))
      .sort((left, right) => left.username.localeCompare(right.username))
      .slice(0, COMMENT_MENTIONS_MAX)
      .map((person) => ({ id: person.id, username: person.username, name: person.name, avatarUrl: person.avatar_url })),
  })
})
