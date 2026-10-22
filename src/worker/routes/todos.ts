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
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newSlug } from '../lib/id'
import { hashPassword } from '../lib/password'
import { storedObject } from '../lib/json'
import { createMinuteBudget } from '../lib/rate-limit'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { mergeSettings } from '@shared/constants'
import { localDate, localDayBounds, parseLocalTime } from '@shared/assistant-time'
import { organizerColorOrNull } from '@shared/organizer-colors'
import {
  MAX_BATCH_TASKS,
  MAX_LIST_NAME_CHARS,
  MAX_REMINDERS_PER_TASK,
  MAX_STEP_TEXT_CHARS,
  MAX_TAGS_PER_TASK,
  MAX_TAG_NAME_CHARS,
  MAX_TASKS_PER_QUERY,
  REMIND_OFFSETS,
  isSnoozeMinutes,
  isTaskBatchRequestOp,
  isTaskSort,
  isTaskStatsBucket,
  isTaskView,
  normalizeReminderTimes,
  normalizeTagNames,
  parseRepeatRule,
  remindAtFor,
  type RemindOffset,
  type RepeatRule,
  type TaskSort,
  type TaskStatsBucket,
} from '@shared/todos/model'
import type { TaskPriority, TaskStatus } from '@shared/assistant'
import { AssistantStore, type TaskQuery } from '../assistant/store'
import { insertFeed, listFeeds, revokeFeed, type OwnFeedRow } from '../todos/feeds'
import { addDays, isStatsDay, loadTodoStats } from '../todos/stats'

const BODY_LIMIT = JSON_BODY_LIMITS.settings
const TITLE_MAX = 300
const DESCRIPTION_MAX = 10_000
/** The longest a published calendar address may live; the same ceiling a note share carries. */
const FEED_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

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

/**
 * The day a plan names: one calendar date, or `null` for "not today".
 *
 * A day in the past is deliberately allowed. Picking a task into a day that has already happened is a
 * backfilled record — it is not shown in today, because today is compared as a string — and refusing
 * it would lose the fact rather than the membership. What is refused is text that is not a day at all,
 * including a date that does not exist on the calendar.
 */
function plannedDay(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !isStatsDay(value)) {
    throw ApiError.badRequest('A planned day must be a date like 2026-01-31, or null.')
  }
  return value
}

/**
 * The reminders a task request names: absolute instants, at most five, ascending and deduplicated.
 *
 * Absolute times rather than offsets from the due date, because a reminder is a fact about when to
 * speak and not about what the due date happens to be: moving the date later must not silently move
 * every reminder the reader set. The presets in the editor are a form shortcut that computes these
 * instants before saving. A list longer than the ceiling is refused rather than trimmed — silently
 * dropping the sixth would tell the reader it was saved.
 */
function reminderTimes(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw ApiError.badRequest('Reminders must be a list of instants.')
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw ApiError.badRequest('Each reminder must be a millisecond timestamp.')
    }
  }
  const unique = new Set(value.map((entry) => Math.trunc(entry)))
  if (unique.size > MAX_REMINDERS_PER_TASK) {
    throw ApiError.badRequest(`A task can carry at most ${MAX_REMINDERS_PER_TASK} reminders.`)
  }
  return normalizeReminderTimes(value)
}

/**
 * A reminder offset the request named, as the absolute instants the store takes.
 *
 * `none` is an explicit empty answer rather than a missing one — it suppresses the account's default.
 * The four real offsets are measured from this task's due date, so without one there is no instant.
 */
function reminderOffsetTimes(value: unknown, dueAt: number | null): number[] {
  if (typeof value !== 'string' || !REMIND_OFFSETS.includes(value as RemindOffset)) {
    throw ApiError.badRequest('A reminder offset must be none, due, 15m, 1h or 1d.')
  }
  const at = remindAtFor(dueAt, value as RemindOffset)
  return at === null ? [] : [at]
}

/**
 * The reminder a create writes when the body named neither a list nor an offset.
 *
 * The account's to-do default is an offset, measured once against this task's own due date: editing
 * the date later must not move a reminder the reader has already been given. A task with no date has
 * nothing to measure from, and a reader who never chose a default has null, so both get no reminder.
 */
function defaultReminderTimes(settingsRaw: string, dueAt: number | null): number[] {
  if (dueAt === null) return []
  const offset = mergeSettings(storedObject(settingsRaw)).todo.defaultRemind
  const at = offset === null ? null : remindAtFor(dueAt, offset)
  return at === null ? [] : [at]
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

/**
 * The ids a batch names: one to a hundred strings, in the order given, each once.
 *
 * A repeated id is one task, and completing or deleting it twice is not what the caller meant. The
 * ceiling is measured before deduplication, so a request that names 101 copies of one id is refused
 * rather than quietly answered — the limit is about what the client sent, not about what survived.
 */
function batchIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('A batch needs at least one task id.')
  }
  if (value.length > MAX_BATCH_TASKS) {
    throw ApiError.badRequest(`A batch may name at most ${MAX_BATCH_TASKS} tasks.`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') throw ApiError.badRequest('Each task id must be text.')
    if (seen.has(entry)) continue
    seen.add(entry)
    ids.push(entry)
  }
  return ids
}

