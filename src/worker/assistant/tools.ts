/**
 * The tools the assistant can reach, and the executor that runs them.
 *
 * Three things are enforced here rather than asked of the model, because a model that is confident and
 * wrong is the failure mode this app has to survive:
 *  - **budgets** — a per-turn call cap, a per-tool cap and a duplicate-call refusal, so a reasoning
 *    loop cannot spend the reader's AI quota or write a hundred tasks;
 *  - **validation** — arguments are checked against the same declaration that generates the JSON
 *    Schema the provider is given, so the two can never disagree;
 *  - **approval** — a destructive tool never runs during the turn. `prepare` resolves the exact target
 *    and writes a pending action; `commit` runs only when the reader presses Approve, once, on that
 *    target. The model can propose; it cannot delete.
 *
 * Scheduled runs get read-only tools plus `notify_reader`, so a routine that has drifted cannot edit
 * the vault while nobody is watching.
 */

import type { AssistantSettings, Task } from '@shared/assistant'
import { ASSISTANT_TOOL_SPECS, MAX_TASK_TITLE_CHARS, TASK_PRIORITIES, TASK_STATUSES, type AssistantMemoryCategory, type AutomationKind } from '@shared/assistant'
import { MEMORY_CATEGORIES_FOR_TOOLS } from './memory-service'
import { parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { hasHistoricalIntent } from '@shared/assistant-memory'
import type { ScheduleSpec } from '@shared/assistant-schedule'
import type { Env } from '../env'
import type { McpWriteContext } from '../mcp/writes'
import { createMcpNote, editMcpNote, trashMcpNote } from '../mcp/writes'
import { readMcpNote, searchMcpNotes } from '../mcp/retrieval'
import { ApiError } from '../lib/errors'
import type { AssistantStore } from './store'
import { assertNoteReadable, noteTitleForLog, readableNoteIds, type NoteScope } from './note-scope'
import type { MemoryHistoryService } from './memory-service'
import type { AutomationService } from './automations'

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'object'

export interface FieldSpec {
  type: FieldKind
  description?: string
  enum?: readonly string[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  optional?: boolean
}

export interface ToolContext {
  store: AssistantStore
  env: Env
  ftsEnabled: boolean
  origin: string
  settings: AssistantSettings
  timezone: string
  /** End of the reader's local day, so 'today' means the same thing in every tool. */
  dayEnd: number
  mode: 'chat' | 'scheduled'
  conversationId?: string
  /** The provider's own id for this call, reused as the note write's idempotency key. */
  callId?: string
  memoryHistory: MemoryHistoryService
  automations: AutomationService
  /** Resolved once per turn by the runner: the note tools all ask it, and a second answer would be a race. */
  noteScope: () => Promise<NoteScope>
  /** Present in chat mode: the note tools write through the same path the MCP server uses. */
  writeContext?: McpWriteContext
}

export interface PreparedTarget {
  targetId: string
  /** What the approval card names, taken from the target's own title. */
  targetLabel: string
}

interface BaseTool {
  name: string
  description: string
  permission: 'read' | 'write' | 'destructive'
  fields: Record<string, FieldSpec>
  maxCallsPerTurn?: number
}

export interface ImmediateTool extends BaseTool {
  permission: 'read' | 'write'
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

export interface DestructiveTool extends BaseTool {
  permission: 'destructive'
  prepare: (args: Record<string, unknown>, ctx: ToolContext) => Promise<PreparedTarget>
  commit: (targetId: string, ctx: ToolContext) => Promise<unknown>
}

export type ToolDefinition = ImmediateTool | DestructiveTool

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

function tool(definition: ToolDefinition): ToolDefinition {
  return definition
}

const localDateField = (description: string): FieldSpec => ({
  type: 'string',
  description: `${description} Local to the reader: YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time.`,
  maxLength: 32,
  optional: true,
})

function dueMillis(value: unknown, ctx: ToolContext): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ToolError('A date must be given as text.')
  const parsed = parseLocalTime(value, ctx.timezone)
  if (parsed === null) throw new ToolError(`Could not understand the date "${value.slice(0, 40)}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`)
  return parsed
}

function presentTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.dueAt,
    ...(task.description ? { description: task.description.slice(0, 300) } : {}),
  }
}

