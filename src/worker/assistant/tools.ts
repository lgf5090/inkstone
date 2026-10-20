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

import type { AssistantArtifact, AssistantSettings, Task } from '@shared/assistant'
import { ASSISTANT_TOOL_SPECS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_ARTIFACTS_PER_CONVERSATION, MAX_TASK_TITLE_CHARS, TASK_PRIORITIES, TASK_STATUSES, WEB_SEARCH_TOOL_NAME, toolPayloadText, toolModeFor, webSearchConfigured, type AssistantMemory, type AssistantMemoryCategory, type AutomationKind } from '@shared/assistant'
import { webSearchEngineFor } from '@shared/web-search-engines'
import { MEMORY_CATEGORIES_FOR_TOOLS } from './memory-service'
import { parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { hasHistoricalIntent } from '@shared/assistant-memory'
import type { ScheduleSpec } from '@shared/assistant-schedule'
import type { Env } from '../env'
import type { McpWriteContext } from '../mcp/writes'
import { createMcpNote, editMcpNote, trashMcpNote } from '../mcp/writes'
import { readMcpNote, searchMcpNotes } from '../mcp/retrieval'
import { buildOverview } from '../subscriptions/overview'
import { normalizeColor, normalizeIcon } from '@shared/subscriptions/identity'
import { listChannels, loadSettings } from '../subscriptions/settings'
import { SubscriptionsStore, storeContext, type StoreContext } from '../subscriptions/store'
import {
  CURRENCY_CODES,
  labelNamesOf,
  PERIOD_UNITS,
  RULES_LIMIT,
  SOON_DAYS,
  type CurrencyCode,
  type LabelKind,
  type PeriodUnit,
  type ReminderRuleInput,
  type SubscriptionDetail,
  type SubscriptionItem,
  type SubscriptionMode,
} from '@shared/subscriptions/model'
import { ApiError } from '../lib/errors'
import { ArtifactVersionConflictError, type AssistantStore, type MemoryScope } from './store'
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
   * The draft the reader has open, so the artifact tools can default to it.
   *
   * Only the id: the tools read the row again before writing, which is what keeps a draft changed
   * between two calls from being overwritten with the copy the model last saw.
   */
  artifactContext?: { id: string }
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

/** How much of a draft one read returns by default, and the most it will return at once. */
const READ_ARTIFACT_DEFAULT_CHARS = 12_000
const READ_ARTIFACT_MAX_CHARS = 20_000

function requireConversation(ctx: ToolContext): string {
  if (!ctx.conversationId) throw new ToolError('Drafts belong to a conversation, and this run has none.')
  return ctx.conversationId
}

/**
 * The draft a tool means: the one named, or the one the reader has open.
 *
 * The row is read fresh every time rather than taken from the turn context, because the reader may
 * have typed into it between two tool calls — and the version check on the write is what turns that
 * into a refusal instead of an overwrite.
 */
async function resolveArtifact(ref: unknown, ctx: ToolContext): Promise<AssistantArtifact> {
  const conversationId = requireConversation(ctx)
  const id = typeof ref === 'string' && ref.trim() ? ref.trim() : ctx.artifactContext?.id
  if (!id) throw new ToolError('No draft is open. Call list_artifacts to see the drafts in this conversation, then pass its id.')
  const artifact = await ctx.store.getArtifact(id)
  if (!artifact || artifact.conversationId !== conversationId) throw new ToolError('No such draft in this conversation.')
  return artifact
}

/** The metadata a write returns: enough for the model and the panel, never the whole document. */
function artifactReceipt(artifact: AssistantArtifact, created: boolean): Record<string, unknown> {
  return {
    artifact: {
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      chars: artifact.content.length,
      created,
    },
  }
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

export const ARTIFACT_TOOLS: ToolDefinition[] = [
  tool({
    name: 'list_artifacts',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the drafts this conversation keeps in the canvas, with their ids, titles and versions.',
    fields: {},
    async run(_args, ctx) {
      const conversationId = requireConversation(ctx)
      const artifacts = await ctx.store.listArtifacts(conversationId)
      return {
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          version: artifact.version,
          chars: artifact.content.length,
          updated_at: artifact.updatedAt,
        })),
      }
    },
  }),
  tool({
    name: 'read_artifact',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Read a draft\'s text. Omit id to read the draft the reader has open. Long drafts can be read in slices with offset and limit.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26, optional: true, description: 'The draft id; defaults to the open draft.' },
      offset: { type: 'integer', minimum: 0, optional: true },
      limit: { type: 'integer', minimum: 1, maximum: READ_ARTIFACT_MAX_CHARS, optional: true },
    },
    async run(args, ctx) {
      const artifact = await resolveArtifact(args.id, ctx)
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.trunc(args.offset)) : 0
      const limit = typeof args.limit === 'number'
        ? Math.min(READ_ARTIFACT_MAX_CHARS, Math.max(1, Math.trunc(args.limit)))
        : READ_ARTIFACT_DEFAULT_CHARS
      const content = artifact.content.slice(offset, offset + limit)
      return {
        artifact: {
          id: artifact.id,
          title: artifact.title,
          version: artifact.version,
          chars: artifact.content.length,
          offset,
          content,
          truncated: offset + content.length < artifact.content.length,
        },
      }
    },
  }),
  tool({
    name: 'create_artifact',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Create a new draft in the canvas and show it to the reader. Use this for a document, plan, spec or long piece they will keep working on, not for a short answer.',
    fields: {
      title: { type: 'string', maxLength: MAX_ARTIFACT_TITLE_CHARS, optional: true },
      content: { type: 'string', maxLength: MAX_ARTIFACT_CONTENT_CHARS },
    },
    async run(args, ctx) {
      const conversationId = requireConversation(ctx)
      if (await ctx.store.countArtifacts(conversationId) >= MAX_ARTIFACTS_PER_CONVERSATION) {
        throw new ToolError(`This conversation already holds ${MAX_ARTIFACTS_PER_CONVERSATION} drafts. Edit one instead of making another.`)
      }
      const title = typeof args.title === 'string' ? args.title.slice(0, MAX_ARTIFACT_TITLE_CHARS) : ''
      const content = String(args.content).slice(0, MAX_ARTIFACT_CONTENT_CHARS)
      const artifact = await ctx.store.createArtifact({
        conversationId,
        title,
        content,
        source: 'assistant',
      })
      await ctx.store.recordActivity('artifact.created', title || 'Untitled draft')
      return artifactReceipt(artifact, true)
    },
  }),
  tool({
    name: 'update_artifact',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Rewrite a draft. Omit id for the open draft. Read it first. Use content to replace the whole body, append to add at the end, or find and replace to change one exact passage.',
    fields: {
      id: { type: 'string', minLength: 1, maxLength: 26, optional: true, description: 'The draft id; defaults to the open draft.' },
      title: { type: 'string', maxLength: MAX_ARTIFACT_TITLE_CHARS, optional: true },
      content: { type: 'string', maxLength: MAX_ARTIFACT_CONTENT_CHARS, optional: true },
      append: { type: 'string', maxLength: 20_000, optional: true },
      find: { type: 'string', maxLength: 8_000, optional: true, description: 'Exact text to replace; must occur once.' },
      replace: { type: 'string', maxLength: 20_000, optional: true, description: 'The text that takes the place of find.' },
    },
    async run(args, ctx) {
      const artifact = await resolveArtifact(args.id, ctx)
      const hasContent = typeof args.content === 'string'
      const hasAppend = typeof args.append === 'string'
      const hasFind = typeof args.find === 'string'
      const hasReplace = typeof args.replace === 'string'
      if (hasFind !== hasReplace) throw new ToolError('find and replace have to be given together.')
      if ([hasContent, hasAppend, hasFind].filter(Boolean).length > 1) {
        throw new ToolError('Choose one: content, append, or find + replace.')
      }
      if (!hasContent && !hasAppend && !hasFind && typeof args.title !== 'string') {
        throw new ToolError('Name content, append, find + replace, or a new title.')
      }
      let next = artifact.content
      if (hasContent) {
        next = String(args.content)
      } else if (hasAppend) {
        const separator = next && !next.endsWith('\n') ? '\n' : ''
        next = `${next}${separator}${String(args.append)}`
      } else if (hasFind) {
        const find = String(args.find)
        if (!find) throw new ToolError('find cannot be empty.')
        const at = next.indexOf(find)
        if (at < 0) throw new ToolError('The text to replace was not found. Read the draft and use an exact excerpt.')
        if (next.indexOf(find, at + find.length) >= 0) {
          throw new ToolError('That text occurs more than once. Use a longer excerpt that appears only once.')
        }
        next = `${next.slice(0, at)}${String(args.replace)}${next.slice(at + find.length)}`
      }
      const title = typeof args.title === 'string' ? args.title.slice(0, MAX_ARTIFACT_TITLE_CHARS) : artifact.title
      const unchanged = next === artifact.content && title === artifact.title
      if (unchanged) return { ...artifactReceipt(artifact, false), changed: false }
      let updated: AssistantArtifact | null
      try {
        updated = await ctx.store.updateArtifact(
          artifact.id,
          { content: next, title },
          { source: 'assistant', baseVersion: artifact.version },
        )
      } catch (error) {
        if (error instanceof ArtifactVersionConflictError) {
          throw new ToolError('The draft changed while you were writing. Read it again, then make the change against the new version.')
        }
        throw error
      }
      if (!updated) throw new ToolError('The draft disappeared before it could be written.')
      await ctx.store.recordActivity('artifact.updated', updated.title || 'Untitled draft')
      return { ...artifactReceipt(updated, false), changed: true }
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
    description: 'Search the reader\'s tasks, notes, memories, subscriptions and past conversations at once.',
    fields: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    async run(args, ctx) {
      const query = String(args.query)
      const [tasks, memories, conversations, subscriptions] = await Promise.all([
        ctx.store.listTasks({ query, limit: 5 }),
        // Scoped like every other read of a memory: this tool answers inside a turn, and a turn does not
        // see another project's facts just because it asked a broader question.
        ctx.store.searchMemories(query, 5, 'all', ctx.memoryScope),
        ctx.store.listConversations(query, { limit: 5 }),
        // A subscription is a fact about money and a date, which is exactly what a reader asks the
        // assistant for when they do not want to open the app: "do I still have that gym thing?".
        (async () => {
          const { store, context } = await subscriptionAccess(ctx)
          const folded = query.toLocaleLowerCase()
          return (await store.list(context))
            .filter((item) => `${item.name} ${item.customType} ${item.category} ${item.notes}`.toLocaleLowerCase().includes(folded))
            .slice(0, 5)
            .map((item) => ({
              id: item.id,
              name: item.name,
              amount: item.amount,
              currency: item.currency,
              expiryDate: item.expiryDate.slice(0, 10),
              daysRemaining: item.daysRemaining,
            }))
        })(),
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
        subscriptions,
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

/**
 * The subscriptions app, reachable from a conversation.
 *
 * The notes vault set the shape: the tools call the same store the HTTP routes call, with the account
 * the session named, so tenancy is a property of how the store is built rather than a check somebody
 * has to remember. A settings read per call is the price of not threading subscription state through
 * `ToolContext`, and it is one indexed row.
 *
 * Deleting is the only destructive verb, and it is the trash rather than the erasure — which is the same
 * choice the app itself makes, and means an approved action stays undoable after the card is dismissed.
 */
export const SUBSCRIPTION_TOOLS: ToolDefinition[] = [
  tool({
    name: 'list_subscriptions',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'List the reader\'s subscriptions with their price, cycle, expiry and how many days are left. Filter to what is due, overdue, switched off, sitting in the trash, or matching a word in a name, type, category or note. `trash` is the only way to see what has been deleted but not yet erased — ask for it before saying nothing was deleted.',
    fields: {
      status: { type: 'string', enum: ['all', 'soon', 'expired', 'active', 'disabled', 'trash'], optional: true, description: 'soon = due within a week. trash = deleted subscriptions that can still be restored. Defaults to all, which excludes the trash.' },
      query: { type: 'string', maxLength: 120, optional: true },
      category: { type: 'string', maxLength: 40, optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, optional: true },
    },
    async run(args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const status = (args.status as string) ?? 'all'
      // The trash is a separate read rather than a filter on the live list: `store.list` excludes those
      // rows in SQL, so a model that never learns the word `trash` cannot see them at all — which is how
      // a restore attempt ended up reporting an empty trash that held one subscription.
      const items = status === 'trash' ? await store.list(context, 'trash') : await store.list(context)
      const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : ''
      const category = typeof args.category === 'string' ? args.category.trim().toLocaleLowerCase() : ''
      const matched = items.filter((item) => {
        if (status === 'soon' && !(item.daysRemaining >= 0 && item.daysRemaining <= SOON_DAYS)) return false
        if (status === 'expired' && item.daysRemaining >= 0) return false
        if (status === 'active' && (item.daysRemaining < 0 || !item.isActive)) return false
        if (status === 'disabled' && item.isActive) return false
        if (category && !labelNamesOf(item.category, 'category').some((token) => token.toLocaleLowerCase() === category)) return false
        if (query) {
          const haystack = `${item.name} ${item.customType} ${item.category} ${item.notes}`.toLocaleLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      }).sort((left, right) => left.daysRemaining - right.daysRemaining)
      const limit = Number(args.limit ?? 15)
      const page = matched.slice(0, limit)
      return {
        total: matched.length,
        // Same honesty rule as the note list: a page is not the whole answer, and a model that is not
        // told the difference will summarise fifteen subscriptions as if they were the account.
        returned: page.length,
        more: matched.length > page.length,
        subscriptions: page.map(presentSubscription),
      }
    },
  }),
  tool({
    name: 'get_subscription',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'Read one subscription in full: its reminder rules, when the next one fires, and its payment history with what each receipt bought.',
    fields: { ref: { type: 'string', minLength: 1, maxLength: 120, description: 'The id, or the name the reader used.' } },
    async run(args, ctx) {
      const { detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      return {
        subscription: presentSubscription(detail.item),
        notes: detail.item.notes.slice(0, 1000),
        reminders: detail.rules.map((rule) => ({
          id: rule.id,
          type: rule.type,
          value: rule.value,
          unit: rule.unit,
          repeatInterval: rule.repeatInterval,
          repeatUntil: rule.repeatUntil,
          muted: Boolean(rule.acknowledgedAt),
          enabled: rule.isEnabled,
        })),
        nextReminder: detail.nextReminder,
        payments: detail.payments.slice(0, 12).map((payment) => ({
          id: payment.id,
          paidAt: payment.paidAt.slice(0, 10),
          amount: payment.amount,
          currency: payment.currency,
          kind: payment.kind,
          note: payment.note,
        })),
        paymentCount: detail.payments.length,
      }
    },
  }),
  tool({
    name: 'subscription_summary',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'The account\'s money picture in one call: what this month and this year have cost in the reader\'s total currency, how that compares with last month, the ceiling the reader set for a month and whether this month is over it, what the current plans commit for a year, which trials are about to start charging, which plans changed price, what renews in the next week, where the spending goes by type and by category, and whether the reminder scheduler is still running.',
    fields: {},
    async run(_args, ctx) {
      const settings = await loadSettings(ctx.env.DB, ctx.store.userId)
      const overview = await buildOverview(ctx.env, ctx.env.DB, ctx.store.userId, settings)
      return {
        totalCurrency: settings.baseCurrency,
        timezone: settings.timezone,
        monthly: overview.monthly,
        yearly: overview.yearly,
        // The ceiling is the reader's own number, and `limit: null` means they never set one — which is a
        // different answer from "not over budget". Leaving it out made the tool unable to say either.
        budget: overview.budget,
        committedYearly: overview.committedYearly,
        trials: overview.trials,
        priceChanges: overview.priceChanges,
        active: overview.active,
        upcoming: overview.upcoming.slice(0, 8),
        byType: overview.byType.slice(0, 6),
        byCategory: overview.byCategory.slice(0, 6),
        months: overview.months,
        scheduler: overview.scheduler
          ? { status: overview.scheduler.status, at: overview.scheduler.startedAt, sent: overview.scheduler.sentCount, reason: overview.scheduler.reason }
          : { status: 'never', note: 'The reminder job has not run yet for this account.' },
      }
    },
  }),
  tool({
    name: 'create_subscription',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Add a subscription. `expiryDate` is the day it next ends, as YYYY-MM-DD in the reader\'s own time zone — ask them rather than inventing it, because a wrong date sends every reminder to the wrong day. Four reminders (7, 3 and 1 days before, plus the day itself) are set unless `reminders` says otherwise.',
    fields: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      expiryDate: { type: 'string', minLength: 10, maxLength: 10, description: 'YYYY-MM-DD.' },
      amount: { type: 'number', minimum: 0, maximum: 1e9, optional: true, description: 'Omit for a free plan; send 0 only for a plan that genuinely costs nothing.' },
      currency: { type: 'string', enum: [...CURRENCY_CODES], optional: true },
      type: { type: 'string', maxLength: 40, optional: true },
      category: { type: 'string', maxLength: 40, optional: true, description: 'Several tags separated by "/".' },
      periodValue: { type: 'integer', minimum: 1, maximum: 120, optional: true },
      periodUnit: { type: 'string', enum: [...PERIOD_UNITS], optional: true },
      mode: { type: 'string', enum: ['cycle', 'reset'], optional: true },
      startDate: { type: 'string', maxLength: 10, optional: true },
      useLunar: { type: 'boolean', optional: true, description: 'True when the reader set the date by the lunar calendar, so the app keeps showing it that way.' },
      isActive: { type: 'boolean', optional: true, description: 'False switches reminders and renewal tracking off. Defaults to on.' },
      autoRenew: { type: 'boolean', optional: true, description: 'False means the plan stops at its expiry instead of charging again, so the app says so. Defaults to on.' },
      trialEndsAt: { type: 'string', maxLength: 10, optional: true, description: 'YYYY-MM-DD the free period turns into a charge. Leave out unless this is a trial.' },
      notes: { type: 'string', maxLength: 2000, optional: true },
      reminders: { type: 'string', maxLength: 200, optional: true, description: 'Comma-separated: "7d" or "12h" for that far ahead, "on" for the day itself, "after:24" to repeat every 24 hours once overdue.' },
    },
    async run(args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const created = await store.create({
        name: String(args.name),
        customType: typeof args.type === 'string' ? args.type : '',
        category: typeof args.category === 'string' ? args.category : '',
        amount: args.amount === undefined ? null : Number(args.amount),
        currency: (args.currency as CurrencyCode) ?? 'CNY',
        startDate: typeof args.startDate === 'string' && args.startDate ? args.startDate : null,
        expiryDate: `${String(args.expiryDate)}T00:00:00Z`,
        periodValue: args.periodValue === undefined ? 1 : Number(args.periodValue),
        periodUnit: (args.periodUnit as PeriodUnit) ?? 'month',
        subscriptionMode: (args.mode as SubscriptionMode) ?? 'cycle',
        useLunar: args.useLunar === true,
        isActive: args.isActive === undefined ? true : args.isActive === true,
        autoRenew: args.autoRenew === undefined ? true : args.autoRenew === true,
        trialEndsAt: typeof args.trialEndsAt === 'string' && args.trialEndsAt ? `${args.trialEndsAt}T00:00:00Z` : null,
        notes: typeof args.notes === 'string' ? args.notes : '',
        reminderRules: typeof args.reminders === 'string' ? parseReminderSpec(args.reminders) : undefined,
      }, context)
      return { created: presentSubscription(created.item), reminders: created.rules.length }
    },
  }),
  tool({
    name: 'update_subscription',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Change the fields of one subscription. Only what is named is touched, so leaving `amount` out keeps the price it has. Pass the whole current `expiryDate` unchanged when editing something else, because the server requires the field.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      name: { type: 'string', maxLength: 120, optional: true },
      expiryDate: { type: 'string', maxLength: 10, optional: true },
      amount: { type: 'number', minimum: 0, maximum: 1e9, optional: true },
      currency: { type: 'string', enum: [...CURRENCY_CODES], optional: true },
      type: { type: 'string', maxLength: 40, optional: true },
      category: { type: 'string', maxLength: 40, optional: true },
      periodValue: { type: 'integer', minimum: 1, maximum: 120, optional: true },
      periodUnit: { type: 'string', enum: [...PERIOD_UNITS], optional: true },
      mode: { type: 'string', enum: ['cycle', 'reset'], optional: true },
      startDate: { type: 'string', maxLength: 10, optional: true, description: 'YYYY-MM-DD the plan started. It anchors a reset-cycle expiry, so changing it moves the date.' },
      useLunar: { type: 'boolean', optional: true, description: 'Whether the app keeps showing the expiry date by the lunar calendar.' },
      autoRenew: { type: 'boolean', optional: true },
      notes: { type: 'string', maxLength: 2000, optional: true },
    },
    async run(args, ctx) {
      const { store, context, detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      const current = detail.item
      const updated = await store.update(current.id, {
        name: typeof args.name === 'string' ? args.name : current.name,
        customType: typeof args.type === 'string' ? args.type : current.customType,
        category: typeof args.category === 'string' ? args.category : current.category,
        amount: args.amount === undefined ? current.amount : Number(args.amount),
        currency: (args.currency as CurrencyCode) ?? current.currency,
        startDate: typeof args.startDate === 'string' && args.startDate ? args.startDate : current.startDate,
        expiryDate: `${(typeof args.expiryDate === 'string' && args.expiryDate ? args.expiryDate : current.expiryDate.slice(0, 10))}T00:00:00Z`,
        periodValue: args.periodValue === undefined ? current.periodValue : Number(args.periodValue),
        periodUnit: (args.periodUnit as PeriodUnit) ?? current.periodUnit,
        subscriptionMode: (args.mode as SubscriptionMode) ?? current.subscriptionMode,
        useLunar: args.useLunar === undefined ? current.useLunar : args.useLunar === true,
        isActive: current.isActive,
        autoRenew: args.autoRenew === undefined ? current.autoRenew : args.autoRenew === true,
        notes: typeof args.notes === 'string' ? args.notes : current.notes,
      }, context)
      if (!updated) throw new ToolError('That subscription is gone.')
      return { updated: presentSubscription(updated.item) }
    },
  }),
  tool({
    name: 'renew_subscription',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Record that a subscription was paid for again: it writes the receipt and moves the expiry date by the cycle. Use this rather than `update_subscription` when the reader says they just paid, because editing the date alone leaves the spending history wrong.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      paymentDate: { type: 'string', maxLength: 10, optional: true, description: 'YYYY-MM-DD. Defaults to today.' },
      amount: { type: 'number', minimum: 0, maximum: 1e9, optional: true, description: 'Defaults to the price on file.' },
      periods: { type: 'integer', minimum: 1, maximum: 120, optional: true, description: 'How many cycles this pays for, for an annual prepayment. Defaults to 1.' },
      note: { type: 'string', maxLength: 200, optional: true },
    },
    async run(args, ctx) {
      const { store, context, detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      if (!detail.item.periodValue || !detail.item.periodUnit) {
        throw new ToolError('That subscription has no cycle set, so there is nothing to extend it by. Give it a period first.')
      }
      const renewed = await store.renew(detail.item.id, {
        paymentDate: typeof args.paymentDate === 'string' && args.paymentDate ? `${args.paymentDate}T00:00:00Z` : undefined,
        amount: args.amount === undefined ? undefined : Number(args.amount),
        periodMultiplier: args.periods === undefined ? 1 : Number(args.periods),
        note: typeof args.note === 'string' ? args.note : undefined,
      }, context)
      if (!renewed) throw new ToolError('That subscription is gone.')
      return { renewed: presentSubscription(renewed.item), payments: renewed.payments.length }
    },
  }),
  tool({
    name: 'set_subscription_reminders',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Replace one subscription\'s reminder rules. Send an empty string to switch reminders off entirely.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      reminders: { type: 'string', maxLength: 200, description: 'Comma-separated: "7d", "12h", "on", "after:24". At most 10 rules.' },
    },
    async run(args, ctx) {
      const { store, detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      const rules = parseReminderSpec(String(args.reminders))
      const saved = await store.replaceRules(detail.item.id, rules)
      if (!saved) throw new ToolError('That subscription is gone.')
      return { reminders: saved.map((rule) => ({ type: rule.type, value: rule.value, unit: rule.unit, repeatInterval: rule.repeatInterval })) }
    },
  }),
  tool({
    name: 'set_subscription_style',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Give a subscription type or a category its icon and colour. The choice applies everywhere that name appears — the list, the filter rail, the spending bars, the detail header — and to every subscription wearing it, not just one row.',
    fields: {
      kind: { type: 'string', enum: ['type', 'category'] },
      name: { type: 'string', minLength: 1, maxLength: 40 },
      icon: { type: 'string', maxLength: 40, optional: true, description: 'As `lucide:<Name>`, e.g. lucide:Cloud. Send an empty string to go back to the default.' },
      color: { type: 'string', maxLength: 7, optional: true, description: 'A palette hex such as #2563eb. Send an empty string for the derived default.' },
    },
    async run(args, ctx) {
      const kind = args.kind as LabelKind
      const name = String(args.name).trim()
      // Checked here as well as in the route, because this is the other door into the same write. The
      // store turns anything it does not recognise into "unset", which for a tool call would mean the
      // model asked for a face, was told nothing went wrong, and quietly got the label cleared instead.
      const icon = typeof args.icon === 'string' && args.icon ? args.icon : undefined
      const color = typeof args.color === 'string' && args.color ? args.color : undefined
      if (icon && !normalizeIcon(icon)) throw new ToolError(`"${icon}" is not an icon the app offers.`)
      if (color && !normalizeColor(color)) throw new ToolError(`"${color}" is not a colour the app offers. Pick one of its sixteen.`)
      const store = new SubscriptionsStore(ctx.env.DB, ctx.store.userId)
      const label = await store.setLabelStyle(kind, name, { icon, color })
      if (!label) throw new ToolError('That label could not be saved.')
      return { label }
    },
  }),
  tool({
    name: 'restore_subscription',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Put a subscription back from the trash. Its payment history and reminders were kept, so this returns it exactly as it was.',
    fields: { ref: { type: 'string', minLength: 1, maxLength: 120 } },
    async run(args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const wanted = String(args.ref).trim()
      const trashed = await store.list(context, 'trash')
      const folded = wanted.toLocaleLowerCase()
      const match = trashed.find((item) => item.id === wanted)
        ?? trashed.find((item) => item.name.toLocaleLowerCase() === folded)
      if (!match) {
        // Naming what is actually there turns a dead end into one more call. A count alone left the model
        // reporting "nothing was deleted" about a trash that held one subscription it could not see.
        const names = trashed.slice(0, 10).map((item) => item.name)
        throw new ToolError(trashed.length === 0
          ? 'The trash is empty, so there is nothing to restore.'
          : `Nothing in the trash matches "${wanted.slice(0, 80)}". The trash holds ${trashed.length}: ${names.join(', ')}${trashed.length > names.length ? ', …' : ''}. Pass one of those names, or list with status "trash".`)
      }
      const restored = await store.restore(match.id, context)
      if (!restored) throw new ToolError('That subscription could not be restored.')
      return { restored: presentSubscription(restored.item) }
    },
  }),
  tool({
    name: 'delete_subscription',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose moving a subscription to the trash. Nothing is removed until the reader approves it, and the trash keeps the payment history so it can be undone afterwards.',
    fields: { ref: { type: 'string', minLength: 1, maxLength: 120 } },
    async prepare(args, ctx) {
      const { detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      return { targetId: detail.item.id, targetLabel: quoted(detail.item.name) }
    },
    async commit(targetId, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const done = await store.trash(targetId, context)
      if (!done) throw new ToolError('This subscription no longer exists.')
      return { trashed: true, note: 'It is in the trash and can be restored.' }
    },
  }),
  tool({
    name: 'subscription_channels',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'Which notification channels the account has set up, which are switched on, and whether the last test through each one worked. A reader asking "will I actually be told", "why did nothing arrive", or "which app is this pushing to" is asking about this. Only a redacted hint is ever returned — a token, password or device key never leaves the server.',
    fields: {},
    async run(_args, ctx) {
      const channels = await listChannels(ctx.env.DB, ctx.store.userId)
      const configured = channels.filter((channel) => channel.configured || channel.enabled)
      return {
        enabledCount: channels.filter((channel) => channel.enabled).length,
        // A channel with no row is not a thing the reader set up, so the ten defaults are not listed at them.
        channels: configured.map((channel) => ({
          kind: channel.kind,
          enabled: channel.enabled,
          configured: channel.configured,
          hint: channel.hint,
          lastTest: channel.lastTestStatus
            ? { status: channel.lastTestStatus, at: channel.lastTestAt, error: channel.lastTestError || undefined }
            : null,
        })),
        note: configured.length === 0
          ? 'No channel is configured, so reminders are computed and logged but nothing is delivered.'
          : undefined,
      }
    },
  }),
]

/** The store and the account's own date context, built the same way the HTTP route builds them. */
async function subscriptionAccess(ctx: ToolContext): Promise<{ store: SubscriptionsStore; context: StoreContext; settings: Awaited<ReturnType<typeof loadSettings>> }> {
  const settings = await loadSettings(ctx.env.DB, ctx.store.userId)
  return {
    store: new SubscriptionsStore(ctx.env.DB, ctx.store.userId),
    context: storeContext(settings),
    settings,
  }
}

/** What a subscription looks like to the model: the fields a question about money or dates actually needs. */
function presentSubscription(item: SubscriptionItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    type: item.customType,
    category: item.category,
    amount: item.amount,
    currency: item.currency,
    period: `${item.periodValue} ${item.periodUnit}`,
    expiryDate: item.expiryDate.slice(0, 10),
    startDate: item.startDate ? item.startDate.slice(0, 10) : null,
    trialEndsAt: item.trialEndsAt ? item.trialEndsAt.slice(0, 10) : null,
    useLunar: item.useLunar,
    daysRemaining: item.daysRemaining,
    isActive: item.isActive,
    autoRenew: item.autoRenew,
    paidTotal: item.paidTotal,
    paymentCount: item.paymentCount,
    nextReminderAt: item.nextReminderAt,
  }
}

/**
 * The reminder shorthand, in both directions.
 *
 * A tool argument that is an array of objects would need `FieldSpec` to grow an array kind, and the model
 * would need to get three nested fields right per rule. `7d,3d,1d,on` is one string it can write from
 * what the reader said, and anything it cannot express is refused with the accepted shapes named back.
 */
function parseReminderSpec(spec: string): ReminderRuleInput[] {
  const tokens = spec.split(',').map((token) => token.trim()).filter(Boolean)
  if (tokens.length > RULES_LIMIT) throw new ToolError(`That is ${tokens.length} rules; one subscription carries at most ${RULES_LIMIT}.`)
  return tokens.map((token): ReminderRuleInput => {
    if (token === 'on') return { type: 'on_expiry', value: 0, unit: 'days', isEnabled: true }
    const after = /^after:?(\d+)$/.exec(token)
    if (after) return { type: 'after_expiry', value: 0, unit: 'days', repeatInterval: Number(after[1]), isEnabled: true }
    const ahead = /^(\d+)([dh])$/.exec(token)
    if (ahead) {
      return {
        type: 'before_expiry',
        value: Number(ahead[1]),
        unit: ahead[2] === 'h' ? 'hours' : 'days',
        isEnabled: true,
      }
    }
    throw new ToolError(`"${token}" is not a reminder. Use "7d", "12h", "on" or "after:24".`)
  })
}

/** A subscription by id or by the name the reader used. Ambiguity is answered, never guessed at. */
async function resolveSubscriptionOrThrow(ref: unknown, ctx: ToolContext): Promise<Awaited<ReturnType<typeof subscriptionAccess>> & { detail: SubscriptionDetail }> {
  const access = await subscriptionAccess(ctx)
  const wanted = String(ref).trim()
  const direct = await access.store.get(wanted, access.context)
  if (direct) return { ...access, detail: direct }
  const items = await access.store.list(access.context)
  const folded = wanted.toLocaleLowerCase()
  const exact = items.filter((item) => item.name.toLocaleLowerCase() === folded)
  const matches = exact.length ? exact : items.filter((item) => item.name.toLocaleLowerCase().includes(folded))
  if (matches.length === 1) {
    const detail = await access.store.get(matches[0].id, access.context)
    if (detail) return { ...access, detail }
  }
  if (matches.length > 1) {
    throw new ToolError(`"${wanted.slice(0, 80)}" matches ${matches.length} subscriptions: ${matches.slice(0, 5).map((item) => item.name).join(', ')}. Name one exactly.`)
  }
  throw new ToolError(`No subscription matches "${wanted.slice(0, 80)}". List them to find the exact name.`)
}

export const ALL_TOOLS: ToolDefinition[] = [
  ...TASK_TOOLS,
  ...MEMORY_TOOLS,
  ...NOTE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...AUTOMATION_TOOLS,
  ...PROJECT_TOOLS,
  ...SEARCH_TOOLS,
  ...IMAGE_TOOLS,
  ...CODE_TOOLS,
  ...WEB_TOOLS,
  ...SUBSCRIPTION_TOOLS,
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
