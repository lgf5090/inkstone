/**
 * The to-do app's HTTP surface.
 *
 * Static paths are registered before `/:id`, because Hono matches in registration order and `/lists`
 * would otherwise be read as the id of a task called "lists". Everything below `use` requires a
 * session, every mutating method spends the caller's write budget, and every query goes through the
 * store, which scopes by the account the session named — an id from another account is a 404 rather
 * than a 403, because a refusal that confirms an id exists is still a leak.
 *
 * Validation lives here rather than in the store: the store's job is the rules that must hold whatever
 * the caller sent, while "a title is required and at most 300 characters" is a property of the request.
 * The task list itself is shared with the assistant's tools, which call the same store methods.
 */

import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { localDayBounds, parseLocalTime } from '@shared/assistant-time'
import { organizerColorOrNull } from '@shared/organizer-colors'
import {
  MAX_LIST_NAME_CHARS,
  MAX_STEP_TEXT_CHARS,
  MAX_TAGS_PER_TASK,
  MAX_TAG_NAME_CHARS,
  MAX_TASKS_PER_QUERY,
  isTaskView,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  type RemindOffset,
  type RepeatRule,
} from '@shared/todos/model'
import type { TaskPriority, TaskStatus } from '@shared/assistant'
import { AssistantStore } from '../assistant/store'

const BODY_LIMIT = JSON_BODY_LIMITS.settings
const TITLE_MAX = 300
const DESCRIPTION_MAX = 10_000

/**
 * How many writes one account may land in a minute, shared by every mutating route in this file.
 *
 * The bucket is the isolate's own: `lib/rate-limit.ts` keeps it in memory, so a cold isolate starts
 * counting again and two warm isolates each hold a full budget. That makes this a brake on a runaway
 * client — a retry loop, a scripted burst — and not a defence against abuse spread across regions. The
 * D1-backed `lib/throttle.ts` would be that defence, at the price of a database write in front of every
 * checkbox, so it stays on the paths where an attempt is genuinely expensive.
 *
 * 60 is someone working fast: ticking tasks off, retitling, moving one between lists and creating a
 * couple, all within a minute of tapping, lands well under it. A client that cannot stay under it is not
 * a person. Reads are unmetered because the app reloads the list whenever it comes back to the
 * foreground, and a limit there would only break the reader's own view.
 */
export const WRITE_BUDGET_PER_MINUTE = 60

const writeBudget = createMinuteBudget(WRITE_BUDGET_PER_MINUTE, 'Too many changes at once. Try again in a minute.')

type Ctx = Context<AppBindings>

export const todoRoutes = new Hono<AppBindings>()

todoRoutes.use('*', requireAuth)

/**
 * Spends the caller's write budget before any mutation runs.
 *
 * Mounted after `requireAuth` so the caller is known by the time a bucket is picked, and it spends even
 * when the handler then rejects the body — a client hammering invalid writes is exactly what this is
 * for. Ordered before every route, so a task, a list, a tag and a step come off the same budget.
 */
todoRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') writeBudget(c.get('userId'))
  await next()
})

function store(c: Ctx): AssistantStore {
  return new AssistantStore(c.env.DB, c.get('userId'), c.env)
}

/** The end of the reader's local day, so "today" is theirs and not the server's. */
function readerDayEnd(timezone: string): number {
  return localDayBounds(timezone).end
}

function text(value: unknown, max: number, field = 'text'): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  const trimmed = value.trim()
  if (!trimmed) throw ApiError.badRequest(`${field} is required`)
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`)
  return trimmed
}

function optionalText(value: unknown, max: number, field = 'text'): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`)
  return trimmed
}

function requiredId(value: unknown): string {
  if (!isValidId(value)) throw ApiError.notFound('Not found')
  return value
}

function asStatus(value: unknown): TaskStatus {
  if (value === 'todo' || value === 'in_progress' || value === 'done') return value
  throw ApiError.badRequest('Unknown task status.')
}

