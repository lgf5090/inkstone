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
import { ASSISTANT_TOOL_SPECS, MAX_TASK_TITLE_CHARS, TASK_PRIORITIES, TASK_STATUSES, WEB_SEARCH_TOOL_NAME, toolPayloadText, toolModeFor, webSearchConfigured, type AssistantMemory, type AssistantMemoryCategory, type AutomationKind } from '@shared/assistant'
import { webSearchEngineFor } from '@shared/web-search-engines'
import { MEMORY_CATEGORIES_FOR_TOOLS } from './memory-service'
import { parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { hasHistoricalIntent } from '@shared/assistant-memory'
import type { ScheduleSpec } from '@shared/assistant-schedule'
import type { Env } from '../env'
import type { McpWriteContext } from '../mcp/writes'
import { createMcpNote, editMcpNote, trashMcpNote } from '../mcp/writes'
import { readMcpNote, searchMcpNotes } from '../mcp/retrieval'
import { ApiError } from '../lib/errors'
import type { AssistantStore, MemoryScope } from './store'
import {
  fuseNoteHits,
  noteVectorGate,
  recallNotesByVector,
  type NoteVectorGate,
  type NoteVectorRecall,
} from './semantic'
import { assertNoteReadable, noteTitleForLog, readableNoteIds, type NoteScope } from './note-scope'
import { oneHopNeighbours } from './note-graph'
import {
  SCOPE_NOTE,
  countVaultNotes,
  folderSubtree,
  listVaultFolders,
  listVaultNotes,
  listVaultTags,
  matchVaultFolders,
  resolveVaultTag,
  type VaultFilter,
} from './vault'
import type { MemoryHistoryService } from './memory-service'
import type { AutomationService } from './automations'
import { saveChatUpload } from './chat-files'
import { generateImage, IMAGE_SIZES } from './image-generation'
import { runSandboxedCode } from './code-sandbox'
import { modelEndpoint } from './model-config'
import { searchWeb } from './web-search'
import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

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
  /**
   * Which memories this turn may recall, edit or forget.
   *
   * The account's own, plus the project the conversation belongs to. It is one value rather than a
   * project id so that "not in a project" is a scope of its own — the account's memories and nothing
   * else — rather than the absence of a filter.
   */
  memoryScope: MemoryScope
  automations: AutomationService
  /** Resolved once per turn by the runner: the note tools all ask it, and a second answer would be a race. */
  noteScope: () => Promise<NoteScope>
  /**
   * The key the reader stored for the web-search engine the settings name, resolved once per turn.
   *
   * `null` when the engine needs none, and `undefined` when nobody resolved it — which the search tool reads
   * as "no key", because a tool offered without the credential it must send is a call that can only fail and
   * a reader who then distrusts the engine. The value never leaves this isolate: it is written into one
   * outbound request's headers and into nothing else, and it is not a settings field, so it is not in a
   * backup, not in a listing and not in a log.
   */
  webSearchKey?: string | null
  /** Present in chat mode: the note tools write through the same path the MCP server uses. */
  writeContext?: McpWriteContext
  /**
   * This reader's external tools by their namespaced name, loaded again for the approval replay.
   *
   * The card was raised by a listing taken a minute earlier; approving runs against a fresh one, so a
   * server the reader removed in between simply has no entry here and the action reads as gone.
   */
  externalByName?: Map<string, ToolDefinition>
  /**
   * Where a tool that makes a file leaves it.
   *
   * The turn owns one of these arrays, so what `image_generate` drew is attached to the answer that
   * produced it rather than to the tool call that ran mid-stream: the reader sees the picture in the
   * reply, and reopening the thread tomorrow shows it again without the model having to be asked.
   */
  generatedAttachments?: string[]
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
  /**
   * A tool the reader added through an external MCP server. Its arguments are validated by that server, not
   * by this file, so the schema the server sent is what the model sees and the object it sends back is
   * passed through as-is.
   */
  external?: boolean
  /**
   * A condition outside the reader's policy that has to hold before this tool is offered at all.
   *
   * A deployment capability this tool cannot work without, checked before the tool is offered: the app runs
   * on a laptop as well as on a full deployment, so a binding is often optional — and a tool whose binding
   * is missing is left out of the list rather than offered and then failing. The model would otherwise spend
   * a turn on a call that cannot succeed, and the reader would read the resulting error as their app being
   * broken. It is not a settings problem they can fix, so it is not raised as one.
   *
   * The second half is a setting the *reader* controls and cannot see from the tool list: a search tool whose
   * engine has no address, or no key, is the same silent failure, and answered the same way — not offered.
   * That is why the turn's resolved context is handed over too: whether a key exists is not a setting, and a
   * predicate with only settings to read cannot answer the question.
   */
  requires?: (env: Env, settings: AssistantSettings, ctx: ToolContext) => boolean
}