/** A quoted fragment of user text for the approval card, shortened so the card stays readable. */
function quoted(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

async function resolveTaskOrThrow(ref: unknown, ctx: ToolContext): Promise<Task> {
  const task = await ctx.store.resolveTask(String(ref))
  if (!task) throw new ToolError(`No single task matches "${String(ref).slice(0, 80)}". List tasks to find the exact one.`)
  return task
}

async function resolveProjectIdOrThrow(ref: unknown, ctx: ToolContext): Promise<string | null | undefined> {
  if (ref === undefined) return undefined
  if (ref === null || ref === '') return null
  const found = await ctx.store.resolveProject(String(ref).slice(0, 200))
  if (!found) throw new ToolError(`Project "${String(ref).slice(0, 80)}" does not exist. Create it first with create_project.`)
  return found.id
}

export const TASK_TOOLS: ToolDefinition[] = [
  tool({
    name: 'create_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Create a to-do for the reader. Use for action items, not for facts.',
    fields: {
      title: { type: 'string', description: 'What needs doing, in a few words.', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS },
      description: { type: 'string', description: 'Optional longer note.', maxLength: 2000, optional: true },
      priority: { type: 'string', enum: TASK_PRIORITIES, description: 'Defaults to medium.', optional: true },
      due: localDateField('When it is due.'),
      project: { type: 'string', description: 'Project name or id.', maxLength: 200, optional: true },
    },
    async run(args, ctx) {
      const task = await ctx.store.createTask({
        title: String(args.title),
        description: typeof args.description === 'string' ? args.description : '',
        priority: args.priority as Task['priority'] | undefined,
        dueAt: dueMillis(args.due, ctx) ?? null,
        projectId: (await resolveProjectIdOrThrow(args.project, ctx)) ?? null,
      })
      await ctx.store.recordActivity('task.created', task.title)
      return { created: presentTask(task) }
    },
  }),
  tool({
    name: 'list_tasks',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'List the reader\'s tasks. view: today (due today or overdue), upcoming, overdue, open, completed.',
    fields: {
      view: { type: 'string', enum: ['today', 'upcoming', 'overdue', 'open', 'completed'], description: 'Defaults to open.', optional: true },
      query: { type: 'string', description: 'Substring of a title or note.', maxLength: 200, optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, optional: true },
    },
    async run(args, ctx) {
      const view = (args.view as string | undefined) ?? 'open'
      const tasks = await ctx.store.listTasks({
        status: view === 'open' ? 'open' : 'all',
        view: view === 'open' ? 'all' : view as 'today' | 'upcoming' | 'overdue' | 'completed',
        query: typeof args.query === 'string' ? args.query : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 25,
        dayEnd: ctx.dayEnd,
      })
      return { count: tasks.length, tasks: tasks.map(presentTask) }
    },
  }),
  tool({
    name: 'update_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Change a task: title, note, status, priority, due date or project.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      title: { type: 'string', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS, optional: true },
      description: { type: 'string', maxLength: 2000, optional: true },
      status: { type: 'string', enum: TASK_STATUSES, optional: true },
      priority: { type: 'string', enum: TASK_PRIORITIES, optional: true },
      due: localDateField('New due date; pass null to clear it.'),
      project: { type: 'string', description: 'Project name or id; null clears it.', maxLength: 200, optional: true },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const updated = await ctx.store.updateTask(task.id, {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(args.status !== undefined ? { status: args.status as Task['status'] } : {}),
        ...(args.priority !== undefined ? { priority: args.priority as Task['priority'] } : {}),
        ...(args.due !== undefined ? { dueAt: dueMillis(args.due, ctx) ?? null } : {}),
        ...(args.project !== undefined ? { projectId: (await resolveProjectIdOrThrow(args.project, ctx)) ?? null } : {}),
      })
      return { updated: updated ? presentTask(updated) : null }
    },
  }),
  tool({
    name: 'complete_task',
    permission: 'write',
    maxCallsPerTurn: 10,
    description: 'Mark a task done.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const done = await ctx.store.updateTask(task.id, { status: 'done' })
      if (done) await ctx.store.recordActivity('task.completed', done.title)
      return { completed: done ? presentTask(done) : null }
    },
  }),
  tool({
    name: 'delete_task',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose permanently deleting a task. Nothing is deleted until the reader approves it.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
    },
    async prepare(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      return { targetId: task.id, targetLabel: quoted(task.title) }
    },
    async commit(targetId, ctx) {
      const task = await ctx.store.getTask(targetId)
      if (!task) throw new ToolError('This task no longer exists.')
      await ctx.store.deleteTask(task.id)
      await ctx.store.recordActivity('task.deleted', task.title)
    },
  }),
]

