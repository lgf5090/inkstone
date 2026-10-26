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

import type { AssistantArtifact, AssistantSettings, Task, TaskPriority } from '@shared/assistant'
import { ASSISTANT_TOOL_SPECS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_ARTIFACTS_PER_CONVERSATION, MAX_MUSIC_EFFECT_TRACK_REF_CHARS, MAX_TASK_TITLE_CHARS, TASK_PRIORITIES, TASK_STATUSES, WEB_SEARCH_TOOL_NAME, toolPayloadText, toolModeFor, webSearchConfigured, type AssistantMemory, type AssistantMemoryCategory, type AutomationKind } from '@shared/assistant'
import { webSearchEngineFor } from '@shared/web-search-engines'
import {
  MAX_BATCH_TASKS,
  MAX_LIST_NAME_CHARS,
  MAX_REMINDERS_PER_TASK,
  MAX_STEPS_PER_TASK,
  MAX_STEP_TEXT_CHARS,
  MAX_TAGS_PER_TASK,
  MAX_TAG_NAME_CHARS,
  REMIND_OFFSETS,
  REPEAT_FREQUENCIES,
  REPEAT_MONTHLY_MODES,
  SNOOZE_MINUTES,
  UPCOMING_DAYS,
  isSnoozeMinutes,
  parseRepeatRule,
  remindAtFor,
  withPreviousSeries,
  type RemindOffset,
  type RepeatRule,
  type TaskCounts,
  type TaskStep,
  type TaskTag,
  type TodoTask,
} from '@shared/todos/model'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { EMAIL_BATCH_ACTIONS } from '@shared/email/model'
import { parseNoteCheckboxes } from '@shared/todos/note-parse'
import { isTaskDone } from '@shared/todos/status'
import { MEMORY_CATEGORIES_FOR_TOOLS } from './memory-service'
import { localDate, parseLocalTime, toLocalMinute } from '@shared/assistant-time'
import { addDays, isStatsDay, loadTodoStats } from '../todos/stats'
import { hasHistoricalIntent } from '@shared/assistant-memory'
import type { ScheduleSpec } from '@shared/assistant-schedule'
import type { Env } from '../env'
import type { MusicTrack } from '@shared/music/model'
import { MusicStore } from '../music/store'
import { decryptMusicCookie } from '../lib/crypto'
import { createNeteaseProvider } from '../music/providers/netease/client'
import type { McpWriteContext } from '../mcp/writes'
import { createMcpNote, editMcpNote, trashMcpNote } from '../mcp/writes'
import { readMcpNote, loadMcpNote, searchMcpNotes } from '../mcp/retrieval'
import { buildOverview, loadRates } from '../subscriptions/overview'
import { applyRateOverrides, rateTableFor, type RateTable } from '@shared/subscriptions/currency'
import { isListSort, LIST_SORTS, sortSubscriptions } from '@shared/subscriptions/sort'
import { normalizeColor, normalizeIcon } from '@shared/subscriptions/identity'
import { matchesSubscriptionSearch } from '@shared/subscriptions/search'
import { SERVICE_TEMPLATES } from '@shared/subscriptions/templates'
import { listChannels, loadSettings, saveSettings } from '../subscriptions/settings'
import { queryNotifyLogs, recentScheduleLogs } from '../subscriptions/logs'
import { formatAmount } from '@shared/subscriptions/format'
import { SubscriptionsStore, storeContext, type StoreContext } from '../subscriptions/store'
import {
  BULK_LIMIT,
  CURRENCY_CODES,
  isRateValue,
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
  type SubscriptionSettings,
} from '@shared/subscriptions/model'
import { ApiError } from '../lib/errors'
import { ArtifactVersionConflictError, MAX_DEPS_PER_TASK, TaskRefusal, type AssistantStore, type MemoryScope } from './store'
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
import {
  discardDraftTool,
  draftEmailReplyTool,
  draftEmailTool,
  getEmailToolMessage,
  getEmailToolThread,
  listEmailToolAccounts,
  listEmailToolMessages,
  markEmailReadTool,
  moveEmailTool,
  searchEmailToolMessages,
} from '../email/tools'
import {
  batchEmailAgent,
  createEmailFolderAgent,
  createEmailTagAgent,
  deleteEmailAgent,
  inspectEmailAgent,
  manageEmailContactAgent,
  manageEmailRuleAgent,
  manageEmailSearchAgent,
  manageEmailSignatureAgent,
  manageEmailTemplateAgent,
  prepareDeleteEmailAgent,
  prepareScheduleEmailAgent,
  prepareSendEmailAgent,
  scheduleEmailAgent,
  sendEmailAgent,
  tagEmailAgent,
  updateEmailDraftAgent,
  updateEmailFolderAgent,
  updateEmailMessageAgent,
  updateEmailSettingsAgent,
  updateEmailTagAgent,
} from '../email/agent'

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'

export interface FieldSpec {
  type: FieldKind
  description?: string
  enum?: readonly string[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  /** `array`: every entry is a string. A step list and a tag list are the two callers. */
  items?: 'string'
  maxItems?: number
  optional?: boolean
  /**
   * An explicit `null` is a value the tool acts on, not a missing argument.
   *
   * Only the fields whose description says "null clears it" set this. Everywhere else a null is read
   * as "the model left this out", because a model that sends null for a field it has nothing to say
   * about must not be told its call was malformed.
   */
  nullable?: boolean
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
  keepArgs?: boolean
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

const localDateField = (description: string, nullable = false): FieldSpec => ({
  type: 'string',
  description: `${description} Local to the reader: YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time.`,
  maxLength: 32,
  optional: true,
  ...(nullable ? { nullable } : {}),
})

function dueMillis(value: unknown, ctx: ToolContext): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new ToolError('A date must be given as text.')
  const parsed = parseLocalTime(value, ctx.timezone)
  if (parsed === null) throw new ToolError(`Could not understand the date "${value.slice(0, 40)}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`)
  return parsed
}

function plannedDay(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ToolError('A planned day must be YYYY-MM-DD.')
  }
  return value
}

function repeatRule(
  args: Record<string, unknown>,
  allowNone: boolean,
  previous?: RepeatRule | null,
): RepeatRule | null | undefined {
  const freq = args.repeat
  if (freq === undefined) {
    if (args.repeatDays !== undefined || args.repeatMonthly !== undefined || args.repeatInterval !== undefined) {
      throw new ToolError('Name the repeat frequency with the days or interval that narrow it.')
    }
    return undefined
  }
  if (allowNone && freq === 'none') return null
  if (typeof freq !== 'string' || !REPEAT_FREQUENCIES.includes(freq as (typeof REPEAT_FREQUENCIES)[number])) {
    throw new ToolError('A repeat frequency must be one of the known rhythms.')
  }
  const interval = args.repeatInterval === undefined ? 1 : Number(args.repeatInterval)
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) {
    throw new ToolError('A repeat interval must be a whole number between 1 and 99.')
  }
  let weekdays: number[] | undefined
  if (typeof args.repeatDays === 'string' && args.repeatDays.trim()) {
    const days = args.repeatDays.split(',').map((entry) => Number(entry.trim()))
    if (!days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      throw new ToolError('Repeat days are weekdays from 0 (Sunday) to 6 (Saturday).')
    }
    weekdays = [...new Set(days)].sort((a, b) => a - b)
  }
  if (weekdays && freq !== 'weekly') throw new ToolError('Repeat days only narrow a weekly rhythm.')
  const monthly = args.repeatMonthly
  if (monthly !== undefined
    && (typeof monthly !== 'string' || !REPEAT_MONTHLY_MODES.includes(monthly as (typeof REPEAT_MONTHLY_MODES)[number]))) {
    throw new ToolError('A monthly rhythm lands on the same day, the last day, or the same nth weekday.')
  }
  if (monthly !== undefined && freq !== 'monthly') throw new ToolError('That monthly choice only narrows a monthly rhythm.')
  const rule = parseRepeatRule({
    freq,
    interval,
    ...(weekdays ? { weekdays } : {}),
    ...(monthly ? { monthlyMode: monthly } : {}),
  })
  if (!rule) throw new ToolError('That repeat rule is not one the app can store.')
  return withPreviousSeries(rule, previous)
}

function reminderInstants(value: unknown, ctx: ToolContext): number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ToolError('Reminders must be a list of local date-times.')
  if (value.length > MAX_REMINDERS_PER_TASK) throw new ToolError(`A task can carry at most ${MAX_REMINDERS_PER_TASK} reminders.`)
  const times = value.map((entry) => {
    if (typeof entry !== 'string') throw new ToolError('Each reminder must be YYYY-MM-DDTHH:MM.')
    const parsed = parseLocalTime(entry, ctx.timezone)
    if (parsed === null) throw new ToolError(`Could not understand the reminder "${entry.slice(0, 40)}".`)
    return parsed
  })
  return [...new Set(times)].sort((left, right) => left - right)
}

/**
 * A task as the model sees it.
 *
 * Everything the reader set is named, because a model that cannot see a list or a step count will
 * happily rewrite the field it cannot see. The list travels as an id: names are the reader's, and
 * `list_task_lists` is the one call that knows them.
 */
function presentTask(task: TodoTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.dueAt,
    starred: task.starred,
    list_id: task.listId,
    ...(task.reminders?.length ? { reminders: task.reminders } : {}),
    ...(task.tags.length ? { tags: task.tags.map((tag) => tag.name) } : {}),
    ...(task.repeat ? { repeat: task.repeat.interval > 1 ? `${task.repeat.freq} x${task.repeat.interval}` : task.repeat.freq } : {}),
    ...(task.remindAt !== null ? { remind_at: task.remindAt } : {}),
    ...(task.stepTotal ? { steps: `${task.stepDone}/${task.stepTotal}` } : {}),
    ...(task.description ? { description: task.description.slice(0, 300) } : {}),
    ...(task.noteId ? { note_id: task.noteId } : {}),
    ...(task.conversationId ? { conversation_id: task.conversationId } : {}),
    // Where the row sits and what it waits for, so a call that set either can read back what it got.
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

/**
 * The list a name or id points at.
 *
 * A name the reader does not have is refused with what they do have, rather than silently filing the
 * task in the inbox: the model said "Work", and a task that landed nowhere would read as a success.
 */
async function resolveListId(ref: unknown, ctx: ToolContext): Promise<string | null> {
  if (ref === undefined || ref === null || ref === '') return null
  if (typeof ref !== 'string') throw new ToolError('A list is named by its name or id.')
  const found = await ctx.store.resolveTaskList(ref.trim().slice(0, 200))
  if (!found) throw new ToolError(`No list matches "${ref.slice(0, 60)}". Call list_task_lists to see the lists.`)
  return found.id
}

/** A note a task came from, checked against the turn's own note scope. */
async function resolveNoteId(ref: string, ctx: ToolContext): Promise<string> {
  const id = ref.trim()
  await assertNoteReadable(ctx.env.DB, ctx.store.userId, id, await ctx.noteScope())
  return id
}

/** A quoted fragment of user text for the approval card, shortened so the card stays readable. */
function quoted(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

async function resolveTaskOrThrow(ref: unknown, ctx: ToolContext): Promise<TodoTask> {
  const task = await ctx.store.resolveTask(String(ref))
  if (!task) throw new ToolError(`No single task matches "${String(ref).slice(0, 80)}". List tasks to find the exact one.`)
  return task
}

/**
 * The tasks one argument names, as ids.
 *
 * A reader names another task the way they would say it out loud — a title, half-remembered — so every
 * entry is read exactly the way an update reads its own `task` argument: an id, or a title matching one
 * task, and an entry that matches nothing is refused with the sentence that says what to do instead.
 * The store still judges the set — its ceiling, a self-wait, a cycle, whose task it is; this turns words into ids.
 */
async function resolveTaskRefsOrThrow(value: unknown, ctx: ToolContext): Promise<string[]> {
  if (!Array.isArray(value)) throw new ToolError('Tasks to wait on are named as a list of ids or titles.')
  const ids: string[] = []
  for (const entry of value) {
    const task = await ctx.store.resolveTask(String(entry))
    if (!task) throw new ToolError(`No single task matches "${String(entry).slice(0, 80)}". List tasks to find the exact one.`)
    if (!ids.includes(task.id)) ids.push(task.id)
  }
  return ids
}

/**
 * A store refusal the model can act on.
 *
 * The task store judges a dependency set and a parent before it writes anything, and its reason is a
 * sentence for the reader — "A task cannot wait on itself" — not a stack trace. Left to the generic
 * error path it would surface as a failed tool call with no lesson, and the model would retry the same
 * shape. Every other error still travels untouched.
 */
async function asToolError<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask()
  } catch (error) {
    if (error instanceof TaskRefusal) throw new ToolError(error.message)
    throw error
  }
}

/**
 * A tag the account really has, by name or id.
 *
 * Refused with what the reader can do instead rather than passed through as a rename that touches
 * nothing: a tag the account does not have is not a smaller version of the request, it is a different
 * one. The leading `#` is dropped the way the reader writes it.
 */