export interface ImmediateTool extends BaseTool {
  permission: 'read' | 'write'
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

export interface DestructiveTool extends BaseTool {
  permission: 'destructive'
  prepare: (args: Record<string, unknown>, ctx: ToolContext) => Promise<PreparedTarget>
  /**
   * `args` is what the model proposed, replayed from the approved row. The notebook's own destructive tools
   * ignore it — deleting a note needs only its id — but an external tool call cannot be re-derived from a
   * target, so the arguments have to come back through the approval.
   */
  commit: (targetId: string, ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
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

/**
 * The folder and tag a question was narrowed to, as ids the SQL can use.
 *
 * A name the vault does not have is refused with what it does have, rather than passed through as a
 * filter that matches nothing: an empty listing reads to the model as "you have no such notes", which
 * is a different answer from "that folder is not one of yours", and only one of them is true.
 */
async function vaultFilterFor(args: Record<string, unknown>, ctx: ToolContext): Promise<VaultFilter> {
  const filter: VaultFilter = {}
  const folderRef = typeof args.folder === 'string' ? args.folder.trim() : ''
  if (folderRef) {
    const matches = await matchVaultFolders(ctx.env.DB, ctx.store.userId, folderRef)
    if (!matches.length) throw new ToolError(`No folder matches "${folderRef.slice(0, 60)}". Call list_folders to see the folder names.`)
    if (matches.length > 1) {
      throw new ToolError(`Several folders match "${folderRef.slice(0, 60)}": ${matches.slice(0, 5).map((match) => match.label).join('; ')}. Give the full path.`)
    }
    filter.folderIds = await folderSubtree(ctx.env.DB, ctx.store.userId, matches[0]!.id)
  }
  const tagRef = typeof args.tag === 'string' ? args.tag.replace(/^#/, '').trim() : ''
  if (tagRef) {
    const tag = await resolveVaultTag(ctx.env.DB, ctx.store.userId, tagRef)
    if (!tag) throw new ToolError(`No tag matches "${tagRef.slice(0, 60)}". Call list_tags to see the tag names.`)
    filter.tagId = tag.id
  }
  return filter
}

/**
 * The tags a turn is pinned to, in the shape the note retriever can filter on.
 *
 * A scope keeps tags as ids — the shape its folder pins and its permission check use — while the
 * retriever narrows both of its lists by tag *name*: the keyword half turns `tags` into `tag:"…"` terms,
 * and both halves then apply `tagScopePredicate()` (`semanticWhere` in `../mcp/ai-search`), the app's one
 * spelling of a tag and its subtree, so the two lists the turn fuses are candidate sets for the same
 * question. Handing ids straight through is a filter no note can satisfy, so a pinned `#meeting` emptied
 * the keyword half and left the vector half answering alone: hits with nothing to say about why.
 *
 * One lookup, spread into both search calls, so the shape question has exactly one answer in this file.
 * A pinned id with no tag behind it is a tag the reader deleted: it cannot be named, and `readableNoteIds`
 * still refuses every note afterwards, so it drops out of the retrieval filter instead of being passed on
 * as a tag name no note carries.
 */
async function tagSearchFilter(db: D1Database, userId: string, scope: NoteScope): Promise<{ tags?: string[] }> {
  const ids = [...scope.tagIds]
  if (!ids.length) return {}
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ')
  const { results } = await db.prepare(
    `SELECT name FROM tags WHERE user_id = ?1 AND id IN (${placeholders})`,
  ).bind(userId, ...ids).all<{ name: string }>()
  const names = (results ?? []).map((row) => row.name)
  return names.length ? { tags: names } : {}
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

/**
 * A memory this turn may touch, or a refusal.
 *
 * The tools see what recall sees. Without this a turn could edit a memory it cannot read, because an id
 * is a stable string that travels through conversations: "I know its name" must not be a permission.
 * A memory filed under no project belongs to the account and is therefore in every turn's scope.
 */
function memoryInScope(memory: AssistantMemory | null, ctx: ToolContext): AssistantMemory {
  if (!memory) throw new ToolError('Memory not found.')
  if (memory.projectId && memory.projectId !== ctx.memoryScope.projectId) throw new ToolError('Memory not found.')
  return memory
}

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
        // Filed where it was learned: a fact about the project this conversation belongs to stays with
        // it, and a conversation outside every project files into the account's own.
        projectId: ctx.memoryScope.projectId,
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
      const found = await ctx.store.searchMemories(query, 10, include ? 'all' : 'current', ctx.memoryScope)
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
      const existing = memoryInScope(await ctx.store.getMemory(String(args.id)), ctx)
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
      const memory = memoryInScope(await ctx.store.getMemory(String(args.id)), ctx)
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

/**
 * How wide each half of a note search is looked over, and how many hits the model is finally handed.
 *
 * The keyword list is asked for more than the reader sees because fusion compares ranks: with eight of
 * each, a note that is third on one list and outside the other's top eight can never be seen to be the
 * better answer. The page that reaches the model stays at eight, which is what the turn's context budget
 * was measured against.
 */
const NOTE_LEXICAL_CANDIDATES = 20
const NOTE_VECTOR_CANDIDATES = 20
const NOTE_RESULT_LIMIT = 8

/**
 * What this page of notes was matched with, in the sentence the model has to respect.
 *
 * A keyword page and a fused page are not the same evidence: only one of them can answer a question whose
 * words the notes never used. Left unsaid, the model reports "you have no note about sea locks" from a
 * list that never looked for the sense of it, and the reader has no way to know the difference.
 */
function noteRetrievalNote(
  gate: NoteVectorGate,
  vector: NoteVectorRecall | null,
  keywordCount: number,
  meaningCount: number,
): string {
  if (meaningCount) {
    return `Retrieval: keyword matches and the reader's AI meaning index, merged by rank (reciprocal-rank fusion over ${keywordCount} keyword hits and ${meaningCount} meaning hits). Each hit says which list it came from.`
  }
  if (vector?.failed) {
    return `Retrieval: keyword matches only — the meaning search failed (${vector.failed}), so nothing here was found by sense. Do not claim the notebook holds no matching note.`
  }
  if (gate.skip === 'no_ai_binding') {
    return 'Retrieval: keyword matches only — this deployment has no AI binding, so the meaning index cannot be read at all.'
  }
  if (gate.skip === 'index_off') {
    return "Retrieval: keyword matches only — the reader has not switched on AI semantic search for their notes, so meaning was never searched. Say so when the question asks for something the notes describe in other words."
  }
  if (gate.skip === 'cap_reached') {
    return "Retrieval: keyword matches only — the account's daily AI embedding allowance is spent, so the meaning index was skipped for this turn."
  }
  return 'Retrieval: keyword matches only — the meaning index was searched and found nothing close enough to this question.'
}

export const NOTE_TOOLS: ToolDefinition[] = [
  tool({
    name: 'search_notes',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Search the reader\'s notes. Matches the words the reader typed always, and also their AI meaning index when they have switched it on: the `retrieval` field says which of the two ran, and each hit says whether it was found by keyword, by meaning, or by both. Returns titles, ids and short excerpts, plus the notes one link away from the best hits — read those when the question is about what a note refers to.',
    fields: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    async run(args, ctx) {
      const query = String(args.query)
      const scope = await ctx.noteScope()
      const gate = await noteVectorGate(ctx.store, ctx.env, ctx.settings)
      // Tags narrow the search itself; the folder scope still filters the hits below, so a turn that asked
      // for `#meeting` cannot reach an untagged note by naming it exactly.
      const tagFilter = await tagSearchFilter(ctx.env.DB, ctx.store.userId, scope)
      // The fusion is done here rather than asked of the MCP retriever's `auto` mode, because that path
      // folds a failed embedding into the same lexical answer it gives when the index is simply off — and
      // "meaning was searched and broke" and "meaning is not switched on" are two different things to tell
      // a reader, only one of which they can act on.
      const [lexical, vector] = await Promise.all([
        searchMcpNotes(ctx.env, ctx.store.userId, ctx.origin, ctx.ftsEnabled, {
          query,
          limit: NOTE_LEXICAL_CANDIDATES,
          mode: 'lexical',
          ...tagFilter,
        }),
        gate.hybrid ? recallNotesByVector(ctx.store, ctx.env, query) : Promise.resolve(null),
      ])
      const keywordHits = lexical.results.map((hit) => ({ id: hit.id, title: hit.title, snippet: hit.snippet }))
      // A failed or empty meaning list leaves the keyword page standing on its own: the reader keeps the
      // answer they were already getting, and is told it is the narrower one.
      const meaningHits = vector && !vector.failed ? vector.hits.slice(0, NOTE_VECTOR_CANDIDATES) : []
      const fused = fuseNoteHits(keywordHits, meaningHits)
      const allowed = await readableNoteIds(ctx.env.DB, ctx.store.userId, fused.map((hit) => hit.id), scope)
      const hits = fused.filter((hit) => allowed.has(hit.id)).slice(0, NOTE_RESULT_LIMIT)
      // The vault's knowledge is mostly in its links: the page that says "see [[the plan]]" answers a
      // question about the plan without mentioning it. One hop from the best hits, titles only — a
      // neighbour is an invitation to read it, not a second copy of its text.
      const related = await oneHopNeighbours(ctx.env.DB, ctx.store.userId, hits.map((hit) => hit.id), scope)
      return {
        results: hits.map((hit) => ({
          id: hit.id,
          title: hit.title,
          excerpt: hit.excerpt.slice(0, 400),
          source: hit.source,
        })),
        retrieval: meaningHits.length ? 'hybrid' : 'lexical',
        retrieval_note: noteRetrievalNote(gate, vector, keywordHits.length, meaningHits.length),
        ...(related.length
          ? {
              related: related.map((entry) => ({
                id: entry.id,
                title: entry.title,
                via: entry.via,
                direction: entry.direction,
              })),
            }
          : {}),
        ...(scope.restricted ? { scope: SCOPE_NOTE } : {}),
      }
    },
  }),
  tool({
    name: 'list_notes',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'List the reader\'s notes, newest first, with the folder and tags each one carries. Use it to answer how much the notebook holds, what is inside a folder, or which note a title refers to; `search_notes` is for reading what the notes say about a topic.',
    fields: {
      view: { type: 'string', enum: ['recent', 'starred', 'archived'], description: "Which notes: 'recent' (default), 'starred' for the reader's favourites, 'archived' for the ones they filed away.", optional: true },
      folder: { type: 'string', description: 'Folder name or full path to list inside, subfolders included.', maxLength: 200, optional: true },
      tag: { type: 'string', description: 'Tag name to list inside.', maxLength: 200, optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many notes to return. Defaults to 20.', optional: true },
    },
    async run(args, ctx) {
      const listing = await listVaultNotes(ctx.env.DB, ctx.store.userId, await ctx.noteScope(), {
        view: args.view as 'recent' | 'starred' | 'archived' | undefined,
        ...(await vaultFilterFor(args, ctx)),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      })
      return {
        total: listing.total,
        returned: listing.notes.length,
        notes: listing.notes.map((note) => ({
          id: note.id,
          title: note.title,
          folder: note.folder,
          tags: note.tags,
          updated_at: new Date(note.updatedAt).toISOString(),
          ...(note.excerpt ? { excerpt: note.excerpt } : {}),
        })),
        ...(listing.total > listing.notes.length ? { note: 'More notes match than are listed; raise limit or narrow the question.' } : {}),
        ...(listing.scopeLimited ? { scope: SCOPE_NOTE } : {}),
      }
    },
  }),
  tool({
    name: 'count_notes',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Count the reader\'s notes and say where they sit: the total, the folders holding the most, and the tags in use. Use this whenever the question is about how many notes there are.',
    fields: {
      folder: { type: 'string', description: 'Count inside this folder and its subfolders.', maxLength: 200, optional: true },
      tag: { type: 'string', description: 'Count notes carrying this tag.', maxLength: 200, optional: true },
    },
    async run(args, ctx) {
      const counts = await countVaultNotes(ctx.env.DB, ctx.store.userId, await ctx.noteScope(), await vaultFilterFor(args, ctx))
      return {
        total: counts.total,
        starred: counts.starred,
        archived: counts.archived,
        by_folder: counts.folders,
        by_tag: counts.tags,
        ...(counts.scopeLimited ? { scope: SCOPE_NOTE } : {}),
      }
    },
  }),
  tool({
    name: 'list_folders',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the reader\'s notebook folders, with how many notes each holds directly. Use it to name a folder correctly before asking about its contents.',
    fields: {},
    async run(_args, ctx) {
      return { folders: await listVaultFolders(ctx.env.DB, ctx.store.userId, await ctx.noteScope()) }
    },
  }),
  tool({
    name: 'list_tags',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the tags the reader\'s notes carry, most used first. Use it to name a tag correctly before asking about its notes.',
    fields: {},
    async run(_args, ctx) {
      return { tags: await listVaultTags(ctx.env.DB, ctx.store.userId, await ctx.noteScope()) }
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
      await noteWritten(ctx, note.id)
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
        await noteWritten(ctx, note.id)
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
      await noteWritten(ctx, note.id)
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
        // Scoped like every other read of a memory: this tool answers inside a turn, and a turn does not
        // see another project's facts just because it asked a broader question.
        ctx.store.searchMemories(query, 5, 'all', ctx.memoryScope),
        ctx.store.listConversations(query, { limit: 5 }),
      ])
      const scope = await ctx.noteScope()
      const tagFilter = await tagSearchFilter(ctx.env.DB, ctx.store.userId, scope)
      const notes = await searchMcpNotes(ctx.env, ctx.store.userId, ctx.origin, ctx.ftsEnabled, {
        query,
        limit: 5,
        ...tagFilter,
      })
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

export const IMAGE_TOOLS: ToolDefinition[] = [
  tool({
    name: 'image_generate',
    permission: 'write',
    // Two is the ceiling because a picture costs real money at the vendor, and a model that decides to
    // "try a few variations" is spending the reader's balance on a whim.
    maxCallsPerTurn: 2,
    description: 'Draw a picture with the reader\'s own image model, and show it in the reply. Use it when the reader asks for an image. Afterwards describe what you drew in words: the picture is already on screen, so do not paste a link, a data URI or base64.',
    fields: {
      prompt: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'What to draw, written out in full: subject, style, composition and lighting. The image model sees only this.',
      },
      size: {
        type: 'string',
        enum: IMAGE_SIZES,
        optional: true,
        description: 'Only when a particular shape was asked for; otherwise leave it out and let the model choose.',
      },
    },
    async run(args, ctx) {
      const prompt = String(args.prompt)
      // The first enabled model whose purpose is image generation. There is no "active image model"
      // setting to consult: the reader marks a model as the image one by its purpose, and a second one
      // listed after it is a spare rather than a preference to be resolved here.
      const model = (await ctx.store.listModels()).find((entry) => entry.enabled && entry.purpose === 'image_generate')
      if (!model) {
        throw new ToolError('No image model is configured. Add one under Assistant settings → Models and set its purpose to image generation.')
      }
      const provider = await ctx.store.providerRecord(model.providerId)
      if (!provider) throw new ToolError('The image model\'s provider is missing. Check Assistant settings → Models.')
      const picked = await ctx.store.pickProviderKey(provider)
      if (!picked) throw new ToolError('The image model\'s provider has no usable API key.')
      const call = modelEndpoint(model, provider)
      let drawn
      try {
        drawn = await generateImage({
          protocol: call.protocol,
          baseUrl: call.baseUrl,
          apiKey: picked.key,
          model: model.model,
          prompt,
          ...(typeof args.size === 'string' ? { size: args.size } : {}),
        })
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : 'The image model failed.')
      }
      await ctx.store.markProviderKeyUsed(provider.id, picked.keyId)
      const attachment = await saveChatUpload(ctx.store, ctx.env, {
        bytes: drawn.bytes,
        mime: drawn.mime,
        filename: imageFilename(prompt, drawn.mime),
      })
      ctx.generatedAttachments?.push(attachment.id)
      return {
        drawn: { filename: attachment.filename, mime: attachment.mime, bytes: attachment.size },
        note: 'The picture is attached to this reply and the reader can already see it. Describe what you drew in words; do not repeat the prompt back or paste a link.',
      }
    },
  }),
]

/** A name the reader can tell apart in the attachment chip, taken from what they asked for. */
function imageFilename(prompt: string, mime: string): string {
  const words = prompt
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
  return `${words || 'image'}.${mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)}`
}

export const CODE_TOOLS: ToolDefinition[] = [
  tool({
    name: 'code_execute',
    permission: 'write',
    // Enough for the loop this tool exists for — run, read the error, fix the line, run again — and no
    // more. Past that the model is searching rather than computing, and the reader is paying per request.
    maxCallsPerTurn: 3,
    description: 'Run a short JavaScript program and read back what it printed and returned. Write the body of an async function: `return` the value you want back, and `console.log` anything you want to see along the way. It is a small interpreter with no network, no imports, no timers and no access to the reader\'s notes or files, so it is a scratchpad for calculation and text handling rather than a way to reach anything. Use it when a number or a transformation has to be right.',
    fields: {
      code: {
        type: 'string',
        minLength: 1,
        maxLength: 20_000,
        description: 'The program itself. `return` and `await` both work, and `console.log` comes back to you. If the result carries an `error`, fix that line and run again.',
      },
    },
    async run(args) {
      try {
        return await runSandboxedCode(String(args.code))
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : 'The code interpreter failed.')
      }
    },
  }),
]

/** How much of a page is kept: enough for an article, small enough to sit in one turn's budget. */
const FETCH_URL_MAX_BYTES = 512 * 1024
const FETCH_URL_MAX_CHARS = 24_000

/** The handful of entities a page actually uses, plus the numeric form for the rest. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

/**
 * The words of a page, without its markup.
 *
 * Deliberately not a parser: what the model needs is the text and where it came from, and a dependency
 * for that would be a dependency for every turn. Scripts, styles and comments are dropped whole — their
 * contents are not prose and would otherwise arrive as the bulk of the answer — and block ends become
 * newlines so paragraphs survive.
 */
function readableText(html: string): { title: string, text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '')
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return {
    title: title.slice(0, 200),
    text: decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
  }
}

export const WEB_TOOLS: ToolDefinition[] = [
  tool({
    name: WEB_SEARCH_TOOL_NAME,
    permission: 'read',
    // Two, the same ceiling the note-side search carries: one search to ask the question and one to refine
    // it is a working turn, and past that a model is paging through results with the reader's clock running.
    maxCallsPerTurn: 2,
    // Not offered without a channel that could answer. The switch in the composer then says why rather than
    // letting the model call a tool that would answer with a configuration error on every turn — and for a
    // hosted engine the missing thing is a key rather than an address, which is the same refusal said about
    // the other half of what an engine needs.
    requires: (_env, settings, ctx) => webSearchConfigured(settings, Boolean(ctx.webSearchKey)),
    description: 'Search the web through the engine the reader picked and get back titles, addresses and short excerpts. Use it when the answer needs what is true out there now, or a fact you are not sure of. It searches only that engine and cannot read a page: use fetch_url for one you already have the address of.',
    fields: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'What to search for, in the words a search engine understands.',
      },
    },
    async run(args, ctx) {
      const query = String(args.query)
      const engine = webSearchEngineFor(ctx.settings.webSearchEngine)
      // A vendor's address is written down in the engine table; only a self-hosted engine reads the one the
      // reader typed, and an empty one of those still means the tool is off.
      const endpoint = (engine.selfHosted ? ctx.settings.webSearchEndpoint : engine.endpoint ?? '').trim()
      const apiKey = ctx.webSearchKey ?? ''
      // Unreachable through the executor, which will not offer the tool without what its engine asks for; said
      // anyway because a scheduled run and an approval replay both reach `run` by other doors.
      if (!endpoint) throw new ToolError('Web search has no engine configured. Set one under Assistant settings.')
      if (engine.requiresKey && !apiKey) {
        throw new ToolError(`Web search needs a key for ${engine.name}. Store one under Assistant settings.`)
      }
      let hits
      try {
        hits = await searchWeb({ engine, endpoint, query, apiKey })
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : 'The search engine did not answer.')
      }
      return {
        query,
        results: hits,
        ...(hits.length
          ? { note: 'Cite the pages you used by their url. The reader sees these as source cards.' }
          : { note: 'That engine returned nothing for this query. Answer without it or rephrase the search.' }),
      }
    },
  }),
  tool({
    name: 'fetch_url',
    permission: 'read',
    // Three is enough to read a page and the two it points at; past that a model is wandering.
    maxCallsPerTurn: 3,
    description: 'Read one public web page and return its text. Use it when the reader gives a link, or when an answer needs what a page actually says rather than what you remember about it. It cannot log in, follow a redirect, or reach a private address.',
    fields: {
      url: {
        type: 'string',
        minLength: 8,
        maxLength: 2048,
        description: 'An absolute https URL of a public page.',
      },
    },
    async run(args) {
      let target: URL
      try {
        target = assertRelayableEndpoint(String(args.url))
      } catch {
        throw new ToolError('Only a public http(s) URL can be read.')
      }
      // https only: a plain-http page can be rewritten in transit, and the model has no way to tell.
      if (target.protocol !== 'https:') throw new ToolError('Only an https URL can be read.')
      let response: Response
      try {
        response = await fetch(target.toString(), {
          redirect: NO_REDIRECT,
          headers: { 'user-agent': 'Inkstone-Chat/1.0', accept: 'text/html,text/plain,application/json' },
        })
      } catch {
        throw new ToolError('That URL could not be reached.')
      }
      // A redirect is how a public address becomes a private one; the fetch refuses to follow, and the
      // model is told so rather than handed the redirect target as if it had read it.
      if (isRedirectResponse(response)) throw new ToolError('That URL redirects, which this tool does not follow.')
      if (!response.ok) throw new ToolError(`That URL returned ${response.status}.`)
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/.test(mime)) {
        throw new ToolError(`That URL is ${mime || 'an unknown type'}, which is not a page this tool can read.`)
      }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > FETCH_URL_MAX_BYTES) throw new ToolError('That page is too large to read in one turn.')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > FETCH_URL_MAX_BYTES) throw new ToolError('That page is too large to read in one turn.')
      const raw = new TextDecoder().decode(bytes)
      const page = /html|xml/.test(mime) ? readableText(raw) : { title: '', text: raw.trim() }
      return {
        url: target.toString(),
        title: page.title,
        text: page.text.slice(0, FETCH_URL_MAX_CHARS),
        ...(page.text.length > FETCH_URL_MAX_CHARS ? { truncated: true } : {}),
      }
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
  ...IMAGE_TOOLS,
  ...CODE_TOOLS,
  ...WEB_TOOLS,
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
    /** This turn's external tools, listed by the runner before the first request goes out. */
    private readonly external: ToolDefinition[] = [],
  ) {}

