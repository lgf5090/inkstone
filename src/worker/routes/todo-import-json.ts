/**
 * `POST /api/todos/import-json` restores the document written by the JSON to-do export.
 *
 * The envelope is checked before anything is written. A truncated export is refused outright, and the
 * task and byte ceilings are refusals rather than slices: neither a short import nor a silently clipped
 * field may look like a restore. Rows are then validated independently so one bad task does not discard
 * the usable rows beside it.
 *
 * Source ids are used only to resolve parent/dependency references inside the document. New task ids are
 * minted by AssistantStore, as are creation timestamps. Lists must already exist in the importing
 * account; tags are resolved by name and created in that account. This prevents a document from linking
 * one account to another account's list or tag rows.
 *
 * `conflict=skip` (the default) recognises an existing task by its normalised title, note, list and
 * start/due instants. `conflict=duplicate` always creates a new row. An `Idempotency-Key` is stronger: a
 * retry of the same key and document replays the first answer, while reusing the key for another
 * document is a 409. The key intentionally does not retry failed rows; fix the document and use a new
 * key for that new operation.
 *
 * A row failure is reported in `errors` with its one-based row number. If failure happens after the task
 * row was created (for example while applying dependencies), `taskId` says so explicitly. Earlier rows
 * stay committed: this endpoint has partial-success semantics, not an all-or-nothing transaction.
 */

