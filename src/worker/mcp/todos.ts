/**
 * The to-do tools the MCP server publishes.
 *
 * Every read and write here goes through `AssistantStore`'s public methods — the same ones the in-app
 * assistant's ten task tools call — so an external agent and the reader's own chat face one to-do model:
 * one set of field names, one set of enums, one timezone, and one rule about what a foreign id answers
 * with. Validation that the shared model already owns stays in the shared model: the limits below are
 * imported from `@shared/todos/model`, never re-stated as numbers. A description's ceiling is the one
 * exception, stated once below: the agent payload's limit is smaller than the HTTP form's on purpose,
 * so it is not the model's number at all.
 *
 * The one thing this surface does add is a scope check on references. A task carries a `note_id` and a
 * `conversation_id` because the app files tasks from notes and from chats, and both are pointers into
 * material a task tool has no business returning: the to-do answer names the note only when the call may
 * read notes, and never names a conversation at all, because no to-do tool can read one.
 */

import type { TaskPriority, TaskStatus } from '@shared/assistant'
import { localDate, localDayBounds, parseLocalTime } from '@shared/assistant-time'
import {
  MAX_LIST_NAME_CHARS,
  MAX_REMINDERS_PER_TASK,
  MAX_REPEAT_INTERVAL,
  MAX_STEP_TEXT_CHARS,
  MAX_TAG_NAME_CHARS,
  MAX_TASKS_PER_QUERY,
  MIN_REPEAT_INTERVAL,
  SNOOZE_MINUTES,
  isSnoozeMinutes,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  withPreviousSeries,
  type RemindOffset,
  type RepeatFrequency,
  type RepeatRule,
  type TaskCounts,
  type TaskView,
  type TodoTask,
} from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import { isStatsDay } from '../todos/stats'
import { AssistantStore, TaskRefusal, type NewTask } from '../assistant/store'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { addDays, loadTodoStats } from '../todos/stats'
import { runIdempotent } from './operations'
import { MCP_SCOPES } from './settings'

export interface McpTodoContext {
  env: Env
  userId: string
  /** The scopes this call is answered under, which decide what a task may be pointed at. */
  scopes: readonly string[]
}

/**
 * How long a task description the MCP tools accept.
 *
 * This is the agent payload's ceiling, 2,000 — the one the in-app assistant's `create_task` and
 * `update_task` already use — not the 10,000 a person may type in the to-do app's form
 * (`MAX_TASK_DESCRIPTION_CHARS` in `@shared/todos/model`). An agent pays for the payload it sends and
 * receives, while the form is written at a keyboard, so the two entry points meet at different
 * numbers on purpose. The constant stays here, beside the tools it governs, so neither limit is
 * mistaken for the other.
 */
export const MAX_TASK_TOOL_DESCRIPTION_CHARS = 2_000

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
  /** The task this one is a step of, by id. */
  parent?: string
  /** The tasks this one waits on, by id. */
  waitsOn?: string[]
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
  /** A task id, or null to put the row back at the top of the tree. */
  parent?: string | null
  /** The whole set this task waits on, replacing the one it has. */
  waitsOn?: string[]
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
    ...(input.parent === undefined ? {} : { parentId: input.parent }),
    ...(input.waitsOn === undefined ? {} : { dependsOn: input.waitsOn }),
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
      const task = await asMcpRefusal(() => store.createTask(newTask))
      await store.recordActivity('task.created', task.title)
      return { task: presentTask(task, context.scopes) }
    },
  })
}