async function resolveTagOrThrow(ref: unknown, ctx: ToolContext): Promise<TaskTag> {
  if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('A tag is named by its name or id.')
  const tag = await ctx.store.resolveTaskTag(ref.replace(/^#/, '').trim())
  if (!tag) throw new ToolError(`No tag matches "${ref.slice(0, 60)}". List tasks to see the tags in use.`)
  return tag
}

/**
 * The one step a partial text names, the same matching `check_task_step` has always used.
 *
 * Two matches are refused rather than resolved by order: the model said "write", and ticking or
 * deleting the wrong half of a task is a silent edit the reader never asked for.
 */
async function resolveStepOrThrow(task: TodoTask, ref: unknown, ctx: ToolContext): Promise<TaskStep> {
  const steps = await ctx.store.listSteps(task.id)
  const needle = String(ref).trim().toLowerCase()
  const matches = steps.filter((step) => step.text.toLowerCase().includes(needle))
  if (matches.length !== 1) {
    throw new ToolError(matches.length
      ? `Several steps match "${quoted(String(ref))}". Name the one you mean more fully.`
      : `No step matches "${quoted(String(ref))}". Read the task first to see its steps.`)
  }
  return matches[0]!
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

/**
 * How many tasks one sweep of a note may create.
 *
 * A note is a page, and a page of boxes is normally a handful; the ceiling is what keeps one call from
 * turning a long checklist into an unbounded write. Anything past it is left for a second call, which
 * is also what makes the cap honest: the boxes are named in `remaining` rather than dropped.
 */
export const MAX_TASKS_FROM_NOTE = 50

/**
 * The comparison an idempotency check uses: the same words, whatever the spacing and case.
 *
 * The title is the half of the key the reader wrote, so two spellings of one line must not become two
 * tasks. This is deliberately a comparison key and not a stored value: the task keeps the box's words.
 */
function taskTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The most suggestions one `plan_today` call answers with.
 *
 * A day holds a handful of tasks, not a page of them, and a suggestion list longer than the screen
 * would make the reader pick through advice rather than accept it. The field's own ceiling is this
 * number, so a model asking for more is clamped by the declaration the provider schema advertises.
 */
export const MAX_PLAN_TODAY_SUGGESTIONS = 8

/**
 * The most open tasks one planning sweep reads before choosing.
 *
 * The candidates are a view of the shelf, not the whole shelf: an account with thousands of open rows
 * still answers from one page, and the page is ordered the way the to-do list is (due date first,
 * then priority), so a cut takes the least urgent tail rather than an arbitrary sample.
 */
export const MAX_PLAN_TODAY_CANDIDATES = 200

/** How many suggestions a call returns when the model does not say. */
const DEFAULT_PLAN_TODAY_SUGGESTIONS = 5

/** Why a task is on the plan. The screen prints the reader's words for the code. */
type PlanTodayReason = 'overdue' | 'starred_due' | 'unscheduled'

interface PlanTodaySuggestion {
  id: string
  title: string
  reason: PlanTodayReason
}

export const TASK_TOOLS: ToolDefinition[] = [
  tool({
    name: 'create_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Create a to-do for the reader. Use for action items, not for facts. A list, tags and steps are optional; a task without a list lands in the inbox. A parent or a task to wait on is named by id or exact title.',
    fields: {
      title: { type: 'string', description: 'What needs doing, in a few words.', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS },
      description: { type: 'string', description: 'Optional longer note.', maxLength: 2000, optional: true },
      priority: { type: 'string', enum: TASK_PRIORITIES, description: 'Defaults to medium.', optional: true },
      due: localDateField('When it is due.'),
      start: localDateField('When it becomes available; pass null for none.', true),
      planned: { type: 'string', description: 'Plan it for a day in My Day, YYYY-MM-DD; null clears it.', maxLength: 10, optional: true, nullable: true },
      list: { type: 'string', description: 'List name or id. Call list_task_lists first if unsure what exists.', maxLength: 200, optional: true },
      project: { type: 'string', description: 'Project name or id.', maxLength: 200, optional: true },
      parent: { type: 'string', description: 'The task this one is a step of, by id or exact title. A child is an ordinary task; the parent only groups it on screen.', maxLength: 300, optional: true },
      waitsOn: { type: 'array', items: 'string', maxItems: MAX_DEPS_PER_TASK, maxLength: 300, description: 'Tasks this one waits on, by id or exact title. A waiting task is still listed and counted; it just says why.', optional: true },
      tags: { type: 'array', items: 'string', maxItems: MAX_TAGS_PER_TASK, description: 'Tag names. One that does not exist yet is created.', optional: true },
      steps: { type: 'array', items: 'string', maxItems: 20, maxLength: MAX_STEP_TEXT_CHARS, description: 'Sub-tasks, in order.', optional: true },
      repeat: { type: 'string', enum: REPEAT_FREQUENCIES, description: 'How often it comes back. Leave it out for a one-off.', optional: true },
      repeatInterval: { type: 'integer', minimum: 1, maximum: 99, description: 'Occurrences every N weeks, months or years. Defaults to 1.', optional: true },
      repeatDays: { type: 'string', description: 'For a weekly rhythm: comma-separated weekdays, 0=Sunday to 6=Saturday.', maxLength: 20, optional: true },
      repeatMonthly: { type: 'string', enum: REPEAT_MONTHLY_MODES, description: 'For a monthly rhythm: the same day, the last day, or the same nth weekday of the due date.', optional: true },
      remind: { type: 'string', enum: REMIND_OFFSETS, description: 'When to remind the reader, relative to the due time. Defaults to none.', optional: true },
      reminders: { type: 'array', items: 'string', maxItems: MAX_REMINDERS_PER_TASK, description: 'Absolute reminders as local YYYY-MM-DDTHH:MM values. Replaces remind when given.', optional: true },
      starred: { type: 'boolean', description: 'Mark it as one to keep in sight.', optional: true },
      note: { type: 'string', description: 'The id of a note this task came from.', maxLength: 26, optional: true },
    },
    async run(args, ctx) {
      const dueAt = dueMillis(args.due, ctx) ?? null
      const startAt = dueMillis(args.start, ctx) ?? null
      const planned = plannedDay(args.planned)
      const repeat = repeatRule(args, false)
      const reminders = reminderInstants(args.reminders, ctx)
      const listId = await resolveListId(args.list, ctx)
      const noteId = typeof args.note === 'string' && args.note.trim() ? await resolveNoteId(args.note, ctx) : null
      // Where the new row sits and what it waits for are read the way every other task reference is:
      // words the reader would use, turned into ids here, judged by the store on the write.
      const parentId = args.parent === undefined ? undefined : (await resolveTaskOrThrow(args.parent, ctx)).id
      const waitsOn = args.waitsOn === undefined ? undefined : await resolveTaskRefsOrThrow(args.waitsOn, ctx)
      const task = await asToolError(async () => ctx.store.createTask({
        title: String(args.title),
        description: typeof args.description === 'string' ? args.description : '',
        priority: args.priority as TaskPriority | undefined,
        dueAt,
        startAt,
        projectId: (await resolveProjectIdOrThrow(args.project, ctx)) ?? null,
        listId,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(waitsOn !== undefined ? { dependsOn: waitsOn } : {}),
        starred: args.starred === true,
        repeat: repeat ?? null,
        ...(reminders !== undefined
          ? { reminders }
          : { remindAt: remindAtFor(dueAt, (args.remind as RemindOffset | undefined) ?? 'none') }),
        noteId,
        conversationId: ctx.conversationId ?? null,
        tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
        steps: Array.isArray(args.steps) ? args.steps as string[] : undefined,
      }))
      if (planned !== undefined) await ctx.store.planTask(task.id, planned)
      const saved = planned !== undefined ? await ctx.store.getTask(task.id) ?? task : task
      await ctx.store.recordActivity('task.created', saved.title)
      return { created: presentTask(saved) }
    },
  }),
  tool({
    name: 'create_tasks_from_note',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create tasks from the checkboxes in one note. Every box whose title is not already a task from this note becomes one, so calling it twice on the same note adds nothing. filter "open" (the default) takes unticked boxes only; "all" also takes ticked ones and files them as completed.',
    fields: {
      note: { type: 'string', description: 'The id of the note to read. Use search_notes or list_notes to find it.', minLength: 1, maxLength: 26 },
      filter: { type: 'string', enum: ['open', 'all'], description: 'Which boxes to take. Defaults to open.', optional: true },
    },
    async run(args, ctx) {
      const noteId = String(args.note)
      await assertNoteReadable(ctx.env.DB, ctx.store.userId, noteId, await ctx.noteScope())
      const note = await loadMcpNote(ctx.env.DB, ctx.store.userId, noteId)
      const boxes = parseNoteCheckboxes(note.content)
      const includeDone = args.filter === 'all'
      // The idempotency key is the note the box came from plus the box's own words. It is loaded once
      // rather than asked per box: a note with fifty boxes should cost one query, not fifty.
      const existing = await ctx.env.DB.prepare(
        `SELECT title FROM todos_tasks WHERE user_id = ?1 AND note_id = ?2`,
      ).bind(ctx.store.userId, noteId).all<{ title: string }>()
      const seen = new Set((existing.results ?? []).map((row) => taskTitleKey(row.title)))
      const tasks: Array<{ id: string, title: string }> = []
      let skipped = 0
      let ignored = 0
      let remaining = 0
      for (const box of boxes) {
        if (!box.title) { ignored++; continue }
        // A ticked box is already done in the note; taking it by default would file finished work as
        // something to do. `filter: 'all'` is the reader asking for the history too.
        if (box.done && !includeDone) { ignored++; continue }
        const key = taskTitleKey(box.title)
        if (seen.has(key)) { skipped++; continue }
        if (tasks.length >= MAX_TASKS_FROM_NOTE) { remaining++; continue }
        const task = await ctx.store.createTask({
          title: box.title,
          noteId,
          // The note writes a bare day; the account's zone is what that day means, the same zone the
          // task list's own "today" is read in.
          dueAt: box.due ? parseLocalTime(box.due, ctx.timezone) : null,
          status: box.done ? 'done' : 'todo',
          conversationId: ctx.conversationId ?? null,
        }, ctx.timezone)
        seen.add(key)
        tasks.push({ id: task.id, title: task.title })
      }
      // One activity line for the sweep, not one per task: fifty rows would bury everything else the
      // reader did that day in the activity list.
      if (tasks.length) await ctx.store.recordActivity('task.created', `${tasks.length} task(s) from note “${note.title}”`)
      return {
        note: { id: note.id, title: note.title },
        created: tasks.length,
        skipped,
        ...(ignored ? { ignored } : {}),
        ...(remaining ? { remaining, note_limit: `Only ${MAX_TASKS_FROM_NOTE} were created; the note has more boxes than one call takes. Tell the reader the rest can be taken on their next request.` } : {}),
        tasks,
      }
    },
  }),
  tool({
    name: 'list_tasks',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'List the reader\'s tasks. view: today (due today or overdue), upcoming, overdue, inbox (no list), starred, open, completed.',
    fields: {
      view: { type: 'string', enum: ['today', 'upcoming', 'overdue', 'inbox', 'starred', 'open', 'completed'], description: 'Defaults to open.', optional: true },
      query: { type: 'string', description: 'Substring of a title or note.', maxLength: 200, optional: true },
      list: { type: 'string', description: 'Only tasks in this list (name or id).', maxLength: 200, optional: true },
      tag: { type: 'string', description: 'Only tasks carrying this tag.', maxLength: 40, optional: true },
      priority: { type: 'string', enum: TASK_PRIORITIES, optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, optional: true },
    },
    async run(args, ctx) {
      const view = (args.view as string | undefined) ?? 'open'
      const listId = await resolveListId(args.list, ctx)
      const tagId = typeof args.tag === 'string' && args.tag.trim()
        ? (await ctx.store.resolveTaskTag(args.tag.replace(/^#/, '').trim()))?.id
        : undefined
      const tasks = await ctx.store.listTasks({
        status: view === 'open' ? 'open' : 'all',
        view: view === 'open' ? 'open' : view as 'today' | 'upcoming' | 'overdue' | 'inbox' | 'starred' | 'completed',
        query: typeof args.query === 'string' ? args.query : undefined,
        listId,
        tagId,
        priority: args.priority as TaskPriority | undefined,
        limit: typeof args.limit === 'number' ? args.limit : 25,
        dayEnd: ctx.dayEnd,
      })
      const counts = await ctx.store.taskCounts(ctx.dayEnd)
      return { count: tasks.length, tasks: tasks.map(presentTask), counts: presentCounts(counts) }
    },
  }),
  tool({
    name: 'get_task',
    permission: 'read',
    maxCallsPerTurn: 5,
    description: 'Read one task with its steps, so you can tell which step is done before changing it.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const steps = await ctx.store.listSteps(task.id)
      return { task: presentTask(task), steps: steps.map((step) => ({ text: step.text, done: step.done })) }
    },
  }),
  tool({
    name: 'update_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Change a task: title, note, status, priority, due or start date, My Day plan, list, parent, the tasks it waits on, tags, star, repeat or reminder. Naming done completes it: a repeating task files its next occurrence, and the answer says its date.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      title: { type: 'string', minLength: 1, maxLength: MAX_TASK_TITLE_CHARS, optional: true },
      description: { type: 'string', maxLength: 2000, optional: true },
      status: { type: 'string', enum: TASK_STATUSES, optional: true },
      priority: { type: 'string', enum: TASK_PRIORITIES, optional: true },
      due: localDateField('New due date; pass null to clear it.', true),
      start: localDateField('New start date; pass null to clear it.', true),
      planned: { type: 'string', description: 'Move it to a day in My Day (YYYY-MM-DD); null clears the plan.', maxLength: 10, optional: true, nullable: true },
      list: { type: 'string', description: 'List name or id; null moves it to the inbox.', maxLength: 200, optional: true, nullable: true },
      project: { type: 'string', description: 'Project name or id; null clears it.', maxLength: 200, optional: true, nullable: true },
      parent: { type: 'string', description: 'The task this one is a step of, by id or exact title; null puts it back at the top.', maxLength: 300, optional: true, nullable: true },
      waitsOn: { type: 'array', items: 'string', maxItems: MAX_DEPS_PER_TASK, maxLength: 300, description: 'The tasks this one waits on, replacing the set it has; an empty list waits on nothing.', optional: true },
      tags: { type: 'array', items: 'string', maxItems: MAX_TAGS_PER_TASK, description: 'The task\'s tags, replacing the ones it has.', optional: true },
      repeat: { type: 'string', enum: [...REPEAT_FREQUENCIES, 'none'], description: 'Set or clear how often it repeats.', optional: true },
      repeatInterval: { type: 'integer', minimum: 1, maximum: 99, description: 'Occurrences every N weeks, months or years. Defaults to 1.', optional: true },
      repeatDays: { type: 'string', description: 'For a weekly rhythm: comma-separated weekdays, 0=Sunday to 6=Saturday.', maxLength: 20, optional: true },
      repeatMonthly: { type: 'string', enum: REPEAT_MONTHLY_MODES, description: 'For a monthly rhythm: the same day, the last day, or the same nth weekday of the due date.', optional: true },
      remind: { type: 'string', enum: REMIND_OFFSETS, description: 'Set or clear the reminder.', optional: true },
      reminders: { type: 'array', items: 'string', maxItems: MAX_REMINDERS_PER_TASK, description: 'Replace the pending reminders with these local YYYY-MM-DDTHH:MM values.', optional: true },
      starred: { type: 'boolean', optional: true },
      note: { type: 'string', description: 'The id of a note this task came from; null clears it.', maxLength: 26, optional: true, nullable: true },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const dueAt = dueMillis(args.due, ctx)
      const startAt = dueMillis(args.start, ctx)
      const planned = plannedDay(args.planned)
      const repeat = repeatRule(args, true, task.repeat)
      const reminders = reminderInstants(args.reminders, ctx)
      const status = args.status !== undefined ? args.status as Task['status'] : undefined
      /**
       * Whether this call is the reader finishing the task.
       *
       * Finishing is not a column: a repeating task files its next occurrence, and `completeTask` is
       * the only place that happens — `updateTask` now refuses the transition, so a chat that ticked a
       * weekly task by name left it finished with no rhythm to come back. The status therefore leaves
       * the patch below and lands as its own call, after every other field and in the same order the
       * single-task route keeps: the row being finished already carries the new title, due date, list
       * and tags, and the occurrence copied from it carries them too.
       */
      const completing = isTaskDone(status) && !isTaskDone(task.status)
      // Read before the write, so a reference that matches nothing is refused as a tool error rather
      // than as a half-applied patch.
      const parentId = args.parent === undefined
        ? undefined
        : args.parent === null
          ? null
          : (await resolveTaskOrThrow(args.parent, ctx)).id
      const waitsOn = args.waitsOn === undefined ? undefined : await resolveTaskRefsOrThrow(args.waitsOn, ctx)
      const updated = await asToolError(async () => ctx.store.updateTask(task.id, {
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(status === undefined || completing ? {} : { status }),
        ...(args.priority !== undefined ? { priority: args.priority as Task['priority'] } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(startAt !== undefined ? { startAt } : {}),
        ...(args.list !== undefined ? { listId: await resolveListId(args.list, ctx) } : {}),
        ...(args.project !== undefined ? { projectId: (await resolveProjectIdOrThrow(args.project, ctx)) ?? null } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(waitsOn !== undefined ? { dependsOn: waitsOn } : {}),
        ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
        ...(repeat !== undefined ? { repeat } : {}),
        ...(reminders !== undefined
          ? { reminders }
          : args.remind !== undefined
            ? { remindAt: remindAtFor(dueAt === undefined ? task.dueAt : dueAt, args.remind as RemindOffset) }
            : {}),
        ...(args.starred !== undefined ? { starred: args.starred === true } : {}),
        ...(args.note !== undefined
          ? { noteId: typeof args.note === 'string' && args.note.trim() ? await resolveNoteId(args.note, ctx) : null }
          : {}),
      }))
      let finished: TodoTask | null = updated
      // The next occurrence belongs in the payload: a model that cannot see the date it just filed
      // would tell the reader a date of its own, and be wrong about it.
      let next: TodoTask | null = null
      if (completing) {
        const done = await ctx.store.completeTask(updated?.id ?? task.id, ctx.timezone)
        if (!done) throw new ToolError('This task no longer exists.')
        finished = done.task
        next = done.next
        await ctx.store.recordActivity('task.completed', done.task.title)
      }
      if (planned !== undefined && finished) {
        const plannedTask = await ctx.store.planTask(finished.id, planned)
        return {
          updated: plannedTask ? presentTask(plannedTask) : null,
          ...(next ? { next: presentTask(next) } : {}),
        }
      }
      return {
        updated: finished ? presentTask(finished) : null,
        ...(next ? { next: presentTask(next) } : {}),
      }
    },
  }),
  tool({
    name: 'plan_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Put a task on a day in the reader\'s My Day, or clear that plan by passing null. This does not change the due date.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      day: { type: 'string', description: 'The day to plan it for, YYYY-MM-DD; null clears the plan.', maxLength: 10, nullable: true },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const day = args.day === null || args.day === '' ? null : String(args.day)
      if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ToolError('A planned day must be YYYY-MM-DD.')
      const planned = await ctx.store.planTask(task.id, day)
      return { planned: planned ? presentTask(planned) : null }
    },
  }),
  tool({
    name: 'complete_task',
    permission: 'write',
    maxCallsPerTurn: 10,
    description: 'Mark a task done. A repeating task files the next occurrence and tells you its date; say that date in your reply.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const result = await ctx.store.completeTask(task.id, ctx.timezone)
      if (!result) throw new ToolError('This task no longer exists.')
      await ctx.store.recordActivity('task.completed', result.task.title)
      return {
        completed: presentTask(result.task),
        ...(result.next ? { next: presentTask(result.next) } : {}),
      }
    },
  }),
  tool({
    name: 'snooze_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: `Remind the reader about a task again in ${SNOOZE_MINUTES.join(', ')} minutes. The new reminder is added to the ones the task already has; it does not replace them.`,
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      minutes: {
        type: 'integer',
        minimum: SNOOZE_MINUTES[0],
        maximum: SNOOZE_MINUTES[SNOOZE_MINUTES.length - 1],
        description: `How long to wait: ${SNOOZE_MINUTES.join(', ')} minutes.`,
      },
    },
    async run(args, ctx) {
      if (!isSnoozeMinutes(args.minutes)) {
        throw new ToolError(`A snooze must be ${SNOOZE_MINUTES.join(', ')} minutes.`)
      }
      const task = await resolveTaskOrThrow(args.task, ctx)
      if (isTaskDone(task.status)) throw new ToolError('A finished task cannot be snoozed.')
      if ((task.reminders?.length ?? 0) >= MAX_REMINDERS_PER_TASK) {
        throw new ToolError(`This task already has ${MAX_REMINDERS_PER_TASK} reminders.`)
      }
      const remindAt = Date.now() + args.minutes * 60_000
      const updated = await ctx.store.snoozeTask(task.id, remindAt)
      if (!updated) throw new ToolError('This task no longer exists.')
      return { snoozed: presentTask(updated), remind_at: remindAt }
    },
  }),
  tool({
    name: 'move_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Move a task within its list, or into another list. Name the task it should land before; null puts it at the end. A list alone appends it there.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      before: { type: 'string', description: 'The task it should land before; null means the end.', maxLength: 300, optional: true, nullable: true },
      list: { type: 'string', description: 'Move it to this list; null is the inbox.', maxLength: 200, optional: true, nullable: true },
    },
    async run(args, ctx) {
      if (args.before === undefined && args.list === undefined) {
        throw new ToolError('Name a list, a task to land before, or both.')
      }
      const task = await resolveTaskOrThrow(args.task, ctx)
      const beforeId = typeof args.before === 'string' ? (await resolveTaskOrThrow(args.before, ctx)).id : null
      const listId = args.list === undefined ? undefined : args.list === null ? null : await resolveListId(args.list, ctx)
      const moved = await ctx.store.moveTask(task.id, {
        beforeId,
        ...(listId !== undefined ? { listId } : {}),
      })
      return { moved: moved ? presentTask(moved) : null }
    },
  }),
  tool({
    name: 'list_trash',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List tasks in the trash, newest deletion first, so one can be restored by id.',
    fields: {
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many rows to return. Defaults to 20.', optional: true },
    },
    async run(args, ctx) {
      const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.trunc(args.limit))) : 20
      const page = await ctx.store.listTrash({ limit })
      return {
        count: page.tasks.length,
        total: page.total,
        tasks: page.tasks.map((task) => ({ ...presentTask(task), deleted_at: task.deletedAt ?? null })),
      }
    },
  }),
  tool({
    name: 'restore_task',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Restore one task from the trash by its id. Call list_trash first to find the exact id.',
    fields: {
      id: { type: 'string', description: 'The trashed task id.', minLength: 1, maxLength: 64 },
    },
    async run(args, ctx) {
      const { task: restored, droppedReminders } = await ctx.store.restoreTask(String(args.id))
      if (!restored) throw new ToolError('No trashed task has that id.')
      // Say so rather than let the model report a clean restore: the reminders that had already passed
      // were dropped on the way back in, and a model that does not know will promise an alert that never comes.
      return {
        restored: presentTask(restored),
        ...(droppedReminders > 0 ? { dropped_reminders: droppedReminders } : {}),
      }
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
  tool({
    name: 'rename_task_tag',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Rename a tag the reader uses on tasks. Every task carrying it shows the new name.',
    fields: {
      tag: { type: 'string', description: 'Tag name or id.', minLength: 1, maxLength: MAX_TAG_NAME_CHARS },
      name: { type: 'string', description: 'The new tag name.', minLength: 1, maxLength: MAX_TAG_NAME_CHARS },
    },
    async run(args, ctx) {
      const tag = await resolveTagOrThrow(args.tag, ctx)
      const name = String(args.name)
      // The table's unique index refuses a duplicate name with a database error; naming the clash is the
      // answer the reader can act on, and the call writes nothing.
      const clash = await ctx.store.findTaskTagByName(name)
      if (clash && clash.id !== tag.id) throw new ToolError(`A tag named "${name}" already exists.`)
      const updated = await ctx.store.updateTaskTag(tag.id, { name })
      if (!updated) throw new ToolError('This tag no longer exists.')
      return { updated: { id: updated.id, name: updated.name, open: updated.openCount } }
    },
  }),
  tool({
    name: 'delete_task_tag',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose deleting a tag from every task carrying it. Nothing is deleted until the reader approves it.',
    fields: {
      tag: { type: 'string', description: 'Tag name or id.', minLength: 1, maxLength: MAX_TAG_NAME_CHARS },
    },
    async prepare(args, ctx) {
      const tag = await resolveTagOrThrow(args.tag, ctx)
      return { targetId: tag.id, targetLabel: quoted(tag.name) }
    },
    async commit(targetId, ctx) {
      const tag = await ctx.store.getTaskTag(targetId)
      if (!tag) throw new ToolError('This tag no longer exists.')
      await ctx.store.deleteTaskTag(tag.id)
    },
  }),
  tool({
    name: 'list_task_lists',
    permission: 'read',
    maxCallsPerTurn: 3,
    description: 'List the reader\'s to-do lists, with how many tasks each still has open.',
    fields: {},
    async run(_args, ctx) {
      const lists = await ctx.store.listTaskLists()
      return {
        lists: lists.map((list) => ({
          id: list.id,
          name: list.name,
          open: list.openCount,
          total: list.openCount + list.doneCount,
        })),
      }
    },
  }),
  tool({
    name: 'create_task_list',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create a to-do list. A list whose name already exists is returned instead of duplicated.',
    fields: {
      name: { type: 'string', minLength: 1, maxLength: MAX_LIST_NAME_CHARS },
      color: { type: 'string', description: 'A hex colour from the app palette.', maxLength: 7, optional: true },
    },
    async run(args, ctx) {
      const list = await ctx.store.createTaskList({
        name: String(args.name),
        color: typeof args.color === 'string' ? args.color : null,
      })
      return { list: { id: list.id, name: list.name, open: list.openCount, total: list.openCount + list.doneCount } }
    },
  }),
  tool({
    name: 'update_task_list',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Change a to-do list: its name, colour, icon or archive state. Use list_task_lists first if unsure which list it is.',
    fields: {
      list: { type: 'string', description: 'List name or id.', minLength: 1, maxLength: 200 },
      name: { type: 'string', minLength: 1, maxLength: MAX_LIST_NAME_CHARS, optional: true },
      color: { type: 'string', description: 'A hex colour; null clears it.', maxLength: 7, optional: true, nullable: true },
      icon: { type: 'string', description: 'One emoji or an icon name; null clears it.', maxLength: 40, optional: true, nullable: true },
      archived: { type: 'boolean', description: 'Archive the list (true) or put it back (false).', optional: true },
    },
    async run(args, ctx) {
      const listId = await resolveListId(args.list, ctx)
      if (!listId) throw new ToolError('A list is named by its name or id.')
      let color: string | null | undefined
      if (args.color !== undefined) {
        if (args.color === null) color = null
        else {
          color = organizerColorOrNull(args.color)
          if (!color) throw new ToolError('That colour is not one of the palette.')
        }
      }
      const icon = args.icon === undefined
        ? undefined
        : args.icon === null
          ? null
          : (String(args.icon).replace(/[\u0000-\u001f\u007f]/g, '').trim() || null)
      const patch = {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(args.archived !== undefined ? { archivedAt: args.archived === true ? Date.now() : null } : {}),
      }
      if (!Object.keys(patch).length) throw new ToolError('Name a new name, colour or icon to change.')
      const list = await ctx.store.updateTaskList(listId, patch)
      if (!list) throw new ToolError('This list no longer exists.')
      return {
        updated: {
          id: list.id,
          name: list.name,
          icon: list.icon,
          color: list.color,
          open: list.openCount,
          total: list.openCount + list.doneCount,
        },
      }
    },
  }),
  tool({
    name: 'delete_task_list',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Propose deleting a to-do list. Its tasks move to the inbox, not the trash; nothing changes until the reader approves it.',
    fields: {
      list: { type: 'string', description: 'List name or id.', minLength: 1, maxLength: 200 },
    },
    async prepare(args, ctx) {
      const listId = await resolveListId(args.list, ctx)
      if (!listId) throw new ToolError('A list is named by its name or id.')
      const list = await ctx.store.getTaskList(listId)
      if (!list) throw new ToolError('This list no longer exists.')
      return { targetId: list.id, targetLabel: quoted(list.name) }
    },
    async commit(targetId, ctx) {
      const list = await ctx.store.getTaskList(targetId)
      if (!list) throw new ToolError('This list no longer exists.')
      await ctx.store.deleteTaskList(list.id)
    },
  }),
  tool({
    name: 'delete_completed_tasks',
    permission: 'destructive',
    maxCallsPerTurn: 1,
    description: `Propose clearing completed tasks, up to ${MAX_BATCH_TASKS} rows per approval — the batch way to remove many at once, so do not call delete_task once per row. A second call takes the next batch if the first said more remain.`,
    fields: {},
    async prepare(_args, ctx) {
      // One page, in the completed list's own order: the cap is the batch route's ceiling, and the count
      // says whether this approval covers all of them or only the first page.
      const completed = await ctx.store.listTasks({ status: 'all', view: 'completed', limit: MAX_BATCH_TASKS })
      if (!completed.length) throw new ToolError('There are no completed tasks to delete.')
      const total = await ctx.store.countTasks({ status: 'all', view: 'completed' })
      const count = completed.length
      return {
        targetId: completed.map((task) => task.id).join(','),
        targetLabel: count < total
          ? `${count} of ${total} completed tasks`
          : `${count} completed task${count === 1 ? '' : 's'}`,
      }
    },
    async commit(targetId, ctx) {
      // Only the rows that were completed when the card was raised: a task the reader reopened in the
      // meantime is work again, and the approval was not a statement about it.
      const ids = targetId.split(',').filter(Boolean)
      let deleted = 0
      for (const id of ids) {
        const task = await ctx.store.getTask(id)
        if (!task || !isTaskDone(task.status)) continue
        await ctx.store.deleteTask(id)
        deleted++
      }
      if (!deleted) throw new ToolError('Those tasks are no longer completed.')
      return { deleted }
    },
  }),
  tool({
    name: 'add_task_step',
    permission: 'write',
    maxCallsPerTurn: 8,
    description: 'Add one step (sub-task) to a task, at the end of its list.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      text: { type: 'string', minLength: 1, maxLength: MAX_STEP_TEXT_CHARS },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const step = await ctx.store.addStep(task.id, String(args.text))
      if (!step) throw new ToolError('This task already has the maximum number of steps.')
      return { added: step.text, steps: (await ctx.store.listSteps(task.id)).length }
    },
  }),
  tool({
    name: 'check_task_step',
    permission: 'write',
    maxCallsPerTurn: 10,
    description: 'Tick or untick one step of a task. The step is matched by its text.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      step: { type: 'string', description: 'The step\'s text, or enough of it to match exactly one step.', minLength: 1, maxLength: MAX_STEP_TEXT_CHARS },
      done: { type: 'boolean', description: 'Defaults to true.', optional: true },
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const step = await resolveStepOrThrow(task, args.step, ctx)
      const done = args.done !== false
      await ctx.store.updateStep(task.id, step.id, { done })
      return { step: step.text, done }
    },
  }),
  tool({
    name: 'delete_task_step',
    permission: 'destructive',
    maxCallsPerTurn: 3,
    description: 'Propose deleting one step of a task. Nothing is deleted until the reader approves it.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      step: { type: 'string', description: 'The step\'s text, or enough of it to match exactly one step.', minLength: 1, maxLength: MAX_STEP_TEXT_CHARS },
    },
    async prepare(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const step = await resolveStepOrThrow(task, args.step, ctx)
      // The separator cannot occur in an id: both are minted from the same alphabet, which has no colon.
      return { targetId: `${task.id}:${step.id}`, targetLabel: quoted(`${task.title} · ${step.text}`) }
    },
    async commit(targetId, ctx) {
      const [taskId, stepId] = targetId.split(':')
      if (!taskId || !stepId) throw new ToolError('This action no longer exists.')
      const task = await ctx.store.getTask(taskId)
      if (!task) throw new ToolError('This task no longer exists.')
      const steps = await ctx.store.listSteps(task.id)
      const step = steps.find((entry) => entry.id === stepId)
      if (!step) throw new ToolError('This step no longer exists.')
      if (!(await ctx.store.deleteStep(task.id, step.id))) throw new ToolError('This step no longer exists.')
    },
  }),
  tool({
    name: 'decompose_task',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Propose a step-by-step breakdown of one task, optionally with the day the whole thing should be finished by. This is a draft: it writes nothing. The reader accepts or edits the steps in the task editor, so do not add them one by one with add_task_step afterwards.',
    fields: {
      task: { type: 'string', description: 'Task id, or a title that matches exactly one task.', minLength: 1, maxLength: 300 },
      steps: { type: 'array', items: 'string', maxItems: MAX_STEPS_PER_TASK, maxLength: MAX_STEP_TEXT_CHARS, description: 'The proposed steps, in the order they should be done.' },
      by: localDateField('When the whole task should be finished.'),
    },
    async run(args, ctx) {
      const task = await resolveTaskOrThrow(args.task, ctx)
      const steps = (args.steps as string[]).filter(Boolean)
      if (!steps.length) throw new ToolError('A breakdown needs at least one step.')
      const byAt = dueMillis(args.by, ctx) ?? null
      // A draft rather than a write: the steps are answered to the model and shown to the reader, and
      // only the task editor's own save turns them into rows. The same rule as an approval card, for a
      // change too small to deserve one.
      return {
        draft: true,
        task: { id: task.id, title: task.title, steps: task.stepTotal },
        steps,
        ...(byAt !== null ? { due_at: byAt } : {}),
        note: 'Nothing was saved: this is a proposal for the reader to accept or edit in the task editor. Do not call add_task_step for these steps unless the reader asks.',
      }
    },
  }),
  tool({
    name: 'plan_today',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Propose which open tasks belong in today, and why. This is a draft: it writes nothing. The result carries suggestions with a reason code — overdue, starred_due (starred and due within the coming week) or unscheduled (no plan and not due today) — and the reader accepts them in the Today screen, which calls the plan endpoint one row at a time. Do not plan, update or complete anything yourself.',
    fields: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_PLAN_TODAY_SUGGESTIONS,
        description: `How many suggestions to return. Defaults to ${DEFAULT_PLAN_TODAY_SUGGESTIONS}.`,
        optional: true,
      },
    },
    async run(args, ctx) {
      const now = Date.now()
      const today = localDate(now, ctx.timezone)
      const upcomingEnd = ctx.dayEnd + UPCOMING_DAYS * 24 * 60 * 60 * 1000
      // One page, read in the order the list itself is read. The three passes below run over the same
      // page rather than three queries, so a candidate that qualifies twice — starred and overdue — is
      // named once, under the more urgent reason.
      const pool = await ctx.store.listTasks({
        status: 'open',
        view: 'open',
        limit: MAX_PLAN_TODAY_CANDIDATES,
      })
      const suggestions: PlanTodaySuggestion[] = []
      const taken = new Set<string>()
      const offer = (task: TodoTask, reason: PlanTodayReason): void => {
        if (taken.has(task.id)) return
        taken.add(task.id)
        suggestions.push({ id: task.id, title: task.title, reason })
      }
      for (const task of pool) {
        if (task.dueAt !== null && task.dueAt < now) offer(task, 'overdue')
      }
      for (const task of pool) {
        // The coming week, starting after today: a starred task due today is already on the screen.
        if (task.starred && task.dueAt !== null && task.dueAt >= ctx.dayEnd && task.dueAt < upcomingEnd) {
          if (task.plannedFor !== today) offer(task, 'starred_due')
        }
      }
      for (const task of pool) {
        const plannedAhead = task.plannedFor !== null && task.plannedFor >= today
        const dueToday = task.dueAt !== null && task.dueAt < ctx.dayEnd
        // The server counts an in-progress task with no date as today, so the plan does not offer it.
        const inProgressToday = task.dueAt === null && task.status === 'in_progress'
        if (plannedAhead || dueToday || inProgressToday) continue
        offer(task, 'unscheduled')
      }
      const asked = typeof args.limit === 'number' ? args.limit : DEFAULT_PLAN_TODAY_SUGGESTIONS
      return {
        draft: true,
        today,
        suggestions: suggestions.slice(0, asked),
        note: 'Nothing was saved. The reason is a code: overdue, starred_due or unscheduled. The reader accepts these in the Today screen; do not call update_task or complete_task for them.',
      }
    },
  }),
  tool({
    name: 'task_stats',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'Read the reader\'s to-do statistics for a date range: completed, created, completion rate, abandoned rate (tasks given up, counted separately from the completion rate rather than inside it), on-time rate, current and longest streak, overdue, and the per-list split. Call this first when writing a weekly review, then base the review on these numbers rather than recounting the list. Defaults to the last seven days ending today in the reader\'s zone.',
    fields: {
      from: {
        type: 'string',
        description: 'First day to count, YYYY-MM-DD in the reader\'s zone. Defaults to six days before the end of the range.',
        maxLength: 10,
        optional: true,
      },
      to: {
        type: 'string',
        description: 'Last day to count, inclusive, YYYY-MM-DD in the reader\'s zone. Defaults to today.',
        maxLength: 10,
        optional: true,
      },
    },
    async run(args, ctx) {
      const now = Date.now()
      const today = localDate(now, ctx.timezone)
      const to = typeof args.to === 'string' && args.to ? args.to : today
      const from = typeof args.from === 'string' && args.from ? args.from : addDays(to, -6)
      if (!isStatsDay(from) || !isStatsDay(to)) {
        throw new ToolError('"from" and "to" must be calendar days like 2026-01-31.')
      }
      if (from > to) throw new ToolError('"from" must not be after "to".')
      // The numbers are the statistics screen's own: the same range reader, the same arithmetic. A
      // second formula here would let the review and the screen disagree about the same week.
      const stats = await loadTodoStats(ctx.env.DB, ctx.store.userId, {
        from,
        to,
        bucket: 'day',
        timezone: ctx.timezone,
        now,
      })
      const { summary } = stats
      return {
        range: stats.range,
        summary: {
          completed: summary.completed,
          created: summary.created,
          open: summary.open,
          completionRate: summary.completionRate,
          abandoned: summary.abandoned,
          abandonedRate: summary.abandonedRate,
          onTime: summary.onTime,
          onTimeDue: summary.onTimeDue,
          onTimeRate: summary.onTimeRate,
          currentStreak: summary.currentStreak,
          longestStreak: summary.longestStreak,
          overdue: summary.overdue,
          medianLeadTimeMs: summary.medianLeadTimeMs,
        },
        by_list: stats.distributions.byList,
        note: 'These are the Statistics screen\'s own numbers; base the review on them rather than recounting the list. The range is the reader\'s calendar, so say which days it covers.',
      }
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
      sort: {
        type: 'string',
        enum: [...LIST_SORTS],
        optional: true,
        description: 'The same ordering the screen\'s toolbar offers: expiry (default, soonest first), cost (what one month of the plan works out to, highest first), amount (one charge, highest first), name. `cost` and `amount` convert to the account\'s total currency before comparing, so a $20 plan does not outrank a ¥150 one.',
      },
    },
    async run(args, ctx) {
      const { store, context, settings } = await subscriptionAccess(ctx)
      const status = (args.status as string) ?? 'all'
      // The trash is a separate read rather than a filter on the live list: `store.list` excludes those
      // rows in SQL, so a model that never learns the word `trash` cannot see them at all — which is how
      // a restore attempt ended up reporting an empty trash that held one subscription.
      const items = status === 'trash' ? await store.list(context, 'trash') : await store.list(context)
      const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : ''
      const category = typeof args.category === 'string' ? args.category.trim().toLocaleLowerCase() : ''
      const filtered = items.filter((item) => {
        if (status === 'soon' && !(item.daysRemaining >= 0 && item.daysRemaining <= SOON_DAYS)) return false
        if (status === 'expired' && item.daysRemaining >= 0) return false
        if (status === 'active' && (item.daysRemaining < 0 || !item.isActive)) return false
        if (status === 'disabled' && item.isActive) return false
        if (category && !labelNamesOf(item.category, 'category').some((token) => token.toLocaleLowerCase() === category)) return false
        if (query && !matchesSubscriptionSearch(item, query)) return false
        return true
      })
      const sort = isListSort(args.sort) ? args.sort : 'expiry'
      // Only the two money orderings need the table, and getting it can reach the currency service when
      // the day's cache is cold — a list asked for by name should not pay for that.
      const rates: RateTable = sort === 'cost' || sort === 'amount' ? await accountRateTable(ctx, settings) : {}
      const matched = sortSubscriptions(filtered, sort, rates)
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
    description: 'Read one subscription in full: its reminder rules, when the next one fires, its payment history with what each receipt bought, and what that history adds up to per calendar year and per currency.',
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
        // Every receipt the plan has, counted rather than listed: the slice above is the recent history,
        // and "what did 2025 cost" is a question about all of it.
        yearlySpend: detail.yearlySpend,
      }
    },
  }),
  tool({
    name: 'subscription_summary',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'The account\'s money picture in one call: what this month and this year have cost in the reader\'s total currency, how that compares with last month, the ceiling the reader set for a month and for a year and whether either is spent, what the months left in the year can still afford, what the current plans commit for a year, where the exchange rates came from and which currencies had none, which trials are about to start charging, which plans changed price, what renews in the next week, where the spending goes by type and by category and which categories the reader capped and whether those caps still hold, how the last twelve months of receipts compare month to month and which days they fell on, and whether the reminder scheduler is still running.',
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
        // The year gets its own sentence because a monthly ceiling cannot answer a yearly question: an
        // annual plan blows through the month it charges in and is exactly on plan for the year.
        yearlyBudget: overview.yearlyBudget,
        // The categories the reader capped, each with its year so far — including the ones that have spent
        // nothing, which is the answer to "is the cap holding".
        categoryBudgets: overview.categoryBudgets,
        committedYearly: overview.committedYearly,
        // Every amount above was converted from something: which day the rates came from, whether that day
        // was published or merely our own approximation, and which currencies had no rate at all and so sit
        // in no total. Asked live without these, a model promised the rates were current the morning the
        // fetch had failed, and said nothing was pinned while the account carried a USD pin.
        rates: {
          base: overview.rates.base,
          source: overview.rates.source,
          takenAt: overview.rates.at === null ? null : new Date(overview.rates.at).toISOString(),
          pinned: settings.rateOverrides,
          unpriced: overview.rates.unpriced,
          basePriced: overview.rates.basePriced,
          note: [
            overview.rates.source === 'feed'
              ? 'Foreign amounts converted at the published daily rates.'
              : 'The rate feed could not be reached, so foreign amounts converted at the app\'s own built-in approximations, which can be a long way off.',
            Object.keys(settings.rateOverrides).length === 0
              ? 'No rate is pinned, so every foreign amount converted at the table above.'
              : 'A pinned currency converted at the reader\'s own number rather than the feed.',
            overview.rates.unpriced.length === 0
              ? ''
              : `${overview.rates.unpriced.join(', ')} had no rate to convert at, so their money is in none of the totals above. Say which, and offer to pin a rate for them with set_subscription_settings.`,
            overview.rates.basePriced
              ? ''
              : `The total currency ${overview.rates.base} has no rate either, so the totals above are really CNY while the setting names ${overview.rates.base}.`,
          ].filter(Boolean).join(' '),
        },
        trials: overview.trials,
        priceChanges: overview.priceChanges,
        active: overview.active,
        upcoming: overview.upcoming.slice(0, 8),
        // Eight of each, the same number the dashboard's own list and ring draw: a model asked "what does
        // the app show" must not be handed a shorter answer than the reader sees.
        byType: overview.byType.slice(0, 8),
        byCategory: overview.byCategory.slice(0, 8),
        months: overview.months,
        // Only the days that charged something, which for one person is a dozen or so rows rather than
        // 182 — the same picture the heat grid paints, for a reader who asks in words.
        daily: overview.daily,
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
    name: 'list_subscription_labels',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'The type and category names the reader has registered, each with the icon and colour the app draws for it, in one answer. Read this before naming a label in another tool: a type the reader already has, spelled differently, becomes a second identity for the same service.',
    fields: {},
    async run(_args, ctx) {
      const { store } = await subscriptionAccess(ctx)
      // Both registries at once: the question is always "what do I already call these", and a tool that
      // demands a `kind` first was measured live making the model send an empty call, get refused, and ask
      // again — two wasted round trips to say one sentence.
      const [types, categories] = await Promise.all([store.listLabels('type'), store.listLabels('category')])
      const list = (kind: LabelKind, labels: Awaited<ReturnType<typeof store.listLabels>>) => ({
        kind,
        total: labels.length,
        // A reader who registered nothing gets the built-in presets instead, and saying so keeps the
        // model from reporting an empty registry to somebody who has forty types on screen.
        note: labels.length === 0 ? `Nothing is registered under ${kind} yet; the app is drawing its built-in suggestions.` : undefined,
        labels: labels.map((entry) => ({ name: entry.name, icon: entry.icon || null, color: entry.color || null })),
      })
      return { types: list('type', types), categories: list('category', categories) }
    },
  }),
  tool({
    name: 'list_subscription_templates',
    permission: 'read',
    maxCallsPerTurn: 1,
    description: 'The services this app knows by name — what each one is usually filed as, and how often it charges. A reader adding a plan who names a service without describing it can be started from here. No entry carries a price, because the app never guesses what a plan costs: ask.',
    fields: {},
    async run(_args, ctx) {
      const { settings } = await subscriptionAccess(ctx)
      const slugOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1)
      return {
        templates: SERVICE_TEMPLATES.map((template) => ({
          name: template.name,
          type: slugOf(template.typeKey),
          category: slugOf(template.categoryKey),
          periodValue: template.periodValue,
          periodUnit: template.periodUnit,
        })),
        // The names above are English keys into the app's own label table; what the reader sees on screen
        // is those labels in their language, so a plan filed straight from this list would carry words
        // their own list never shows.
        note: 'type and category are the app\'s built-in label names in English. Before creating a plan from one, read list_subscription_labels and file it under the spelling that reader\'s own list shows — in their language, which is '
          + (settings.locale === 'en-US' ? 'English.' : 'Chinese.')
          + ' The amount is never in this list; ask what they pay.',
      }
    },
  }),
  tool({
    name: 'get_subscription_settings',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'How the subscriptions app is configured for this reader: the time zone reminders are judged in, the hours it may send them in, whether dates are shown by the lunar calendar, how many receipts a row carries, the currency the dashboard totals in, the ceilings they set for a month, for a year and for any category, and any exchange rate they pinned over the daily feed. Carrying no answer for one of these is a real fact about the account, so name it rather than guessing.',
    fields: {},
    async run(_args, ctx) {
      return presentSettings(await loadSettings(ctx.env.DB, ctx.store.userId))
    },
  }),
  tool({
    name: 'set_subscription_settings',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Change how the subscriptions app behaves for this reader. Only what is named is touched. `timezone` must be a real IANA zone such as Asia/Shanghai, and `notificationHours` is which hours of the reader\'s own day reminders may arrive in. `rateOverrides` is how the reader wants a currency valued, in yuan per unit, instead of the daily feed.',
    fields: {
      timezone: { type: 'string', maxLength: 40, optional: true, description: 'An IANA zone name, for example Asia/Shanghai or Europe/Berlin.' },
      notificationHours: { type: 'string', maxLength: 80, optional: true, description: 'Comma-separated hours of the day the reader may be woken with a reminder, such as "9,10,19,20". Send "all" for no window, or "none" to stay quiet.' },
      showLunar: { type: 'boolean', optional: true },
      paymentHistoryLimit: { type: 'integer', minimum: 1, maximum: 200, optional: true },
      baseCurrency: { type: 'string', enum: [...CURRENCY_CODES], optional: true },
      budgetMonthly: { type: 'number', minimum: 0, maximum: 1e9, optional: true },
      clearBudget: { type: 'boolean', optional: true, description: 'True removes the monthly ceiling altogether. Leave it out to keep or set one.' },
      budgetYearly: { type: 'number', minimum: 0, maximum: 1e9, optional: true, description: 'What a whole calendar year of these plans may cost, counted against the receipts already in it. A reader who pays for a year at a time needs this rather than twelve times the monthly number.' },
      clearYearlyBudget: { type: 'boolean', optional: true, description: 'True removes the yearly ceiling altogether. Leave it out to keep or set one.' },
      categoryBudgets: {
        type: 'string',
        maxLength: 240,
        optional: true,
        description: 'Ceilings for one category of plans across this calendar year, as "streaming:600, music:200". The names are matched as the reader wrote them, so a category nobody has filed a plan under yet is a ceiling that reads zero. Named categories are added to the ceilings already set; "streaming:none" lets one go uncapped again.',
      },
      clearCategoryBudgets: { type: 'boolean', optional: true, description: 'True removes every category ceiling, so no part of the year is capped.' },
      rateOverrides: {
        type: 'string',
        maxLength: 160,
        optional: true,
        description: 'Rates the reader stated for themselves, as "USD:7.2, JPY:0.045", each meaning 1 of that currency = so many yuan. Named currencies are added to the pins already set; "USD:none" lets one follow the feed again. Every total the app adds up converts with these.',
      },
      clearRates: { type: 'boolean', optional: true, description: 'True removes every pinned rate, so the account converts at the daily feed again.' },
    },
    async run(args, ctx) {
      const patch: Record<string, unknown> = {}
      if (typeof args.timezone === 'string') patch.timezone = args.timezone
      if (typeof args.showLunar === 'boolean') patch.showLunar = args.showLunar
      if (args.paymentHistoryLimit !== undefined) patch.paymentHistoryLimit = Number(args.paymentHistoryLimit)
      if (typeof args.baseCurrency === 'string') patch.baseCurrency = args.baseCurrency
      if (typeof args.notificationHours === 'string') {
        const text = args.notificationHours.trim().toLocaleLowerCase()
        if (text === 'none') patch.notificationHours = []
        else if (text === 'all' || !text) patch.notificationHours = Array.from({ length: 24 }, (_, hour) => String(hour))
        else {
          const hours = text.split(',').map((part) => part.trim()).filter(Boolean)
          if (!hours.every((part) => /^\d{1,2}$/.test(part) && Number(part) >= 0 && Number(part) <= 23)) {
            throw new ToolError(`"${args.notificationHours}" is not a list of hours. Name the hours as numbers 0 to 23, such as "9,10,19,20", or send "all" or "none".`)
          }
          patch.notificationHours = [...new Set(hours)]
        }
      }
      // A ceiling is one of the few settings where "no value" is the answer the reader means, and a number
      // field cannot carry that, so clearing it is its own verb rather than a zero.
      if (args.clearBudget === true) patch.budgetMonthly = null
      else if (args.budgetMonthly !== undefined) patch.budgetMonthly = Number(args.budgetMonthly)
      if (args.clearYearlyBudget === true) patch.budgetYearly = null
      else if (args.budgetYearly !== undefined) patch.budgetYearly = Number(args.budgetYearly)
      // A ceiling is stated one category at a time in a conversation — "and keep video under six hundred
      // this year" — so the names given are merged into what the account already capped. Only
      // `clearCategoryBudgets` answers "drop them all", which a merge cannot express.
      if (args.clearCategoryBudgets === true) patch.budgetCategories = {}
      else if (typeof args.categoryBudgets === 'string') {
        const tokens = args.categoryBudgets.split(',').map((token) => token.trim()).filter(Boolean)
        if (!tokens.length) throw new ToolError('Name a category to cap, such as "streaming:600", or ask to clear the ceilings.')
        const ceilings: Record<string, number> = { ...(await loadSettings(ctx.env.DB, ctx.store.userId)).budgetCategories }
        for (const token of tokens) {
          const [rawName = '', rawValue] = token.split(/[:=]/)
          const name = rawName.trim()
          if (!name) throw new ToolError(`"${token}" names no category. Write <category>:<amount>, such as "streaming:600".`)
          const value = (rawValue ?? '').trim()
          if (value.toLowerCase() === 'none') {
            delete ceilings[name]
            continue
          }
          const numeric = Number(value)
          if (!Number.isFinite(numeric) || numeric <= 0) {
            throw new ToolError(`"${token}" is not a ceiling. Write <category>:<amount>, such as "streaming:600", or "streaming:none" to leave it uncapped.`)
          }
          ceilings[name] = numeric
        }
        patch.budgetCategories = ceilings
      }
      // A pin is stated one currency at a time in a conversation — "and use 7.2 for the dollar" — so the
      // currencies named are merged into what the account already pinned. Only `clearRates` answers "drop
      // them all", because a merge cannot express that and an empty string would be read as either.
      if (args.clearRates === true) patch.rateOverrides = {}
      else if (typeof args.rateOverrides === 'string') {
        const tokens = args.rateOverrides.split(',').map((token) => token.trim()).filter(Boolean)
        if (!tokens.length) throw new ToolError('Name a currency to pin, such as "USD:7.2", or ask to clear the pinned rates.')
        const pinned: Record<string, number> = { ...(await loadSettings(ctx.env.DB, ctx.store.userId)).rateOverrides }
        for (const token of tokens) {
          const [rawCode = '', rawValue] = token.split(/[:=]/)
          const code = rawCode.trim().toUpperCase()
          if (!(CURRENCY_CODES as readonly string[]).includes(code)) {
            throw new ToolError(`"${code}" is not a currency this app converts. It knows ${CURRENCY_CODES.join(', ')}.`)
          }
          if (code === 'CNY') throw new ToolError('The yuan is what every other rate is measured against, so it has no rate of its own to pin.')
          const value = (rawValue ?? '').trim()
          if (value.toLowerCase() === 'none') {
            delete pinned[code]
            continue
          }
          const numeric = Number(value)
          if (!isRateValue(numeric)) {
            throw new ToolError(`"${token}" is not a rate. Write 1 <currency> = <number>, such as "USD:7.2", or "USD:none" to let it follow the feed.`)
          }
          pinned[code] = numeric
        }
        patch.rateOverrides = pinned
      }
      if (!Object.keys(patch).length) throw new ToolError('Name at least one setting to change.')
      let settings
      try {
        settings = await saveSettings(ctx.env.DB, ctx.store.userId, patch)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ToolError(reason === 'invalid_timezone'
          ? `"${String(args.timezone)}" is not a time zone the app accepts. Use an IANA name such as Asia/Shanghai, Europe/Berlin or America/New_York.`
          : `That setting could not be saved: ${reason.slice(0, 160)}`)
      }
      return presentSettings(settings)
    },
  }),
  tool({
    name: 'set_subscription_active',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Switch one subscription\'s tracking on or off. Off keeps the row and its receipts and stops reminders for it — it is not the trash, which is what `delete_subscription` is for.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      active: { type: 'boolean', description: 'False stops reminders and renewal counting for it; true starts them again.' },
    },
    async run(args, ctx) {
      const { store, context, detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      const active = args.active === true
      // The bulk write reports the rows it touched, not the rows whose state moved, so a repeat of the
      // same switch would answer "done" while changing nothing. The refusal is read off the row first.
      if (detail.item.isActive === active) {
        throw new ToolError(`That subscription is already ${active ? 'switched on' : 'switched off'}.`)
      }
      await store.bulk([detail.item.id], active ? 'activate' : 'deactivate')
      const after = await store.get(detail.item.id, context)
      return { updated: after ? presentSubscription(after.item) : null }
    },
  }),
  tool({
    name: 'subscription_logs',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'What the reminder scheduler actually did: the deliveries it attempted per channel with the reason for each failure, and the sweeps that ran — how many subscriptions it looked at, how many matched, how many were silenced as duplicates. `subscription_summary` answers what is due; this answers whether the app told the reader about it. Titles and bodies are omitted on purpose: the reader can read them in the notification.',
    fields: {
      ref: { type: 'string', maxLength: 120, optional: true, description: 'Limit the deliveries to one subscription, named as the reader named it.' },
      status: { type: 'string', enum: ['all', 'success', 'failed'], optional: true },
      limit: { type: 'integer', minimum: 1, maximum: 50, optional: true },
    },
    async run(args, ctx) {
      const limit = Number(args.limit ?? 15)
      let subscriptionId: string | undefined
      if (typeof args.ref === 'string' && args.ref.trim()) {
        const { detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
        subscriptionId = detail.item.id
      }
      const status = args.status === 'success' || args.status === 'failed' ? args.status : undefined
      const [deliveries, sweeps] = await Promise.all([
        queryNotifyLogs(ctx.env.DB, ctx.store.userId, { subscriptionId, status, limit }),
        recentScheduleLogs(ctx.env.DB, ctx.store.userId, 5),
      ])
      return {
        total: deliveries.length,
        more: deliveries.length === limit,
        deliveries: deliveries.map((entry) => ({
          subscription: entry.subscriptionName,
          channel: entry.channel,
          status: entry.status,
          at: entry.createdAt,
          // The two fields that turn "failed" into something the reader can act on.
          error: entry.error || null,
          detail: entry.detail || null,
        })),
        sweeps: sweeps.map((entry) => ({
          startedAt: entry.startedAt,
          status: entry.status,
          inWindow: entry.inWindow,
          checked: entry.checkedCount,
          matched: entry.matchedCount,
          deduped: entry.dedupedCount,
          sent: entry.sentCount,
          reason: entry.reason || null,
        })),
        note: deliveries.length === 0
          ? 'No delivery has been attempted yet, which is different from nothing being due — check the reminders and the notification window.'
          : undefined,
      }
    },
  }),
  tool({
    name: 'edit_subscription_payment',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Correct one receipt that was already paid: its date, amount, currency or note. Use this rather than `renew_subscription` when the reader says the record is wrong, because renewing writes a second receipt and doubles what the dashboard says they spent. The receipt ids come from `get_subscription`.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      payment: { type: 'string', minLength: 1, maxLength: 40, description: 'The receipt\'s id, as `get_subscription` returned it.' },
      date: { type: 'string', maxLength: 10, optional: true, description: 'YYYY-MM-DD.' },
      amount: { type: 'number', minimum: 0, maximum: 1e9, optional: true },
      currency: { type: 'string', enum: [...CURRENCY_CODES], optional: true },
      note: { type: 'string', maxLength: 200, optional: true, description: 'Send an empty string to clear the note.' },
    },
    async run(args, ctx) {
      const { store, context, detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      const wanted = String(args.payment).trim()
      const payment = detail.payments.find((entry) => entry.id === wanted)
      if (!payment) {
        const held = detail.payments.slice(0, 5).map((entry) => `${entry.id} (${entry.paidAt.slice(0, 10)} ${formatAmount(entry.amount, entry.currency)})`)
        throw new ToolError(`No receipt ${held.length ? 'of this subscription matches' : 'exists to edit'} "${wanted.slice(0, 40)}".${held.length ? ` It holds: ${held.join(', ')}.` : ''} Read the subscription first to get the id.`)
      }
      const patch: { date?: string; amount?: number; currency?: string; note?: string } = {}
      if (typeof args.date === 'string' && args.date) patch.date = `${args.date.slice(0, 10)}T00:00:00Z`
      if (args.amount !== undefined) patch.amount = Number(args.amount)
      if (typeof args.currency === 'string') patch.currency = args.currency
      if (typeof args.note === 'string') patch.note = args.note
      if (!Object.keys(patch).length) throw new ToolError('Name at least one part of the receipt to change.')
      const updated = await store.updatePayment(detail.item.id, payment.id, patch, context)
      if (!updated) throw new ToolError('That receipt is gone.')
      return {
        updated: presentSubscription(updated.item),
        payment: {
          id: payment.id,
          date: (patch.date ?? payment.paidAt).slice(0, 10),
          amount: patch.amount ?? payment.amount,
          currency: patch.currency ?? payment.currency,
          note: patch.note ?? payment.note,
        },
        payments: updated.payments.length,
      }
    },
  }),
  tool({
    name: 'delete_subscription_payment',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Erase one receipt from a subscription\'s history. This is not undoable and it changes what the reader has been told they spent, so it is proposed for approval rather than run.',
    fields: {
      ref: { type: 'string', minLength: 1, maxLength: 120 },
      payment: { type: 'string', minLength: 1, maxLength: 40 },
    },
    async prepare(args, ctx) {
      const { detail } = await resolveSubscriptionOrThrow(args.ref, ctx)
      const wanted = String(args.payment).trim()
      const payment = detail.payments.find((entry) => entry.id === wanted)
      if (!payment) throw new ToolError(`No receipt of "${detail.item.name}" matches "${wanted.slice(0, 40)}". Read the subscription to get its ids.`)
      return {
        targetId: `${detail.item.id}:${payment.id}`,
        targetLabel: `${detail.item.name} — ${formatAmount(payment.amount, payment.currency)} on ${payment.paidAt.slice(0, 10)}`,
      }
    },
    async commit(targetId, ctx, args) {
      const { store, context, detail } = await resolveSubscriptionOrThrow(String(args.ref), ctx)
      const paymentId = targetId.split(':')[1] ?? ''
      if (!detail.payments.some((entry) => entry.id === paymentId)) {
        throw new ToolError(`That receipt is no longer on ${detail.item.name}, so nothing was erased.`)
      }
      const updated = await store.deletePayment(detail.item.id, paymentId, context)
      if (!updated) throw new ToolError('That receipt is gone.')
      return {
        deleted: true,
        subscription: presentSubscription(updated.item),
        payments: updated.payments.length,
        note: 'The receipt is erased; the subscription and its remaining history are untouched.',
      }
    },
  }),
  tool({
    name: 'bulk_update_subscriptions',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Switch tracking on or off, or set the category, for several subscriptions at once. Name them in `refs`, separated by commas. Trashing is deliberately not a bulk verb: one wrong name would multiply a deletion, so `delete_subscription` handles that one plan at a time and asks first.',
    fields: {
      refs: { type: 'string', minLength: 1, maxLength: 2000, description: 'Names or ids, comma-separated. Up to 200.' },
      action: { type: 'string', enum: ['activate', 'deactivate', 'set_category'] },
      category: { type: 'string', maxLength: 40, optional: true, description: 'Required for set_category, ignored otherwise.' },
    },
    async run(args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const action = String(args.action)
      if (action === 'set_category' && !(typeof args.category === 'string' && args.category.trim())) {
        throw new ToolError('set_category needs a `category` to set. Name it, or send several labels separated by "/" to replace the whole set.')
      }
      const wanted = String(args.refs).split(',').map((entry) => entry.trim()).filter(Boolean)
      if (!wanted.length) throw new ToolError('Name at least one subscription.')
      const live = await store.list(context)
      const folded = new Map<string, typeof live[number][]>()
      for (const item of live) {
        const key = item.name.toLocaleLowerCase()
        folded.set(key, [...(folded.get(key) ?? []), item])
      }
      const ids: string[] = []
      const skipped: string[] = []
      for (const name of wanted.slice(0, BULK_LIMIT)) {
        const exact = folded.get(name.toLocaleLowerCase())
        if (exact && exact.length === 1) { ids.push(exact[0]!.id); continue }
        const byId = live.find((item) => item.id === name)
        if (byId) { ids.push(byId.id); continue }
        skipped.push(exact && exact.length > 1 ? `${name} (matches ${exact.length} plans)` : `${name} (no live plan of that name)`)
      }
      if (!ids.length) throw new ToolError(`Nothing was changed. ${skipped.join('; ')}.`)
      const changed = await store.bulk(ids, action as 'activate' | 'deactivate' | 'set_category', { category: typeof args.category === 'string' ? args.category : undefined })
      return {
        action,
        asked: wanted.length,
        matched: ids.length,
        changed,
        skipped,
        more: wanted.length > BULK_LIMIT,
      }
    },
  }),
  tool({
    name: 'add_subscription_label',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Register a type or category name so it is offered when the reader types it, without attaching it to any subscription yet. A plan that already uses the name registers it on save, so this is for the list itself.',
    fields: {
      kind: { type: 'string', enum: ['type', 'category'] },
      name: { type: 'string', minLength: 1, maxLength: 40 },
    },
    async run(args, ctx) {
      const { store } = await subscriptionAccess(ctx)
      const kind = args.kind === 'category' ? 'category' : 'type'
      await store.registerLabels(kind, String(args.name))
      const labels = await store.listLabels(kind)
      const named = labels.find((entry) => entry.name.toLocaleLowerCase() === String(args.name).trim().toLocaleLowerCase())
      if (!named) throw new ToolError(`"${String(args.name).slice(0, 40)}" was not registered — the app rejects names that are empty or too long.`)
      return { kind, label: named, total: labels.length }
    },
  }),
  tool({
    name: 'rename_subscription_label',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Rename a type or category everywhere it is used: the registry entry and every subscription carrying it. Refused when the new name is already taken, because merging two names is a different decision than renaming one.',
    fields: {
      kind: { type: 'string', enum: ['type', 'category'] },
      name: { type: 'string', minLength: 1, maxLength: 40 },
      to: { type: 'string', minLength: 1, maxLength: 40 },
    },
    async run(args, ctx) {
      const { store } = await subscriptionAccess(ctx)
      const kind = args.kind === 'category' ? 'category' : 'type'
      const renamed = await store.renameLabel(kind, String(args.name), String(args.to))
      if (!renamed) {
        throw new ToolError(`"${String(args.name).slice(0, 40)}" was not renamed to "${String(args.to).slice(0, 40)}". The target name may already exist, or the two names are the same.`)
      }
      const labels = await store.listLabels(kind)
      return { kind, total: labels.length, labels: labels.map((entry) => entry.name) }
    },
  }),
  tool({
    name: 'remove_subscription_label',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Take a type or category out of the registry, so it stops being suggested. Subscriptions that were using it keep the word they hold — this does not edit any plan — and re-registering the name brings its icon and colour back.',
    fields: {
      kind: { type: 'string', enum: ['type', 'category'] },
      name: { type: 'string', minLength: 1, maxLength: 40 },
    },
    async run(args, ctx) {
      const { store } = await subscriptionAccess(ctx)
      const kind = args.kind === 'category' ? 'category' : 'type'
      const removed = await store.removeLabel(kind, String(args.name))
      const labels = await store.listLabels(kind)
      return {
        kind,
        removed,
        total: labels.length,
        note: removed ? undefined : `Nothing registered is called "${String(args.name).slice(0, 40)}".`,
      }
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
    name: 'purge_subscription',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Erase one subscription that is already in the trash, together with its whole payment history. This cannot be undone, so it only accepts a plan the reader has already trashed — `delete_subscription` is the verb that puts one there.',
    fields: { ref: { type: 'string', minLength: 1, maxLength: 120 } },
    async prepare(args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const wanted = String(args.ref).trim()
      const folded = wanted.toLocaleLowerCase()
      const trashed = await store.list(context, 'trash')
      const match = trashed.find((item) => item.id === wanted) ?? trashed.find((item) => item.name.toLocaleLowerCase() === folded)
      if (!match) {
        throw new ToolError(trashed.length === 0
          ? 'The trash is empty, so there is nothing to erase. Moving a plan to the trash is `delete_subscription`.'
          : `Nothing in the trash matches "${wanted.slice(0, 80)}". The trash holds ${trashed.length}: ${trashed.slice(0, 10).map((item) => item.name).join(', ')}.`)
      }
      return { targetId: match.id, targetLabel: quoted(match.name) }
    },
    async commit(targetId, ctx) {
      const { store } = await subscriptionAccess(ctx)
      const erased = await store.purge(targetId)
      if (!erased) throw new ToolError('That subscription is no longer in the trash, so nothing was erased.')
      return { purged: true, note: 'The plan and its receipts are gone for good.' }
    },
  }),
  tool({
    name: 'empty_subscription_trash',
    permission: 'destructive',
    maxCallsPerTurn: 1,
    description: 'Erase every subscription in the trash at once, with their payment histories. The approval card names how many are about to go, because this is the one deletion in the app that no longer has a way back.',
    fields: {},
    async prepare(_args, ctx) {
      const { store, context } = await subscriptionAccess(ctx)
      const trashed = await store.list(context, 'trash')
      if (!trashed.length) throw new ToolError('The trash is already empty.')
      const names = trashed.slice(0, 5).map((item) => item.name).join(', ')
      return {
        targetId: String(trashed.length),
        targetLabel: `${trashed.length} subscription${trashed.length === 1 ? '' : 's'}: ${names}${trashed.length > 5 ? ', …' : ''}`,
      }
    },
    async commit(targetId, ctx) {
      const { store } = await subscriptionAccess(ctx)
      const purged = await store.emptyTrash()
      if (purged === 0) return { purged: 0, note: 'Nothing was erased — the trash was emptied first.' }
      if (String(purged) !== targetId) {
        return { purged, note: `${targetId} were on the card the reader approved; ${purged} went. The list changed in between.` }
      }
      return { purged, note: 'Every trashed plan and its receipts are gone for good.' }
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

/**
 * The rate table the account's own money is added up with — the same three steps the dashboard runs:
 * the day's rates against the yuan, this account's pins over them, then re-based to the currency it
 * counts in. A list ordered "by what costs most" has to use that table or it disagrees with the total
 * printed above it.
 */
async function accountRateTable(ctx: ToolContext, settings: Awaited<ReturnType<typeof loadSettings>>): Promise<RateTable> {
  const { table } = await loadRates(ctx.env)
  return rateTableFor(applyRateOverrides(table, settings.rateOverrides), settings.baseCurrency)
}

/**
 * What the settings look like to the model, in the words the reader would use back.
 *
 * The inbound token hint is left out on purpose: it is a fragment of a credential, and a tool result
 * travels to the model provider with the rest of the turn. Each ceiling carries a sentence for its own
 * absence, because "no ceiling" is an answer the account gave and not a field the tool forgot.
 */
function presentSettings(settings: SubscriptionSettings): Record<string, unknown> {
  return {
    timezone: settings.timezone,
    notificationHours: settings.notificationHours,
    showLunar: settings.showLunar,
    paymentHistoryLimit: settings.paymentHistoryLimit,
    locale: settings.locale,
    baseCurrency: settings.baseCurrency,
    budgetMonthly: settings.budgetMonthly,
    budgetNote: settings.budgetMonthly === null
      ? 'No monthly ceiling is set, so the dashboard never calls a month over budget.'
      : undefined,
    budgetYearly: settings.budgetYearly,
    budgetYearlyNote: settings.budgetYearly === null
      ? 'No yearly ceiling is set, so the dashboard never calls a year over budget.'
      : undefined,
    budgetCategories: settings.budgetCategories,
    categoryBudgetsNote: Object.keys(settings.budgetCategories).length === 0
      ? 'No category is capped, so the dashboard sets no ceiling on any part of the year.'
      : undefined,
    rateOverrides: settings.rateOverrides,
    ratesNote: Object.keys(settings.rateOverrides).length === 0
      ? 'No rate is pinned, so every total converts at the daily exchange feed.'
      : undefined,
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
    // Per currency, because the receipts are: a plan paid in two currencies has two answers to "what
    // have I spent on it", and adding them would be a number that means nothing.
    paidByCurrency: item.paidByCurrency,
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

async function emailToolCall<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (error instanceof ApiError) throw new ToolError(error.message)
    throw error
  }
}

export const EMAIL_TOOLS: ToolDefinition[] = [
  tool({
    name: 'email_list_accounts',
    permission: 'read',
    maxCallsPerTurn: 2,
    description: 'List the owner\'s mailboxes. Use this before naming an account in another email tool.',
    fields: {},
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(_args, ctx) {
      return { accounts: await listEmailToolAccounts(ctx.env, ctx.store.userId) }
    },
  }),
  tool({
    name: 'email_list',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'List messages in one mailbox folder. Use email_read for the body and email_thread for the whole conversation.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      folder: { type: 'string', description: 'Folder id or name, such as inbox, sent, draft, archive, trash or spam.', maxLength: 200, optional: true },
      tag: { type: 'string', description: 'Only messages carrying this tag path, such as work/meeting.', maxLength: 255, optional: true },
      important: { type: 'boolean', description: 'Only messages marked important.', optional: true },
      focused: { type: 'boolean', description: 'Only messages in the focused inbox (true) or the other inbox (false).', optional: true },
      followUp: { type: 'boolean', description: 'Only messages waiting for a follow-up.', optional: true },
      limit: { type: 'integer', description: 'How many messages to return, at most 100.', minimum: 1, maximum: 100, optional: true },
      page: { type: 'integer', description: 'Page number, starting at 1.', minimum: 1, maximum: 1000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return {
        emails: await listEmailToolMessages(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          folder: typeof args.folder === 'string' ? args.folder : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
          important: typeof args.important === 'boolean' ? args.important : undefined,
          focused: typeof args.focused === 'boolean' ? args.focused : undefined,
          followUp: typeof args.followUp === 'boolean' ? args.followUp : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          page: typeof args.page === 'number' ? args.page : undefined,
        }),
      }
    },
  }),
  tool({
    name: 'email_read',
    permission: 'read',
    maxCallsPerTurn: 5,
    description: 'Read one email with its full body, headers and attachment metadata.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The email id.', minLength: 1, maxLength: 64 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      const message = await getEmailToolMessage(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        emailId: String(args.emailId),
      })
      if (!message) throw new ToolError('Email not found')
      return { email: message }
    },
  }),
  tool({
    name: 'email_thread',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'Read every message in one conversation thread, oldest first.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      threadId: { type: 'string', description: 'The thread id from an email.', minLength: 1, maxLength: 64 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return getEmailToolThread(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        threadId: String(args.threadId),
      })
    },
  }),
  tool({
    name: 'email_search',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'Search a mailbox by subject, body, sender or recipient. Returns message metadata, not full bodies.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      query: { type: 'string', description: 'Text to search for.', minLength: 1, maxLength: 500 },
      folder: { type: 'string', description: 'Optional folder id or name.', maxLength: 200, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return {
        emails: await searchEmailToolMessages(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          query: String(args.query),
          folder: typeof args.folder === 'string' ? args.folder : undefined,
        }),
      }
    },
  }),
  tool({
    name: 'email_draft_reply',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Draft a reply to an existing email and save it in Drafts. This never sends; the reader reviews and sends it.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      originalEmailId: { type: 'string', description: 'The id of the email being replied to.', minLength: 1, maxLength: 64 },
      to: { type: 'string', description: 'Recipient email address.', minLength: 3, maxLength: 320 },
      subject: { type: 'string', description: 'Subject line, usually Re: ...', minLength: 1, maxLength: 1000 },
      body: { type: 'string', description: 'Plain-text reply body. No HTML and no agent commentary.', minLength: 1, maxLength: 20000 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      const draft = await draftEmailReplyTool(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        originalEmailId: String(args.originalEmailId),
        to: String(args.to),
        subject: String(args.subject),
        body: String(args.body),
      })
      if (!draft) throw new ToolError('Original email not found')
      return { status: 'draft_saved', draft }
    },
  }),
  tool({
    name: 'email_draft',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Draft a new email and save it in Drafts. This never sends.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      to: { type: 'string', description: 'Recipient email address.', minLength: 3, maxLength: 320 },
      subject: { type: 'string', description: 'Subject line.', minLength: 1, maxLength: 1000 },
      body: { type: 'string', description: 'Plain-text body. No HTML and no agent commentary.', minLength: 1, maxLength: 20000 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return {
        status: 'draft_saved',
        draft: await draftEmailTool(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          to: String(args.to),
          subject: String(args.subject),
          body: String(args.body),
        }),
      }
    },
  }),
  tool({
    name: 'email_mark_read',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Mark one email read or unread.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The email id.', minLength: 1, maxLength: 64 },
      read: { type: 'boolean', description: 'true to mark read, false for unread.' },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      const updated = await markEmailReadTool(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        emailId: String(args.emailId),
        read: args.read === true,
      })
      if (!updated) throw new ToolError('Email not found')
      return { status: 'updated', emailId: args.emailId, read: args.read === true }
    },
  }),
  tool({
    name: 'email_move',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Move one email to another folder, such as archive or trash.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The email id.', minLength: 1, maxLength: 64 },
      folderId: { type: 'string', description: 'Target folder id or name.', minLength: 1, maxLength: 200 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      const moved = await moveEmailTool(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        emailId: String(args.emailId),
        folderId: String(args.folderId),
      })
      if (!moved) throw new ToolError('Email or folder not found')
      return { status: 'moved', emailId: args.emailId, folder: args.folderId }
    },
  }),
  {
    name: 'email_discard_draft',
    permission: 'destructive',
    maxCallsPerTurn: 2,
    description: 'Permanently discard a draft from the Drafts folder.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      draftId: { type: 'string', description: 'The draft email id.', minLength: 1, maxLength: 64 },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async prepare(args, ctx) {
      const draft = await getEmailToolMessage(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        emailId: String(args.draftId),
      })
      if (!draft || draft.folderId !== 'draft') throw new ToolError('Draft not found')
      return { targetId: draft.id, targetLabel: draft.subject || draft.id }
    },
    async commit(targetId, ctx, args) {
      const discarded = await discardDraftTool(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        draftId: targetId,
      })
      if (!discarded) throw new ToolError('Draft not found')
      return { status: 'discarded', draftId: targetId }
    },
  },
  tool({
    name: 'email_inspect',
    permission: 'read',
    maxCallsPerTurn: 4,
    description: 'Read the mailbox structure and settings before changing them. Sections: overview (accounts, folders, tags, searches, filters, templates, stats), folders, tags, searches, rules, templates, contacts, settings, scheduled, stats. Use this to get the ids and names the other email tools take.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      section: {
        type: 'string',
        description: 'Which part of the mailbox to read.',
        enum: ['overview', 'folders', 'tags', 'searches', 'rules', 'templates', 'contacts', 'settings', 'scheduled', 'stats'],
      },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => inspectEmailAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        section: String(args.section) as Parameters<typeof inspectEmailAgent>[2]['section'],
      }))
    },
  }),
  tool({
    name: 'email_folder',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Create a folder, or rename, recolor, reorder, or reparent one. Folders nest at most five levels. System folder names cannot be reused.',
    fields: {
      action: { type: 'string', enum: ['create', 'update'], description: 'Create a new folder or update an existing one.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      folderId: { type: 'string', description: 'The folder id or exact name. Required for update.', maxLength: 200, optional: true },
      name: { type: 'string', description: 'Folder name. Required for create.', maxLength: 120, optional: true },
      parentId: { type: 'string', description: 'Parent folder id or exact name; an empty string moves the folder to the top level.', maxLength: 200, optional: true, nullable: true },
      color: { type: 'string', description: 'One of the organizer colors, or an empty string to clear it.', maxLength: 40, optional: true, nullable: true },
      sortOrder: { type: 'integer', description: 'Sort order among siblings.', minimum: 0, maximum: 1000000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(async () => {
        if (args.action === 'create') {
          return { status: 'created', folder: await createEmailFolderAgent(ctx.env, ctx.store.userId, {
            accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
            name: args.name,
            parentId: args.parentId,
            color: args.color,
          }) }
        }
        if (typeof args.folderId !== 'string' || !args.folderId) throw new ToolError('A folder id is required for update.')
        return { status: 'updated', folder: await updateEmailFolderAgent(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          folderId: args.folderId,
          name: args.name,
          parentId: args.parentId,
          color: args.color,
          sortOrder: args.sortOrder,
        }) }
      })
    },
  }),
  tool({
    name: 'email_tag',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Create or rename a tag, or attach/detach a tag on one email. A tag path looks like work/meeting; missing ancestors are created when attaching by path.',
    fields: {
      action: { type: 'string', enum: ['create', 'update', 'attach', 'detach'], description: 'Create a tag, update it, or attach/detach it on one email.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The email id for attach or detach.', maxLength: 64, optional: true },
      tagId: { type: 'string', description: 'The tag id for update, attach, or detach.', maxLength: 64, optional: true },
      name: { type: 'string', description: 'The tag path for create/update, or the path to resolve when attach/detach has no tagId.', maxLength: 255, optional: true },
      color: { type: 'string', description: 'One of the organizer colors, or an empty string to clear it.', maxLength: 40, optional: true, nullable: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(async () => {
        if (args.action === 'create') {
          return { status: 'created', tag: await createEmailTagAgent(ctx.env, ctx.store.userId, {
            accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
            name: args.name,
            color: args.color,
          }) }
        }
        if (args.action === 'update') {
          if (typeof args.tagId !== 'string' || !args.tagId) throw new ToolError('A tag id is required for update.')
          return { status: 'updated', tag: await updateEmailTagAgent(ctx.env, ctx.store.userId, {
            accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
            tagId: args.tagId,
            name: args.name,
            color: args.color,
          }) }
        }
        if (typeof args.emailId !== 'string' || !args.emailId) throw new ToolError('An email id is required.')
        if (typeof args.tagId !== 'string' && typeof args.name !== 'string') throw new ToolError('Name a tag id or tag path.')
        return emailToolCall(() => tagEmailAgent(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          emailId: args.emailId as string,
          ...(typeof args.tagId === 'string' ? { tagId: args.tagId } : {}),
          ...(typeof args.name === 'string' ? { name: args.name } : {}),
          remove: args.action === 'detach',
        }))
      })
    },
  }),
  tool({
    name: 'email_update_message',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Change one email: read/unread, starred, important, mute the thread, move to a folder, restore from Trash, snooze until a time, or set/clear a follow-up. Omitted fields are left alone; snoozeUntil and followUpAt accept null to clear.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The email id.', minLength: 1, maxLength: 64 },
      read: { type: 'boolean', optional: true },
      starred: { type: 'boolean', optional: true },
      important: { type: 'boolean', optional: true },
      muted: { type: 'boolean', description: 'Mute or unmute the whole thread.', optional: true },
      folder: { type: 'string', description: 'Folder id or exact name; trash moves it to Trash.', maxLength: 200, optional: true },
      restore: { type: 'boolean', description: 'Restore a trashed message to the inbox.', optional: true },
      snoozeUntil: { type: 'string', description: 'ISO time to snooze until, or null to clear the snooze.', maxLength: 40, optional: true, nullable: true },
      followUpAt: { type: 'string', description: 'ISO time to flag the message for follow-up, or null to clear it.', maxLength: 40, optional: true, nullable: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(async () => {
        const message = await updateEmailMessageAgent(ctx.env, ctx.store.userId, {
          accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
          emailId: String(args.emailId),
          ...(typeof args.read === 'boolean' ? { read: args.read } : {}),
          ...(typeof args.starred === 'boolean' ? { starred: args.starred } : {}),
          ...(typeof args.important === 'boolean' ? { important: args.important } : {}),
          ...(typeof args.muted === 'boolean' ? { muted: args.muted } : {}),
          ...(typeof args.folder === 'string' ? { folder: args.folder } : {}),
          ...(typeof args.restore === 'boolean' ? { restore: args.restore } : {}),
          ...(Object.prototype.hasOwnProperty.call(args, 'snoozeUntil') ? { snoozeUntil: args.snoozeUntil as string | null } : {}),
          ...(Object.prototype.hasOwnProperty.call(args, 'followUpAt') ? { followUpAt: args.followUpAt as string | null } : {}),
        })
        return { status: 'updated', email: message }
      })
    },
  }),
  tool({
    name: 'email_batch',
    permission: 'write',
    maxCallsPerTurn: 2,
    description: 'Change up to 100 emails at once: read, unread, star, unstar, archive, trash, restore, or move to a folder.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      ids: { type: 'array', items: 'string', maxItems: 100, description: 'The email ids, exactly as email_list returned them.' },
      action: { type: 'string', enum: [...EMAIL_BATCH_ACTIONS], description: 'The change to apply to every listed email.' },
      folder: { type: 'string', description: 'Target folder id or exact name, required for move.', maxLength: 200, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => batchEmailAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        ids: (args.ids as string[]) ?? [],
        action: String(args.action),
        folder: typeof args.folder === 'string' ? args.folder : undefined,
      }))
    },
  }),
  tool({
    name: 'email_update_draft',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Edit a saved draft in place. Omitted fields stay as they are; changing the body replaces the plain-text source and its HTML. This never sends.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      draftId: { type: 'string', description: 'The draft email id.', minLength: 1, maxLength: 64 },
      to: { type: 'string', description: 'Recipient address.', maxLength: 320, optional: true },
      cc: { type: 'string', description: 'Cc addresses; an empty string clears them.', maxLength: 3200, optional: true, nullable: true },
      bcc: { type: 'string', description: 'Bcc addresses; an empty string clears them.', maxLength: 3200, optional: true, nullable: true },
      subject: { type: 'string', description: 'Subject line.', maxLength: 1000, optional: true },
      body: { type: 'string', description: 'Plain-text body with Markdown.', maxLength: 20000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      if (args.to === undefined && args.cc === undefined && args.bcc === undefined && args.subject === undefined && args.body === undefined) {
        throw new ToolError('Name at least one part of the draft to change.')
      }
      return emailToolCall(() => updateEmailDraftAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        draftId: String(args.draftId),
        to: typeof args.to === 'string' ? args.to : undefined,
        cc: Object.prototype.hasOwnProperty.call(args, 'cc') ? args.cc as string | null : undefined,
        bcc: Object.prototype.hasOwnProperty.call(args, 'bcc') ? args.bcc as string | null : undefined,
        subject: typeof args.subject === 'string' ? args.subject : undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
      }))
    },
  }),
  {
    name: 'email_send',
    permission: 'destructive',
    keepArgs: true,
    maxCallsPerTurn: 2,
    description: 'Propose a real email send; the reader must approve it before anything leaves. mode draft sends an existing draft and its attachments; new, reply, and forward compose and send in one approved step. Reply and forward default to the original sender and quote the original below the new text.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      mode: { type: 'string', enum: ['draft', 'new', 'reply', 'forward'], description: 'What to send.' },
      draftId: { type: 'string', description: 'The saved draft id when mode is draft.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The original email id for reply or forward.', maxLength: 64, optional: true },
      to: { type: 'string', description: 'Recipient address for new, or an override for reply/forward.', maxLength: 320, optional: true },
      subject: { type: 'string', description: 'Subject for new, or an override for reply/forward.', maxLength: 1000, optional: true },
      body: { type: 'string', description: 'Plain-text body with Markdown for new, reply, or forward.', maxLength: 20000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async prepare(args, ctx) {
      return emailToolCall(() => prepareSendEmailAgent(ctx.env, ctx.store.userId, args as unknown as Parameters<typeof prepareSendEmailAgent>[2]))
    },
    async commit(targetId, ctx, args) {
      return emailToolCall(async () => {
        const result = await sendEmailAgent(ctx.env, ctx.store.userId, {
          ...(args as unknown as Parameters<typeof sendEmailAgent>[2]),
          operationId: `agent-send:${targetId}`,
        })
        if (result.status === 'failed') throw new ToolError(result.error ?? 'The email could not be sent.')
        return result
      })
    },
  },
  {
    name: 'email_schedule_send',
    permission: 'destructive',
    keepArgs: true,
    maxCallsPerTurn: 2,
    description: 'Propose scheduling a message to send later, or cancelling a queued scheduled send. The reader must approve it. mode draft schedules a saved draft; new, reply, and forward save the draft first.',
    fields: {
      action: { type: 'string', enum: ['schedule', 'cancel'], description: 'Schedule a send or cancel one.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      scheduledId: { type: 'string', description: 'The scheduled send id to cancel.', maxLength: 64, optional: true },
      mode: { type: 'string', enum: ['draft', 'new', 'reply', 'forward'], description: 'What to schedule.', optional: true },
      draftId: { type: 'string', description: 'The saved draft id when mode is draft.', maxLength: 64, optional: true },
      emailId: { type: 'string', description: 'The original email id for reply or forward.', maxLength: 64, optional: true },
      to: { type: 'string', description: 'Recipient address for new, or an override for reply/forward.', maxLength: 320, optional: true },
      subject: { type: 'string', description: 'Subject for new, or an override for reply/forward.', maxLength: 1000, optional: true },
      body: { type: 'string', description: 'Plain-text body with Markdown for new, reply, or forward.', maxLength: 20000, optional: true },
      sendAt: { type: 'string', description: 'ISO time when the message should leave.', maxLength: 40, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async prepare(args, ctx) {
      return emailToolCall(() => prepareScheduleEmailAgent(
        ctx.env,
        ctx.store.userId,
        args as unknown as Parameters<typeof prepareScheduleEmailAgent>[2],
        { timezone: ctx.timezone, locale: ctx.settings.language },
      ))
    },
    async commit(_targetId, ctx, args) {
      return emailToolCall(() => scheduleEmailAgent(ctx.env, ctx.store.userId, args as unknown as Parameters<typeof scheduleEmailAgent>[2]))
    },
  },
  tool({
    name: 'email_rule',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Create or update an inbound filter, or block/unblock a sender. Condition tokens: from:ADDRESS, to:ADDRESS, subject:TEXT, has-attachment, min-bytes:10000. Action tokens: move:Folder, tag:path, read, star, trash. Every condition must match, actions run in order.',
    fields: {
      action: { type: 'string', enum: ['create', 'update', 'block', 'unblock'], description: 'Create/update a filter, or block/unblock a sender.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      filterId: { type: 'string', description: 'The filter id for update.', maxLength: 64, optional: true },
      name: { type: 'string', description: 'Filter name.', maxLength: 80, optional: true },
      enabled: { type: 'boolean', description: 'Whether the filter runs on new mail.', optional: true },
      conditions: { type: 'array', items: 'string', maxItems: 5, description: 'Condition tokens such as from:boss@example.com.', optional: true },
      actions: { type: 'array', items: 'string', maxItems: 5, description: 'Action tokens such as move:Projects, tag:work/urgent, star, read, trash.', optional: true },
      address: { type: 'string', description: 'Sender address for block or unblock.', maxLength: 320, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => manageEmailRuleAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        action: String(args.action) as Parameters<typeof manageEmailRuleAgent>[2]['action'],
        filterId: typeof args.filterId === 'string' ? args.filterId : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        conditions: Array.isArray(args.conditions) ? args.conditions as string[] : undefined,
        actions: Array.isArray(args.actions) ? args.actions as string[] : undefined,
        address: typeof args.address === 'string' ? args.address : undefined,
      }))
    },
  }),
  tool({
    name: 'email_template',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create or update a reusable subject and Markdown body that the reader can insert in the composer.',
    fields: {
      action: { type: 'string', enum: ['create', 'update'], description: 'Create a template or update one.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      templateId: { type: 'string', description: 'The template id for update.', maxLength: 64, optional: true },
      name: { type: 'string', description: 'Template name.', maxLength: 80, optional: true },
      subject: { type: 'string', description: 'Subject line.', maxLength: 200, optional: true },
      body: { type: 'string', description: 'Markdown body.', maxLength: 20000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => manageEmailTemplateAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        action: String(args.action) as 'create' | 'update',
        templateId: typeof args.templateId === 'string' ? args.templateId : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        subject: typeof args.subject === 'string' ? args.subject : undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
      }))
    },
  }),
  tool({
    name: 'email_signature',
    permission: 'write',
    maxCallsPerTurn: 4,
    description: 'Create or update a signature, make it the default, or toggle it on/off. At most eight signatures are kept.',
    fields: {
      action: { type: 'string', enum: ['create', 'update', 'default', 'toggle'], description: 'What to do with the signature.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      signatureId: { type: 'string', description: 'The signature id for update, default, or toggle.', maxLength: 64, optional: true },
      name: { type: 'string', description: 'Signature name.', maxLength: 60, optional: true },
      text: { type: 'string', description: 'Signature text, appended after "--".', maxLength: 4000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => manageEmailSignatureAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        action: String(args.action) as Parameters<typeof manageEmailSignatureAgent>[2]['action'],
        signatureId: typeof args.signatureId === 'string' ? args.signatureId : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
      }))
    },
  }),
  tool({
    name: 'email_search_recipe',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Create or update a saved search that the reader can reopen from the sidebar. The query supports the same filters as the search box.',
    fields: {
      action: { type: 'string', enum: ['create', 'update'], description: 'Create a saved search or update one.' },
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      searchId: { type: 'string', description: 'The saved search id for update.', maxLength: 64, optional: true },
      name: { type: 'string', description: 'Saved search name.', maxLength: 80, optional: true },
      query: { type: 'string', description: 'The search query.', maxLength: 500, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => manageEmailSearchAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        action: String(args.action) as 'create' | 'update',
        searchId: typeof args.searchId === 'string' ? args.searchId : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        query: typeof args.query === 'string' ? args.query : undefined,
      }))
    },
  }),
  tool({
    name: 'email_contact',
    permission: 'write',
    maxCallsPerTurn: 5,
    description: 'Manage contacts and recipient groups: create/update a contact, create/update a group, or add/remove a contact from a group.',
    fields: {
      action: { type: 'string', enum: ['create', 'update', 'group_create', 'group_update', 'group_add', 'group_remove'], description: 'Which contact or group change to make.' },
      contactId: { type: 'string', description: 'The contact id for update or group membership changes.', maxLength: 64, optional: true },
      groupId: { type: 'string', description: 'The group id for group_update, group_add, or group_remove.', maxLength: 64, optional: true },
      email: { type: 'string', description: 'Contact email address for create or update.', maxLength: 320, optional: true },
      name: { type: 'string', description: 'Contact name or group name.', maxLength: 120, optional: true },
      company: { type: 'string', description: 'Contact company.', maxLength: 120, optional: true },
      notes: { type: 'string', description: 'Contact notes.', maxLength: 2000, optional: true },
      starred: { type: 'boolean', description: 'Whether the contact or group is starred.', optional: true },
      pinned: { type: 'boolean', description: 'Whether the contact or group is pinned to the top.', optional: true },
      avatar: { type: 'string', description: 'Avatar preference: emoji:🦊, lucide:star, an uploaded data URL, or empty for the generated avatar.', maxLength: 262144, optional: true },
      description: { type: 'string', description: 'Group description.', maxLength: 500, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      return emailToolCall(() => manageEmailContactAgent(ctx.env, ctx.store.userId, {
        action: String(args.action) as Parameters<typeof manageEmailContactAgent>[2]['action'],
        contactId: typeof args.contactId === 'string' ? args.contactId : undefined,
        groupId: typeof args.groupId === 'string' ? args.groupId : undefined,
        email: typeof args.email === 'string' ? args.email : undefined,
        name: typeof args.name === 'string' ? args.name : undefined,
        company: typeof args.company === 'string' ? args.company : undefined,
        notes: typeof args.notes === 'string' ? args.notes : undefined,
        starred: typeof args.starred === 'boolean' ? args.starred : undefined,
        pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined,
        avatar: typeof args.avatar === 'string' ? args.avatar : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
      }))
    },
  }),
  tool({
    name: 'email_update_settings',
    permission: 'write',
    maxCallsPerTurn: 3,
    description: 'Change mailbox settings: display name, automatic drafts, focused inbox, the assistant instructions for this mailbox, or the vacation auto-reply window and message.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      displayName: { type: 'string', description: 'Sender name recipients see.', maxLength: 120, optional: true },
      autoDraft: { type: 'boolean', description: 'Whether new mail gets an automatic draft.', optional: true },
      focusedInbox: { type: 'boolean', description: 'Whether new inbox mail is split into Focused and Other.', optional: true },
      agentSystemPrompt: { type: 'string', description: 'Instructions for the mail assistant; an empty string restores the default.', maxLength: 8000, optional: true },
      vacationEnabled: { type: 'boolean', description: 'Turn the vacation auto-reply on or off.', optional: true },
      vacationStart: { type: 'string', description: 'ISO start of the vacation window, or empty for no bound.', maxLength: 40, optional: true, nullable: true },
      vacationEnd: { type: 'string', description: 'ISO end of the vacation window, or empty for no bound.', maxLength: 40, optional: true, nullable: true },
      vacationSubject: { type: 'string', description: 'Vacation reply subject; empty uses Auto: plus the original subject.', maxLength: 200, optional: true },
      vacationBody: { type: 'string', description: 'Vacation reply text.', maxLength: 4000, optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async run(args, ctx) {
      const vacationTouched = args.vacationEnabled !== undefined
        || args.vacationStart !== undefined
        || args.vacationEnd !== undefined
        || args.vacationSubject !== undefined
        || args.vacationBody !== undefined
      if (vacationTouched && typeof args.vacationEnabled !== 'boolean') {
        throw new ToolError('vacationEnabled is required when changing the vacation reply.')
      }
      return emailToolCall(() => updateEmailSettingsAgent(ctx.env, ctx.store.userId, {
        accountId: typeof args.accountId === 'string' ? args.accountId : undefined,
        displayName: typeof args.displayName === 'string' ? args.displayName : undefined,
        autoDraft: typeof args.autoDraft === 'boolean' ? args.autoDraft : undefined,
        focusedInbox: typeof args.focusedInbox === 'boolean' ? args.focusedInbox : undefined,
        agentSystemPrompt: typeof args.agentSystemPrompt === 'string' ? args.agentSystemPrompt : undefined,
        ...(vacationTouched ? {
          vacation: {
            enabled: args.vacationEnabled as boolean,
            start: Object.prototype.hasOwnProperty.call(args, 'vacationStart') ? args.vacationStart as string | null : undefined,
            end: Object.prototype.hasOwnProperty.call(args, 'vacationEnd') ? args.vacationEnd as string | null : undefined,
            subject: typeof args.vacationSubject === 'string' ? args.vacationSubject : undefined,
            body: typeof args.vacationBody === 'string' ? args.vacationBody : undefined,
          },
        } : {}),
      }))
    },
  }),
  {
    name: 'email_delete',
    permission: 'destructive',
    keepArgs: true,
    maxCallsPerTurn: 2,
    description: 'Propose a deletion. message moves to Trash unless the reader explicitly asked to delete it forever, in which case set permanent; trash empties every trashed message; folder can also delete its messages. tags, rules, templates, signatures, saved searches, contacts, and groups are removed for good. The reader must approve it.',
    fields: {
      accountId: { type: 'string', description: 'Mailbox id from email_list_accounts. Optional when only one mailbox exists.', maxLength: 64, optional: true },
      kind: { type: 'string', enum: ['message', 'folder', 'tag', 'rule', 'template', 'signature', 'search', 'contact', 'group', 'trash'], description: 'What is being deleted.' },
      id: { type: 'string', description: 'The id of the item to delete; omit only for trash.', maxLength: 64, optional: true },
      permanent: { type: 'boolean', description: 'Only set true when the reader explicitly asked to delete a message forever; omitting it moves the message to Trash.', optional: true },
      deleteEmails: { type: 'boolean', description: 'When deleting a folder, also delete the messages inside it.', optional: true },
    },
    requires: (env) => Boolean(env.EMAIL_MAILBOX),
    async prepare(args, ctx) {
      return emailToolCall(() => prepareDeleteEmailAgent(ctx.env, ctx.store.userId, args as unknown as Parameters<typeof prepareDeleteEmailAgent>[2]))
    },
    async commit(_targetId, ctx, args) {
      return emailToolCall(() => deleteEmailAgent(ctx.env, ctx.store.userId, args as unknown as Parameters<typeof deleteEmailAgent>[2]))
    },
  },
]

/**
 * How many tracks one play call may name. The catalog keeps 100 as the wire limit; a turn that plays
 * more than this is a generated playlist pretending to be a single instruction.
 */
const MUSIC_PLAY_MAX_TRACK_REFS = 50

/** The library tools' own ceiling. A model naming more tracks is building a list, not asking for one. */
const MUSIC_TOOL_TRACK_REFS_MAX = 100
const MUSIC_TOOL_QUERY_MAX = 200
const MUSIC_TOOL_SEARCH_MAX = 50
const MUSIC_TOOL_PLAYLIST_NAME_MAX = 200
const MUSIC_TOOL_PLAYLIST_DESCRIPTION_MAX = 2_000

type MusicToolScope = 'song' | 'album' | 'playlist' | 'artist'

interface ResolvedMusicTrackRef {
  ref: string
  track: MusicTrack
}

function musicTrackRefOf(track: MusicTrack): string {
  return track.provider === 'netease' ? `netease:${track.providerId}` : track.id
}

function stringRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))]
}