export const MEMORY_TOOLS: ToolDefinition[] = [
  tool({
    name: 'remember',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Store a durable fact about the reader. Only when they ask to be remembered something, or state a clearly lasting preference. Write it as a short third-person statement.',
    fields: {
      content: { type: 'string', minLength: 3, maxLength: 1000 },
      category: { type: 'string', enum: MEMORY_CATEGORIES_FOR_TOOLS, optional: true },
    },
    async run(args, ctx) {
      const result = await ctx.memoryHistory.create({
        content: String(args.content),
        category: (args.category as AssistantMemoryCategory | undefined) ?? 'other',
        source: 'assistant',
      })
      await ctx.store.recordActivity('memory.created', result.memory.content)
      return {
        remembered: { id: result.memory.id, content: result.memory.content, category: result.memory.category },
        ...(result.superseded.length
          ? { now_historical: result.superseded.map((memory) => ({ id: memory.id, content: memory.content })) }
          : {}),
        ...(result.reviews.length
          ? { needs_reader_review: 'This may conflict with an older memory; both are kept until the reader reviews it on the Memory page.' }
          : {}),
      }
    },
  }),
  tool({
    name: 'search_memories',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Search what you remember about the reader. Results marked historical are past facts; set include_history for a question about the past.',
    fields: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      include_history: { type: 'boolean', optional: true },
    },
    async run(args, ctx) {
      const query = String(args.query)
      const include = args.include_history === true || hasHistoricalIntent(query)
      const found = await ctx.store.searchMemories(query, 10, include ? 'all' : 'current')
      return {
        memories: found.map((memory) => ({
          id: memory.id,
          content: memory.content,
          category: memory.category,
          ...(memory.status !== 'active' ? { status: memory.status } : {}),
        })),
      }
    },
  }),
  tool({
    name: 'update_memory',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Correct an existing memory by id.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26 },
      content: { type: 'string', minLength: 3, maxLength: 1000 },
      category: { type: 'string', enum: MEMORY_CATEGORIES_FOR_TOOLS, optional: true },
    },
    async run(args, ctx) {
      const existing = await ctx.store.getMemory(String(args.id))
      if (!existing) throw new ToolError('Memory not found.')
      const result = await ctx.memoryHistory.update(existing.id, {
        content: String(args.content),
        category: (args.category as AssistantMemoryCategory | undefined) ?? existing.category,
      })
      return { updated: { id: result.memory.id, content: result.memory.content } }
    },
  }),
  tool({
    name: 'forget_memory',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose deleting a memory by id. Nothing is deleted until the reader approves it.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26 } },
    async prepare(args, ctx) {
      const memory = await ctx.store.getMemory(String(args.id))
      if (!memory) throw new ToolError('Memory not found.')
      return { targetId: memory.id, targetLabel: quoted(memory.content) }
    },
    async commit(targetId, ctx) {
      const memory = await ctx.store.getMemory(targetId)
      if (!memory) throw new ToolError('This memory no longer exists.')
      await ctx.store.deleteMemory(memory.id)
      await ctx.store.recordActivity('memory.deleted', memory.content)
    },
  }),
]

