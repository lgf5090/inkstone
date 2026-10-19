/**
 * The tasks a turn named, pulled out of what the tools answered.
 *
 * A task tool answers with JSON, and the rows in it are tasks the reader can open. Printing that as
 * text makes them copy a title into a search box; the ids are already in hand, so the row offers the
 * door instead of the address.
 *
 * Only the task tools are read. A note carries an id and a title too, and a chip that opened a note in
 * the to-do app would be a link to nothing — the same reasoning `note-refs` states from the other side.
 */

/** The tools whose payload describes tasks, by name. */
const TASK_TOOLS = new Set([
  'create_task', 'list_tasks', 'get_task', 'update_task', 'complete_task',
  'add_task_step', 'check_task_step', 'list_task_lists',
])

/** The shape every task id in this app has: a 26-character Crockford-ish ULID. */
const TASK_ID = /^[0-9a-hjkmnp-tv-z]{26}$/

const MAX_REFS = 8

export interface TaskRef {
  id: string
  title: string
}

/**
 * The task rows in one payload, in the order the payload named them.
 *
 * A task is recognised by carrying both an id of the right shape and a title; a list row carries a
 * name instead, so a list is never mistaken for a task. A result that is not the JSON this app wrote —
 * a provider's own text, or an error string — yields nothing rather than a guess: a chip is a promise
 * that pressing it opens something.
 */
function collect(value: unknown, out: TaskRef[], seen: Set<string>): void {
  if (out.length >= MAX_REFS) return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, seen)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const id = record.id
  const title = record.title
  if (typeof id === 'string' && TASK_ID.test(id) && typeof title === 'string' && !seen.has(id)) {
    seen.add(id)
    const trimmed = title.trim()
    if (trimmed) out.push({ id, title: trimmed })
  }
  for (const nested of Object.values(record)) collect(nested, out, seen)
}

export function taskRefsFromToolResult(toolName: string, result: string | undefined): TaskRef[] {
  if (!result || !TASK_TOOLS.has(toolName)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return []
  }
  const out: TaskRef[] = []
  collect(parsed, out, new Set())
  return out
}