/**
 * Turn the refs a model was shown back into rows this account owns.
 *
 * An internal id is looked up directly; a `netease:<id>` ref names a provider identity that only
 * becomes a library row once the track has been played, saved or favourited. Requiring that row is
 * deliberate: a write tool may name tracks the reader has already seen, not invent library entries
 * from an id the model guessed.
 */
async function resolveMusicTrackRefs(
  ctx: ToolContext,
  refs: readonly string[],
): Promise<ResolvedMusicTrackRef[]> {
  const store = new MusicStore(ctx.env.DB, ctx.store.userId)
  const resolved: ResolvedMusicTrackRef[] = []
  for (const ref of refs) {
    const providerId = ref.startsWith('netease:') ? ref.slice('netease:'.length).trim() : ''
    const track = providerId
      ? await store.findTrack('netease', providerId)
      : await store.getTrack(ref)
    if (!track) {
      throw new ToolError(providerId
        ? `The music app has not saved "${ref}" yet. Play or favourite this track in the music app once, then try again.`
        : `No track in this library matches "${ref}". Use a trackRef a music tool returned.`)
    }
    if (!resolved.some((entry) => entry.track.id === track.id)) resolved.push({ ref, track })
  }
  return resolved
}

async function musicSearchProvider(ctx: ToolContext) {
  const store = new MusicStore(ctx.env.DB, ctx.store.userId)
  const stored = await store.getAccountCookie('netease')
  let cookie: string | undefined
  if (stored) {
    try {
      cookie = (await decryptMusicCookie(ctx.env, ctx.store.userId, stored)) ?? undefined
    } catch (error) {
      // Anonymous search still reaches the public catalogue; a vault problem must not turn into
      // "search is broken" for a reader whose stored session simply cannot be opened here.
      console.warn('[inkstone] Music account cookie could not be decrypted; searching anonymously:', error)
    }
  }
  return createNeteaseProvider({ cookie, upstreamBaseUrl: ctx.env.MUSIC_UPSTREAM_API })
}