  get callCount(): number {
    return this.calls
  }

  /**
   * The context one call runs under.
   *
   * The turn's own attachment collector rides along untouched: it belongs to the turn, which is the only
   * party that can put what it holds on the answer, and a second one made here would collect into an
   * array nobody reads.
   */
  private contextFor(callId: string): ToolContext {
    return { ...this.ctx, callId }
  }

  budgetExhausted(): boolean {
    return this.calls >= this.budget.maxToolCalls
  }

  available(): ToolDefinition[] {
    if (this.budget.maxToolCalls <= 0) return []
    const own = this.ctx.mode === 'chat'
      ? ALL_TOOLS
      : ALL_TOOLS.filter((definition) => definition.permission === 'read' || definition.name === 'notify_reader')
    // An automation has no reader watching, so a remote tool that needs an Approve press is not offered.
    const remote = this.ctx.mode === 'chat' ? this.external : this.external.filter((definition) => definition.permission !== 'destructive')
    // The reader's policy comes last and can only ever take tools away: it is a ceiling on what the turn
    // may reach, not a second list of things to reach for.
    return [...own, ...remote].filter((definition) => this.offers(definition))
  }

  /**
   * Whether the reader's policy leaves this tool on the table.
   *
   * In chat the answer is the policy itself: a class the reader closed is closed. In an unwatched run
   * there are two more things to say. A tool held for approval is not offered at all, because a card
   * nobody can press is a call that fails rather than one that waits. And `notify_reader` is never taken
   * away there — a routine exists to tell the reader something, so a policy that silenced the telling
   * would leave a schedule that runs every morning and says nothing.
   */
  private offers(definition: ToolDefinition): boolean {
    // A capability the deployment does not have, or an address the reader has not configured, takes the
    // tool away before the reader's policy is asked, because no policy can put it back.
    if (definition.requires && !definition.requires(this.ctx.env, this.ctx.settings, this.ctx)) return false
    const mode = toolModeFor(this.ctx.settings, definition.permission)
    if (this.ctx.mode === 'chat') return mode !== 'off'
    return mode === 'auto' || definition.name === 'notify_reader'
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
    const args = definition.external ? asArgumentRecord(rawArgs) : validateArgs(definition.fields, rawArgs)
    const signature = `${name}:${stableStringify(args)}`
    if ((this.signatures.get(signature) ?? 0) >= 1) {
      throw new ToolError('This exact call was already made in this request. Use the earlier result instead of repeating it.')
    }
    this.calls++
    this.perTool.set(name, used + 1)
    this.signatures.set(signature, (this.signatures.get(signature) ?? 0) + 1)

    if (toolModeFor(this.ctx.settings, definition.permission) === 'auto') {
      // A read or a write *is* the call. A deletion goes through the same prepare/commit pair the
      // approval card runs, minus the wait: skipping `prepare` would also skip the lookup that decides
      // what this tool is allowed to touch.
      if (definition.permission !== 'destructive') return await definition.run(args, this.contextFor(callId))
      const prepared = await definition.prepare(args, this.contextFor(callId))
      return await definition.commit(prepared.targetId, this.contextFor(callId), args)
    }
    if (!this.ctx.conversationId) throw new ToolError(`"${name}" needs the reader's approval and can only be used in chat.`)
    // A deletion looks its target up, and the card reads that name back. A read or a write has no such
    // lookup, so what the model proposed is kept whole instead: approving replays exactly the call that
    // was shown, which is the same promise the deletion path keeps by remembering its target.
    const prepared = definition.permission === 'destructive'
      ? await definition.prepare(args, this.contextFor(callId))
      : { targetId: '', targetLabel: '' }
    const action = await this.ctx.store.createPendingAction({
      conversationId: this.ctx.conversationId,
      tool: definition.name,
      targetId: prepared.targetId,
      targetLabel: prepared.targetLabel,
      // What the model proposed, kept so approving runs exactly that and not a re-derivation.
      args: definition.permission === 'destructive' && !definition.external ? undefined : args,
    })
    this.approvals.set(callId, { id: action.id, toolId: callId })
    return {
      status: 'awaiting_reader_approval',
      action: `${definition.name} ${prepared.targetLabel}`.trim(),
      note: 'Nothing has changed yet. The reader now sees an Approve button for exactly this action. Tell them briefly what you proposed. Do not call this tool again for the same item, and do not say it is done.',
    }
  }
}

