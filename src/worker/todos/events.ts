/**
 * A task's own history, as the panel reads it back.
 *
 * The rows are written by `AssistantStore` in the same batch as the status change that caused them, so
 * what this module returns is the account's record rather than a second account of it. It reads them
 * for one task at a time and newest first: the panel opens on a task the reader is looking at, and the
 * question it answers is "what happened to this one", not "what happened lately".
 *
 * It lives beside `stats.ts` rather than inside `routes/todos.ts` for the reason that file does — the
 * route layer holds no SQL, and `tests/worker-layering.test.ts` counts every `.prepare(` under it.
 */
import type { TaskEvent, TaskStatus } from '@shared/todos/model'

/** How many rows one task's panel asks for: a task edited more than fifty times shows its latest fifty. */
export const TASK_EVENT_PAGE = 50

type EventRow = {
  id: string
  kind: string
  from_status: string | null
  to_status: string
  at: number
}

/**
 * The newest events of one task.
 *
 * `at` descending with `id` as the tie-break, because two events written in the same millisecond (a
 * birth and an immediate move) would otherwise come back in whatever order the planner chose, and a
 * history read out of order is a history that says the task was completed before it existed.
 */
export async function listTaskEvents(
  db: D1Database,
  userId: string,
  taskId: string,
  limit = TASK_EVENT_PAGE,
): Promise<TaskEvent[]> {
  const rows = await db.prepare(
    `SELECT id, kind, from_status, to_status, at
       FROM todos_task_events
      WHERE user_id = ?1 AND task_id = ?2
      ORDER BY at DESC, id DESC
      LIMIT ?3`,
  ).bind(userId, taskId, limit).all<EventRow>()
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind === 'born' ? 'born' : 'status',
    fromStatus: row.from_status === null ? null : (row.from_status as TaskStatus),
    toStatus: row.to_status as TaskStatus,
    at: row.at,
  }))
}