export const NOTE_TOOLS: ToolDefinition[] = [
  tool({
    name: 'search_notes',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Search the reader\'s notes. Returns titles, ids and short excerpts.',
    fields: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    async run(args, ctx) {
      const response = await searchMcpNotes(ctx.env, ctx.store.userId, ctx.origin, ctx.ftsEnabled, {
        query: String(args.query),
        limit: 8,
      })
      const scope = await ctx.noteScope()
      const allowed = await readableNoteIds(ctx.env.DB, ctx.store.userId, response.results.map((hit) => hit.id), scope)
      return {
        results: response.results.filter((hit) => allowed.has(hit.id)).slice(0, 8).map((hit) => ({
          id: hit.id,
          title: hit.title,
          excerpt: hit.snippet.slice(0, 400),
        })),
        ...(scope.restricted ? { scope: 'limited to the folders the reader allowed the assistant to read' } : {}),
      }
    },
  }),
  tool({
    name: 'read_note',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Read a note by id.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26 } },
    async run(args, ctx) {
      const id = String(args.id)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, id, await ctx.noteScope())
      const note = await readMcpNote(ctx.env.DB, ctx.store.userId, ctx.origin, { noteId: id, maxChars: 8000 })
      return note
    },
  }),
  tool({
    name: 'create_note',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Save a Markdown note in the reader\'s vault (an idea, meeting notes, reference material).',
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 300 },
      content: { type: 'string', maxLength: 20_000 },
    },
    async run(args, ctx) {
      const writeContext = requireWriteContext(ctx)
      const note = await createMcpNote(writeContext, {
        operationId: ctx.callId ?? 'assistant',
        title: String(args.title).slice(0, 300),
        content: String(args.content ?? ''),
      })
      await ctx.store.recordActivity('note.created', note.title)
      return { created: { id: note.id, title: note.title } }
    },
  }),
  tool({
    name: 'update_note',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Replace a note\'s body, or append to it. Prefer append: replacing discards what the reader wrote.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26 },
      content: { type: 'string', maxLength: 20_000, optional: true },
      append: { type: 'string', maxLength: 10_000, optional: true },
      title: { type: 'string', minLength: 1, maxLength: 300, optional: true },
    },
    async run(args, ctx) {
      const id = String(args.id)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, id, await ctx.noteScope())
      const writeContext = requireWriteContext(ctx)
      if (typeof args.append === 'string') {
        const note = await editMcpNote(writeContext, {
          operationId: ctx.callId ?? 'assistant',
          noteId: id,
          expectedRev: await currentNoteRev(ctx, id),
          operation: 'append',
          text: `\n\n${args.append}`,
        })
        return { updated: { id: note.id, title: note.title } }
      }
      const note = await editMcpNote(writeContext, {
        operationId: ctx.callId ?? 'assistant',
        noteId: id,
        expectedRev: await currentNoteRev(ctx, id),
        operation: 'replace',
        text: String(args.content ?? ''),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
      })
      return { updated: { id: note.id, title: note.title } }
    },
  }),
  tool({
    name: 'delete_note',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Propose moving a note to the trash. Nothing is removed until the reader approves it.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26 } },
    async prepare(args, ctx) {
      const id = String(args.id)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, id, await ctx.noteScope())
      return { targetId: id, targetLabel: await noteTitleForLog(ctx.env.DB, ctx.store.userId, id) }
    },
    async commit(targetId, ctx) {
      const writeContext = requireWriteContext(ctx)
      await trashMcpNote(writeContext, {
        operationId: ctx.callId ?? 'assistant',
        noteId: targetId,
        expectedRev: await currentNoteRev(ctx, targetId),
      })
      await ctx.store.recordActivity('note.trashed', targetId)
    },
  }),
]