/**
 * The revision a conditional write names.
 *
 * `If-Match` wins over a body field: it is the standard place for a precondition, and a client library
 * that adds the header must not be overruled by a body a caller forgot to update. `*` means "some live
 * row", which every route here already requires. A header the route cannot read is a 400 rather than an
 * unconditional write — silently dropping a guard is how the lost update came back.
 */
function requestRevision(c: Ctx, body: Record<string, unknown>): number | undefined {
  const header = c.req.header('If-Match')
  if (header !== undefined) {
    const value = header.trim()
    if (value === '*') return undefined
    const match = /^(?:W\/)?"?(\d+)"?$/.exec(value)
    const rev = match ? Number(match[1]) : Number.NaN
    if (!Number.isSafeInteger(rev) || rev < 1) {
      throw ApiError.badRequest('If-Match must name a task revision.')
    }
    return rev
  }
  const rev = body.rev
  if (rev === undefined || rev === null) return undefined
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) {
    throw ApiError.badRequest('rev must be the task revision.')
  }
  return rev
}

/**
 * The revision each row of a batch was read at, keyed by task id.
 *
 * A batch carries many revisions and one header cannot name them, so the map is the body's own shape.
 * A row whose revision does not match is a failure of that row, not of the batch: the same per-row
 * answer a missing id already gets.
 */
function batchRevisions(value: unknown): Map<string, number> {
  const revisions = new Map<string, number>()
  if (value === undefined || value === null) return revisions
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('A batch revision map must be an object keyed by task id.')
  }
  for (const [id, rev] of Object.entries(value)) {
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) {
      throw ApiError.badRequest('Each batch revision must be a task revision.')
    }
    revisions.set(id, rev)
  }
  return revisions
}

/** The 409 a guarded write answers with when the row moved: the store's own shape for a single task. */
function revisionConflict(id: string, rev: number | undefined): ApiError {
  return ApiError.conflict('The task changed since it was read. Reload it and try again.', { id, rev })
}

/** The flag a star batch sets. Absent means "star them", which is the gesture the bar offers. */
function batchStarValue(value: unknown): boolean {
  if (value === undefined || value === null || value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw ApiError.badRequest('A star batch takes true or false.')
}

/**
 * A list's or task's colour: one of the shared palette, or a hex the reader mixed themselves.
 *
 * Exported beside the icon validator below because the task routes judge the same two columns the
 * list and tag routes do, and a second copy of the rule would eventually disagree with this one.
 */
export function colorValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('A colour must be text.')
  const colour = organizerColorOrNull(value)
  if (!colour) throw ApiError.badRequest('That colour is not one of the palette.')
  return colour
}

/**
 * A list's or task's icon: one emoji, or the name of an icon the picker offers.
 *
 * Deliberately not `normalizeOrganizerIcon`, whose 8-unit ceiling is sized for the emoji a folder
 * stores — an icon name such as `Briefcase` is longer than that, and truncating it would leave a
 * value no picker could ever produce again. Exported for the same reason as the colour validator:
 * one rule for the list, the tag and the task faces.
 */
export function iconValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw ApiError.badRequest('An icon must be text.')
  const icon = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (icon.length > 40) throw ApiError.badRequest('That icon name is too long.')
  return icon || null
}

// ------------------------------------------------------------------- tasks

/**
 * The listing a request is asking for, in the shape the store reads it.
 *
 * Every filter the to-do app's screen can state is a parameter here, and this is the only place that
 * decides whether a parameter is one the app has a meaning for: an unreadable status, sort or date is a
 * 400 rather than a filter quietly dropped, because a listing that ignores the condition it was given
 * answers a different question than the one the reader asked.
 *
 * A completion window belongs to the finished view alone. On any other view it would either be dropped
 * (answering the unfiltered question) or empty the page (every open row has no completion day), so it is
 * refused there instead.
 */