/** A remote tool decides what a valid argument object is; this only refuses the things that are not one. */
function asArgumentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
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
  const definition = ctx.externalByName?.get(stored.tool) ?? TOOL_BY_NAME.get(stored.tool)
  if (!definition) throw ApiError.notFound('This action no longer exists.')
  if (stored.status === 'expired') {
    await store.resolvePendingAction(actionId, { status: 'expired' })
    throw ApiError.conflict('This request expired. Ask again to get a new one.')
  }
  if (!(await store.claimPendingAction(actionId, 'approved'))) {
    throw ApiError.conflict('This action was already handled.')
  }
  let output: unknown
  try {
    // A deletion is redone from the target it named. A read or a write has no target to redo from, so the
    // arguments that were shown on the card are replayed whole — the call the reader approved, and no
    // other.
    output = definition.permission === 'destructive'
      ? await definition.commit(stored.targetId, ctx, stored.args ?? {})
      : await definition.run(stored.args ?? {}, { ...ctx, callId: stored.id })
  } catch (error) {
    await store.resolvePendingAction(actionId, {
      status: 'failed',
      error: error instanceof ToolError ? error.message : 'The action failed.',
    })
    if (!(error instanceof ToolError)) console.error('[inkstone] approved assistant action failed:', error instanceof Error ? error.message : error)
  }
  return {
    action: await store.getPendingAction(actionId),
    // A tool that answers with something hands it back, so the card's call can be read afterwards: an
    // approved remote call is otherwise the one tool result no thread ever shows.
    ...(output === undefined ? {} : { result: toolPayloadText(output) }),
  }
}

export async function cancelApprovedAction(store: AssistantStore, actionId: string) {
  const stored = await store.getPendingAction(actionId)
  if (!stored) throw ApiError.notFound('This action no longer exists.')
  if (stored.status !== 'pending') return stored
  await store.resolvePendingAction(actionId, { status: 'cancelled' })
  return await store.getPendingAction(actionId)
}

// ------------------------------------------------------------- note plumbing

/**
 * Leave a mark on the note that says which conversation wrote it.
 *
 * The notebook's backlink panel is built from `[[links]]` inside note text, so a note the assistant
 * wrote has no backlinks at all — nothing points at it, because a conversation is not a note. This is
 * what lets the note say where it came from.
 *
 * Best-effort on purpose: the note is already written and stored by the time this runs, and a failure
 * here would report the whole call as failed for something the reader can neither see nor act on. The
 * loss is one backlink, and it is logged rather than swallowed.
 */
async function noteWritten(ctx: ToolContext, noteId: string): Promise<void> {
  if (!ctx.conversationId) return
  try {
    await ctx.store.recordNoteWrite(noteId, ctx.conversationId)
  } catch (error) {
    console.warn('[inkstone] note origin not recorded:', error instanceof Error ? error.message : error)
  }
}

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
