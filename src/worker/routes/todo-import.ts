/**
 * `POST /api/todos/import` — the CSV door into the task list.
 *
 * Kept in its own router and mounted before `/api/todos`, because Hono matches in registration order
 * and the task router already owns `/:id`: a request for `import` must be a route, never a task id.
 * Everything the importer writes goes through `AssistantStore`, so the account scoping and the task
 * rules are the same ones the app and the assistant use; this file only adapts multipart, checks the
 * ceilings and decides what `conflict` means.
 *
 * The file is small enough to read whole (2 MiB, 5000 rows), and a row that cannot be read is answered
 * in `errors` while the rest of the file still lands. The one question a CSV cannot answer on its own
 * is identity, so a row is "the same task" as an existing one when its title (case-insensitive) and
 * due instant match: `skip` leaves the existing task, `newer` makes the file the source of truth, and
 * `duplicate` always inserts a fresh row. Re-importing the same file therefore settles instead of
 * growing the list, except under `duplicate`, which is what that word is for.
 */

import { Hono } from 'hono'
import { MAX_TASKS_PER_QUERY, type TodoTask } from '@shared/todos/model'
import { AssistantStore, type NewTask } from '../assistant/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readFormDataWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  MAX_TODO_CSV_BYTES,
  MAX_TODO_CSV_ROWS,
  TodoCsvError,
  parseTodoCsv,
  type TodoCsvRow,
} from '../todos/import-csv'

/** How many imports one account may start in a minute; each call spends one. */
export const IMPORT_BUDGET_PER_MINUTE = 30

/** The multipart envelope around a file at the ceiling, with room for a boundary and the fields. */
const FORM_BYTES = MAX_TODO_CSV_BYTES + 1024 * 1024

/** How many existing tasks one import reads before deciding a row is already here. */
const MATCH_SCAN_TASKS = 10 * MAX_TASKS_PER_QUERY

const takeBudget = createMinuteBudget(
  IMPORT_BUDGET_PER_MINUTE,
  'Too many imports at once. Try again in a minute.',
)

type ImportConflict = 'skip' | 'newer' | 'duplicate'

const CONFLICTS: readonly ImportConflict[] = ['skip', 'newer', 'duplicate']

/** The same words, default and refusal as `/api/import`, so one client setting keeps one meaning. */
function importConflict(value: unknown): ImportConflict {
  if (value === null || value === '') return 'newer'
  if (typeof value === 'string' && (CONFLICTS as readonly string[]).includes(value)) {
    return value as ImportConflict
  }
  throw ApiError.badRequest('conflict must be skip, newer, or duplicate')
}

interface ListResolution {
  id: string | null
  /** The row named a list this account does not have. It is imported without one, never created. */
  missing: boolean
}

async function resolveList(
  store: AssistantStore,
  cache: Map<string, string | null>,
  name: string | null,
): Promise<ListResolution> {
  if (!name) return { id: null, missing: false }
  const key = name.toLocaleLowerCase()
  if (!cache.has(key)) cache.set(key, (await store.findTaskListByName(name))?.id ?? null)
  const id = cache.get(key) ?? null
  return { id, missing: id === null }
}

/** A row's identity across imports: the title the reader will recognise and the instant it is due. */
function taskKey(title: string, dueAt: number | null): string {
  return `${title.trim().toLocaleLowerCase()}\u0000${dueAt ?? ''}`
}

/**
 * Every task this account already holds, by the identity a CSV row can state.
 *
 * One page at a time because a listing is capped, and a bounded number of pages because the point is
 * to recognise rows from a file of at most 5000, not to mirror a vault of any size. A task beyond the
 * scan is simply not matched — the import creates a row rather than guessing.
 */
async function loadExistingTasks(store: AssistantStore): Promise<Map<string, TodoTask>> {
  const byKey = new Map<string, TodoTask>()
  for (let offset = 0; offset < MATCH_SCAN_TASKS; offset += MAX_TASKS_PER_QUERY) {
    const page = await store.listTasks({
      status: 'all',
      sort: 'created',
      limit: MAX_TASKS_PER_QUERY,
      offset,
    })
    for (const task of page) byKey.set(taskKey(task.title, task.dueAt), task)
    if (page.length < MAX_TASKS_PER_QUERY) break
  }
  return byKey
}