function listingQuery(c: Ctx, timezone: string, dayEnd: number, today: string): TaskQuery {
  const list = c.req.query('list')
  const tag = c.req.query('tag')
  const priority = c.req.query('priority')
  const namedView = c.req.query('view')
  const view = isTaskView(namedView) ? namedView : 'all'
  const completedFrom = completionDay(c.req.query('completedFrom'), 'completedFrom')
  const completedTo = completionDay(c.req.query('completedTo'), 'completedTo')
  if ((completedFrom !== undefined || completedTo !== undefined) && view !== 'completed') {
    throw ApiError.badRequest('A completion window only applies to the completed view.')
  }
  const limit = Number(c.req.query('limit'))
  const offset = Number(c.req.query('offset'))
  return {
    status: taskStatusFilter(c.req.query('status')),
    view,
    // The inbox is a collection with no row behind it, so the address spells it `none` rather than
    // leaving the parameter out, which would mean "any list".
    listId: list === undefined ? undefined : list === 'none' ? null : requiredId(list),
    tagId: tag ? requiredId(tag) : undefined,
    priority: priority ? asPriority(priority) : undefined,
    starred: c.req.query('starred') === '1' ? true : undefined,
    query: c.req.query('q')?.trim().slice(0, 200) || undefined,
    dueFrom: optionalDue(c.req.query('dueFrom'), timezone),
    dueTo: optionalDue(c.req.query('dueTo'), timezone),
    completedFrom,
    completedTo,
    sort: asSort(c.req.query('sort')),
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TASKS_PER_QUERY, Math.trunc(limit))) : undefined,
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : undefined,
    dayEnd,
    // The one day the today view adds its picked rows by. Handed to the listing and the counts from
    // the same request, so the badge cannot be a day ahead of the page it opens.
    today,
  }
}

/**
 * The range and granularity a statistics request asks for.
 *
 * `from` and `to` are calendar days in the account's zone, both inclusive; missing values mean the last
 * 30 days, with `to` measured from the day the request lands on. A day that does not exist (30 February)
 * or a range that runs backwards is a 400 rather than an empty answer, because the reader asked a
 * different question than the one an empty range would answer. The comparison is lexical, which is exact
 * for `YYYY-MM-DD` and needs no zone arithmetic.
 */
function statsRange(c: Ctx, timezone: string): { from: string; to: string; bucket: TaskStatsBucket } {
  const today = localDate(Date.now(), timezone)
  const to = c.req.query('to') || today
  if (!isStatsDay(to)) throw ApiError.badRequest('A statistics range must end on a date like 2026-01-31.')
  const from = c.req.query('from') || addDays(to, -29)
  if (!isStatsDay(from)) throw ApiError.badRequest('A statistics range must start on a date like 2026-01-31.')
  if (from > to) throw ApiError.badRequest('A statistics range cannot start after it ends.')
  const bucket = c.req.query('bucket') ?? 'day'
  if (!isTaskStatsBucket(bucket)) throw ApiError.badRequest('A bucket must be day, week or month.')
  return { from, to, bucket }
}

todoRoutes.get('/', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const dayEnd = readerDayEnd(settings.timezone)
  const today = localDate(Date.now(), settings.timezone)
  const query = listingQuery(c, settings.timezone, dayEnd, today)
  // The page, its count and the sidebar numbers are three reads of the same account and no shared
  // transaction: a listing is allowed to be one write behind, and saying so is better than a fourth
  // round trip made while the reader waits.
  const [tasks, total, counts] = await Promise.all([
    s.listTasks(query),
    s.countTasks(query),
    s.taskCounts(dayEnd, today),
  ])
  return c.json({ tasks, total, counts, dayEnd, timezone: settings.timezone })
})

/**
 * The statistics screen's one read.
 *
 * Registered before `/:id` so "stats" is a route and not a task id. Validation and the account's zone
 * are all this handler adds; the rows, the arithmetic and the day boundaries live in `todos/stats`, which
 * keeps every query out of the route file.
 */
todoRoutes.get('/stats', async (c) => {
  const settings = await store(c).getSettings()
  const range = statsRange(c, settings.timezone)
  const stats = await loadTodoStats(c.env.DB, c.get('userId'), {
    ...range,
    timezone: settings.timezone,
    now: Date.now(),
  })
  return c.json(stats)
})

/** One page of the trash, newest deletion first; `total` counts the whole trash, not the page. */
function trashPageQuery(c: Ctx): { limit?: number; offset?: number } {
  const limit = Number(c.req.query('limit'))
  const offset = Number(c.req.query('offset'))
  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TASKS_PER_QUERY, Math.trunc(limit))) : undefined,
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : undefined,
  }
}

/**
 * The account's deleted tasks, and the two doors out of the trash.
 *
 * A deleted row is only hidden from every other read, so this is the one listing that asks for it
 * by name; restoring puts the same row back, and purging removes it with its children. Both writes
 * answer 404 for a live row or another account's id: the trash is a door, not a way around the
 * account scoping every other task route already carries. Static `/trash` is registered above
 * `/:id`, or it would be read as a task id.
 */
todoRoutes.get('/trash', async (c) => {
  return c.json(await store(c).listTrash(trashPageQuery(c)))
})

todoRoutes.post('/:id/restore', async (c) => {
  const s = store(c)
  const { task, droppedReminders } = await s.restoreTask(requiredId(c.req.param('id')))
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task, droppedReminders })
})

todoRoutes.delete('/:id/purge', async (c) => {
  const id = requiredId(c.req.param('id'))
  if (!(await store(c).purgeTask(id))) throw ApiError.notFound('Task not found')
  return c.json({ purged: true })
})

// ------------------------------------------------------------------- feed

