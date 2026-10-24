/**
 * `POST /api/todos/import` — the CSV door into the task list.
 *
 * Kept in its own router and mounted before `/api/todos`, because Hono matches in registration order
 * and the task router already owns `/:id`: a request for `import` must be a route, never a task id.
 * Everything the importer writes goes through `AssistantStore`, so the account scoping and the task
 * rules are the same ones the app and the assistant use; this file only adapts multipart, checks the
 * ceilings and decides what `conflict` means.
 *
 * The file is small enough to read whole (2 MiB, 1000 rows), and a row that cannot be read is answered
 * in `errors` while the rest of the file still lands. Reading is cheap; writing is not. A row costs
 * several D1 statements, so a file of the ceiling cannot finish inside one Worker invocation. The
 * caller therefore walks the file in slices: `offset` and `limit` name the rows this request writes,
 * `nextOffset` says where the next one starts, and `null` means the file is done. The one question a
 * CSV cannot answer on its own is identity, so a row is "the same task" as an existing one when its
 * title (case-insensitive) and due instant match: `skip` leaves the existing task, `newer` makes the
 * file the source of truth, and `duplicate` always inserts a fresh row. Re-importing the same file
 * therefore settles instead of growing the list, except under `duplicate`, which is what that word is
 * for. The match reads the account on every slice, so a later slice sees what the earlier ones wrote.
 */

import { Hono } from 'hono'
import { MAX_TASKS_PER_QUERY, type TodoTask } from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import { AssistantStore, type NewTask } from '../assistant/store'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { readFormDataWithinLimit } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  DEFAULT_TODO_CSV_SLICE,
  MAX_TODO_CSV_BYTES,
  MAX_TODO_CSV_ROWS,
  MAX_TODO_CSV_SLICE,
  TodoCsvError,
  parseTodoCsv,
  type TodoCsvRow,
  type TodoCsvRowError,
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

/** Where this request starts in the file. The first slice names nothing and gets zero. */
function importOffset(value: unknown): number {
  if (value === null || value === '') return 0
  const offset = Number(value)
  if (!Number.isInteger(offset) || offset < 0) {
    throw ApiError.badRequest('offset must be a non-negative integer')
  }
  return offset
}

/** How many rows this request writes. A larger ask is trimmed to the ceiling rather than refused. */
function importLimit(value: unknown): number {
  if (value === null || value === '') return DEFAULT_TODO_CSV_SLICE
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1) {
    throw ApiError.badRequest('limit must be a positive integer')
  }
  return Math.min(limit, MAX_TODO_CSV_SLICE)
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

/** How many readable rows start before a line, which is the row index a bad line sits in front of. */
function rowsBeforeLine(rows: readonly TodoCsvRow[], line: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows[middle]!.line < line) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * The unreadable rows that belong to this slice.
 *
 * A bad line has no place in `rows`, so it is attached to the readable row it precedes: the error is
 * answered by the slice that will write that row, and one after the last row is answered by the final
 * slice. Every error therefore lands in exactly one answer across a full walk, and its line is the
 * line the reader sees in their editor rather than a position inside the slice.
 */
function errorsInSlice(
  rows: readonly TodoCsvRow[],
  errors: readonly TodoCsvRowError[],
  offset: number,
  end: number,
): TodoCsvRowError[] {
  const final = end >= rows.length
  return errors.filter((error) => {
    const before = rowsBeforeLine(rows, error.line)
    return before >= offset && (before < end || (final && before === rows.length))
  })
}

/**
 * Every task this account already holds, by the identity a CSV row can state.
 *
 * One page at a time because a listing is capped, and a bounded number of pages because the point is
 * to recognise rows from a file of at most 1000, not to mirror a vault of any size. A task beyond the
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
  if (row.completed !== null && isTaskDone(task.status) !== row.completed) return false
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
  const offset = importOffset(form.get('offset'))
  const limit = importLimit(form.get('limit'))
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

  const rows = parsed.rows.slice(offset, offset + limit)
  const end = offset + rows.length
  const nextOffset = end < parsed.rows.length ? end : null
  const errors = errorsInSlice(parsed.rows, parsed.errors, offset, end)

  const existing = conflict === 'duplicate' ? new Map<string, TodoTask>() : await loadExistingTasks(store)
  const listIds = new Map<string, string | null>()
  let created = 0
  let updated = 0
  let skipped = 0
  let missingLists = 0

  for (const row of rows) {
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
      // A finished row is not one column the patch may write: completing a task files the next
      // occurrence of a repeating one, and only `completeTask` does that. So `completed` leaves the
      // patch below and lands as its own call, after every other field — the order the single-task
      // PATCH keeps, so the occurrence the repeat files carries the title, due date and tags this file
      // just brought. Naming the status a row already has is still an ordinary patch.
      const finishing = row.completed === true && !isTaskDone(match.status)
      const patch: Partial<NewTask> = {
        title: row.title,
        description: row.notes,
        priority: row.priority,
        dueAt: row.dueAt,
        ...(list.missing ? {} : { listId: list.id }),
        tags: row.tags,
        ...(row.completed === null || finishing ? {} : { status: row.completed ? 'done' : 'todo' }),
      }
      const written = await store.updateTask(match.id, patch, settings.timezone)
      if (!written) throw ApiError.conflict('That task disappeared while it was being imported.')
      if (finishing) {
        const done = await store.completeTask(written.id, settings.timezone)
        if (!done) throw ApiError.conflict('That task disappeared while it was being imported.')
        existing.set(key, done.task)
      } else {
        existing.set(key, written)
      }
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
    // `invalid` and `total` describe the file, not the slice: the client prints progress against the
    // file's own size and does not have to add either up. `errors` lists only this slice's bad rows.
    invalid: parsed.errors.length,
    missingLists,
    total,
    errors,
    nextOffset,
  })
})