export async function updateMcpTask(context: McpTodoContext, input: McpTaskPatch): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_todo',
    request: input,
    execute: async () => {
      const existing = await readTask(store, input.taskId)
      const dueAt = input.due === undefined ? undefined : input.due === null ? null : dueMillis(input.due, timezone)
      const listId = await resolveListRef(store, input.list)
      const noteId = await resolveNoteRef(context, input.note)
      const repeat = repeatOf(input.repeat, input.repeatInterval, existing.repeat)
      const patch: Partial<NewTask> = {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(listId !== undefined ? { listId } : {}),
        ...(input.parent === undefined ? {} : { parentId: input.parent }),
        ...(input.waitsOn === undefined ? {} : { dependsOn: input.waitsOn }),
        ...(input.tags !== undefined ? { tags: normalizeTagNames(input.tags) } : {}),
        ...(input.starred !== undefined ? { starred: input.starred } : {}),
        ...(repeat !== undefined ? { repeat } : {}),
        ...(noteId !== undefined ? { noteId } : {}),
        ...(input.remind !== undefined
          ? { remindAt: remindAtFor(dueAt === undefined ? existing.dueAt : dueAt, input.remind) }
          : {}),
      }
      let task = Object.keys(patch).length ? await asMcpRefusal(() => store.updateTask(existing.id, patch)) : existing
      if (!task) throw ApiError.notFound('Task not found')
      let next: TodoTask | null = null
      if (isTaskDone(input.status)) {
        const done = await store.completeTask(task.id, timezone)
        if (!done) throw ApiError.notFound('Task not found')
        task = done.task
        next = done.next
        await store.recordActivity('task.completed', task.title)
      } else if (input.status !== undefined && input.status !== task.status) {
        const updated = await store.updateTask(task.id, { status: input.status })
        if (!updated) throw ApiError.notFound('Task not found')
        task = updated
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
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'complete_todo',
    request: input,
    execute: async () => {
      const existing = await readTask(store, input.taskId)
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
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_todo',
    request: input,
    execute: async () => {
      const existing = await readTask(store, input.taskId)
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

/**
 * A store refusal, in the words an MCP answer carries.
 *
 * The task store judges a parent and a dependency set before it writes anything, and its reason is the
 * caller's lesson — "A task cannot wait on itself" — not a stack trace. Left alone it would surface as a
 * server error, which tells an agent nothing to change about the next call.
 */
async function asMcpRefusal<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask()
  } catch (error) {
    if (error instanceof TaskRefusal) throw ApiError.badRequest(error.message)
    throw error
  }
}

// ------------------------------------------------------------------- steps

export async function addMcpTaskStep(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; text: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'add_todo_step',
    request: input,
    execute: async () => {
      await readTask(store, input.taskId)
      const step = await store.addStep(input.taskId, input.text)
      if (!step) throw ApiError.badRequest('This task already holds the maximum number of steps.')
      return { step: { id: step.id, text: step.text, done: step.done } }
    },
  })
}

export async function checkMcpTaskStep(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; stepId: string; done: boolean },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'check_todo_step',
    request: input,
    execute: async () => {
      await readTask(store, input.taskId)
      const step = await store.updateStep(input.taskId, input.stepId, { done: input.done })
      if (!step) throw ApiError.notFound('Step not found')
      return { step: { id: step.id, text: step.text, done: step.done } }
    },
  })
}

export async function deleteMcpTaskStep(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; stepId: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_todo_step',
    request: input,
    execute: async () => {
      await readTask(store, input.taskId)
      if (!(await store.deleteStep(input.taskId, input.stepId))) throw ApiError.notFound('Step not found')
      return { deleted: true, step_id: input.stepId }
    },
  })
}

// ------------------------------------------------------------------- trash

export async function listMcpTaskTrash(
  context: McpTodoContext,
  input: { limit?: number; offset?: number },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 25)), MAX_TASKS_PER_QUERY)
  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const page = await store.listTrash({ limit, offset })
  return {
    count: page.tasks.length,
    total: page.total,
    tasks: page.tasks.map((task) => ({ ...presentTask(task, context.scopes), deleted_at: task.deletedAt ?? null })),
  }
}

export async function restoreMcpTask(
  context: McpTodoContext,
  input: { operationId: string; taskId: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'restore_todo',
    request: input,
    execute: async () => {
      const { task, droppedReminders } = await store.restoreTask(input.taskId)
      if (!task) throw ApiError.notFound('No trashed task has that id.')
      return {
        restored: presentTask(task, context.scopes),
        ...(droppedReminders > 0 ? { dropped_reminders: droppedReminders } : {}),
      }
    },
  })
}

// ------------------------------------------------------------------- plan and snooze