/**
 * The owner's half of the calendar subscription: mint, list and revoke.
 *
 * E02's public reader (`routes/todo-feeds.ts`) already serves a slug; these are the three calls that
 * produce and retire one. They sit on this router rather than beside the reader because they are the
 * account's own writes and must inherit its session, its write budget and its account scoping — the
 * reader deliberately has none of those. Static `/feed` is registered above `/:id`, or "feed" would be
 * read as a task id.
 *
 * The address a calendar subscribes to is `<origin>/feeds/<slug>.ics`, and a protected feed's passcode
 * is never part of it: the key travels as `?key=`, which the reader verifies, so an address copied out
 * of a screen or a log is a capability plus a marker, not the capability plus its secret.
 */

/** The shape the settings screen lists and the create answer returns — never a passcode hash. */
function feedInfo(row: OwnFeedRow, origin: string) {
  return {
    slug: row.slug,
    url: `${origin}/feeds/${row.slug}.ics`,
    hasPassword: row.has_password !== 0,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/**
 * The expiry a request asked for, measured from now; `null`, `0` or an absent value mean "no expiry".
 *
 * Same arithmetic and the same 365-day ceiling as a note share: an address that can be revoked is
 * allowed to live long, but not forever by accident. A negative, non-finite or non-numeric value is a
 * 400 rather than a silently dropped condition — the caller would otherwise believe they set one.
 */
function feedExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw ApiError.badRequest('expiresIn must be a non-negative number or null')
  }
  return value > 0 ? Date.now() + Math.min(value, FEED_MAX_AGE_MS) : null
}

todoRoutes.get('/feed', async (c) => {
  const rows = await listFeeds(c.env.DB, c.get('userId'))
  const origin = new URL(c.req.url).origin
  return c.json({ feeds: rows.map((row) => feedInfo(row, origin)) })
})

/**
 * Mints one feed under a new slug.
 *
 * The passcode is validated with the shares' own rule and stored through `hashPassword`, so there is
 * one passcode scheme across the product and this route never sees the hash again. The plaintext is
 * not echoed anywhere: the answer carries `hasPassword`, and the address stays key-free.
 */
todoRoutes.post('/feed', async (c) => {
  const body = await readJson<{ password?: unknown, expiresIn?: unknown }>(c, BODY_LIMIT)
  if (body.password !== undefined && body.password !== null && typeof body.password !== 'string') {
    throw ApiError.badRequest('password must be a string or null')
  }
  const passcodeProblem = sharePasscodeProblem(body.password)
  if (passcodeProblem) throw ApiError.badRequest(passcodeProblem)
  const expiresAt = feedExpiry(body.expiresIn)
  const passwordHash = typeof body.password === 'string' && body.password
    ? await hashPassword(body.password)
    : null
  const now = Date.now()
  const slug = newSlug()
  await insertFeed(c.env.DB, { slug, userId: c.get('userId'), passwordHash, expiresAt, now })
  const feed = feedInfo(
    { slug, has_password: passwordHash ? 1 : 0, expires_at: expiresAt, created_at: now },
    new URL(c.req.url).origin,
  )
  return c.json({ feed }, 201)
})

/**
 * Retires one feed by stamping `revoked_at`.
 *
 * The slug is validated before the update, and the account is part of the predicate: a value that
 * belongs to somebody else is the same 404 as one that never existed. An already revoked feed answers
 * 404 too — "it is not live" is the whole truth, and a 200 would suggest the address still works.
 */
todoRoutes.delete('/feed/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) throw ApiError.notFound('The subscription does not exist')
  if (!(await revokeFeed(c.env.DB, c.get('userId'), slug, Date.now()))) {
    throw ApiError.notFound('The subscription does not exist')
  }
  return c.json({ ok: true })
})

/**
 * One change applied to every task the caller picked.
 *
 * A batch is not a transaction: the rows that can change do, and the rows that cannot are named with
 * the reason they did not. That is what lets a selection survive a row another tab finished and a
 * stale id: a 200 that says ninety-nine changed and one was gone is a more useful answer than a 409
 * that leaves the reader guessing which. Ids are scoped by the store, so another account's id is
 * `not found` here exactly as it is on the single-task routes; the answer never says whether it exists
 * somewhere else.
 *
 * The write bucket counts the call once, through the middleware every other write already passes: a
 * batch is one gesture from the client, and a second, unmetered door for it is how a batch becomes a
 * bypass. The work inside is bounded by `MAX_BATCH_TASKS`.
 */
