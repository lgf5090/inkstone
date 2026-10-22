/**
 * The reads and writes a published to-do feed needs, kept in the module that owns the `todos_*`
 * tables.
 *
 * A route must not write SQL — `tests/worker-layering.test.ts` counts every `.prepare(` under
 * `src/worker/routes/` and fails on a non-zero total, and the reason is not style: nine routes once
 * carried their own queries, and the fix showed the other direction too, with a store importing a
 * route's helper. So the feed's reads and writes live here, next to the schema that declares their
 * columns.
 *
 * The public reads are narrower than anything the account's own app asks for. A feed is the owner's
 * text reaching a third-party calendar, so `loadFeedTasks` names the columns a calendar may see and
 * never reads `note_id`, `conversation_id`, or a passcode hash; `findFeed` returns only what a public
 * request may be judged by — who owns the feed, whether it still lives, and what guards it. The
 * owner's listing goes one step further and never selects the hash at all, only whether there is one.
 */
import { MAX_TASKS_PER_QUERY, parseRepeatRule } from '@shared/todos/model'
import { TASK_VISIBLE_PREDICATE } from '../assistant/store'
import type { IcsTask } from './ics'

export type FeedRow = {
  user_id: string
  password_hash: string | null
  expires_at: number | null
  revoked_at: number | null
}

/** One feed as the owner's list may see it: the address and its guards, never the passcode hash. */
export type OwnFeedRow = {
  slug: string
  /** `1` when a passcode is stored, `0` otherwise — the column's presence is all a screen needs. */
  has_password: number
  expires_at: number | null
  created_at: number
}

export type NewFeed = {
  slug: string
  userId: string
  /** Already hashed by the caller; this module never sees a plaintext passcode. */
  passwordHash: string | null
  expiresAt: number | null
  now: number
}

type TaskRow = {
  id: string
  title: string
  description: string
  priority: string
  due_at: number
  repeat_rule: string | null
}

/** The feed a published slug names, whether or not it is still alive — the caller decides what a dead one says. */
export async function findFeed(db: D1Database, slug: string): Promise<FeedRow | null> {
  return (
    (await db
      .prepare(
        `SELECT user_id, password_hash, expires_at, revoked_at FROM todos_feeds WHERE slug = ?1`,
      )
      .bind(slug)
      .first<FeedRow>()) ?? null
  )
}

/**
 * Publish one feed under a freshly minted slug.
 *
 * A plain insert rather than an upsert over `(user_id, slug)`: every mint is a new address, and the
 * random slug is the primary key's other half, so there is no earlier row this write could mean to
 * replace. A collision is left to the unique index and fails loudly instead of silently rotating the
 * address the caller is about to copy.
 */
export async function insertFeed(db: D1Database, feed: NewFeed): Promise<void> {
  await db
    .prepare(
      `INSERT INTO todos_feeds (slug, user_id, password_hash, expires_at, revoked_at, created_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
    )
    .bind(feed.slug, feed.userId, feed.passwordHash, feed.expiresAt, feed.now)
    .run()
}

/** The feeds an account can still manage, newest first; revoked rows stay in the table but leave this list. */
export async function listFeeds(db: D1Database, userId: string): Promise<OwnFeedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT slug, (password_hash IS NOT NULL) AS has_password, expires_at, created_at
         FROM todos_feeds
        WHERE user_id = ?1 AND revoked_at IS NULL
        ORDER BY created_at DESC, slug DESC`,
    )
    .bind(userId)
    .all<OwnFeedRow>()
  return results ?? []
}

/**
 * Soft-revoke one of the account's feeds.
 *
 * An update rather than a delete, so the address is never minted again and a stale calendar keeps
 * getting the same 404 it would for an address that never existed. The account is part of the
 * predicate, so another account's slug changes nothing and the caller sees a 404 like any other id.
 * `false` means no live row matched — already revoked, never existed, or not this account's.
 */
export async function revokeFeed(
  db: D1Database,
  userId: string,
  slug: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE todos_feeds SET revoked_at = ?3
        WHERE user_id = ?1 AND slug = ?2 AND revoked_at IS NULL`,
    )
    .bind(userId, slug, now)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

/**
 * What the calendar may show: open tasks with a due date up to the horizon, oldest first.
 *
 * The same visibility rule the app's own listings open with, so a list put away on the reader's side
 * is gone from the address a third-party calendar polls on its next fetch as well — a shelf the reader
 * cannot see past is not a shelf their calendar should see past.
 */
export async function loadFeedTasks(db: D1Database, userId: string, horizonEnd: number): Promise<IcsTask[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, description, priority, due_at, repeat_rule
         FROM todos_tasks
        WHERE user_id = ?1 AND status != 'done' AND ${TASK_VISIBLE_PREDICATE}
          AND due_at IS NOT NULL AND due_at <= ?2
        ORDER BY due_at ASC, id ASC
        LIMIT ?3`,
    )
    .bind(userId, horizonEnd, MAX_TASKS_PER_QUERY)
    .all<TaskRow>()
  return (results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    priority: toPriority(row.priority),
    dueAt: Number(row.due_at),
    repeat: parseRepeatRule(parseStoredRepeat(row.repeat_rule)),
  }))
}

function toPriority(value: string): IcsTask['priority'] {
  return value === 'low' || value === 'high' || value === 'urgent' ? value : 'medium'
}

/** A stored `repeat_rule` is JSON text; a malformed one simply means "does not repeat", never a 500. */
function parseStoredRepeat(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
