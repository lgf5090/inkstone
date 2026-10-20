/**
 * The to-do tools the MCP server publishes.
 *
 * Every read and write here goes through `AssistantStore`'s public methods — the same ones the in-app
 * assistant's ten task tools call — so an external agent and the reader's own chat face one to-do model:
 * one set of field names, one set of enums, one timezone, and one rule about what a foreign id answers
 * with. Validation that the shared model already owns stays in the shared model: the limits below are
 * imported from `@shared/todos/model`, never re-stated as numbers. The one limit the model does not own
 * yet — how long a task description may be — is stated once beside the tools and marked as local.
 *
 * The one thing this surface does add is a scope check on references. A task carries a `note_id` and a
 * `conversation_id` because the app files tasks from notes and from chats, and both are pointers into
 * material a task tool has no business returning: the to-do answer names the note only when the call may
 * read notes, and never names a conversation at all, because no to-do tool can read one.
 */

import type { TaskPriority, TaskStatus } from '@shared/assistant'
import { localDayBounds, parseLocalTime } from '@shared/assistant-time'
import {
  MAX_LIST_NAME_CHARS,
  MAX_REPEAT_INTERVAL,
  MAX_STEP_TEXT_CHARS,
  MAX_TAG_NAME_CHARS,
  MIN_REPEAT_INTERVAL,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  type RemindOffset,
  type RepeatFrequency,
  type RepeatRule,
  type TaskCounts,
  type TaskView,
  type TodoTask,
} from '@shared/todos/model'
import { AssistantStore, type NewTask } from '../assistant/store'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { runIdempotent } from './operations'
import { MCP_SCOPES } from './settings'

export interface McpTodoContext {
  env: Env
  userId: string
  /** The scopes this call is answered under, which decide what a task may be pointed at. */
  scopes: readonly string[]
}

/**
 * How long a task description the tools accept.
 *
 * A local constant on purpose: `@shared/todos/model` has no description limit yet, and the two surfaces
 * that write one disagree. The to-do app's HTTP route accepts 10,000 characters (`DESCRIPTION_MAX` in
 * `src/worker/routes/todos.ts`), while the in-app assistant's `create_task` and `update_task` stop at
 * 2,000. These tools follow the assistant because the caller is an agent paying for its own payload;
 * once the model owns one number, this file should import it and both entry points should meet there.
 */
export const MAX_TASK_DESCRIPTION_CHARS = 2_000

export interface McpTaskListing {
  view: TaskView
  list?: string
  tag?: string
  priority?: TaskPriority
  starred?: boolean
  query?: string
  limit: number
  offset: number
}

export interface McpNewTask {
  operationId: string
  title: string
  description?: string
  priority?: TaskPriority
  due?: string
  remind?: RemindOffset
  list?: string
  tags?: string[]
  steps?: string[]
  repeat?: RepeatFrequency
  repeatInterval?: number
  starred?: boolean
  note?: string
}

/** Every field is optional, and only the ones the caller named are written. */
export interface McpTaskPatch {
  operationId: string
  taskId: string
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  due?: string | null
  list?: string | null
  tags?: string[]
  repeat?: RepeatFrequency | 'none'
  repeatInterval?: number
  remind?: RemindOffset
  starred?: boolean
  note?: string | null
}

export async function listMcpTasks(context: McpTodoContext, input: McpTaskListing): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  const dayEnd = localDayBounds(timezone).end
  const listId = await resolveListRef(store, input.list)
  const tagId = await resolveTagRef(store, input.tag)
  const tasks = await store.listTasks({
    view: input.view,
    listId,
    tagId,
    priority: input.priority,
    starred: input.starred,
    query: input.query,
    limit: input.limit,
    offset: input.offset,
    dayEnd,
  })
  const counts = await store.taskCounts(dayEnd)
  return {
    tasks: tasks.map((task) => presentTask(task, context.scopes)),
    count: tasks.length,
    counts: presentCounts(counts),
    // The page is measured in the reader's calendar, so the answer says which one rather than leaving a
    // client to guess it from a UTC `day_end`.
    timezone,
    day_end: dayEnd,
  }
}

export async function getMcpTask(context: McpTodoContext, taskId: string): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const task = await readTask(store, taskId)
  const steps = await store.listSteps(task.id)
  return {
    task: presentTask(task, context.scopes),
    steps: steps.map((step) => ({ text: step.text, done: step.done })),
  }
}