todoRoutes.post('/batch', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (!isTaskBatchRequestOp(body.op)) {
    throw ApiError.badRequest('A batch operation must be complete, delete, move, priority, star, tag or due.')
  }
  const op = body.op
  const ids = batchIds(body.ids)
  const revisions = batchRevisions(body.revs)
  // The target is validated once, before any row changes: a list that does not exist is a bad request
  // about the batch, not a failure of each row inside it.
  let moveListId: string | null = null
  let priority: TaskPriority = 'medium'
  let starred = true
  let tagAdd: string[] = []
  let dueAt: number | null = null
  switch (op) {
    case 'move':
      if (body.value === undefined) throw ApiError.badRequest('A move needs a list id, or null for the inbox.')
      moveListId = await listRef(s, body.value)
      break
    case 'priority':
      priority = asPriority(body.value)
      break
    case 'star':
      starred = batchStarValue(body.value)
      break
    case 'tag':
      if (typeof body.value !== 'string' && !Array.isArray(body.value)) {
        throw ApiError.badRequest('Tags must be a list of names.')
      }
      tagAdd = normalizeTagNames(body.value)
      if (!tagAdd.length) throw ApiError.badRequest('A tag batch needs at least one tag name.')
      break
    case 'due': {
      // The banner's gesture: absent value means "the end of the reader's today", which is the one
      // instant that is both not overdue and still inside today. An explicit value uses the same
      // grammar a single task's due date does, so a day or a date-time both read as they always do.
      const target = body.value === undefined || body.value === null || body.value === ''
        ? parseLocalTime(localDate(Date.now(), settings.timezone), settings.timezone)
        : parseDue(body.value, settings.timezone)
      if (target === null) throw ApiError.badRequest('A due batch needs a day like 2026-01-31.')
      dueAt = target
      break
    }
    default:
      break
  }

  const done: string[] = []
  const failed: { id: string; reason: string }[] = []
  for (const id of ids) {
    try {
      const existing = await s.getTask(id)
      if (!existing) {
        failed.push({ id, reason: 'not found' })
        continue
      }
      const expectedRev = revisions.get(id)
      if (expectedRev !== undefined && existing.rev !== expectedRev) {
        failed.push({ id, reason: 'conflict' })
        continue
      }
      switch (op) {
        case 'complete':
          // The store method, not a status column: a repeating task has to file its next occurrence,
          // and that happens in exactly one place. The row's own revision rides along, so a row that
          // moved between the read above and this press is refused per row rather than finished over
          // whoever changed it.
          if (!(await s.completeTask(id, settings.timezone, expectedRev))) {
            failed.push({ id, reason: 'not found' })
            continue
          }
          break
        case 'delete':
          await s.deleteTask(id)
          break
        case 'move':
          // The same door a card drop uses, with a null anchor: the end of the destination. Naming only
          // the list would leave the row's old place on it, and it would sort into the middle of an
          // order the reader never put it in — a batch is not a different kind of move.
          if (!(await s.moveTask(id, { beforeId: null, listId: moveListId }, expectedRev))) {
            failed.push({ id, reason: 'not found' })
            continue
          }
          break
        case 'priority':
          if (!(await s.updateTask(id, { priority }, settings.timezone, expectedRev))) {
            failed.push({ id, reason: 'not found' })
            continue
          }
          break
        case 'star':
          if (!(await s.updateTask(id, { starred }, settings.timezone, expectedRev))) {
            failed.push({ id, reason: 'not found' })
            continue
          }
          break
        case 'tag':
          // `setTaskTags` replaces, so the row's own words go back in front of the new ones: the bar's
          // action is "add a tag", not "set this row's whole vocabulary".
          await s.setTaskTags(id, [...existing.tags.map((tag) => tag.name), ...tagAdd])
          break
        case 'due':
          // Only `due_at` moves. `planned_for` is the reader's own pick and stays exactly where it was,
          // which is why this goes through a partial patch rather than a read-modify-write of the row.
          if (!(await s.updateTask(id, { dueAt: dueAt as number }, settings.timezone, expectedRev))) {
            failed.push({ id, reason: 'not found' })
            continue
          }
          break
      }
      done.push(id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The row moved between the read above and the guarded write: the same per-row answer the
        // pre-check gives, and the rest of the batch still lands.
        failed.push({ id, reason: 'conflict' })
        continue
      }
      if (!(error instanceof ApiError)) {
        // Reported per row below; the log is what tells an operator a batch failure was the database
        // rather than the id.
        console.error(`[inkstone] batch ${op} failed for task ${id}:`, error)
      }
      failed.push({ id, reason: error instanceof Error ? error.message : 'failed' })
    }
  }
  return c.json({ done, failed })
})