import { Hono } from 'hono'
import {
  MAX_REPEAT_COUNT,
  MAX_REPEAT_EXCLUDED_DAYS,
  MAX_REPEAT_INTERVAL,
  MAX_REPEAT_UNTIL_MS,
  MAX_STEPS_PER_TASK,
  MAX_STEP_TEXT_CHARS,
  MAX_TAGS_PER_TASK,
  MAX_TAG_NAME_CHARS,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TASK_ICON_CHARS,
  MAX_TIME_ESTIMATE_MS,
  MIN_REPEAT_COUNT,
  MIN_REPEAT_INTERVAL,
  isRepeatFrequency,
  isTimeEstimateMs,
  isTodoTimestamp,
  normalizeReminderTimes,
  normalizeTagNames,
  parseRepeatRule,
  taskColorOrNull,
  taskIconOrNull,
  type RepeatRule,
} from '@shared/todos/model'
import { TASK_PRIORITIES, TASK_STATUSES, MAX_TASK_TITLE_CHARS } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { AssistantStore, MAX_DEPS_PER_TASK, type NewTask } from '../assistant/store'
import type { AppBindings } from '../env'
import { isValidId } from '../lib/id'
import { ApiError } from '../lib/errors'
import { runIdempotent } from '../mcp/operations'
import { createMinuteBudget } from '../lib/rate-limit'
import { readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { isStatsDay } from '../todos/stats'

/** A bounded write unit: large exports are refused rather than partially walked without saying so. */
export const MAX_TODO_JSON_IMPORT_TASKS = 500

/** Room for the same compact JSON export at the task ceiling, including escaped text and metadata. */
export const MAX_TODO_JSON_IMPORT_BYTES = 16 * 1024 * 1024

/** Each call spends one of the account's import requests for the current minute. */
export const TODO_JSON_IMPORT_BUDGET_PER_MINUTE = 30

const takeBudget = createMinuteBudget(
  TODO_JSON_IMPORT_BUDGET_PER_MINUTE,
  'Too many imports at once. Try again in a minute.',
)

type Conflict = 'skip' | 'duplicate'
type RawRecord = Record<string, unknown>

interface ImportedStep {
  text: string
  done: boolean
}

interface ImportRow {
  index: number
  sourceId: string
  input: NewTask
  dependsOn: string[]
  steps: ImportedStep[] | null
  stepTotal: number
}

interface ImportError {
  row: number
  sourceId: string | null
  reason: string
  taskId?: string
}

interface ImportWarning {
  row: number
  sourceId: string
  reason: string
}

interface ImportResult {
  total: number
  created: number
  skipped: number
  failed: number
  partial: boolean
  imported: Array<{ row: number, sourceId: string, taskId: string }>
  errors: ImportError[]
  warnings: ImportWarning[]
}

function record(value: unknown, label: string): RawRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as RawRecord
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const text = value.trim()
  if (!text) throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} cannot exceed ${max} characters`)
  return text
}

function optionalText(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  if (value.length > max) throw new Error(`${label} cannot exceed ${max} characters`)
  return value
}

function timestamp(value: unknown, label: string): number {
  if (!isTodoTimestamp(value)) throw new Error(`${label} must be a supported millisecond timestamp`)
  return value
}

function nullableTimestamp(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  return timestamp(value, label)
}

function nullableId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (!isValidId(value)) throw new Error(`${label} must be an id or null`)
  return value
}

function referenceId(value: unknown, label: string): string {
  if (!isValidId(value)) throw new Error(`${label} must be an id`)
  return value
}

function nullableFlag(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new Error(`${label} must be true, false or null`)
  return value
}

function repeatRule(value: unknown): RepeatRule | null {
  if (value === undefined || value === null) return null
  const raw = record(value, 'repeat')
  if (!isRepeatFrequency(raw.freq)) throw new Error('repeat.freq must be daily, weekly, monthly or yearly')
  if (typeof raw.interval !== 'number' || !Number.isInteger(raw.interval)
    || raw.interval < MIN_REPEAT_INTERVAL || raw.interval > MAX_REPEAT_INTERVAL) {
    throw new Error(`repeat.interval must be between ${MIN_REPEAT_INTERVAL} and ${MAX_REPEAT_INTERVAL}`)
  }
  if (raw.untilAt !== undefined && raw.untilAt !== null
    && (!isTodoTimestamp(raw.untilAt) || raw.untilAt > MAX_REPEAT_UNTIL_MS)) {
    throw new Error('repeat.untilAt must be a supported millisecond timestamp')
  }
  if (raw.count !== undefined && raw.count !== null
    && (typeof raw.count !== 'number' || !Number.isInteger(raw.count)
      || raw.count < MIN_REPEAT_COUNT || raw.count > MAX_REPEAT_COUNT)) {
    throw new Error(`repeat.count must be between ${MIN_REPEAT_COUNT} and ${MAX_REPEAT_COUNT}`)
  }
  if (raw.produced !== undefined && raw.produced !== null
    && (typeof raw.produced !== 'number' || !Number.isInteger(raw.produced)
      || raw.produced < 0 || raw.produced > MAX_REPEAT_COUNT)) {
    throw new Error(`repeat.produced must be between 0 and ${MAX_REPEAT_COUNT}`)
  }
  if (raw.excludedDays !== undefined && raw.excludedDays !== null) {
    if (!Array.isArray(raw.excludedDays) || raw.excludedDays.length > MAX_REPEAT_EXCLUDED_DAYS
      || raw.excludedDays.some((day) => typeof day !== 'string' || !isStatsDay(day))) {
      throw new Error('repeat.excludedDays must contain valid YYYY-MM-DD dates')
    }
  }
  const parsed = parseRepeatRule(raw)
  if (!parsed) throw new Error('repeat is not a rule this app can read')
  return parsed
}

function reminderTimes(raw: RawRecord): number[] {
  const value = raw.reminders === undefined ? raw.remindAt : raw.reminders
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('reminders must be a list of millisecond timestamps')
  if (value.length > 5) throw new Error('A task can carry at most 5 reminders')
  const times = value.map((entry) => timestamp(entry, 'reminder'))
  if (new Set(times).size > 5) throw new Error('A task can carry at most 5 reminders')
  return normalizeReminderTimes(times)
}

function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('tags must be a list')
  if (value.length > MAX_TAGS_PER_TASK) throw new Error(`A task can carry at most ${MAX_TAGS_PER_TASK} tags`)
  const names: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const tag = record(entry, 'tag')
    if (tag.id !== undefined && !isValidId(tag.id)) throw new Error('tag.id must be an id')
    const name = requiredText(tag.name, 'tag.name', MAX_TAG_NAME_CHARS)
    const normalized = normalizeTagNames([name])
    if (normalized.length !== 1 || normalized[0] !== name) {
      throw new Error('tag.name must be a plain name of at most 40 characters')
    }
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) throw new Error('tags must not repeat a name')
    seen.add(key)
    names.push(name)
  }
  return names
}

function dependencyIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('dependsOn must be a list')
  if (value.length > MAX_DEPS_PER_TASK) throw new Error(`A task can wait on at most ${MAX_DEPS_PER_TASK} others`)
  const ids = value.map((entry) => referenceId(record(entry, 'dependency').id, 'dependency.id'))
  if (new Set(ids).size !== ids.length) throw new Error('dependsOn must not repeat a task')
  return ids
}

function importedSteps(value: unknown): ImportedStep[] | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) throw new Error('steps must be a list')
  if (value.length > MAX_STEPS_PER_TASK) throw new Error(`A task can carry at most ${MAX_STEPS_PER_TASK} steps`)
  return value.map((entry) => {
    if (typeof entry === 'string') return { text: requiredText(entry, 'step', MAX_STEP_TEXT_CHARS), done: false }
    const step = record(entry, 'step')
    if (step.done !== undefined && typeof step.done !== 'boolean') throw new Error('step.done must be true or false')
    return {
      text: requiredText(step.text, 'step.text', MAX_STEP_TEXT_CHARS),
      done: step.done === true,
    }
  })
}

function parseRow(value: unknown, index: number): ImportRow {
  const raw = record(value, 'task')
  const sourceId = referenceId(raw.id, 'task.id')
  const title = requiredText(raw.title, 'task.title', MAX_TASK_TITLE_CHARS)
  if (typeof raw.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(raw.status)) {
    throw new Error('task.status must be todo, in_progress, done or cancelled')
  }
  if (typeof raw.priority !== 'string' || !(TASK_PRIORITIES as readonly string[]).includes(raw.priority)) {
    throw new Error('task.priority must be low, medium, high or urgent')
  }
  if (raw.starred !== undefined && typeof raw.starred !== 'boolean') throw new Error('task.starred must be true or false')
  if (raw.deletedAt !== undefined && raw.deletedAt !== null) throw new Error('A trashed task cannot be imported')
  const dueAt = nullableTimestamp(raw.dueAt, 'task.dueAt')
  const startAt = nullableTimestamp(raw.startAt, 'task.startAt')
  const dueAllDay = raw.dueAllDay === undefined ? false : raw.dueAllDay
  if (typeof dueAllDay !== 'boolean') throw new Error('task.dueAllDay must be true or false')
  const dueOn = raw.dueOn === undefined || raw.dueOn === null ? null : raw.dueOn
  if (dueOn !== null && (typeof dueOn !== 'string' || !isStatsDay(dueOn))) {
    throw new Error('task.dueOn must be a YYYY-MM-DD date or null')
  }
  if (dueAllDay && dueOn === null) throw new Error('An all-day task needs task.dueOn')
  if (dueAllDay && dueAt === null) throw new Error('An all-day task needs task.dueAt')
  if (!dueAllDay && dueOn !== null) throw new Error('task.dueOn is only valid for an all-day task')
  if (startAt !== null && dueAt !== null && startAt > dueAt) {
    throw new Error('task.startAt cannot be after task.dueAt')
  }
  const plannedFor = raw.plannedFor === undefined || raw.plannedFor === null ? null : raw.plannedFor
  if (plannedFor !== null && (typeof plannedFor !== 'string' || !isStatsDay(plannedFor))) {
    throw new Error('task.plannedFor must be a YYYY-MM-DD date or null')
  }
  const estimate = raw.timeEstimateMs === undefined || raw.timeEstimateMs === null ? null : raw.timeEstimateMs
  if (estimate !== null && !isTimeEstimateMs(estimate)) {
    throw new Error(`task.timeEstimateMs must be between 0 and ${MAX_TIME_ESTIMATE_MS}`)
  }
  const icon = raw.icon === undefined || raw.icon === null ? null : raw.icon
  if (icon !== null && (typeof icon !== 'string' || icon.length > MAX_TASK_ICON_CHARS || taskIconOrNull(icon) === null)) {
    throw new Error('task.icon is not an icon this app can store')
  }
  const color = raw.color === undefined || raw.color === null ? null : raw.color
  if (color !== null && (typeof color !== 'string' || taskColorOrNull(color) === null)) {
    throw new Error('task.color is not a colour this app can store')
  }
  const stepTotal = raw.stepTotal === undefined ? 0 : raw.stepTotal
  const stepDone = raw.stepDone === undefined ? 0 : raw.stepDone
  if (typeof stepTotal !== 'number' || !Number.isInteger(stepTotal) || stepTotal < 0 || stepTotal > MAX_STEPS_PER_TASK) {
    throw new Error(`task.stepTotal must be between 0 and ${MAX_STEPS_PER_TASK}`)
  }
  if (typeof stepDone !== 'number' || !Number.isInteger(stepDone) || stepDone < 0 || stepDone > stepTotal) {
    throw new Error('task.stepDone must be between zero and task.stepTotal')
  }
  // These timestamps are not writable through AssistantStore, but validating them keeps a corrupt
  // document from being accepted merely because the fields happen to be ignored on restore.
  timestamp(raw.createdAt, 'task.createdAt')
  timestamp(raw.updatedAt, 'task.updatedAt')
  nullableTimestamp(raw.completedAt, 'task.completedAt')
  nullableTimestamp(raw.remindAt, 'task.remindAt')
  if (raw.spawnedNextId !== undefined && raw.spawnedNextId !== null && !isValidId(raw.spawnedNextId)) {
    throw new Error('task.spawnedNextId must be a task id or null')
  }
  const steps = importedSteps(raw.steps)
  if (steps !== null && steps.length !== stepTotal) throw new Error('steps must match task.stepTotal')
  if (steps !== null && steps.filter((step) => step.done).length !== stepDone) {
    throw new Error('completed steps must match task.stepDone')
  }
  const input: NewTask = {
    title,
    description: optionalText(raw.description, 'task.description', MAX_TASK_DESCRIPTION_CHARS),
    status: raw.status as NewTask['status'],
    priority: raw.priority as NewTask['priority'],
    important: nullableFlag(raw.important, 'task.important'),
    urgent: nullableFlag(raw.urgent, 'task.urgent'),
    dueAt,
    dueAllDay,
    dueOn,
    startAt,
    projectId: nullableId(raw.projectId, 'task.projectId'),
    listId: nullableId(raw.listId, 'task.listId'),
    parentId: nullableId(raw.parentId, 'task.parentId'),
    icon,
    color,
    plannedFor,
    starred: raw.starred === true,
    archivedAt: nullableTimestamp(raw.archivedAt, 'task.archivedAt'),
    repeat: repeatRule(raw.repeat),
    reminders: reminderTimes(raw),
    noteId: nullableId(raw.noteId, 'task.noteId'),
    conversationId: nullableId(raw.conversationId, 'task.conversationId'),
    tags: tagNames(raw.tags),
    steps: steps?.map((step) => step.text) ?? [],
    timeEstimateMs: estimate,
  }
  return { index, sourceId, input, dependsOn: dependencyIds(raw.dependsOn), steps, stepTotal }
}

function validateDocument(value: RawRecord): RawRecord[] {
  if (value.format !== 'inkstone-todos') throw ApiError.badRequest('format must be inkstone-todos')
  if (value.version !== 1) throw ApiError.badRequest('version must be 1')
  if (typeof value.truncated !== 'boolean') throw ApiError.badRequest('truncated must be a boolean')
  if (value.truncated) throw ApiError.badRequest('A truncated to-do export cannot be imported')
  if (!isTodoTimestamp(value.exportedAt)) throw ApiError.badRequest('exportedAt must be a supported millisecond timestamp')
  if (typeof value.timezone !== 'string' || !isValidTimeZone(value.timezone)) {
    throw ApiError.badRequest('timezone must be a valid IANA timezone')
  }
  if (!Array.isArray(value.tasks)) throw ApiError.badRequest('tasks must be an array')
  if (value.tasks.length > MAX_TODO_JSON_IMPORT_TASKS) {
    throw ApiError.badRequest(`A JSON import can hold at most ${MAX_TODO_JSON_IMPORT_TASKS} tasks.`)
  }
  if (typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) {
    throw ApiError.badRequest('total must be a non-negative integer')
  }
  if (value.total !== value.tasks.length) throw ApiError.badRequest('total must equal the number of tasks')
  const ids = new Set<string>()
  for (const valueTask of value.tasks) {
    if (!valueTask || typeof valueTask !== 'object' || Array.isArray(valueTask)) continue
    const id = (valueTask as RawRecord).id
    if (isValidId(id)) {
      if (ids.has(id)) throw ApiError.badRequest('task ids must be unique within an export')
      ids.add(id)
    }
  }
  return value.tasks
}

function conflictValue(value: string | undefined): Conflict {
  if (value === undefined || value === '') return 'skip'
  if (value === 'skip' || value === 'duplicate') return value
  throw ApiError.badRequest('conflict must be skip or duplicate')
}

function taskFingerprint(task: Pick<NewTask, 'title' | 'description' | 'listId' | 'startAt' | 'dueAt'>): string {
  return JSON.stringify([
    task.title?.trim().toLocaleLowerCase() ?? '',
    task.description ?? '',
    task.listId ?? null,
    task.startAt ?? null,
    task.dueAt ?? null,
  ])
}

/** Bounded like the import itself; an Idempotency-Key remains the exact retry contract beyond this scan. */
async function existingByFingerprint(store: AssistantStore): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (let offset = 0; offset < MAX_TODO_JSON_IMPORT_TASKS; offset += 500) {
    const page = await store.listTasks({
      status: 'all',
      archived: 'any',
      includeShelvedLists: true,
      sort: 'created',
      limit: 500,
      offset,
    })
    for (const task of page) {
      const key = taskFingerprint(task)
      if (!found.has(key)) found.set(key, task.id)
    }
    if (page.length < 500) break
  }
  return found
}

function cycleNodes(rows: ImportRow[], valid: Set<number>, edges: (row: ImportRow) => number[]): Set<number> {
  const byIndex = new Map(rows.map((row) => [row.index, row]))
  const state = new Map<number, 0 | 1 | 2>()
  const stack: number[] = []
  const cycles = new Set<number>()
  const visit = (index: number): void => {
    if (!valid.has(index)) return
    const current = state.get(index) ?? 0
    if (current === 2) return
    if (current === 1) {
      const start = stack.indexOf(index)
      for (const member of stack.slice(start)) cycles.add(member)
      return
    }
    state.set(index, 1)
    stack.push(index)
    for (const next of edges(byIndex.get(index)!)) visit(next)
    stack.pop()
    state.set(index, 2)
  }
  for (const row of rows) visit(row.index)
  return cycles
}

function parentCreationOrder(rows: ImportRow[], pending: Set<number>): number[] {
  const bySource = new Map(rows.map((row) => [row.sourceId, row]))
  const byIndex = new Map(rows.map((row) => [row.index, row]))
  const state = new Map<number, 0 | 1 | 2>()
  const order: number[] = []
  const visit = (index: number): void => {
    if (!pending.has(index) || state.get(index) === 2) return
    state.set(index, 1)
    const parentId = byIndex.get(index)!.input.parentId
    const parent = parentId ? bySource.get(parentId) : undefined
    if (parent && pending.has(parent.index)) visit(parent.index)
    state.set(index, 2)
    order.push(index)
  }
  for (const row of rows) visit(row.index)
  return order
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'The task could not be imported'
}

async function importDocument(
  store: AssistantStore,
  tasks: RawRecord[],
  conflict: Conflict,
): Promise<ImportResult> {
  const rows: ImportRow[] = []
  const errors: ImportError[] = []
  const warnings: ImportWarning[] = []
  const failed = new Set<number>()
  const fail = (row: ImportRow | null, index: number, sourceId: string | null, reason: string, taskId?: string): void => {
    if (row && failed.has(row.index)) return
    failed.add(index)
    errors.push({ row: index + 1, sourceId, reason, ...(taskId ? { taskId } : {}) })
  }

  for (const [index, value] of tasks.entries()) {
    try {
      rows.push(parseRow(value, index))
    } catch (error) {
      const sourceId = value && typeof value === 'object' && !Array.isArray(value)
        && isValidId((value as RawRecord).id) ? (value as RawRecord).id as string : null
      fail(null, index, sourceId, errorReason(error))
    }
  }
  rows.sort((a, b) => a.index - b.index)
  const bySource = new Map(rows.map((row) => [row.sourceId, row]))
  const byIndex = new Map(rows.map((row) => [row.index, row]))
  const valid = new Set(rows.filter((row) => !failed.has(row.index)).map((row) => row.index))

  const listCache = new Map<string, boolean>()
  const taskCache = new Map<string, boolean>()
  const taskExists = async (id: string): Promise<boolean> => {
    if (!taskCache.has(id)) taskCache.set(id, Boolean(await store.getTask(id)))
    return taskCache.get(id)!
  }
  for (const row of rows) {
    if (!valid.has(row.index)) continue
    try {
      const listId = row.input.listId
      if (listId) {
        if (!listCache.has(listId)) listCache.set(listId, Boolean(await store.getTaskList(listId)))
        if (!listCache.get(listId)) throw new Error('The referenced list does not belong to this account')
      }
      const projectId = row.input.projectId
      if (projectId && !(await store.resolveProject(projectId))) {
        throw new Error('The referenced project does not belong to this account')
      }
      const parentId = row.input.parentId
      if (parentId && !bySource.has(parentId) && !(await taskExists(parentId))) {
        throw new Error('The parent task does not belong to this account or document')
      }
      for (const dependencyId of row.dependsOn) {
        if (!bySource.has(dependencyId) && !(await taskExists(dependencyId))) {
          throw new Error('A dependency task does not belong to this account or document')
        }
      }
    } catch (error) {
      fail(row, row.index, row.sourceId, errorReason(error))
      valid.delete(row.index)
    }
  }

  // A reference to a row that failed validation cannot be restored. Repeat because rejecting one row
  // may reject its children and dependents, but each source row is still answered only once.
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!valid.has(row.index)) continue
      const references = [row.input.parentId, ...row.dependsOn]
        .filter((id): id is string => Boolean(id && bySource.has(id)))
      const missing = references.find((id) => {
        const source = bySource.get(id)!
        return failed.has(source.index)
      })
      if (missing) {
        fail(row, row.index, row.sourceId, 'A referenced task in the document could not be imported')
        valid.delete(row.index)
        changed = true
      }
    }
  }

  const parentCycles = cycleNodes(rows, valid, (row) => {
    const parent = row.input.parentId ? bySource.get(row.input.parentId) : undefined
    return parent ? [parent.index] : []
  })
  const dependencyCycles = cycleNodes(rows, valid, (row) => row.dependsOn
    .map((id) => bySource.get(id)?.index)
    .filter((index): index is number => index !== undefined))
  for (const index of new Set([...parentCycles, ...dependencyCycles])) {
    const row = byIndex.get(index)!
    fail(row, index, row.sourceId, 'Task parent/dependency references contain a cycle')
    valid.delete(index)
  }
  changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!valid.has(row.index)) continue
      const references = [row.input.parentId, ...row.dependsOn]
        .filter((id): id is string => Boolean(id && bySource.has(id)))
      if (references.some((id) => failed.has(bySource.get(id)!.index))) {
        fail(row, row.index, row.sourceId, 'A referenced task in the document could not be imported')
        valid.delete(row.index)
        changed = true
      }
    }
  }

  const existing = conflict === 'skip' ? await existingByFingerprint(store) : new Map<string, string>()
  const sourceToTarget = new Map<string, string>()
  const pending = new Set<number>()
  for (const row of rows) {
    if (!valid.has(row.index)) continue
    if (row.steps === null && row.stepTotal > 0) {
      warnings.push({
        row: row.index + 1,
        sourceId: row.sourceId,
        reason: 'TodoExportDocument carries step counts but not step text; step contents could not be restored',
      })
    }
    const match = conflict === 'skip' ? existing.get(taskFingerprint(row.input)) : undefined
    if (match) {
      sourceToTarget.set(row.sourceId, match)
    } else {
      pending.add(row.index)
    }
  }

  let created = 0
  let skipped = 0
  const imported: ImportResult['imported'] = []
  const settings = await store.getSettings()
  const createdRows: ImportRow[] = []
  for (const index of parentCreationOrder(rows, pending)) {
    const row = byIndex.get(index)!
    const parentId = row.input.parentId
      ? sourceToTarget.get(row.input.parentId!)
        ?? (bySource.has(row.input.parentId!) ? null : row.input.parentId!)
      : null
    if (row.input.parentId && bySource.has(row.input.parentId!) && parentId === null) {
      fail(row, row.index, row.sourceId, 'The parent task could not be imported')
      continue
    }
    try {
      const task = await store.createTask({ ...row.input, parentId }, settings.timezone)
      sourceToTarget.set(row.sourceId, task.id)
      createdRows.push(row)
      if (row.steps?.some((step) => step.done)) {
        const steps = await store.listSteps(task.id)
        for (const [position, step] of row.steps.entries()) {
          if (step.done) {
            const written = await store.updateStep(task.id, steps[position]!.id, { done: true })
            if (!written) throw new Error('A step could not be marked complete')
          }
        }
      }
      created++
      imported.push({ row: row.index + 1, sourceId: row.sourceId, taskId: task.id })
    } catch (error) {
      const taskId = sourceToTarget.get(row.sourceId)
      fail(row, row.index, row.sourceId, errorReason(error), taskId)
      // A failed post-create step must not leave a supposedly usable parent/dependency target behind.
      sourceToTarget.delete(row.sourceId)
      console.error('[inkstone] JSON todo import row failed:', row.index + 1, error)
    }
  }

  for (const row of createdRows) {
    if (failed.has(row.index)) continue
    const taskId = sourceToTarget.get(row.sourceId)!
    try {
      const dependsOn = row.dependsOn.map((id) => {
        const mapped = sourceToTarget.get(id)
        if (mapped) return mapped
        if (bySource.has(id)) throw new Error('A dependency task could not be imported')
        return id
      })
      if (dependsOn.length) await store.replaceTaskDeps(taskId, dependsOn)
    } catch (error) {
      fail(row, row.index, row.sourceId, errorReason(error), taskId)
      created--
      const importedAt = imported.findIndex((entry) => entry.sourceId === row.sourceId)
      if (importedAt >= 0) imported.splice(importedAt, 1)
      console.error('[inkstone] JSON todo dependency import failed:', row.index + 1, error)
    }
  }
  for (const row of rows) {
    if (valid.has(row.index) && !pending.has(row.index)) skipped++
  }

  errors.sort((a, b) => a.row - b.row)
  return {
    total: tasks.length,
    created,
    skipped,
    failed: errors.length,
    partial: errors.length > 0 || warnings.length > 0,
    imported,
    errors,
    warnings,
  }
}

export const todoImportJsonRoutes = new Hono<AppBindings>()

todoImportJsonRoutes.use('*', requireAuth)
todoImportJsonRoutes.use('*', async (c, next) => {
  takeBudget(c.get('userId'))
  await next()
})

todoImportJsonRoutes.post('/', async (c) => {
  const document = await readJson<RawRecord>(c, MAX_TODO_JSON_IMPORT_BYTES)
  const tasks = validateDocument(document)
  const conflict = conflictValue(c.req.query('conflict'))
  const store = new AssistantStore(c.env.DB, c.get('userId'), c.env)
  const key = c.req.header('idempotency-key')?.trim()
  const result = key
    ? await runIdempotent<ImportResult>({
      db: c.env.DB,
      userId: c.get('userId'),
      operationId: key,
      tool: 'http.todos.import-json',
      request: { document, conflict },
      execute: () => importDocument(store, tasks, conflict),
    })
    : await importDocument(store, tasks, conflict)
  return c.json(result)
})