function sameImportedFields(
  task: TodoTask,
  row: TodoCsvRow,
  listId: string | null,
  missingList: boolean,
): boolean {
  if (task.title !== row.title || task.description !== row.notes) return false
  if (task.dueAt !== row.dueAt || task.priority !== row.priority) return false
  // A list the file names but this account does not have says nothing about the task's current one.
  if (!missingList && task.listId !== listId) return false
  if (row.completed !== null && (task.status === 'done') !== row.completed) return false
  const current = task.tags.map((tag) => tag.name.toLocaleLowerCase()).sort()
  const wanted = row.tags.map((name) => name.toLocaleLowerCase()).sort()
  return current.length === wanted.length && current.every((name, index) => name === wanted[index])
}

export const todoImportRoutes = new Hono<AppBindings>()

todoImportRoutes.use('*', requireAuth)
todoImportRoutes.use('*', async (c, next) => {
  takeBudget(c.get('userId'))
  await next()
})

todoImportRoutes.post('/', async (c) => {
  const form = await readFormDataWithinLimit(c.req, FORM_BYTES)
  const conflict = importConflict(form.get('conflict'))
  const files = form.getAll('file').filter((entry): entry is File => entry instanceof File)
  if (files.length !== 1) throw ApiError.badRequest('Attach exactly one CSV file.')
  const file = files[0]!
  if (file.size > MAX_TODO_CSV_BYTES) throw ApiError.tooLarge('The CSV cannot exceed 2 MiB.')

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
      .decode(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw ApiError.badRequest('The CSV must be UTF-8 text.')
  }

  const store = new AssistantStore(c.env.DB, c.get('userId'), c.env)
  const settings = await store.getSettings()
  let parsed: ReturnType<typeof parseTodoCsv>
  try {
    parsed = parseTodoCsv(text, settings.timezone)
  } catch (error) {
    if (error instanceof TodoCsvError) throw ApiError.badRequest(error.message)
    throw error
  }
  const total = parsed.rows.length + parsed.errors.length
  if (total > MAX_TODO_CSV_ROWS) {
    throw ApiError.badRequest(`A CSV import can hold at most ${MAX_TODO_CSV_ROWS} task rows.`)
  }

  const existing = conflict === 'duplicate' ? new Map<string, TodoTask>() : await loadExistingTasks(store)
  const listIds = new Map<string, string | null>()
  let created = 0
  let updated = 0
  let skipped = 0
  let missingLists = 0

  for (const row of parsed.rows) {
    const key = taskKey(row.title, row.dueAt)
    const match = conflict === 'duplicate' ? undefined : existing.get(key)
    if (match && conflict === 'skip') {
      skipped++
      continue
    }

    const list = await resolveList(store, listIds, row.listName)
    if (match && conflict === 'newer') {
      if (sameImportedFields(match, row, list.id, list.missing)) {
        skipped++
        continue
      }
      const patch: Partial<NewTask> = {
        title: row.title,
        description: row.notes,
        priority: row.priority,
        dueAt: row.dueAt,
        ...(list.missing ? {} : { listId: list.id }),
        tags: row.tags,
        ...(row.completed === null ? {} : { status: row.completed ? 'done' : 'todo' }),
      }
      const written = await store.updateTask(match.id, patch, settings.timezone)
      if (!written) throw ApiError.conflict('That task disappeared while it was being imported.')
      existing.set(key, written)
      updated++
      if (list.missing) missingLists++
      continue
    }

    if (list.missing) missingLists++
    const task = await store.createTask({
      title: row.title,
      description: row.notes,
      priority: row.priority,
      dueAt: row.dueAt,
      listId: list.id,
      status: row.completed ? 'done' : 'todo',
      tags: row.tags,
    }, settings.timezone)
    created++
    if (conflict !== 'duplicate') existing.set(key, task)
  }

  return c.json({
    created,
    updated,
    skipped,
    invalid: parsed.errors.length,
    missingLists,
    total,
    errors: parsed.errors,
  })
})