export const AUTOMATION_TOOLS: ToolDefinition[] = [
  tool({
    name: 'create_reminder',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create a one-time reminder that appears in the reader\'s notification centre. Give either at (local YYYY-MM-DDTHH:MM) or in_minutes.',
    fields: {
      message: { type: 'string', minLength: 1, maxLength: 500 },
      at: { type: 'string', description: 'Local time, YYYY-MM-DDTHH:MM.', maxLength: 32, optional: true },
      in_minutes: { type: 'integer', minimum: 1, maximum: 60 * 24 * 365, optional: true },
    },
    async run(args, ctx) {
      const message = String(args.message)
      const at = typeof args.at === 'string'
        ? args.at
        : typeof args.in_minutes === 'number'
          // Round up to the next whole minute plus a minute, so "in 5 minutes" never fires early.
          ? toLocalMinute(Date.now() + args.in_minutes * 60_000 + 59_000, ctx.timezone)
          : ''
      if (!at) throw new ToolError('Provide at or in_minutes.')
      const automation = await ctx.automations.create({
        name: message.slice(0, 120),
        kind: 'reminder',
        message,
        schedule: { type: 'once', at },
        enabled: true,
      })
      return { reminder: { id: automation.id, message: automation.message, when: automation.nextRun } }
    },
  }),
  tool({
    name: 'create_automation',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: [
      'Create a recurring schedule. kind: reminder (show a message, no AI), task_digest (deterministic summary of due and overdue tasks, no AI),',
      'or assistant_prompt (run a prompt with read-only tools; use only when reasoning is truly needed).',
      'schedule examples: {type:"daily",time:"09:00"}, {type:"weekly",days:[5],time:"17:00"} (0 is Sunday),',
      '{type:"monthly",day:1,time:"08:00"}, {type:"interval",minutes:120}, {type:"once",at:"2026-01-31T09:00"}. Times are local.',
    ].join(' '),
    fields: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      kind: { type: 'string', enum: ['reminder', 'task_digest', 'assistant_prompt'] },
      message: { type: 'string', maxLength: 2000, optional: true },
      schedule: { type: 'object', description: 'The schedule object, one of the shapes above.' },
    },
    async run(args, ctx) {
      const automation = await ctx.automations.create({
        name: String(args.name),
        kind: args.kind as AutomationKind,
        message: typeof args.message === 'string' ? args.message : '',
        schedule: args.schedule as ScheduleSpec,
        enabled: true,
      })
      return { automation: { id: automation.id, name: automation.name, next_run: automation.nextRun } }
    },
  }),
  tool({
    name: 'list_automations',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the reader\'s reminders and schedules.',
    fields: {},
    async run(_args, ctx) {
      const list = await ctx.store.listAutomations()
      return {
        automations: list.map((automation) => ({
          id: automation.id,
          name: automation.name,
          kind: automation.kind,
          enabled: automation.enabled,
          next_run: automation.nextRun,
        })),
      }
    },
  }),
  tool({
    name: 'cancel_automation',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose deleting a reminder or schedule by id. Nothing is removed until the reader approves it.',
    fields: { id: { type: 'string', minLength: 1, maxLength: 26 } },
    async prepare(args, ctx) {
      const automation = await ctx.store.getAutomation(String(args.id))
      if (!automation) throw new ToolError('Automation not found.')
      return { targetId: automation.id, targetLabel: quoted(automation.name) }
    },
    async commit(targetId, ctx) {
      const automation = await ctx.store.getAutomation(targetId)
      if (!automation) throw new ToolError('This automation no longer exists.')
      await ctx.automations.delete(automation.id)
    },
  }),
]

