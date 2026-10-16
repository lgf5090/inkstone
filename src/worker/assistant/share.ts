/**
 * Publishing one conversation behind an unguessable link.
 *
 * The notes app has published single notes this way for a while, and a shared thread is the same
 * promise: somebody without an account reads exactly what was linked, and nothing else. What is
 * *different* is what travels. A note is one body of text its author meant to be read; a conversation is
 * a transcript whose tool results may quote the reader's private notes and whose reasoning is the model
 * thinking aloud. So the public payload is built from a whitelist of fields rather than by stripping a
 * row, and this module is that whitelist.
 *
 * The passcode hashing, the attempt throttle and the slug format are the notes side's, imported rather
 * than re-implemented: a second copy of a password check is a second place for it to be wrong.
 */

import { LIMITS } from '@shared/constants'
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { AssistantSource, PublicConversation } from '@shared/assistant'
import { isValidSlug, newSlug } from '../lib/id'
import { ApiError } from '../lib/errors'
import { hashPassword, verifyPassword } from '../lib/password'
import { assertAttemptBudget, assertNotLocked, clearLoginFailures, consumeAttemptBudget, recordLoginFailure } from '../lib/throttle'

/** How much of a thread a public link carries: enough for a real conversation, bounded for a page. */
export const MAX_SHARED_MESSAGES = 400

/** One live link for one conversation: re-sharing refreshes the row rather than minting a second one. */
export interface ChatShareRow {
  slug: string
  conversation_id: string
  user_id: string
  password_hash: string | null
  expires_at: number | null
  views: number
  created_at: number
}

export class ChatShareStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The link this account has on one of its conversations, or null. */
  async shareFor(conversationId: string): Promise<ChatShareRow | null> {
    return await this.db
      .prepare(
        `SELECT slug, conversation_id, user_id, password_hash, expires_at, views, created_at
           FROM chat_share_links WHERE user_id = ?1 AND conversation_id = ?2`,
      )
      .bind(this.userId, conversationId)
      .first<ChatShareRow>()
  }

  /**
   * Whether this account has a conversation the reader could share.
   *
   * A temporary conversation is not one: the reader asked for a thread that would not be kept, and a
   * public link is the most kept a conversation can be. Refused here rather than at the route so the
   * public reader and the share button cannot disagree about which threads exist.
   */
  async liveConversationExists(conversationId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS present FROM chat_conversations WHERE user_id = ?1 AND id = ?2 AND ephemeral = 0`)
      .bind(this.userId, conversationId)
      .first<{ present: number }>()
    return Boolean(row)
  }

  /**
   * Creates the link, or refreshes the one already there.
   *
   * The conditional columns are the notes side's rule: a field the request did not name keeps what it
   * had, so re-sharing without a passcode does not silently remove the passcode set last week. The slug
   * is only replaced when the reader asks for a fresh link, because the old address may already be out
   * there and rotating it uninvited would break the link they sent.
   */
  async upsertShare(input: {
    conversationId: string
    passwordHash: string | null
    expiresAt: number | null
    now: number
    replacePassword: boolean
    replaceExpiry: boolean
    rotate: boolean
  }): Promise<boolean> {
    const existing = await this.shareFor(input.conversationId)
    if (!existing) {
      await this.db
        .prepare(
          `INSERT INTO chat_share_links (slug, conversation_id, user_id, password_hash, expires_at, views, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`,
        )
        .bind(newSlug(), input.conversationId, this.userId, input.passwordHash, input.expiresAt, input.now)
        .run()
      return true
    }
    const slug = input.rotate ? newSlug() : existing.slug
    const result = await this.db
      .prepare(
        `UPDATE chat_share_links SET slug = ?3,
           password_hash = CASE WHEN ?4 THEN ?5 ELSE password_hash END,
           expires_at = CASE WHEN ?6 THEN ?7 ELSE expires_at END
         WHERE user_id = ?1 AND conversation_id = ?2`,
      )
      .bind(
        this.userId, input.conversationId, slug,
        input.replacePassword ? 1 : 0, input.passwordHash,
        input.replaceExpiry ? 1 : 0, input.expiresAt,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async deleteShare(conversationId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM chat_share_links WHERE user_id = ?1 AND conversation_id = ?2`)
      .bind(this.userId, conversationId)
      .run()
  }
}

/** A link by its slug, for the public half. Cross-account on purpose: the slug *is* the capability. */
export async function findConversationShare(db: D1Database, slug: string): Promise<ChatShareRow | null> {
  if (!isValidSlug(slug)) return null
  return await db
    .prepare(
      `SELECT slug, conversation_id, user_id, password_hash, expires_at, views, created_at
         FROM chat_share_links WHERE slug = ?1`,
    )
    .bind(slug)
    .first<ChatShareRow>()
}

export async function countConversationShareView(db: D1Database, slug: string): Promise<void> {
  await db.prepare(`UPDATE chat_share_links SET views = views + 1 WHERE slug = ?1`).bind(slug).run()
}

/** What the pre-rendered document may say before anybody types a passcode. */
export interface ConversationShareMeta {
  title: string
  password_hash: string | null
  expires_at: number | null
}