export async function planMcpTask(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; day: string | null },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const day = input.day === null || input.day === ''
    ? null
    : isStatsDay(input.day) ? input.day : (() => { throw ApiError.badRequest('A planned day must be a date like 2026-01-31, or null.') })()
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'plan_todo',
    request: input,
    execute: async () => {
      await readTask(store, input.taskId)
      const task = await store.planTask(input.taskId, day)
      if (!task) throw ApiError.notFound('Task not found')
      return { planned: presentTask(task, context.scopes) }
    },
  })
}

export async function snoozeMcpTask(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; minutes: number },
): Promise<Record<string, unknown>> {
  if (!isSnoozeMinutes(input.minutes)) {
    throw ApiError.badRequest(`A snooze must be ${SNOOZE_MINUTES.join(', ')} minutes.`)
  }
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'snooze_todo',
    request: input,
    execute: async () => {
      const existing = await readTask(store, input.taskId)
      if (isTaskDone(existing.status)) throw ApiError.badRequest('A finished task cannot be snoozed.')
      if ((existing.reminders?.length ?? 0) >= MAX_REMINDERS_PER_TASK) {
        throw ApiError.badRequest(`This task already has ${MAX_REMINDERS_PER_TASK} reminders.`)
      }
      const remindAt = Date.now() + input.minutes * 60_000
      const task = await store.snoozeTask(existing.id, remindAt)
      if (!task) throw ApiError.notFound('Task not found')
      return { snoozed: presentTask(task, context.scopes), remind_at: remindAt }
    },
  })
}

export async function archiveMcpTask(
  context: McpTodoContext,
  input: { operationId: string; taskId: string; archived?: boolean },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const shelf = input.archived === undefined ? true : input.archived
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'archive_todo',
    request: input,
    execute: async () => {
      const existing = await readTask(store, input.taskId)
      const task = await store.updateTask(existing.id, { archivedAt: shelf ? Date.now() : null })
      if (!task) throw ApiError.notFound('Task not found')
      return { task: presentTask(task, context.scopes), archived: task.archivedAt !== null }
    },
  })
}

// ------------------------------------------------------------------- lists

export async function createMcpTaskList(
  context: McpTodoContext,
  input: { operationId: string; name: string; icon?: string | null; color?: string | null },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'create_todo_list',
    request: input,
    execute: async () => {
      const list = await store.createTaskList({
        name: input.name.trim().slice(0, MAX_LIST_NAME_CHARS),
        icon: input.icon ?? null,
        color: input.color ?? null,
      })
      return { list: { id: list.id, name: list.name, icon: list.icon, color: list.color } }
    },
  })
}

export async function updateMcpTaskList(
  context: McpTodoContext,
  input: {
    operationId: string
    listId: string
    name?: string
    icon?: string | null
    color?: string | null
    archived?: boolean
  },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'update_todo_list',
    request: input,
    execute: async () => {
      const list = await store.updateTaskList(input.listId, {
        ...(input.name !== undefined ? { name: input.name.trim().slice(0, MAX_LIST_NAME_CHARS) } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? Date.now() : null } : {}),
      })
      if (!list) throw ApiError.notFound('List not found')
      return { list: { id: list.id, name: list.name, icon: list.icon, color: list.color, archived: list.archivedAt !== null } }
    },
  })
}

export async function deleteMcpTaskList(
  context: McpTodoContext,
  input: { operationId: string; listId: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_todo_list',
    request: input,
    execute: async () => {
      const list = await store.getTaskList(input.listId)
      if (!list) throw ApiError.notFound('List not found')
      await store.deleteTaskList(list.id)
      return { deleted: true, list_id: list.id, tasks_moved_to_inbox: list.openCount + list.doneCount }
    },
  })
}

// ------------------------------------------------------------------- tags

export async function renameMcpTaskTag(
  context: McpTodoContext,
  input: { operationId: string; tag: string; name: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'rename_todo_tag',
    request: input,
    execute: async () => {
      const found = await resolveTagRef(store, input.tag)
      if (found === undefined) throw ApiError.badRequest('No such tag. Call list_todos to see the tags in use.')
      const tag = await store.updateTaskTag(found, { name: input.name.trim().slice(0, MAX_TAG_NAME_CHARS) })
      if (!tag) throw ApiError.notFound('Tag not found')
      return { tag: { id: tag.id, name: tag.name, color: tag.color } }
    },
  })
}