export const PROJECT_TOOLS: ToolDefinition[] = [
  tool({
    name: 'list_projects',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the reader\'s projects.',
    fields: {},
    async run(_args, ctx) {
      return {
        projects: (await ctx.store.listProjects()).map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description.slice(0, 200),
        })),
      }
    },
  }),
  tool({
    name: 'create_project',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Create a project that groups tasks.',
    fields: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 2000, optional: true },
    },
    async run(args, ctx) {
      const name = String(args.name)
      const existing = await ctx.store.findProjectByName(name)
      if (existing) return { existing: { id: existing.id, name: existing.name } }
      const project = await ctx.store.createProject({
        name,
        description: typeof args.description === 'string' ? args.description : '',
      })
      return { created: { id: project.id, name: project.name } }
    },
  }),
]

export const SEARCH_TOOLS: ToolDefinition[] = [
  tool({
    name: 'search',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'Search the reader\'s tasks, notes, memories and past conversations at once.',
    fields: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    async run(args, ctx) {
      const query = String(args.query)
      const [tasks, memories, conversations] = await Promise.all([
        ctx.store.listTasks({ query, limit: 5 }),
        ctx.store.searchMemories(query, 5, 'all'),
        ctx.store.listConversations(query, 5),
      ])
      const notes = await searchMcpNotes(ctx.env, ctx.store.userId, ctx.origin, ctx.ftsEnabled, { query, limit: 5 })
      const scope = await ctx.noteScope()
      const allowed = await readableNoteIds(ctx.env.DB, ctx.store.userId, notes.results.map((hit) => hit.id), scope)
      return {
        tasks: tasks.map(presentTask),
        memories: memories.map((memory) => ({ id: memory.id, content: memory.content, status: memory.status })),
        notes: notes.results.filter((hit) => allowed.has(hit.id))
          .map((hit) => ({ id: hit.id, title: hit.title, excerpt: hit.snippet.slice(0, 200) })),
        conversations: conversations.map((conversation) => ({ id: conversation.id, title: conversation.title })),
      }
    },
  }),
  tool({
    name: 'notify_reader',
    permission: 'write',
    maxCallsPerTurn: 1,
    description: 'Post a message to the reader\'s notification centre. Use in scheduled runs to deliver a result.',
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    async run(args, ctx) {
      const notification = await ctx.store.createNotification({
        title: String(args.title),
        body: String(args.body),
      })
      return { notified: notification.id }
    },
  }),
]

export const ALL_TOOLS: ToolDefinition[] = [
  ...TASK_TOOLS,
  ...MEMORY_TOOLS,
  ...NOTE_TOOLS,
  ...AUTOMATION_TOOLS,
  ...PROJECT_TOOLS,
  ...SEARCH_TOOLS,
]

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((definition) => [definition.name, definition]))

/**
 * Refuses to start with a tool the reader could never see.
 *
 * The label and approval keys live in the shared spec list because the client renders them; a tool
 * missing from that list would stream a chip with no words, and a spec with no tool would be a menu
 * row that does nothing.
 */
export function assertToolsMatchSpecs(): void {
  const names = new Set<string>()
  for (const definition of ALL_TOOLS) {
    if (names.has(definition.name)) throw new Error(`duplicate assistant tool: ${definition.name}`)
    names.add(definition.name)
    if (!ASSISTANT_TOOL_SPECS.some((spec) => spec.name === definition.name)) {
      throw new Error(`assistant tool missing from ASSISTANT_TOOL_SPECS: ${definition.name}`)
    }
    const spec = ASSISTANT_TOOL_SPECS.find((entry) => entry.name === definition.name)!
    if (spec.permission !== definition.permission) {
      throw new Error(`assistant tool permission disagrees for ${definition.name}`)
    }
  }
  for (const spec of ASSISTANT_TOOL_SPECS) {
    if (!names.has(spec.name)) throw new Error(`assistant tool spec has no implementation: ${spec.name}`)
  }
}

// ------------------------------------------------------------- json schema