export async function createMcpTask(context: McpTodoContext, input: McpNewTask): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  const dueAt = input.due === undefined ? null : dueMillis(input.due, timezone)
  const listId = await resolveListRef(store, input.list)
  const noteId = await resolveNoteRef(context, input.note)
  const repeat = repeatOf(input.repeat, input.repeatInterval)
  const newTask: NewTask = {
    title: input.title.trim(),
    description: input.description ?? '',
    priority: input.priority,
    dueAt,
    listId: listId ?? null,
    starred: input.starred === true,
    repeat,
    remindAt: remindAtFor(dueAt, input.remind ?? 'none'),
    noteId: noteId ?? null,
    tags: input.tags === undefined ? undefined : normalizeTagNames(input.tags),
    steps: stepTexts(input.steps),
  }
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_todo',
    request: input,
    execute: async () => {
      const task = await store.createTask(newTask)
      await store.recordActivity('task.created', task.title)
      return { task: presentTask(task, context.scopes) }
    },
  })
}

export async function updateMcpTask(context: McpTodoContext, input: McpTaskPatch): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  const existing = await readTask(store, input.taskId)
  const dueAt = input.due === undefined ? undefined : input.due === null ? null : dueMillis(input.due, timezone)
  const listId = await resolveListRef(store, input.list)
  const noteId = await resolveNoteRef(context, input.note)
  const repeat = repeatOf(input.repeat, input.repeatInterval)

  const patch: Partial<NewTask> = {
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(listId !== undefined ? { listId } : {}),
    ...(input.tags !== undefined ? { tags: normalizeTagNames(input.tags) } : {}),
    ...(input.starred !== undefined ? { starred: input.starred } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(noteId !== undefined ? { noteId } : {}),
    // An offset is measured from the due date this patch is asking for, falling back to the stored one:
    // moving a task and its reminder in one request is the common case, and the route reads it the same.
    ...(input.remind !== undefined
      ? { remindAt: remindAtFor(dueAt === undefined ? existing.dueAt : dueAt, input.remind) }
      : {}),
  }
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_todo',
    request: input,
    execute: async () => {
      let task = Object.keys(patch).length ? await store.updateTask(existing.id, patch) : existing
      if (!task) throw ApiError.notFound('Task not found')
      let next: TodoTask | null = null
      if (input.status === 'done') {
        // Ticking a repeating task files its next occurrence here too, so an agent cannot leave a repeat
        // row finished and never coming back — the one state the app itself refuses to write.
        const done = await store.completeTask(task.id, timezone)
        if (!done) throw ApiError.notFound('Task not found')
        task = done.task
        next = done.next
        await store.recordActivity('task.completed', task.title)
      } else if (input.status !== undefined && input.status !== task.status) {
        task = (await store.updateTask(task.id, { status: input.status })) ?? task
      }
      return {
        task: presentTask(task, context.scopes),
        ...(next ? { next: presentTask(next, context.scopes) } : {}),
      }
    },
  })
}

export async function completeMcpTask(context: McpTodoContext, input: { operationId: string; taskId: string }): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  const existing = await readTask(store, input.taskId)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'complete_todo',
    request: input,
    execute: async () => {
      const result = await store.completeTask(existing.id, timezone)
      if (!result) throw ApiError.notFound('Task not found')
      await store.recordActivity('task.completed', result.task.title)
      return {
        completed: presentTask(result.task, context.scopes),
        ...(result.next ? { next: presentTask(result.next, context.scopes) } : {}),
      }
    },
  })
}

export async function deleteMcpTask(context: McpTodoContext, input: { operationId: string; taskId: string }): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const existing = await readTask(store, input.taskId)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_todo',
    request: input,
    execute: async () => {
      await store.deleteTask(existing.id)
      await store.recordActivity('task.deleted', existing.title)
      return { deleted: true, task_id: existing.id }
    },
  })
}

export async function listMcpTaskLists(context: McpTodoContext): Promise<Record<string, unknown>> {
  const lists = await storeFor(context).listTaskLists()
  return {
    lists: lists.map((list) => ({
      id: list.id,
      name: list.name,
      open: list.openCount,
      total: list.openCount + list.doneCount,
    })),
  }
}

function storeFor(context: McpTodoContext): AssistantStore {
  return new AssistantStore(context.env.DB, context.userId, context.env)
}

/** The reader's own zone, which is what every due date in this file is measured in. */
async function timezoneOf(store: AssistantStore): Promise<string> {
  return (await store.getSettings()).timezone
}

async function readTask(store: AssistantStore, taskId: string): Promise<TodoTask> {
  const task = await store.getTask(taskId)
  // An id from another account is a miss, not a refusal: a 403 would confirm the row exists.
  if (!task) throw ApiError.notFound('Task not found')
  return task
}