export async function deleteMcpTaskTag(
  context: McpTodoContext,
  input: { operationId: string; tag: string },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  return runIdempotent({
    db: context.env.DB,
    userId: context.userId,
    operationId: input.operationId,
    tool: 'delete_todo_tag',
    request: input,
    execute: async () => {
      const found = await resolveTagRef(store, input.tag)
      if (found === undefined) throw ApiError.badRequest('No such tag. Call list_todos to see the tags in use.')
      await store.deleteTaskTag(found)
      return { deleted: true, tag_id: found }
    },
  })
}

// ------------------------------------------------------------------- statistics

export async function todoStats(
  context: McpTodoContext,
  input: { from?: string; to?: string; bucket?: 'day' | 'week' | 'month' },
): Promise<Record<string, unknown>> {
  const store = storeFor(context)
  const timezone = await timezoneOf(store)
  const today = localDate(Date.now(), timezone)
  const to = input.to ?? today
  if (!isStatsDay(to)) throw ApiError.badRequest('A statistics range must end on a date like 2026-01-31.')
  const from = input.from ?? addDays(to, -6)
  if (!isStatsDay(from)) throw ApiError.badRequest('A statistics range must start on a date like 2026-01-31.')
  if (from > to) throw ApiError.badRequest('A statistics range cannot start after it ends.')
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  if (span > 366) throw ApiError.badRequest('A statistics range cannot cover more than 366 days.')
  const stats = await loadTodoStats(context.env.DB, context.userId, {
    from,
    to,
    bucket: input.bucket ?? 'day',
    timezone,
    now: Date.now(),
  })
  return {
    range: stats.range,
    timezone,
    summary: {
      completed: stats.summary.completed,
      created: stats.summary.created,
      open: stats.summary.open,
      completionRate: stats.summary.completionRate,
      abandoned: stats.summary.abandoned,
      onTimeRate: stats.summary.onTimeRate,
      currentStreak: stats.summary.currentStreak,
      longestStreak: stats.summary.longestStreak,
      overdue: stats.summary.overdue,
    },
    by_list: stats.distributions.byList,
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
    // Where the row sits and what it waits for, so a call that set either can read back what it got
    // rather than assume the write said what it was asked.
    ...(task.parentId ? { parent_id: task.parentId } : {}),
    ...(task.dependsOn.length ? { waits_on: task.dependsOn.map((entry) => entry.id) } : {}),
    ...(task.blocks.length ? { blocking: task.blocks.map((entry) => entry.id) } : {}),
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
  if (!(await storeFor(context).knownNote(ref))) throw ApiError.notFound('Note not found')
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
 *
 * `previous` is the rule on the row being edited: a caller naming a new rhythm says nothing about the
 * series that rhythm already runs, so the ceiling, the pause and the days let go of ride over with it.
 */
function repeatOf(
  freq: RepeatFrequency | 'none' | undefined,
  interval?: number,
  previous?: RepeatRule | null,
): RepeatRule | null | undefined {
  if (freq === undefined) return undefined
  if (freq === 'none') return null
  const rule = parseRepeatRule({ freq, interval: interval ?? MIN_REPEAT_INTERVAL })
  if (!rule) {
    throw ApiError.badRequest(`A repeat interval is between ${MIN_REPEAT_INTERVAL} and ${MAX_REPEAT_INTERVAL}.`)
  }
  return withPreviousSeries(rule, previous)
}

function stepTexts(steps: string[] | undefined): string[] | undefined {
  if (steps === undefined) return undefined
  // The count ceiling is the model's and is enforced by the tool's schema; trimming and shortening here
  // is what the store's own `addStep` would do anyway, done once for the whole list.
  return steps.map((step) => step.trim().slice(0, MAX_STEP_TEXT_CHARS)).filter(Boolean)
}