/**
 * The link and its conversation's title in one read, addressed by slug.
 *
 * The shell needs both at once — the title only goes out when the link is live and unguarded — and a
 * route that joined two tables itself would be a route that owns this table's shape.
 */
export async function loadConversationShareMeta(db: D1Database, slug: string): Promise<ConversationShareMeta | null> {
  if (!isValidSlug(slug)) return null
  return await db
    .prepare(
      `SELECT c.title, s.password_hash, s.expires_at
         FROM chat_share_links s JOIN chat_conversations c ON c.user_id = s.user_id AND c.id = s.conversation_id
        WHERE s.slug = ?1`,
    )
    .bind(slug)
    .first<ConversationShareMeta>()
}

/**
 * Who published it, as the two fields a shared page may show.
 *
 * Nothing else about the account is anyone's business, which is why this is a projection of two columns
 * rather than the row — the same pair a shared note prints. Read apart from the transcript, and falling
 * back rather than joining: a link that outlives the account row still has to show the conversation.
 */
export interface ConversationShareAuthor {
  name: string
  avatarUrl: string
}

export async function loadConversationShareAuthor(db: D1Database, userId: string): Promise<ConversationShareAuthor> {
  const row = await db
    .prepare(`SELECT name, avatar_url FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ name: string | null, avatar_url: string | null }>()
  return { name: row?.name?.trim() || 'Inkstone', avatarUrl: row?.avatar_url ?? '' }
}

/**
 * The transcript, with every field that is not for a stranger left out.
 *
 * Reasoning is absent because it is the model thinking aloud rather than the answer; tool rows are absent
 * because their results quote the reader's own notes; attachments are absent because they are the
 * reader's files under a private prefix. What is left is what someone looking over the reader's shoulder
 * would have seen: who spoke, what they said, when, and which model answered.
 */
export async function loadSharedConversation(
  db: D1Database,
  conversationId: string,
  userId: string,
): Promise<{ title: string; createdAt: number; updatedAt: number, messages: PublicConversation['messages'] } | null> {
  const conversation = await db
    .prepare(`SELECT title, created_at, updated_at FROM chat_conversations WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, conversationId)
    .first<{ title: string; created_at: number; updated_at: number }>()
  if (!conversation) return null
  const { results } = await db
    .prepare(
      `SELECT role, content, created_at, model_label, sources
         FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2
        ORDER BY created_at ASC, rowid ASC LIMIT ?3`,
    )
    .bind(userId, conversationId, MAX_SHARED_MESSAGES)
    .all<{ role: string, content: string, created_at: number, model_label: string | null, sources: string | null }>()
  return {
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages: (results ?? []).map((row) => ({
      role: row.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: row.content ?? '',
      createdAt: row.created_at,
      modelLabel: row.model_label ?? '',
      ...(row.sources ? { sources: parseSharedSources(row.sources) } : {}),
    })),
  }
}

function parseSharedSources(value: string): AssistantSource[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is { url: string, title?: string, cited?: string } =>
        Boolean(entry) && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string')
      .map((entry) => ({
        url: entry.url,
        title: typeof entry.title === 'string' && entry.title ? entry.title : entry.url,
        ...(typeof entry.cited === 'string' && entry.cited ? { cited: entry.cited } : {}),
      }))
      .slice(0, 20)
  } catch {
    return []
  }
}

/**
 * The passcode gate of the public read, mirroring the notes side.
 *
 * Two throttles rather than one: per visitor per link, and per link overall, so a single hostile client
 * cannot spend the whole link's budget guessing and lock the reader out of their own share.
 */
export async function assertConversationShareAccess(
  db: D1Database,
  slug: string,
  ip: string,
  row: ChatShareRow,
  password: string,
): Promise<void> {
  if (!row.password_hash) return
  if (!password) throw ApiError.unauthenticated('An access password is required')
  const lockTargets = [`chat-share:${slug}:ip:${ip}`]
  const workTargets = [
    { key: `chat-share-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
    { key: `chat-share-work:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
  ]
  await assertAttemptBudget(async () => {
    await assertNotLocked(db, lockTargets)
    await consumeAttemptBudget(db, workTargets)
  })
  if (!(await verifyPassword(password, row.password_hash))) {
    await recordLoginFailure(db, lockTargets)
    throw new ApiError(401, 'invalid_credentials', 'Incorrect passcode')
  }
  await clearLoginFailures(db, [...lockTargets, ...workTargets.map((target) => target.key)])
}

/** Hashes a passcode the reader set, after checking it against the shared rules. `named` is the route's
 *  "the request actually mentioned this field" test, which is what keeps an untouched one. */
export async function conversationSharePasswordHash(password: unknown): Promise<{ hash: string | null, named: boolean }> {
  if (password === undefined) return { hash: null, named: false }
  if (password !== null && typeof password !== 'string') throw ApiError.badRequest('password must be a string or null')
  const problem = sharePasscodeProblem(password as string | null)
  if (problem) throw ApiError.badRequest(problem)
  if (password === null || password === '') return { hash: null, named: true }
  return { hash: await hashPassword((password as string).slice(0, LIMITS.passwordMaxLength)), named: true }
}