/**
 * A task as an external agent sees it, field for field as the assistant's own tools name them.
 *
 * `note_id` travels only when the call may read notes; `conversation_id` never travels, because no to-do
 * tool can read a conversation and naming one would be a leak with nothing on the other side of it.
 */
function presentTask(task: TodoTask, scopes: readonly string[]): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.dueAt,
    starred: task.starred,
    list_id: task.listId,
    ...(task.tags.length ? { tags: task.tags.map((tag) => tag.name) } : {}),
    ...(task.repeat ? { repeat: task.repeat.interval > 1 ? `${task.repeat.freq} x${task.repeat.interval}` : task.repeat.freq } : {}),
    ...(task.remindAt !== null ? { remind_at: task.remindAt } : {}),
    ...(task.stepTotal ? { steps: `${task.stepDone}/${task.stepTotal}` } : {}),
    ...(task.description ? { description: task.description.slice(0, 300) } : {}),
    ...(task.noteId && scopes.includes(MCP_SCOPES.read) ? { note_id: task.noteId } : {}),
  }
}

/** The counts a listing answers with, so "how many are left" needs no second call. */
function presentCounts(counts: TaskCounts): Record<string, number> {
  return {
    inbox: counts.inbox,
    today: counts.today,
    upcoming: counts.upcoming,
    overdue: counts.overdue,
    open: counts.all,
    completed: counts.completed,
    starred: counts.starred,
  }
}

function dueMillis(value: string, timezone: string): number {
  const parsed = parseLocalTime(value, timezone)
  if (parsed === null) {
    throw ApiError.badRequest('That date could not be read. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.')
  }
  return parsed
}

/** A list named by id or by name, as the id the store wants. */
async function resolveListRef(store: AssistantStore, ref: string | null | undefined): Promise<string | null | undefined> {
  if (ref === undefined) return undefined
  if (ref === null || ref === '') return null
  const found = await store.resolveTaskList(ref.trim().slice(0, MAX_LIST_NAME_CHARS))
  if (found) return found.id
  throw refIsId(ref) ? ApiError.notFound('List not found') : ApiError.badRequest('No such list. Call list_todo_lists for the names this account has.')
}

async function resolveTagRef(store: AssistantStore, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined
  const trimmed = ref.replace(/^#/, '').trim().slice(0, MAX_TAG_NAME_CHARS)
  if (!trimmed) return undefined
  const found = await store.resolveTaskTag(trimmed)
  if (found) return found.id
  throw refIsId(ref) ? ApiError.notFound('Tag not found') : ApiError.badRequest('No such tag. Call list_todos to see the tags in use.')
}

/**
 * A note a task came from, or the absence of one.
 *
 * The reference is a pointer, so it is checked as a pointer: the note has to be this account's, and the
 * call has to hold `notes:read`. Neither check reads a byte of note text — that is the point of doing it
 * here rather than by fetching the note.
 */
async function resolveNoteRef(context: McpTodoContext, ref: string | null | undefined): Promise<string | null | undefined> {
  if (ref === undefined) return undefined
  if (ref === null || ref === '') return null
  if (!context.scopes.includes(MCP_SCOPES.read)) {
    throw ApiError.forbidden(`OAuth scope required: ${MCP_SCOPES.read}`)
  }
  const row = await context.env.DB.prepare(
    `SELECT 1 AS ok FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  ).bind(ref, context.userId).first<{ ok: number }>()
  if (!row) throw ApiError.notFound('Note not found')
  return ref
}

function refIsId(ref: string): boolean {
  return isValidId(ref.trim())
}

/**
 * The repeat rule the caller described, or nothing at all when it did not describe one.
 *
 * `undefined` means "leave the column as it is" and `null` means "stop repeating", which is the difference
 * a patch has to keep. The interval is checked by the model's own reader so its ceiling is stated once.
 */
function repeatOf(freq: RepeatFrequency | 'none' | undefined, interval?: number): RepeatRule | null | undefined {
  if (freq === undefined) return undefined
  if (freq === 'none') return null
  const rule = parseRepeatRule({ freq, interval: interval ?? MIN_REPEAT_INTERVAL })
  if (!rule) {
    throw ApiError.badRequest(`A repeat interval is between ${MIN_REPEAT_INTERVAL} and ${MAX_REPEAT_INTERVAL}.`)
  }
  return rule
}

function stepTexts(steps: string[] | undefined): string[] | undefined {
  if (steps === undefined) return undefined
  // The count ceiling is the model's and is enforced by the tool's schema; trimming and shortening here
  // is what the store's own `addStep` would do anyway, done once for the whole list.
  return steps.map((step) => step.trim().slice(0, MAX_STEP_TEXT_CHARS)).filter(Boolean)
}