function asPriority(value: unknown): TaskPriority {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'urgent') return value
  throw ApiError.badRequest('Unknown task priority.')
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be true or false`)
  return value
}

/** A local date, a local date-time, an instant, or nothing. */
function parseDue(value: unknown, timezone: string): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = parseLocalTime(value, timezone)
    if (parsed === null) throw ApiError.badRequest('That date could not be read.')
    return parsed
  }
  throw ApiError.badRequest('A due date must be text or a number.')
}

function asRepeat(value: unknown): RepeatRule | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = parseRepeatRule(value)
  if (!parsed) throw ApiError.badRequest('A repeat rule needs a frequency of daily, weekly, monthly or yearly.')
  return parsed
}

const REMIND_VALUES: readonly RemindOffset[] = ['none', 'due', '15m', '1h', '1d']

function asRemind(value: unknown): RemindOffset {
  if (typeof value !== 'string' || !(REMIND_VALUES as readonly string[]).includes(value)) {
    throw ApiError.badRequest('A reminder must be one of none, due, 15m, 1h or 1d.')
  }
  return value as RemindOffset
}

async function listRef(s: AssistantStore, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('A list must be named by id.')
  const found = await s.resolveTaskList(value)
  if (!found) throw ApiError.badRequest('That list does not exist.')
  return found.id
}

async function projectRef(s: AssistantStore, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('A project must be named by id.')
  const found = await s.resolveProject(value)
  if (!found) throw ApiError.badRequest('That project does not exist.')
  return found.id
}

function optionalId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !isValidId(value)) throw ApiError.badRequest(`${field} must be an id.`)
  return value
}

function stepTexts(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw ApiError.badRequest('Steps must be a list of texts.')
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, MAX_STEP_TEXT_CHARS))
    .filter(Boolean)
}

function tagNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) && typeof value !== 'string') throw ApiError.badRequest('Tags must be a list of names.')
  return normalizeTagNames(value).slice(0, MAX_TAGS_PER_TASK)
}

function colorValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('A colour must be text.')
  const colour = organizerColorOrNull(value)
  if (!colour) throw ApiError.badRequest('That colour is not one of the palette.')
  return colour
}

/**
 * A list's icon: one emoji, or the name of an icon the picker offers.
 *
 * Deliberately not `normalizeOrganizerIcon`, whose 8-unit ceiling is sized for the emoji a folder
 * stores — an icon name such as `Briefcase` is longer than that, and truncating it would leave a
 * value no picker could ever produce again.
 */
function iconValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('An icon must be text.')
  const icon = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (icon.length > 40) throw ApiError.badRequest('That icon name is too long.')
  return icon || null
}

// ------------------------------------------------------------------- tasks

todoRoutes.get('/', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const view = c.req.query('view')
  const list = c.req.query('list')
  const tag = c.req.query('tag')
  const priority = c.req.query('priority')
  const starred = c.req.query('starred')
  const limit = Number(c.req.query('limit'))
  const offset = Number(c.req.query('offset'))
  const dayEnd = readerDayEnd(settings.timezone)
  const tasks = await s.listTasks({
    status: taskStatusFilter(c.req.query('status')),
    view: isTaskView(view) ? view : 'all',
    listId: list === undefined ? undefined : list === 'none' ? null : requiredId(list),
    tagId: tag ? requiredId(tag) : undefined,
    priority: priority ? asPriority(priority) : undefined,
    starred: starred === '1' ? true : undefined,
    query: c.req.query('q')?.trim().slice(0, 200) || undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TASKS_PER_QUERY, Math.trunc(limit))) : undefined,
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : undefined,
    dayEnd,
  })
  return c.json({ tasks, counts: await s.taskCounts(dayEnd), dayEnd, timezone: settings.timezone })
})

todoRoutes.post('/', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const dueAt = parseDue(body.dueAt, settings.timezone)
  const remind = body.remind === undefined ? 'none' : asRemind(body.remind)
  const task = await s.createTask({
    title: text(body.title, TITLE_MAX, 'A task title'),
    description: optionalText(body.description, DESCRIPTION_MAX, 'A task note') ?? '',
    status: body.status === undefined ? undefined : asStatus(body.status),
    priority: body.priority === undefined ? undefined : asPriority(body.priority),
    dueAt,
    projectId: await projectRef(s, body.projectId),
    listId: await listRef(s, body.listId),
    starred: body.starred === undefined ? undefined : asBoolean(body.starred, 'starred'),
    repeat: asRepeat(body.repeat),
    remindAt: remindAtFor(dueAt, remind),
    noteId: optionalId(body.noteId, 'noteId') ?? null,
    conversationId: optionalId(body.conversationId, 'conversationId') ?? null,
    tags: tagNames(body.tags),
    steps: stepTexts(body.steps),
  })
  await s.recordActivity('task.created', task.title)
  return c.json({ task }, 201)
})

// ------------------------------------------------------------------- lists

todoRoutes.get('/lists', async (c) => {
  return c.json({ lists: await store(c).listTaskLists() })
})

todoRoutes.post('/lists', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const list = await s.createTaskList({
    name: text(body.name, MAX_LIST_NAME_CHARS, 'A list name'),
    icon: iconValue(body.icon) ?? null,
    color: colorValue(body.color) ?? null,
  })
  return c.json({ list }, 201)
})

todoRoutes.patch('/lists/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const list = await s.updateTaskList(id, {
    ...(body.name !== undefined ? { name: text(body.name, MAX_LIST_NAME_CHARS, 'A list name') } : {}),
    ...(body.icon !== undefined ? { icon: iconValue(body.icon) ?? null } : {}),
    ...(body.color !== undefined ? { color: colorValue(body.color) ?? null } : {}),
    ...(typeof body.position === 'number' ? { position: body.position } : {}),
  })
  if (!list) throw ApiError.notFound('List not found')
  return c.json({ list })
})

todoRoutes.delete('/lists/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getTaskList(id))) throw ApiError.notFound('List not found')
  await s.deleteTaskList(id)
  return c.json({ deleted: true })
})

// -------------------------------------------------------------------- tags

todoRoutes.get('/tags', async (c) => {
  return c.json({ tags: await store(c).listTaskTags() })
})

todoRoutes.post('/tags', async (c) => {
  const s = store(c)
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const tag = await s.createTaskTag({
    name: text(body.name, MAX_TAG_NAME_CHARS, 'A tag name'),
    color: colorValue(body.color) ?? null,
  })
  return c.json({ tag }, 201)
})

todoRoutes.patch('/tags/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const tag = await s.updateTaskTag(id, {
    ...(body.name !== undefined ? { name: text(body.name, MAX_TAG_NAME_CHARS, 'A tag name') } : {}),
    ...(body.color !== undefined ? { color: colorValue(body.color) ?? null } : {}),
  })
  if (!tag) throw ApiError.notFound('Tag not found')
  return c.json({ tag })
})

todoRoutes.delete('/tags/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getTaskTag(id))) throw ApiError.notFound('Tag not found')
  await s.deleteTaskTag(id)
  return c.json({ deleted: true })
})

todoRoutes.get('/:id', async (c) => {
  const s = store(c)
  const task = await s.getTask(requiredId(c.req.param('id')))
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task, steps: await s.listSteps(task.id) })
})

todoRoutes.patch('/:id', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const existing = await s.getTask(id)
  if (!existing) throw ApiError.notFound('Task not found')
  const dueAt = body.dueAt === undefined ? undefined : parseDue(body.dueAt, settings.timezone)
  // A reminder given as an offset is measured from the due date the patch is asking for, falling back
  // to the one already stored: moving a task and its reminder in one request is the common case.
  const remindAt = body.remind === undefined
    ? undefined
    : remindAtFor(dueAt === undefined ? existing.dueAt : dueAt, asRemind(body.remind))
  const nextStatus = body.status !== undefined ? asStatus(body.status) : undefined
  /**
   * Whether this request is the reader finishing the task.
   *
   * Finishing is not just a column: a repeating task files its next occurrence, and that has to happen
   * exactly once, in `completeTask`. Writing `status = 'done'` through the general patch would move the
   * row and drop the occurrence — which is what the checkbox did until this branch existed, so the same
   * press meant different things depending on whether it came from the app or from the chat.
   */
  const completing = nextStatus === 'done' && existing.status !== 'done'
  // Every other column lands first, so the row being completed already carries the new title, due date
  // and tags — `completeTask` copies those into the next occurrence.
  const patch = {
    ...(body.title !== undefined ? { title: text(body.title, TITLE_MAX, 'A task title') } : {}),
    ...(body.description !== undefined ? { description: optionalText(body.description, DESCRIPTION_MAX, 'A task note') ?? '' } : {}),
    ...(body.priority !== undefined ? { priority: asPriority(body.priority) } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(body.projectId !== undefined ? { projectId: await projectRef(s, body.projectId) } : {}),
    ...(body.listId !== undefined ? { listId: await listRef(s, body.listId) } : {}),
    ...(body.starred !== undefined ? { starred: asBoolean(body.starred, 'starred') } : {}),
    ...(body.repeat !== undefined ? { repeat: asRepeat(body.repeat) } : {}),
    ...(remindAt !== undefined ? { remindAt } : {}),
    ...(body.noteId !== undefined ? { noteId: optionalId(body.noteId, 'noteId') } : {}),
    ...(body.conversationId !== undefined ? { conversationId: optionalId(body.conversationId, 'conversationId') } : {}),
    ...(body.tags !== undefined ? { tags: tagNames(body.tags) ?? [] } : {}),
  }
  let task = Object.keys(patch).length ? await s.updateTask(id, patch) : existing
  if (!task) throw ApiError.notFound('Task not found')
  let next = null
  if (completing) {
    const done = await s.completeTask(id, settings.timezone)
    if (!done) throw ApiError.notFound('Task not found')
    task = done.task
    next = done.next
    await s.recordActivity('task.completed', task.title)
  } else if (nextStatus !== undefined && nextStatus !== task.status) {
    task = (await s.updateTask(id, { status: nextStatus })) ?? task
  }
  return c.json({ task, ...(next ? { next } : {}) })
})

todoRoutes.delete('/:id', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const existing = await s.getTask(id)
  if (!existing) throw ApiError.notFound('Task not found')
  await s.deleteTask(id)
  await s.recordActivity('task.deleted', existing.title)
  return c.json({ deleted: true })
})

// ------------------------------------------------------------------- steps

todoRoutes.post('/:id/steps', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  if (!(await s.getTask(id))) throw ApiError.notFound('Task not found')
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const step = await s.addStep(id, text(body.text, MAX_STEP_TEXT_CHARS, 'A step'))
  if (!step) throw ApiError.badRequest('This task already has the maximum number of steps.')
  return c.json({ step }, 201)
})

todoRoutes.patch('/:id/steps/:stepId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const stepId = requiredId(c.req.param('stepId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const step = await s.updateStep(id, stepId, {
    ...(body.text !== undefined ? { text: text(body.text, MAX_STEP_TEXT_CHARS, 'A step') } : {}),
    ...(body.done !== undefined ? { done: asBoolean(body.done, 'done') } : {}),
  })
  if (!step) throw ApiError.notFound('Step not found')
  return c.json({ step })
})

todoRoutes.delete('/:id/steps/:stepId', async (c) => {
  const s = store(c)
  const removed = await s.deleteStep(requiredId(c.req.param('id')), requiredId(c.req.param('stepId')))
  if (!removed) throw ApiError.notFound('Step not found')
  return c.json({ deleted: true })
})

function taskStatusFilter(value: string | undefined): TaskStatus | 'open' | 'all' {
  if (!value || value === 'all' || value === 'open') return (value ?? 'all') as TaskStatus | 'open' | 'all'
  return asStatus(value)
}