todoRoutes.post('/', async (c) => {
  const s = store(c)
  const settings = await s.getSettings()
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const dueAt = parseDue(body.dueAt, settings.timezone)
  // A start date is read with the due date's own grammar — a local date, a local date-time, an instant
  // or nothing — because it is the same kind of fact and a second parser would eventually disagree.
  const startAt = parseDue(body.startAt, settings.timezone)
  const reminders = body.reminders !== undefined
    ? reminderTimes(body.reminders)
    : body.remind !== undefined
      ? reminderOffsetTimes(body.remind, dueAt)
      : defaultReminderTimes(c.get('user')?.settingsRaw ?? '', dueAt)
  const task = await s.createTask({
    title: text(body.title, TITLE_MAX, 'A task title'),
    description: optionalText(body.description, DESCRIPTION_MAX, 'A task note') ?? '',
    status: body.status === undefined ? undefined : asStatus(body.status),
    priority: body.priority === undefined ? undefined : asPriority(body.priority),
    dueAt,
    startAt,
    projectId: await projectRef(s, body.projectId),
    listId: await listRef(s, body.listId),
    // The task's own face, judged by the list and tag routes' own validators: a colour outside the
    // palette and an icon name past the ceiling are a 400 here rather than a face the pickers could
    // never produce again. Absent leaves the list's to show through.
    icon: iconValue(body.icon) ?? null,
    color: colorValue(body.color) ?? null,
    starred: body.starred === undefined ? undefined : asBoolean(body.starred, 'starred'),
    repeat: asRepeat(body.repeat),
    reminders,
    noteId: optionalId(body.noteId, 'noteId') ?? null,
    conversationId: optionalId(body.conversationId, 'conversationId') ?? null,
    tags: tagNames(body.tags),
    steps: stepTexts(body.steps),
  })
  await s.recordActivity('task.created', task.title)
  return c.json({ task }, 201)
})

/**
 * Picks one task into a day, or takes it back out with `null`.
 *
 * A separate endpoint rather than a `plannedFor` field on PATCH: the pick is its own gesture with its
 * own body shape (`{date}`), and the old client's PATCH never has to learn about a column it does not
 * send. The task id is scoped by the store, so another account's id is a 404 like every other id here.
 *
 * The guard is the store's, not a read of this row's own: the route hands over the revision the caller
 * named and the write either matches it or refuses. Reading the row here to compare first was a second
 * copy of the same rule, and the two disagreed inside the window between the read and the write — the
 * exact window a conditional write exists to close.
 */
todoRoutes.post('/:id/plan', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const expectedRev = requestRevision(c, body)
  const task = await s.planTask(id, plannedDay(body.date), expectedRev)
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task })
})

/**
 * Where a move wants the task: before this row, or at the end with null.
 *
 * The anchor is required rather than optional, because an absent field would make an empty body mean
 * "append" — silently moving a task the caller forgot to describe. A missing anchor is a 400, the
 * same way a malformed one is.
 */
function moveAnchor(value: unknown, taskId: string): string | null {
  if (value === undefined) throw ApiError.badRequest('A move needs beforeId, or null for the end.')
  if (value === null) return null
  if (!isValidId(value)) throw ApiError.badRequest('beforeId must be a task id, or null.')
  if (value === taskId) throw ApiError.badRequest('A task cannot be placed before itself.')
  return value
}

/**
 * Places one task before another row, optionally in another list.
 *
 * A route of its own rather than a field on PATCH: a move is one answer about order (and maybe one
 * collection), while PATCH owns the row's content. The anchor is scoped by the store, so another
 * account's task is a 404 and an anchor outside the destination is a 400 that names the request.
 * `listId` absent keeps the task where it is; null is the inbox, the same reading every other list
 * field in this file gives it.
 *
 * The revision the caller named goes to the store rather than being checked against a read here: a
 * drop computed from a listing the row has already moved past must not land, and the guard that says so
 * belongs on the write, not beside it.
 */
todoRoutes.post('/:id/move', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  const beforeId = moveAnchor(body.beforeId, id)
  const expectedRev = requestRevision(c, body)
  const listId = body.listId === undefined ? undefined : await listRef(s, body.listId)
  const task = await s.moveTask(id, { beforeId, listId }, expectedRev)
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task })
})

/**
 * "Remind me again": append one reminder some minutes from now.
 *
 * Appended, never substituted — a snooze is a second chance, and the reminder the reader set earlier
 * is still theirs to receive. The four durations are the only body shape; absolute instants are what
 * the task endpoints already take, and a second way to say the same thing would be a second validator
 * to keep in step. A finished task is refused because nothing will ever be announced for it, and a
 * task already at the five-reminder ceiling is refused rather than silently dropping one.
 *
 * The row is read here for those two questions only — what this request is asking for. Whether the
 * caller still holds it is the store's guard to answer, so the revision rides to `snoozeTask` and the
 * reminder is queued only when the row it lands on is the row the caller saw.
 */
todoRoutes.post('/:id/snooze', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  if (!isSnoozeMinutes(body.minutes)) {
    throw ApiError.badRequest('A snooze must be 10, 60, 540 or 1440 minutes.')
  }
  const expectedRev = requestRevision(c, body)
  const existing = await s.getTask(id)
  if (!existing) throw ApiError.notFound('Task not found')
  if (existing.status === 'done') throw ApiError.badRequest('A finished task cannot be snoozed.')
  if ((existing.reminders?.length ?? 0) >= MAX_REMINDERS_PER_TASK) {
    throw ApiError.badRequest(`This task already has ${MAX_REMINDERS_PER_TASK} reminders.`)
  }
  const task = await s.snoozeTask(id, Date.now() + body.minutes * 60_000, expectedRev)
  if (!task) throw ApiError.notFound('Task not found')
  return c.json({ task, reminders: task.reminders ?? [] })
})