/**
 * The JSON Schema a provider is given, generated from the same declaration the executor validates
 * against. Two sources for one contract is how a tool ends up advertising a field it then rejects.
 */
export function parametersSchema(fields: Record<string, FieldSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(fields)) {
    const schema: Record<string, unknown> = { type: spec.type }
    if (spec.description) schema.description = spec.description
    if (spec.enum) schema.enum = [...spec.enum]
    if (spec.minLength !== undefined) schema.minLength = spec.minLength
    if (spec.maxLength !== undefined) schema.maxLength = spec.maxLength
    if (spec.minimum !== undefined) schema.minimum = spec.minimum
    if (spec.maximum !== undefined) schema.maximum = spec.maximum
    if (spec.type === 'string') schema.additionalProperties = false
    properties[name] = schema
    if (!spec.optional) required.push(name)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Checks a model-supplied argument object.
 *
 * Unknown keys are dropped rather than rejected: a model that adds a helpful `note` field has not
 * broken the call, and refusing the whole thing costs a turn. A missing or wrongly-typed required
 * field is refused, because there the tool would be acting on something the model never said.
 */
export function validateArgs(fields: Record<string, FieldSpec>, raw: unknown): Record<string, unknown> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(fields)) {
    const value = source[name]
    if (value === undefined || value === null) {
      if (spec.optional) continue
      throw new ToolError(`Missing required argument "${name}".`)
    }
    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') throw new ToolError(`"${name}" must be text.`)
        const text = value.trim()
        if (spec.enum && !spec.enum.includes(text)) throw new ToolError(`"${name}" must be one of ${spec.enum.join(', ')}.`)
        if (spec.minLength !== undefined && text.length < spec.minLength) throw new ToolError(`"${name}" is too short.`)
        out[name] = spec.maxLength !== undefined ? text.slice(0, spec.maxLength) : text
        continue
      }
      case 'integer':
      case 'number': {
        const numeric = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(numeric)) throw new ToolError(`"${name}" must be a number.`)
        const clamped = Math.min(spec.maximum ?? numeric, Math.max(spec.minimum ?? numeric, numeric))
        out[name] = spec.type === 'integer' ? Math.trunc(clamped) : clamped
        continue
      }
      case 'boolean':
        out[name] = value === true || value === 'true'
        continue
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`"${name}" must be an object.`)
        out[name] = value
        continue
      default:
        throw new ToolError(`"${name}" declares an unknown type.`)
    }
  }
  return out
}

// ---------------------------------------------------------------- executor

export interface ExecutorBudget {
  maxToolCalls: number
}

export class ToolExecutor {
  private calls = 0
  private readonly perTool = new Map<string, number>()
  private readonly signatures = new Map<string, number>()
  private readonly approvals = new Map<string, { id: string, toolId: string }>()

  constructor(
    private readonly ctx: ToolContext,
    private readonly budget: ExecutorBudget,
  ) {}

  get callCount(): number {
    return this.calls
  }

  budgetExhausted(): boolean {
    return this.calls >= this.budget.maxToolCalls
  }

  available(): ToolDefinition[] {
    if (this.budget.maxToolCalls <= 0) return []
    if (this.ctx.mode === 'chat') return ALL_TOOLS
    return ALL_TOOLS.filter((definition) => definition.permission === 'read' || definition.name === 'notify_reader')
  }

  find(name: string): ToolDefinition | undefined {
    return this.available().find((definition) => definition.name === name)
  }

  /** The proposal a call produced, keyed by the provider's tool-call id. */
  approvalFor(callId: string): { id: string, toolId: string } | undefined {
    return this.approvals.get(callId)
  }

