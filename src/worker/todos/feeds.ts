/**
 * The reads a published to-do feed needs, kept in the module that owns the `todos_*` tables.
 *
 * A route must not write SQL — `tests/worker-layering.test.ts` counts every `.prepare(` under
 * `src/worker/routes/` and fails on a non-zero total, and the reason is not style: nine routes once
 * carried their own queries, and the fix showed the other direction too, with a store importing a
 * route's helper. So the feed's two reads live here, next to the schema that declares their columns.
 *
 * Both are narrower than anything the account's own app asks for. A feed is the owner's text reaching a
 * third-party calendar, so `loadFeedTasks` names the columns a calendar may see and never reads
 * `note_id`, `conversation_id`, or a passcode hash; `findFeed` returns only what a public request may
 * be judged by — who owns the feed, whether it still lives, and what guards it.
 */
import { MAX_TASKS_PER_QUERY, parseRepeatRule } from '@shared/todos/model'
import type { IcsTask } from './ics'

export type FeedRow = {
  user_id: string
  password_hash: string | null
  expires_at: number | null
  revoked_at: number | null
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

/** What the calendar may show: open tasks with a due date up to the horizon, oldest first. */
export async function loadFeedTasks(db: D1Database, userId: string, horizonEnd: number): Promise<IcsTask[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, description, priority, due_at, repeat_rule
         FROM todos_tasks
        WHERE user_id = ?1 AND status != 'done' AND due_at IS NOT NULL AND due_at <= ?2
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