// ------------------------------------------------------------------- lists

/**
 * The account's lists: the working ones by default, the archive when it is asked for by name.
 *
 * Archiving is a shelf, not a deletion: a list asked for under `archived=1` still carries the tasks
 * it holds, and the archive section is the only screen that reads that half. Every account-wide
 * count leaves a put-away list's tasks out, so the badge and the working page agree.
 */
todoRoutes.get('/lists', async (c) => {
  return c.json({ lists: await store(c).listTaskLists({ archived: c.req.query('archived') === '1' }) })
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
  const existing = await s.getTaskList(id)
  if (!existing) throw ApiError.notFound('List not found')
  // Grouping is one level deep. The parent is read first, so "that parent does not exist" is a 400
  // about the request rather than a 404 that would confirm an id in another account; a child used as
  // a parent, a list put under itself and a container moved under another list are all the same
  // refusal, because each would make the tree more than one level tall.
  let parentId: string | null | undefined
  if (body.parentId !== undefined) {
    parentId = optionalId(body.parentId, 'parentId')
    if (parentId != null) {
      if (parentId === id) throw ApiError.badRequest('A list cannot be grouped under itself.')
      const parent = await s.getTaskList(parentId)
      if (!parent) throw ApiError.badRequest('That parent list does not exist.')
      if (parent.parentId !== null) throw ApiError.badRequest('Lists can only be grouped one level deep.')
      if ((await s.countTaskListChildren(id)) > 0) {
        throw ApiError.badRequest('A list with its own sub-lists cannot be grouped under another list.')
      }
    }
  }
  const list = await s.updateTaskList(id, {
    ...(body.name !== undefined ? { name: text(body.name, MAX_LIST_NAME_CHARS, 'A list name') } : {}),
    ...(body.icon !== undefined ? { icon: iconValue(body.icon) ?? null } : {}),
    ...(body.color !== undefined ? { color: colorValue(body.color) ?? null } : {}),
    ...(typeof body.position === 'number' ? { position: body.position } : {}),
    // The stamp is the moment the list left the working page. A false answer clears it instead of
    // writing a second value, so unarchiving restores exactly the state the list was in.
    ...(body.archived !== undefined ? { archivedAt: asBoolean(body.archived, 'archived') ? Date.now() : null } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
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
  const expectedRev = requestRevision(c, body)
  const existing = await s.getTask(id)
  if (!existing) throw ApiError.notFound('Task not found')
  // A guard that already disagrees is refused before anything is written. Once the patch below has
  // written, that write has spent the revision, and the completion after it can only lean on this
  // pre-check as its conflict check. While nothing has been written — a bare tick — the revision the
  // caller named still stands, so `completeTask` is guarded by it too.
  if (expectedRev !== undefined && existing.rev !== expectedRev) throw revisionConflict(id, existing.rev)
  const dueAt = body.dueAt === undefined ? undefined : parseDue(body.dueAt, settings.timezone)
  // Absent leaves the column alone; null clears it, exactly as the due date's own field reads.
  const startAt = body.startAt === undefined ? undefined : parseDue(body.startAt, settings.timezone)
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
    ...(startAt !== undefined ? { startAt } : {}),
    ...(body.projectId !== undefined ? { projectId: await projectRef(s, body.projectId) } : {}),
    ...(body.listId !== undefined ? { listId: await listRef(s, body.listId) } : {}),
    // The face columns follow the list route's own reading: absent leaves the column alone, null
    // clears it back to the list's, and an unusable value is a 400 rather than a silent drop.
    ...(body.icon !== undefined ? { icon: iconValue(body.icon) ?? null } : {}),
    ...(body.color !== undefined ? { color: colorValue(body.color) ?? null } : {}),
    ...(body.starred !== undefined ? { starred: asBoolean(body.starred, 'starred') } : {}),
    ...(body.repeat !== undefined ? { repeat: asRepeat(body.repeat) } : {}),
    ...(body.reminders !== undefined ? { reminders: reminderTimes(body.reminders) } : {}),
    ...(body.noteId !== undefined ? { noteId: optionalId(body.noteId, 'noteId') } : {}),
    ...(body.conversationId !== undefined ? { conversationId: optionalId(body.conversationId, 'conversationId') } : {}),
    ...(body.tags !== undefined ? { tags: tagNames(body.tags) ?? [] } : {}),
  }
  // Whether this request also names content. A write here spends the revision the caller named, so a
  // second write made by the same request — the completion, or a reopen — must not name it again: the
  // guard would refuse this caller's own follow-up. A bare tick writes nothing first, and so keeps its
  // guard: the completion is that request's only write, and it should answer for the read it came from.
  const wroteFields = Object.keys(patch).length > 0
  let task = wroteFields
    ? await s.updateTask(id, patch, settings.timezone, expectedRev)
    : existing
  if (!task) throw ApiError.notFound('Task not found')
  let next = null
  if (completing) {
    const done = await s.completeTask(id, settings.timezone, wroteFields ? undefined : expectedRev)
    if (!done) throw ApiError.notFound('Task not found')
    task = done.task
    next = done.next
    await s.recordActivity('task.completed', task.title)
  } else if (nextStatus !== undefined && nextStatus !== task.status) {
    task = (await s.updateTask(
      id,
      { status: nextStatus },
      settings.timezone,
      wroteFields ? undefined : expectedRev,
    )) ?? task
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

/**
 * Where a step move wants the row, read from a PATCH body.
 *
 * `position` is the zero-based index the step lands on after the move, and `beforeStepId` is the
 * sibling it should sit before (`null` is the end) — the same anchor folders take. Naming both leaves
 * two answers to one question, so it is refused; naming neither is not a move and answers null. The
 * index is validated here and clamped by the store, because a place past the end is the last place.
 */
function stepPlacement(body: Record<string, unknown>): { beforeStepId: string | null } | { position: number } | null {
  const numbered = body.position !== undefined
  const anchored = body.beforeStepId !== undefined
  if (!numbered && !anchored) return null
  if (numbered && anchored) throw ApiError.badRequest('A step move names position or beforeStepId, not both.')
  if (numbered) {
    const value = body.position
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw ApiError.badRequest('position must be a whole step number from zero.')
    }
    return { position: value }
  }
  const value = body.beforeStepId
  if (value === null) return { beforeStepId: null }
  if (!isValidId(value)) throw ApiError.badRequest('beforeStepId must be a step id, or null.')
  return { beforeStepId: value }
}

todoRoutes.patch('/:id/steps/:stepId', async (c) => {
  const s = store(c)
  const id = requiredId(c.req.param('id'))
  const stepId = requiredId(c.req.param('stepId'))
  const body = await readJson<Record<string, unknown>>(c, BODY_LIMIT)
  // Text and tick are validated before anything is written, so a body that is half wrong cannot
  // leave the row moved. The move goes first: its anchor can still be refused, and a refusal after
  // the text had landed would be a partial edit.
  const patch = {
    ...(body.text !== undefined ? { text: text(body.text, MAX_STEP_TEXT_CHARS, 'A step') } : {}),
    ...(body.done !== undefined ? { done: asBoolean(body.done, 'done') } : {}),
  }
  const placement = stepPlacement(body)
  if (placement && 'beforeStepId' in placement && placement.beforeStepId === stepId) {
    throw ApiError.badRequest('A step cannot be placed before itself.')
  }
  let step = placement ? await s.moveStep(id, stepId, placement) : null
  if (placement && !step) throw ApiError.notFound('Step not found')
  if (Object.keys(patch).length) step = await s.updateStep(id, stepId, patch)
  if (!step) throw ApiError.notFound('Step not found')
  return c.json({ step })
})

todoRoutes.delete('/:id/steps/:stepId', async (c) => {
  const s = store(c)
  const removed = await s.deleteStep(requiredId(c.req.param('id')), requiredId(c.req.param('stepId')))
  if (!removed) throw ApiError.notFound('Step not found')
  return c.json({ deleted: true })
})

function taskStatusFilter(value: string | undefined): TaskQuery['status'] {
  if (!value || value === 'all' || value === 'open') return (value ?? 'all') as TaskStatus | 'open' | 'all'
  // One status answers with the single-value form, several with the set; either way an unknown word is a
  // refusal and not a filter that happens to match everything.
  const wanted = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))].map(asStatus)
  return wanted.length > 1 ? wanted : wanted[0] ?? 'all'
}

/** A due bound: a local date, a local date-time, or nothing at all. */
function optionalDue(value: string | undefined, timezone: string): number | undefined {
  if (value === undefined || value === '') return undefined
  // `parseDue` reads a blank as "no date", which is the parameter being absent; a date it cannot read at
  // all is the 400 it throws rather than a filter that silently matches everything.
  return parseDue(value, timezone) ?? undefined
}

/**
 * A completion bound: one account-zone calendar day, or nothing at all.
 *
 * No range check is made on the pair — a window that ends before it starts matches no row, and saying
 * "nothing was finished then" is the honest answer to a question with nothing in it, not a 400.
 */
function completionDay(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === '') return undefined
  if (!isStatsDay(value)) throw ApiError.badRequest(`${field} must be a date like 2026-01-31.`)
  return value
}

/** The order the caller asked the listing to be read in, or none. */
function asSort(value: string | undefined): TaskSort | undefined {
  if (value === undefined || value === '') return undefined
  if (!isTaskSort(value)) throw ApiError.badRequest('A sort must be due, priority, created or completed.')
  return value
}
