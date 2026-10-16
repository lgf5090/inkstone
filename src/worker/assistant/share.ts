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
import { isValidId, isValidSlug, newSlug } from '../lib/id'
import { ApiError } from '../lib/errors'
import { hashPassword, verifyPassword } from '../lib/password'
import { assertAttemptBudget, assertNotLocked, clearLoginFailures, consumeAttemptBudget, recordLoginFailure } from '../lib/throttle'

/** How much of a thread a public link carries: enough for a real conversation, bounded for a page. */
export const MAX_SHARED_MESSAGES = 400

/**
 * How many turns one reader may pick for a single link.
 *
 * A bound rather than a preference: the picked ids are the link's key and the filter its read runs, and
 * both are happier small. Fifty exchanges is already more than anybody reads in a link they were sent.
 */
export const MAX_SHARED_PICK = 50

/** The scope of a link that publishes the whole thread, which is what a link without a scope means. */
export const WHOLE_THREAD = ''

/**
 * A selection, written down in one canonical form.
 *
 * Sorted and de-duplicated so that the same set of turns is the same link however it was ticked, and
 * joined into a string because that string is part of the row's key. The ids are validated before they
 * get here, and validated again when the string is read back, because a key built out of text is a key
 * that has to be safe to put in a query.
 */
export function messageScope(ids: readonly string[]): string {
  return [...new Set(ids.filter(isValidId))].sort().join(',')
}

/** The turns a scope names. An unreadable or unknown id is dropped rather than passed on. */
export function scopeMessageIds(scope: string): string[] {
  if (!scope) return []
  return scope.split(',').filter(isValidId).slice(0, MAX_SHARED_PICK)
}

/** One live link for one conversation and one scope: re-sharing refreshes the row rather than minting a
 *  second one. */
export interface ChatShareRow {
  slug: string
  conversation_id: string
  user_id: string
  scope: string
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

  /** The link this account has on one conversation under one scope, or null. */
  async shareFor(conversationId: string, scope: string = WHOLE_THREAD): Promise<ChatShareRow | null> {
    return await this.db
      .prepare(
        `SELECT slug, conversation_id, user_id, scope, password_hash, expires_at, views, created_at
           FROM chat_share_links WHERE user_id = ?1 AND conversation_id = ?2 AND scope = ?3`,
      )
      .bind(this.userId, conversationId, scope)
      .first<ChatShareRow>()
  }

  /**
   * Which of the picked turns are really in this conversation.
   *
   * Asked before a link is written, because the scope becomes part of the row's key and a link that named
   * a turn from somewhere else would be a link whose read returns nothing — a broken page rather than a
   * refusal, and one nobody would think to look for in the key.
   */
  async messagesInConversation(conversationId: string, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return []
    const placeholders = ids.map((_, index) => `?${index + 3}`).join(', ')
    const { results } = await this.db
      .prepare(
        `SELECT id FROM chat_messages
          WHERE user_id = ?1 AND conversation_id = ?2 AND id IN (${placeholders})`,
      )
      .bind(this.userId, conversationId, ...ids)
      .all<{ id: string }>()
    return (results ?? []).map((row) => row.id)
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
    scope: string
    passwordHash: string | null
    expiresAt: number | null
    now: number
    replacePassword: boolean
    replaceExpiry: boolean
    rotate: boolean
  }): Promise<boolean> {
    const existing = await this.shareFor(input.conversationId, input.scope)
    if (!existing) {
      await this.db
        .prepare(
          `INSERT INTO chat_share_links (slug, conversation_id, user_id, scope, password_hash, expires_at, views, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`,
        )
        .bind(newSlug(), input.conversationId, this.userId, input.scope, input.passwordHash, input.expiresAt, input.now)
        .run()
      return true
    }
    const slug = input.rotate ? newSlug() : existing.slug
    const result = await this.db
      .prepare(
        `UPDATE chat_share_links SET slug = ?4,
           password_hash = CASE WHEN ?5 THEN ?6 ELSE password_hash END,
           expires_at = CASE WHEN ?7 THEN ?8 ELSE expires_at END
         WHERE user_id = ?1 AND conversation_id = ?2 AND scope = ?3`,
      )
      .bind(
        this.userId, input.conversationId, input.scope, slug,
        input.replacePassword ? 1 : 0, input.passwordHash,
        input.replaceExpiry ? 1 : 0, input.expiresAt,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }

  async deleteShare(conversationId: string, scope: string = WHOLE_THREAD): Promise<void> {
    await this.db
      .prepare(`DELETE FROM chat_share_links WHERE user_id = ?1 AND conversation_id = ?2 AND scope = ?3`)
      .bind(this.userId, conversationId, scope)
      .run()
  }
}

/** A link by its slug, for the public half. Cross-account on purpose: the slug *is* the capability. */
export async function findConversationShare(db: D1Database, slug: string): Promise<ChatShareRow | null> {
  if (!isValidSlug(slug)) return null
  return await db
    .prepare(
      `SELECT slug, conversation_id, user_id, scope, password_hash, expires_at, views, created_at
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
  scope: string = WHOLE_THREAD,
): Promise<{ title: string; createdAt: number; updatedAt: number, messages: PublicConversation['messages'] } | null> {
  const conversation = await db
    .prepare(`SELECT title, created_at, updated_at FROM chat_conversations WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, conversationId)
    .first<{ title: string; created_at: number; updated_at: number }>()
  if (!conversation) return null
  // A scoped link carries the exchanges it names and nothing around them: the reader picked those turns
  // and the rest of the thread is not what they handed over. The ids are the link's own key, already
  // checked against this conversation when it was made.
  const picked = scopeMessageIds(scope)
  const onlyPicked = picked.length ? `AND id IN (${picked.map((_, index) => `?${index + 4}`).join(', ')})` : ''
  const { results } = await db
    .prepare(
      `SELECT role, content, created_at, model_label, sources
         FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2 ${onlyPicked}
        ORDER BY created_at ASC, rowid ASC LIMIT ?3`,
    )
    .bind(userId, conversationId, MAX_SHARED_MESSAGES, ...picked)
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