const MUSIC_TOOLS: ToolDefinition[] = [
  tool({
    name: 'music_play',
    permission: 'write',
    description: 'Start playing the named tracks in the reader\'s music app. Pass trackRefs exactly as a music tool returned them (for example "netease:123" or an internal track id); this tool does not search. The browser that asked performs the playback, so answer that playback has started and never claim a track finished.',
    fields: {
      trackRefs: {
        type: 'array',
        items: 'string',
        maxItems: MUSIC_PLAY_MAX_TRACK_REFS,
        maxLength: MAX_MUSIC_EFFECT_TRACK_REF_CHARS,
        description: 'The tracks to play, in order. At least one.',
      },
    },
    async run(args) {
      const trackRefs = Array.isArray(args.trackRefs)
        ? args.trackRefs.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : []
      if (!trackRefs.length) throw new ToolError('Name at least one track to play.')
      // The effect is the only channel back to the player; the result beside it is what the model reads.
      return { effect: { kind: 'music.play', trackRefs, mode: 'replace' }, result: { ok: true } }
    },
  }),
  tool({
    name: 'music_search',
    permission: 'read',
    description: 'Search the Netease catalogue. Returns compact results with a trackRef for each match; nothing is saved to the library. Use music_favorite or music_play with a returned ref afterwards.',
    fields: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: MUSIC_TOOL_QUERY_MAX,
        description: 'What to search for: a title, artist, album or playlist name.',
      },
      scope: {
        type: 'string',
        enum: ['song', 'album', 'playlist', 'artist'] as const,
        optional: true,
        description: 'What kind of result to return. Defaults to song.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MUSIC_TOOL_SEARCH_MAX,
        optional: true,
        description: `How many results to return, at most ${MUSIC_TOOL_SEARCH_MAX}. Defaults to 10.`,
      },
    },
    async run(args, ctx) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) throw new ToolError('Say what to search for.')
      const scope = (typeof args.scope === 'string' ? args.scope : 'song') as MusicToolScope
      const limit = typeof args.limit === 'number' ? Math.min(MUSIC_TOOL_SEARCH_MAX, Math.max(1, Math.trunc(args.limit))) : 10
      const provider = await musicSearchProvider(ctx)
      let result: Awaited<ReturnType<typeof provider.search>>
      try {
        // Artist search is not a catalogue endpoint: the song search is the one that names artists,
        // so its results are folded into distinct names instead of pretending to be a song list.
        result = await provider.search({
          type: scope === 'artist' ? 'song' : scope,
          keywords: query,
          limit: scope === 'artist' ? Math.min(MUSIC_TOOL_SEARCH_MAX, limit * 3) : limit,
          offset: 0,
        })
      } catch (error) {
        console.warn('[inkstone] music_search failed:', error instanceof Error ? error.name : error)
        throw new ToolError('The music catalogue could not be searched just now. Try again shortly.')
      }
      if (scope === 'song') {
        return {
          scope,
          total: result.total,
          items: result.tracks.slice(0, limit).map((track) => ({
            trackRef: musicTrackRefOf(track),
            title: track.title,
            artists: track.artists.map((artist) => artist.name),
            album: track.album,
            durationMs: track.durationMs,
          })),
        }
      }
      if (scope === 'album') {
        return {
          scope,
          total: result.total,
          items: result.albums.slice(0, limit).map((album) => ({
            albumRef: `netease:${album.id}`,
            title: album.name,
            artists: album.artists,
            trackCount: album.trackCount,
          })),
        }
      }
      if (scope === 'playlist') {
        return {
          scope,
          total: result.total,
          items: result.playlists.slice(0, limit).map((playlist) => ({
            playlistRef: `netease:${playlist.providerId}`,
            title: playlist.name,
            creator: playlist.creator ?? '',
            trackCount: playlist.trackCount,
          })),
        }
      }
      const artists = new Map<string, { artistRef: string, name: string }>()
      for (const track of result.tracks) {
        for (const artist of track.artists) {
          if (!artist.name || artists.has(artist.name)) continue
          artists.set(artist.name, { artistRef: artist.id ? `netease:${artist.id}` : '', name: artist.name })
          if (artists.size >= limit) break
        }
        if (artists.size >= limit) break
      }
      return { scope, total: artists.size, items: [...artists.values()] }
    },
  }),
  tool({
    name: 'music_favorite',
    permission: 'write',
    description: 'Add tracks to the reader\'s favourites or remove them. Pass trackRefs exactly as a music tool returned them; a ref for a track the music app has not saved yet is refused with the step that fixes it. Calling it twice is the same as calling it once.',
    fields: {
      trackRefs: {
        type: 'array',
        items: 'string',
        maxItems: MUSIC_TOOL_TRACK_REFS_MAX,
        maxLength: MAX_MUSIC_EFFECT_TRACK_REF_CHARS,
        description: 'The tracks to favourite or unfavourite, in order.',
      },
      favorite: {
        type: 'boolean',
        optional: true,
        description: 'True to favourite (the default), false to remove from favourites.',
      },
    },
    async run(args, ctx) {
      const refs = stringRefs(args.trackRefs)
      if (!refs.length) throw new ToolError('Name at least one track.')
      if (refs.length > MUSIC_TOOL_TRACK_REFS_MAX) throw new ToolError(`At most ${MUSIC_TOOL_TRACK_REFS_MAX} tracks may be changed at once.`)
      const favorite = args.favorite !== false
      const resolved = await resolveMusicTrackRefs(ctx, refs)
      const store = new MusicStore(ctx.env.DB, ctx.store.userId)
      const tracks: Array<{ trackRef: string, title: string, favorite: boolean }> = []
      for (const { ref, track } of resolved) {
        if (favorite) {
          if (!(await store.addFavorite(track.id))) throw new ToolError(`The track "${track.title}" could not be favourited.`)
        } else {
          await store.removeFavorite(track.id)
        }
        tracks.push({ trackRef: ref, title: track.title, favorite })
      }
      return { ok: true, favorite, tracks }
    },
  }),
  tool({
    name: 'music_pin',
    permission: 'write',
    description: 'Pin a favourite track or a playlist to the top of the library, or unpin it. Pinning a track that is not a favourite favourites it first and says so. Calling it twice keeps the first pin position.',
    fields: {
      kind: {
        type: 'string',
        enum: ['track', 'playlist'] as const,
        description: 'Whether the id names a track or a playlist.',
      },
      id: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MUSIC_EFFECT_TRACK_REF_CHARS,
        description: 'A trackRef as a music tool returned it, or a playlist id.',
      },
      pinned: {
        type: 'boolean',
        optional: true,
        description: 'True to pin (the default), false to unpin.',
      },
    },
    async run(args, ctx) {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) throw new ToolError('Name the track or playlist to pin.')
      const pinned = args.pinned !== false
      const store = new MusicStore(ctx.env.DB, ctx.store.userId)
      if (args.kind === 'playlist') {
        const playlist = await store.setPlaylistPinned(id, pinned)
        if (!playlist) throw new ToolError('That playlist is not in this library.')
        return { ok: true, kind: 'playlist', id: playlist.id, name: playlist.name, pinned }
      }
      const [resolved] = await resolveMusicTrackRefs(ctx, [id])
      if (!resolved) throw new ToolError('That track is not in this library.')
      const track = resolved.track
      const wasFavorite = await store.isFavorite(track.id)
      if (pinned && !wasFavorite && !(await store.addFavorite(track.id))) {
        throw new ToolError(`The track "${track.title}" could not be favourited.`)
      }
      if (pinned) await store.setFavoritePinned(track.id, true)
      else if (wasFavorite) await store.setFavoritePinned(track.id, false)
      return {
        ok: true,
        kind: 'track',
        trackRef: resolved.ref,
        title: track.title,
        pinned,
        favorite: pinned ? true : wasFavorite,
        addedToFavorites: pinned && !wasFavorite,
      }
    },
  }),
  tool({
    name: 'music_playlist_create',
    permission: 'write',
    description: 'Create a playlist in the reader\'s library from tracks the music app has already saved. At most 100 tracks; duplicates and unknown refs are dropped. This does not start playback.',
    fields: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: MUSIC_TOOL_PLAYLIST_NAME_MAX,
        description: 'The playlist name.',
      },
      description: {
        type: 'string',
        maxLength: MUSIC_TOOL_PLAYLIST_DESCRIPTION_MAX,
        optional: true,
        description: 'An optional description.',
      },
      trackRefs: {
        type: 'array',
        items: 'string',
        maxItems: MUSIC_TOOL_TRACK_REFS_MAX,
        maxLength: MAX_MUSIC_EFFECT_TRACK_REF_CHARS,
        optional: true,
        description: 'The tracks to add, in order. A trackRef from a music tool or an internal library id.',
      },
    },
    async run(args, ctx) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const refs = stringRefs(args.trackRefs)
      if (refs.length > MUSIC_TOOL_TRACK_REFS_MAX) throw new ToolError(`At most ${MUSIC_TOOL_TRACK_REFS_MAX} tracks may be added at once.`)
      const resolved = refs.length ? await resolveMusicTrackRefs(ctx, refs) : []
      const store = new MusicStore(ctx.env.DB, ctx.store.userId)
      const playlist = await store.createPlaylist({ name, description })
      const added = resolved.length ? await store.addPlaylistItems(playlist.id, resolved.map((entry) => entry.track.id)) : 0
      if (added === null) throw new ToolError('The playlist could not be created right now.')
      return {
        ok: true,
        playlist: { id: playlist.id, name: playlist.name, description: playlist.description },
        trackCount: added ?? 0,
        durationMs: resolved.reduce((sum, entry) => sum + entry.track.durationMs, 0),
      }
    },
  }),
]