  async execute(name: string, rawArgs: unknown, callId: string): Promise<unknown> {
    const definition = this.find(name)
    if (!definition) throw new ToolError(`Tool "${name}" is not available.`)
    if (this.calls >= this.budget.maxToolCalls) {
      throw new ToolError('The tool-call budget for this request is spent. Answer with what you already have.')
    }
    const used = this.perTool.get(name) ?? 0
    if (definition.maxCallsPerTurn !== undefined && used >= definition.maxCallsPerTurn) {
      throw new ToolError(`"${name}" was already used ${used} times in this request. Do not call it again.`)
    }
    const args = validateArgs(definition.fields, rawArgs)
    const signature = `${name}:${stableStringify(args)}`
    if ((this.signatures.get(signature) ?? 0) >= 1) {
      throw new ToolError('This exact call was already made in this request. Use the earlier result instead of repeating it.')
    }
    this.calls++
    this.perTool.set(name, used + 1)
    this.signatures.set(signature, (this.signatures.get(signature) ?? 0) + 1)

    if (definition.permission !== 'destructive') {
      return await definition.run(args, { ...this.ctx, callId })
    }
    if (!this.ctx.conversationId) throw new ToolError(`"${name}" needs the reader's approval and can only be used in chat.`)
    const prepared = await definition.prepare(args, { ...this.ctx, callId })
    const action = await this.ctx.store.createPendingAction({
      conversationId: this.ctx.conversationId,
      tool: definition.name,
      targetId: prepared.targetId,
      targetLabel: prepared.targetLabel,
    })
    this.approvals.set(callId, { id: action.id, toolId: callId })
    return {
      status: 'awaiting_reader_approval',
      action: `${definition.name} ${prepared.targetLabel}`,
      note: 'Nothing has changed yet. The reader now sees an Approve button for exactly this action. Tell them briefly what you proposed. Do not call this tool again for the same item, and do not say it is done.',
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * Runs a proposal the reader approved.
 *
 * The pending row is claimed first, so a double press, a second device and a retry after a failed
 * commit all run the target at most once — and only ever on the target that was shown.
 */
export async function runApprovedAction(store: AssistantStore, ctx: ToolContext, actionId: string) {
  const stored = await store.getPendingAction(actionId)
  if (!stored) throw ApiError.notFound('This action no longer exists.')
  const definition = TOOL_BY_NAME.get(stored.tool)
  if (!definition || definition.permission !== 'destructive') {
    throw ApiError.notFound('This action no longer exists.')
  }
  if (stored.status === 'expired') {
    await store.resolvePendingAction(actionId, { status: 'expired' })
    throw ApiError.conflict('This request expired. Ask again to get a new one.')
  }
  if (!(await store.claimPendingAction(actionId, 'approved'))) {
    throw ApiError.conflict('This action was already handled.')
  }
  try {
    await definition.commit(stored.targetId, ctx)
  } catch (error) {
    await store.resolvePendingAction(actionId, {
      status: 'failed',
      error: error instanceof ToolError ? error.message : 'The action failed.',
    })
    if (!(error instanceof ToolError)) console.error('[inkstone] approved assistant action failed:', error instanceof Error ? error.message : error)
  }
  return await store.getPendingAction(actionId)
}

export async function cancelApprovedAction(store: AssistantStore, actionId: string) {
  const stored = await store.getPendingAction(actionId)
  if (!stored) throw ApiError.notFound('This action no longer exists.')
  if (stored.status !== 'pending') return stored
  await store.resolvePendingAction(actionId, { status: 'cancelled' })
  return await store.getPendingAction(actionId)
}

// ------------------------------------------------------------- note plumbing

function requireWriteContext(ctx: ToolContext): McpWriteContext {
  if (!ctx.writeContext) throw new ToolError('Note writing is not available in this run.')
  return ctx.writeContext
}

async function currentNoteRev(ctx: ToolContext, id: string): Promise<number> {
  const row = await ctx.env.DB.prepare(`SELECT rev FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
    .bind(ctx.store.userId, id).first<{ rev: number }>()
  if (!row) throw new ToolError('Note not found.')
  return row.rev
}

export { readableNoteIds }