export const ALL_TOOLS: ToolDefinition[] = [
  ...TASK_TOOLS,
  ...MEMORY_TOOLS,
  ...NOTE_TOOLS,
  ...ARTIFACT_TOOLS,
  ...EMAIL_TOOLS,
  ...AUTOMATION_TOOLS,
  ...PROJECT_TOOLS,
  ...SEARCH_TOOLS,
  ...IMAGE_TOOLS,
  ...CODE_TOOLS,
  ...WEB_TOOLS,
  ...SUBSCRIPTION_TOOLS,
  ...MUSIC_TOOLS,
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
    if (spec.type === 'array') {
      schema.items = { type: spec.items ?? 'string' }
      if (spec.maxItems !== undefined) schema.maxItems = spec.maxItems
    }
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
      if (value === null && spec.nullable) {
        out[name] = null
        continue
      }
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
      case 'array': {
        if (!Array.isArray(value)) throw new ToolError(`"${name}" must be a list.`)
        const items = value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => {
            const trimmed = entry.trim()
            return spec.maxLength !== undefined ? trimmed.slice(0, spec.maxLength) : trimmed
          })
          .filter(Boolean)
        out[name] = spec.maxItems !== undefined ? items.slice(0, spec.maxItems) : items
        continue
      }
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
      args: definition.permission === 'destructive' && !definition.external && !definition.keepArgs ? undefined : args,
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
