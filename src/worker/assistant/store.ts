/**
 * Every read and write the assistant makes against D1.
 *
 * Two rules hold throughout, and both come from the difference between this app and the single-user
 * project it was ported from:
 *  - every statement carries `user_id`, so one reader's conversations, memories and schedules can
 *    never surface in another's assistant;
 *  - anything read out of a JSON column is decoded rather than trusted, because a row may have been
 *    written by an older build, restored from a backup file, or edited by hand — stored text is input.
 */

import { ASSISTANT_MODEL_KINDS, ASSISTANT_MODEL_PURPOSES, MAX_ARTIFACT_VERSIONS, MAX_TURN_SCOPES, SAVED_MESSAGE_EXCERPT_CHARS, clipSuggestionList, clipToolPayload, parseCustomParams, isNoteSourceId, isSourceUrl } from '@shared/assistant'
import { activePricePeriod, parsePricePeriods } from '@shared/price-periods'
import { parseAssistantIcon } from '@shared/assistant-icons'
import type {
  AssistantArtifact,
  AssistantArtifactVersion,
  AssistantArtifactVersionSource,
  AssistantConversation,
  AssistantMemory,
  AssistantMemoryCategory,
  AssistantMemorySource,
  AssistantMemoryStatus,
  AssistantMessage,
  AssistantModel,
  AssistantPricePeriod,
  AssistantSource,
  AssistantTurnScope,
  AssistantSkill,
  MessageFeedback,
  AssistantModelKind,
  AssistantModelPurpose,
  AssistantCustomParam,
  AssistantNotification,
  AssistantProvider,
  AssistantProviderKey,
  AssistantSearchKey,
  AssistantReasoning,
  AssistantSettings,
  Automation,
  AutomationKind,
  AutomationRun,
  AutomationStatus,
  ChatFolderNode,
  ChatProjectNode,
  ConversationTag,
  UsageFilter,
  PendingAction,
  Project,
  TaskPriority,
  TaskStatus,
  ToolActivity,
  UsageCounters,
  ReasoningDialect,
  SavedMessage,
} from '@shared/assistant'
import { dialectsForProtocol } from '@shared/reasoning'
import {
  COMPLETED_PAGE_SIZE,
  MAX_STEPS_PER_TASK,
  MAX_STEP_TEXT_CHARS,
  MAX_TASKS_PER_QUERY,
  MAX_TAG_NAME_CHARS,
  MAX_LIST_NAME_CHARS,
  UPCOMING_DAYS,
  defaultColorFor,
  nextOccurrence,
  normalizeReminderTimes,
  normalizeTagNames,
  parseRepeatRule,
  taskColorOrNull,
  taskIconOrNull,
  type RepeatRule,
  type TaskCounts,
  type TaskList,
  type TaskSort,
  type TaskStep,
  type TaskTag,
  type TaskView,
  type TodoTask,
} from '@shared/todos/model'
import type { McpOAuthSecrets, McpOAuthStatus } from './mcp-oauth'
import { ASSISTANT_MCP_TOOL_MODES, ASSISTANT_MCP_TRANSPORTS, DEFAULT_MCP_TIMEOUT_SECONDS, EPHEMERAL_CONVERSATION_RETENTION_DAYS, MAX_MCP_DESCRIPTION_CHARS, MAX_MCP_TOOL_OVERRIDES, MAX_MCP_HEADER_VALUE_CHARS, MAX_MCP_LABEL_CHARS, MAX_MCP_TOOL_NAME_CHARS, MAX_MCP_TIMEOUT_SECONDS, MIN_MCP_TIMEOUT_SECONDS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, RUN_PARTIAL_MAX_CHARS, MAX_ANSWER_VERSIONS, MAX_CHAT_ATTACHMENTS, MAX_FEEDBACK_REASON_CHARS, clipReasoning, isMcpHeaderName, parseModelModalities, parseProviderEndpoints, reasoningDialectValue, reasoningValue, type AssistantAnswerVersion, type AssistantMcpServer, type AssistantMcpToolMode, type AssistantMcpTransport, type AssistantModelModality, type ChatAttachment } from '@shared/assistant'
import {
  ASSISTANT_MEMORY_CATEGORIES,
  ASSISTANT_PROTOCOLS,
  AUTOMATION_KINDS,
  DEFAULT_ASSISTANT_SETTINGS,
  EMPTY_USAGE,
  normalizeAssistantSettings,
  type AssistantProtocol,
  type MemoryReview,
  type PendingActionStatus,
} from '@shared/assistant'
import { parseScheduleSpec, zonedTimeToUtc, type ScheduleSpec } from '@shared/assistant-schedule'
import { localDate } from '@shared/assistant-time'
import { likePattern } from '@shared/markdown-utils'
import type { Env } from '../env'
import { tagScopePredicate } from '../db/rows'
import { ID_READ_BATCH, MAX_BATCH_STATEMENTS, chunkMarks, idChunks } from '../db/writes'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { parseStoredJson } from '../lib/json'
import { decryptAssistantKey, decryptMcpOAuth, encryptAssistantKey, encryptMcpOAuth } from '../lib/crypto'
import { curatedModelLimits } from './vendor-model-limits'

/** How long a reader has to approve a destructive proposal. */
export const PENDING_ACTION_TTL_MS = 30 * 60 * 1000

/**
 * How long a chat turn may hold its conversation's lease before it counts as abandoned.
 *
 * Judged against one step rather than one turn: a reasoning model can spend minutes writing a long answer
 * before the lease is next touched, and a lease that ages out while a step is still streaming is a turn
 * that has to be allowed to renew its way back in (`touchRun`). This number is the headroom over that,
 * not the mechanism that keeps a live turn alive.
 */
export const RUN_LEASE_MS = 5 * 60 * 1000

/**
 * What one conversation's claim currently says about itself, read without changing it.
 *
 * `claimed` is whether a row exists at all, which is a third state the caller has to be able to tell apart
 * from `running`: no row is a conversation nobody has run since the last answer was filed, while a row with
 * `running` false is a turn that stopped renewing — the one shape that can carry a fragment worth reading
 * back. `token` is the `started_at` of that claim, and the only thing that can take it away again safely.
 */
export interface RunLease {
  claimed: boolean
  running: boolean
  token: number | null
  /** The words the turn had written when it last renewed, cut to `RUN_PARTIAL_MAX_CHARS`. */
  text: string | null
  /** Whether that fragment filled the ceiling, so whatever is here is not the whole of what was written. */
  truncated: boolean
}

/**
 * Cut a turn's unfinished answer to what a lease row may carry.
 *
 * The ceiling is what stops the lock table becoming a place to park model output: see
 * `RUN_PARTIAL_MAX_CHARS`. Cutting is done here rather than at the caller because the column is the trust
 * boundary — a caller that forgot, or that is handed text from somewhere else, cannot make the row bigger
 * than this. An empty answer is stored as NULL, the same value a claim predating the column carries, so
 * "nothing written yet" has exactly one representation.
 */
function clipRunPartial(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const clipped = value.slice(0, RUN_PARTIAL_MAX_CHARS)
  return clipped.length > 0 ? clipped : null
}

/** How long an automation may be claimed by a tick that never finished before another may take it. */
export const AUTOMATION_CLAIM_MS = 10 * 60 * 1000

/**
 * How many refused sends one device's subscription gets before it is dropped.
 *
 * A push service that answers 4xx/5xx without saying the endpoint is gone is usually describing a device
 * that has been wiped, uninstalled or offline past its retention — none of which a retry fixes. Five is
 * enough to ride out a service hiccup and small enough that a dead row does not linger holding a credential.
 */
export const PUSH_SUBSCRIPTION_FAILURE_LIMIT = 5

/** How much of a push service's refusal is kept, so an HTML error page cannot become the row. */
const PUSH_SUBSCRIPTION_ERROR_CHARS = 500

/**
 * One browser device a reader has asked to be notified on, as the store holds it.
 *
 * `endpoint`, `p256dh` and `auth` together are the ability to put a notification on that device. They stay
 * server-side: this type is what `push.ts` sends with and what a route must redact before returning it, and
 * the table is deliberately outside every export path (see the comment in `assistant/schema.ts`).
 */
export interface AssistantPushSubscription {
  id: string
  /**
   * The account the device belongs to.
   *
   * Carried because a send is a request the sender makes on its own, with no caller-side store to ask which
   * account a row belongs to: the failure count and the delete have to go back to the row's own account, and
   * guessing from the endpoint would be a cross-account write. It is an id, not a secret, so a route may echo it.
   */
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt: number
  failures: number
  lastError: string | null
}

/**
 * The counter a caller names, as the column it is stored in.
 *
 * `UsageCounters` is camelCase because it crosses the API, `chat_usage_daily` is snake_case
 * because it is a table, and the two are only safe to join through a list like this one.
 */
export const USAGE_COLUMNS: Readonly<Record<keyof UsageCounters, string>> = {
  requests: 'requests',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  toolCalls: 'tool_calls',
  scheduledRuns: 'scheduled_runs',
  embeddings: 'embeddings',
  errors: 'errors',
}

const MESSAGE_STATUSES = ['complete', 'error', 'cancelled'] as const
const MEMORY_SOURCES = ['manual', 'assistant', 'import'] as const
const MEMORY_STATUS_VALUES = ['active', 'historical', 'uncertain'] as const
const ACTION_STATUSES = ['pending', 'approved', 'cancelled', 'expired', 'failed'] as const
const AUTOMATION_STATUS_VALUES = ['scheduled', 'running', 'paused', 'completed', 'failed'] as const
const RUN_STATUSES = ['running', 'success', 'error', 'skipped'] as const
const TASK_STATUS_VALUES = ['todo', 'in_progress', 'done'] as const
const TASK_PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent'] as const

const MEMORY_COLUMNS
  = `id, content, category, source, status, superseded_by, valid_from, valid_until, project_id, note_id, created_at, updated_at`

/**
 * Which memories a turn may see: the account's own, plus the project it is answering in.
 *
 * A fact filed under one project is not automatically true in the next, so a turn recalls the account's
 * own memories and its project's, and never a third project's. `projectId: null` is a turn that is not
 * inside a project — it sees the account's memories and nothing else, which is narrower than "no filter"
 * and is why this is a scope rather than an optional argument.
 */
export interface MemoryScope {
  projectId: string | null
}

/**
 * The scope as a predicate. `undefined` means no filter at all, and is only ever the management screen's
 * own read — a turn always has a scope, even when that scope is the account's memories alone.
 *
 * `column` is qualified where the query joins, because an unqualified `project_id` across two tables is a
 * name the database has to guess at.
 */
function applyMemoryScope(q: Query, scope: MemoryScope | undefined, column = 'project_id'): void {
  if (!scope) return
  if (scope.projectId) q.raw(`(${column} IS NULL OR ${column} = ${q.add(scope.projectId)})`)
  else q.raw(`${column} IS NULL`)
}

/**
 * The provider columns a listing may read.
 *
 * `length(key_ciphertext) > 0` answers "is a key stored" without the ciphertext ever leaving the row,
 * so no provider listing can carry a key out even if a route is added carelessly later.
 */
const PROVIDER_COLUMNS = `id, label, protocol, base_url, endpoints, reasoning_dialect, key_hint, length(key_ciphertext) > 0 AS has_key, created_at, updated_at`

/** A provider key row, ciphertext included: read only by the rotation, never by a listing. */
const PROVIDER_KEY_COLUMNS = `id, provider_id, label, key_ciphertext, key_hint, enabled, last_used_at, error_count, last_error, created_at, updated_at`

/**
 * A search engine's key, ciphertext included.
 *
 * The listing version asks for `length(key_ciphertext) > 0` instead of the ciphertext, the same way a
 * provider listing does, so a route that only wants to say whether a key exists cannot read one out.
 */
const SEARCH_KEY_COLUMNS = `engine, key_ciphertext, key_hint, created_at, updated_at`

function bool(value: unknown): boolean {
  return value === 1 || value === true
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/**
 * A contains-pattern for LIKE, with the wildcards in the reader's own text escaped.
 *
 * The app's shared `likePattern` is a *prefix* pattern — right for a tag tree, wrong here: a memory
 * search for "live" would only find statements that begin with it, which silently disables the whole
 * conflict check for anything but the first word.
 *
 * The literal is truncated before escaping because SQLite compiles a LIKE pattern into a program and
 * refuses one longer than 50 000 characters with `LIKE or GLOB pattern too complex`. That is reachable
 * from the composer: a chat body may be 64 KB, and a pasted log line or base64 blob arrives as one
 * unbroken term, so an unguarded pattern used to fail the whole turn. 16 000 keeps even the worst case
 * — a term made entirely of characters that escape to two — under the ceiling.
 */
const LIKE_TERM_CEILING = 16_000

function containsPattern(term: string): string {
  const literal = term.slice(0, LIKE_TERM_CEILING)
  return `%${literal.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/**
 * Where the previous page of a list stopped.
 *
 * Three fields because the list is ordered by all three: pinned rows first, then by recency, then by id
 * to break ties between turns written in the same millisecond. A cursor that carried only the timestamp
 * would either repeat or skip the rows that share it.
 */
export interface ConversationCursor {
  pinned: number
  updatedAt: number
  id: string
}

/** How many ids one delete statement may carry: the bind-variable ceiling, not SQLite's. */
const ATTACHMENT_DELETE_BATCH = ID_READ_BATCH

/**
 * How long a notification's pointer may be.
 *
 * The column holds `<app>:<id>`, which is a couple of dozen characters in every shape written today; the
 * ceiling is there because the writer is a Worker that may be handed a string it did not build, and a
 * pointer that has been allowed to become a paragraph is no longer a pointer. Clamped on the way in rather
 * than refused, so one badly-formed pointer cannot cost the reader the notice it was carried with.
 */
const NOTIFICATION_LINK_MAX_CHARS = 200

/** How much of a matched message the search row shows, on each side of the hit. */
const SEARCH_SNIPPET_RADIUS = 40

/**
 * A short excerpt around the first hit, so a search row can be judged without opening the thread.
 *
 * Whitespace is collapsed first: a match inside a code block or a list would otherwise arrive as a strip
 * of newlines, and the reader would see the snippet machinery instead of their own words.
 */
function searchSnippet(content: string, query: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  const needle = query.slice(0, LIKE_TERM_CEILING).trim().toLowerCase()
  if (!needle) return text.slice(0, SEARCH_SNIPPET_RADIUS * 2)
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return text.slice(0, SEARCH_SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(text.length, at + needle.length + SEARCH_SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * A JSON column that may not be there at all.
 *
 * The parse itself belongs to `parseStoredJson`; what this adds is the row that predates the column,
 * where the value is null or a stray number rather than text. Every consumer below treats a
 * non-object as "nothing stored", so both failures read the same way.
 */
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? parseStoredJson(value) : null
}

/**
 * Every statement this module runs must name its owner.
 *
 * Twenty-odd of these were written before the pattern held, and the ones that slipped were silent: an
 * unscoped `DELETE FROM chat_messages` wipes every account's history and no test that runs one
 * account would notice. Reading `user_id = ?1` out of the SQL text is a cheap always-on check at the
 * one place all statements pass through, so the next unscoped statement fails loudly at the call
 * rather than quietly corrupting a neighbour. The cron sweep in `dueAutomations` is the one deliberate
 * exception, and it goes straight to `db.prepare` for that reason.
 */
const SCOPED_STATEMENT = /\buser_id = \?\d+/

export function assertScoped(sql: string): void {
  if (/^\s*INSERT/i.test(sql)) return
  if (SCOPED_STATEMENT.test(sql)) return
  throw new Error(`assistant statement without a tenant filter: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`)
}

/**
 * Builds a WHERE list and its parameters together.
 *
 * The alternative — splicing `?N` numbers by hand — is how a tenant filter gets forgotten: the number
 * is right, the clause is in the wrong place, and every gate still passes. Here a value and its
 * placeholder are produced by one call, so a clause cannot exist without its bind.
 */
class Query {
  readonly binds: unknown[] = []
  private readonly clauses: string[] = []

  constructor(userId: string) {
    this.binds.push(userId)
    this.clauses.push(`user_id = ?1`)
  }

  /** Adds a clause that references no parameter. */
  raw(clause: string): this {
    this.clauses.push(clause)
    return this
  }

  /** Adds `column = ?n` and returns nothing; the placeholder is already inside the clause. */
  eq(column: string, value: unknown): this {
    this.binds.push(value)
    this.clauses.push(`${column} = ?${this.binds.length}`)
    return this
  }

  /**
   * Adds `column IN (?, ?, …)`. The placeholders come out of the same call that supplies the values,
   * which is the whole point: a hand-numbered list is where a tenant filter goes missing.
   */
  inList(column: string, values: readonly unknown[]): this {
    if (!values.length) {
      this.clauses.push('1 = 0')
      return this
    }
    this.clauses.push(`${column} IN (${values.map((value) => this.add(value)).join(', ')})`)
    return this
  }

  /** Adds a clause the caller writes around the placeholder `add` returns. */
  add(value: unknown): string {
    this.binds.push(value)
    return `?${this.binds.length}`
  }

  or(clauses: string[]): this {
    this.clauses.push(`(${clauses.join(' OR ')})`)
    return this
  }

  get where(): string {
    return this.clauses.join(' AND ')
  }
}

/**
 * The predicate every read of `todos_tasks` that means "the reader's tasks" has to carry.
 *
 * Deleting a task stamps `deleted_at` instead of removing the row, so a query that forgets this
 * clause brings the task back into a listing, a badge, a statistic, a calendar or the reminder sweep.
 * The rule is stated once here and imported by the reads that live outside this module (`todos/stats`,
 * `todos/feeds`, `assistant/tasks`), rather than spelled again at each call: a bare `FROM todos_tasks`
 * anywhere in this repo is the bug this constant exists to prevent, and a reviewer should read it as
 * one. The trash list and the retention sweep are the only reads that ask for the opposite and use
 * `TASK_TRASHED_PREDICATE` instead.
 */
export const TASK_LIVE_PREDICATE = 'deleted_at IS NULL'

/** The same rule for a statement that gives `todos_tasks` an alias. */
export function taskLive(alias = 'todos_tasks'): string {
  return `${alias}.deleted_at IS NULL`
}

/** The opposite read: the rows the trash page lists and the retention sweep removes. */
export const TASK_TRASHED_PREDICATE = 'deleted_at IS NOT NULL'

/**
 * How long a deleted task stays restorable.
 *
 * Thirty days is long enough to notice a mistake a week later and short enough that the trash does not
 * become a second task list. The sweep reads this one constant, and the surfaces that speak about the
 * window (the trash page, its copy) name the same number rather than their own.
 */
export const TODO_TRASH_RETENTION_DAYS = 30

/**
 * How many expired rows one cron fire purges.
 *
 * A backlog is worked off over several ticks: the sweep is a maintenance job, and a deployment with
 * years of trash must not spend the whole fire deleting it. Two hundred rows is four bounded batches
 * per account represented in the page, which keeps one invocation inside the platform's budget.
 */
export const TODO_TRASH_PURGE_LIMIT = 200

const DAY_MS = 24 * 60 * 60 * 1000

function decodeAction(value: unknown): PendingAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.tool !== 'string') return null
  return {
    id: raw.id,
    tool: raw.tool,
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : '',
    targetId: typeof raw.targetId === 'string' ? raw.targetId : '',
    targetLabel: typeof raw.targetLabel === 'string' ? raw.targetLabel.slice(0, 300) : '',
    status: pickEnum(raw.status, ACTION_STATUSES, 'pending'),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : null,
    createdAt: num(raw.createdAt) ?? 0,
    expiresAt: num(raw.expiresAt) ?? 0,
  }
}

/** A stored `tools` array may hold anything; an entry that is not a tool activity is dropped. */
/** A stored JSON string list, tolerant of the row that predates the column. */
export function decodeStringList(value: unknown): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * The pages a stored answer searched.
 *
 * Read the same forgiving way tools are: a row written by an older build, or a backup from one, simply
 * has no sources, and a malformed entry is dropped rather than failing the whole transcript read.
 */
export function decodeSources(value: unknown): AssistantSource[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  const out: AssistantSource[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const cited = typeof raw.cited === 'string' && raw.cited ? { cited: raw.cited.slice(0, 400) } : {}
    const title = typeof raw.title === 'string' && raw.title ? raw.title.slice(0, 300) : ''
    // A note is recognized by its id, and its url is rewritten rather than trusted: the stored path is
    // the app's own, and rebuilding it here is what makes an exported transcript open the right note
    // wherever it is read.
    if (raw.kind === 'note' && isNoteSourceId(raw.id)) {
      out.push({ url: `/n/${raw.id}`, title: title || raw.id, kind: 'note', id: raw.id, ...cited })
      continue
    }
    if (!isSourceUrl(raw.url)) continue
    out.push({
      url: raw.url.slice(0, 2000),
      title: title || raw.url.slice(0, 300),
      ...cited,
    })
  }
  return out.slice(0, 20)
}

/**
 * What a turn was allowed to read, as it was stored with the reader's own words.
 *
 * Forgiving in the same way as the rest of a transcript row: an older row has no scopes, and a name this
 * build cannot recognise is dropped rather than failing the thread. The name is capped because it is a
 * label in a chip, not a copy of the note.
 */
export function decodeScopes(value: unknown): AssistantTurnScope[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  const out: AssistantTurnScope[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (raw.kind !== 'tag' && raw.kind !== 'folder' && raw.kind !== 'note') continue
    if (typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string') continue
    out.push({ kind: raw.kind, id: raw.id.slice(0, 64), name: raw.name.slice(0, 200) })
  }
  return out.slice(0, MAX_TURN_SCOPES)
}

/**
 * The follow-up chips an answer volunteered, read back through the same clip the naming pass wrote them with.
 *
 * A row that predates the column, and a backup that names none, both come back `[]` and the transcript shows
 * no group at all — which is the honest reading, not an empty frame. The clip re-runs here because this column
 * is also what a restore hands back, and a file is trusted for nothing a live turn was held to.
 */
export function decodeSuggestions(value: unknown): string[] {
  return clipSuggestionList(parseJson(value))
}

export function decodeTools(value: unknown): ToolActivity[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  const out: ToolActivity[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    const approval = decodeAction(raw.approval)
    out.push({
      id: raw.id,
      name: raw.name,
      ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 300) } : {}),
      ...(typeof raw.args === 'string' ? { args: clipToolPayload(raw.args) } : {}),
      ...(typeof raw.result === 'string' ? { result: clipToolPayload(raw.result) } : {}),
      status: pickEnum(raw.status, ['running', 'success', 'error'] as const, 'success'),
      ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 300) } : {}),
      ...(approval ? { approval } : {}),
    })
  }
  return out
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  tools: string | null
  attachments: string | null
  status: string
  error: string | null
  source: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  model_label: string | null
  reasoning: string | null
  feedback: string | null
  sources: string | null
  scopes: string | null
  suggestions: string | null
  saved_at: number | null
  created_at: number
  version_count?: number | null
}

const MESSAGE_COLUMNS
  = `id, conversation_id, role, content, reasoning, tools, attachments, status, error, source, input_tokens, output_tokens, duration_ms, model_label, feedback, sources, scopes, suggestions, saved_at, created_at`
/** How many answers this turn has already displaced; only the transcript list pays for it. */
const MESSAGE_VERSION_COUNT
  = `(SELECT COUNT(*) FROM chat_answer_versions v WHERE v.user_id = chat_messages.user_id AND v.message_id = chat_messages.id) AS version_count`

/**
 * Two messages written in the same millisecond are common — a turn saves the reader's line and the
 * reply within one tick — and a ULID id says nothing about which came first. The rowid does, so
 * every read of a conversation orders by it rather than by `id`.
 */
const MESSAGE_ORDER = `created_at ASC, seq ASC`

/** One row of the kept answers, as {@link AssistantStore.listSavedMessages} reads it. */
interface SavedMessageRow {
  id: string
  conversation_id: string
  role: string
  created_at: number
  saved_at: number
  excerpt: string | null
}

/**
 * How much of a kept answer the read takes out of the row.
 *
 * Wider than the shelf shows, because the whitespace flattening below folds a paragraph onto one line and a
 * reply that opens with blank lines or a fence would otherwise arrive short of what the row has room for.
 * It is still a slice, not the column: the shelf is a pointer into a thread, and a page of twenty full
 * answers is the transcript paid for twice.
 */
const SAVED_MESSAGE_EXCERPT_READ_CHARS = SAVED_MESSAGE_EXCERPT_CHARS * 3

/** The read slice as the shelf shows it: whitespace folded, then bounded to the row's own length. */
function excerptOf(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, SAVED_MESSAGE_EXCERPT_CHARS)
}

/** The reader's verdict on one answer, read back from what the column stores. */
interface FeedbackVerdict {
  verdict: MessageFeedback
  reason: string
}

/**
 * The `feedback` column as it is stored: `''` for nothing, `up`/`down` for a bare verdict, or a small JSON
 * object carrying a downvote's reason. Written back as a plain `down` when there is no reason, so the value
 * stays what every row before this was — the JSON form only appears once a reader says what was wrong.
 *
 * The read is lenient by design: the same string is what a backup file can hand back, and an unparseable or
 * unexpected value resolves to "no verdict" rather than throwing — an answer's rating is never worth failing
 * a whole transcript read over.
 */
export function decodeFeedback(raw: unknown): FeedbackVerdict | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw === 'up') return { verdict: 'up', reason: '' }
  if (raw === 'down') return { verdict: 'down', reason: '' }
  if (raw[0] !== '{') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const verdict = (parsed as { v?: unknown }).v
  if (verdict !== 'up' && verdict !== 'down') return null
  // An upvote has no reason by contract, so one that somehow carries it reads back as a plain upvote.
  if (verdict === 'up') return { verdict: 'up', reason: '' }
  const reason = (parsed as { r?: unknown }).r
  return { verdict: 'down', reason: typeof reason === 'string' ? reason.slice(0, MAX_FEEDBACK_REASON_CHARS) : '' }
}

/** The value the `feedback` column stores for one verdict, with a downvote's reason folded in. */
export function encodeFeedback(verdict: MessageFeedback | null, reason?: string): string {
  if (!verdict) return ''
  if (verdict === 'up') return 'up'
  const text = (reason ?? '').slice(0, MAX_FEEDBACK_REASON_CHARS)
  return text ? JSON.stringify({ v: 'down', r: text }) : 'down'
}

function toMessage(r: MessageRow): AssistantMessage {
  const verdict = decodeFeedback(r.feedback)
  // A `[]`, a null and a row predating the column all mean "no suggestions", and all are dropped rather than
  // surfaced as an empty array: the footline renders the group only when it has something to put in it, and a
  // transcript where every answer carries `suggestions: []` would be a transcript that promises chips it does
  // not show. Read through the same clip the write used, so a backup that overfilled the row cannot overfill it here.
  const suggestions = decodeSuggestions(r.suggestions)
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content ?? '',
    reasoning: r.reasoning ?? '',
    tools: decodeTools(r.tools),
    attachments: decodeStringList(r.attachments),
    status: pickEnum(r.status, MESSAGE_STATUSES, 'complete'),
    error: r.error,
    source: r.source === 'import' ? 'import' : 'chat',
    createdAt: r.created_at,
    usage: { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 },
    durationMs: r.duration_ms ?? 0,
    modelLabel: r.model_label ?? '',
    ...(verdict ? { feedback: verdict.verdict } : {}),
    ...(verdict?.reason ? { feedbackReason: verdict.reason } : {}),
    ...(r.sources ? { sources: decodeSources(r.sources) } : {}),
    ...(r.scopes ? { scopes: decodeScopes(r.scopes) } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    versionCount: r.version_count ?? undefined,
    savedAt: r.saved_at ?? null,
  }
}

interface McpServerRow {
  id: string
  label: string
  url: string
  description?: string | null
  transport?: string | null
  timeout_seconds?: number | null
  has_key?: number | null
  oauth_meta?: string | null
  enabled: number | null
  tool_mode: string | null
  tool_modes?: string | null
  created_at: number
  updated_at: number
}

/**
 * The plain half of one server's authorization, decoded rather than trusted.
 *
 * The column is written by this app and read by this app, but a restore from a backup file and a boot onto
 * a database another branch spent are both in this program's future, so an unusable value means "no
 * authorization started here" rather than a broken settings screen.
 */
export function parseMcpOAuthMeta(value: string | null | undefined): McpOAuthStatus | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const text = (key: string, max: number) => (typeof record[key] === 'string' ? (record[key] as string).slice(0, max) : '')
  const issuer = text('issuer', 512)
  const authorizationEndpoint = text('authorizationEndpoint', 2048)
  const tokenEndpoint = text('tokenEndpoint', 2048)
  // Half a discovered document is worse than none: an authorize press would build a URL out of guesses.
  if (!issuer || !authorizationEndpoint || !tokenEndpoint) return null
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: text('registrationEndpoint', 2048),
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 16)
      : [],
    clientId: text('clientId', 512),
    dynamic: record.dynamic === true || record.dynamic === 1,
    authorized: record.authorized === true || record.authorized === 1,
    expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.max(0, Math.trunc(Number(record.expiresAt))) : 0,
  }
}

/** The three columns that make a stored authorization unusable, kept in one place so the two agree. */
const MCP_OAUTH_COLUMNS = 'oauth_ciphertext, oauth_meta'

/**
 * The stored secret half of an authorization, read back as the shape this app writes.
 *
 * A vault blob is somebody's bytes: it may have been written by an older build, or restored from a file that
 * predates a field. Anything missing reads as "nothing there" rather than as a half-token, because a call
 * made with half a bearer fails at the third party in a way the reader cannot diagnose from here.
 */
function normaliseMcpOAuthSecrets(value: unknown): McpOAuthSecrets {
  const record = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const text = (field: unknown, max: number) => (typeof field === 'string' ? field.slice(0, max) : '')
  const tokens = record.tokens
  const shape = tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens as Record<string, unknown> : null
  const access = text(shape?.access, 8192)
  // The registration address and its token are only ever useful together, so they are read back as a pair
  // or not at all — a lone half would draw a button whose press could not delete anything.
  const registration = record.registration && typeof record.registration === 'object' && !Array.isArray(record.registration)
    ? record.registration as Record<string, unknown>
    : null
  const clientUri = text(registration?.clientUri, 2048)
  const registrationToken = text(registration?.accessToken, 2048)
  return {
    clientId: text(record.clientId, 512),
    clientSecret: text(record.clientSecret, 2048),
    registration: clientUri && registrationToken ? { clientUri, accessToken: registrationToken } : null,
    tokens: shape && access ? {
      access,
      refresh: text(shape.refresh, 8192),
      expiresAt: Number.isFinite(Number(shape.expiresAt)) ? Math.max(0, Math.trunc(Number(shape.expiresAt))) : 0,
      tokenType: text(shape.tokenType, 32) || 'Bearer',
    } : null,
    pending: (() => {
      const pending = record.pending
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null
      const entry = pending as Record<string, unknown>
      const verifier = text(entry.verifier, 128)
      const state = text(entry.state, 256)
      if (!verifier || !state) return null
      return { verifier, state, startedAt: Number.isFinite(Number(entry.startedAt)) ? Number(entry.startedAt) : 0 }
    })(),
  }
}

/**
 * The stored headers, from the ciphertext's own plaintext.
 *
 * A row written before this was a map holds one bearer token, so a plaintext that is not a JSON object is
 * read as exactly that: one `Authorization` header. That keeps an already-working server working without a
 * second code path anywhere else.
 */
function clampTimeout(value: unknown): number {
  const numeric = num(value)
  if (numeric === null) return DEFAULT_MCP_TIMEOUT_SECONDS
  return Math.min(Math.max(Math.round(numeric), MIN_MCP_TIMEOUT_SECONDS), MAX_MCP_TIMEOUT_SECONDS)
}

export function parseMcpHeaderBlob(plaintext: string): Record<string, string> {
  const trimmed = plaintext.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && isMcpHeaderName(name)) out[name] = value.slice(0, MAX_MCP_HEADER_VALUE_CHARS)
      }
      return out
    }
  } catch {
    // Not a map: the token an older row holds.
  }
  return { Authorization: `Bearer ${trimmed}` }
}

/**
 * The stored off-list, as names.
 *
 * A row written by an older version has no column and a hand-edited row can hold anything, so this is the
 * one place the JSON is trusted: a value that is not a list of strings reads as "nothing is off", which is
 * what the server did before this existed.
 */
/**
 * One server's per-tool exceptions, decoded rather than trusted.
 *
 * A row written before this column existed holds nothing, and one written by another branch could hold
 * anything at all; both read as "the server's own answer stands for every tool" rather than failing the
 * list. Names are capped and trimmed the way the rest of the row is, because they are the server's own
 * spelling and a name this app invented would never match the tool it was meant to govern.
 */
function parseToolModes(value: string | null | undefined): Record<string, AssistantMcpToolMode> {
  if (!value) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const modes: Record<string, AssistantMcpToolMode> = {}
  for (const [name, mode] of Object.entries(parsed as Record<string, unknown>)) {
    const trimmed = name.trim().slice(0, MAX_MCP_TOOL_NAME_CHARS)
    if (!trimmed || !(ASSISTANT_MCP_TOOL_MODES as readonly string[]).includes(mode as string)) continue
    modes[trimmed] = mode as AssistantMcpToolMode
    if (Object.keys(modes).length >= MAX_MCP_TOOL_OVERRIDES) break
  }
  return modes
}

function toMcpServer(r: McpServerRow): AssistantMcpServer {
  const status = parseMcpOAuthMeta(r.oauth_meta)
  return {
    id: r.id,
    label: r.label,
    url: r.url,
    description: (r.description ?? '').slice(0, MAX_MCP_DESCRIPTION_CHARS),
    transport: pickEnum(r.transport, ASSISTANT_MCP_TRANSPORTS, 'streamableHttp'),
    timeoutSeconds: clampTimeout(r.timeout_seconds),
    enabled: bool(r.enabled),
    toolMode: pickEnum(r.tool_mode, ASSISTANT_MCP_TOOL_MODES, 'ask'),
    toolModes: parseToolModes(r.tool_modes),
    hasKey: bool(r.has_key),
    authorization: status
      ? {
          issuer: status.issuer,
          scopes: status.scopes,
          authorized: status.authorized,
          expiresAt: status.expiresAt,
          clientId: status.clientId,
          dynamic: status.dynamic,
        }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface AnswerVersionRow {
  id: string
  message_id: string
  conversation_id: string
  content: string
  reasoning: string | null
  tools: string | null
  model_label: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  created_at: number
}

const ANSWER_VERSION_COLUMNS
  = `id, message_id, conversation_id, content, reasoning, tools, model_label, input_tokens, output_tokens, duration_ms, created_at`

function toAnswerVersion(r: AnswerVersionRow): AssistantAnswerVersion {
  return {
    id: r.id,
    messageId: r.message_id,
    conversationId: r.conversation_id,
    content: r.content ?? '',
    reasoning: r.reasoning ?? '',
    tools: decodeTools(r.tools),
    modelLabel: r.model_label ?? '',
    usage: { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 },
    durationMs: r.duration_ms ?? 0,
    createdAt: r.created_at,
  }
}

export interface NewTask {
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  dueAt?: number | null
  /** When the task may be begun. Independent of `dueAt`; null clears it. */
  startAt?: number | null
  projectId?: string | null
  listId?: string | null
  /** The task's own icon — `lucide:<Name>` or a single emoji — or null to wear the list's. */
  icon?: string | null
  /** The task's own colour from the shared palette, or null to wear the list's. */
  color?: string | null
  starred?: boolean
  repeat?: RepeatRule | null
  /** The task's reminders as absolute instants. Replaces the pending list when given to `updateTask`. */
  reminders?: number[]
  /**
   * One reminder as an absolute instant.
   *
   * The assistant's tool and the MCP surface still speak a single instant, so the store accepts it and
   * writes a `todos_reminders` row; the old `todos_tasks.remind_at` column is never written. A caller
   * that names `reminders` wins over this field.
   */
  remindAt?: number | null
  noteId?: string | null
  conversationId?: string | null
  /** Tag names; an unknown one is created. Replaces the task's tags when given to `updateTask`. */
  tags?: string[]
  /** Step texts, created in order. Only read by `createTask`. */
  steps?: string[]
}

/**
 * A list as the organizer page reads it: the shared list shape plus where it sits.
 *
 * The shared model is what every surface reads; the archive stamp and the parent pointer are
 * organizer facts rather than properties of a list's tasks, so they travel beside it instead of
 * widening the model every consumer would have to learn. Both null mean "in use" and "top level".
 */
export interface TaskListEntry extends TaskList {
  archivedAt: number | null
  parentId: string | null
}

export interface TaskQuery {
  /** One status, the two words that stand for a set of them, or the set itself. */
  status?: TaskStatus | 'open' | 'all' | readonly TaskStatus[]
  view?: TaskView
  projectId?: string
  /** `null` asks for the inbox; leaving it out applies no list filter at all. */
  listId?: string | null
  tagId?: string
  priority?: TaskPriority
  starred?: boolean
  query?: string
  /** Only tasks due at or after this instant. An undated task is in no due range. */
  dueFrom?: number
  /** Only tasks due before this instant — the bound is the start of the day after the one asked for. */
  dueTo?: number
  /**
   * Completion-day bounds, as the account-zone `YYYY-MM-DD` the task was finished on.
   *
   * The route only accepts these on the finished view; the store applies them wherever they are set.
   * They compare as strings because the column already holds a calendar day in a sortable form: no
   * zone arithmetic at query time, and a row whose day was never filled is in no window.
   */
  completedFrom?: string
  completedTo?: string
  /** The order the caller wants. Left out, the view decides, which is how a listing has always read. */
  sort?: TaskSort
  limit?: number
  offset?: number
  /** End of the reader's local day, in UTC milliseconds. */
  dayEnd?: number
  /**
   * The account-zone day (`YYYY-MM-DD`) `view=today` is read against in its "picked for today" half.
   *
   * The route passes the same string it hands `taskCounts`, so the page and the badge answer one
   * question. Left out, the store resolves it from the account's own zone — the shape the MCP and
   * assistant callers use, which have a `dayEnd` but no reason to compute a day themselves.
   */
  today?: string
}

/** One day-and-model slice of the usage series, whichever dimension table answered it. */
type UsageSeriesRow = {
  day: string
  modelLabel: string
  /** The model this slice was billed to, empty when the row was filed before the id was kept. */
  modelId: string
  providerId: string
  providerLabel: string
  keyId: string
  keyLabel: string
} & UsageCounters

const TASK_PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`

/**
 * The reader's own order, ahead of whatever order the view would otherwise use.
 *
 * A row that carries a place is read first, by that place; a row nobody has moved carries null and
 * follows in the view's existing order. That is the whole reading of "position ?? sort key": the
 * stored place wins where it exists, and its absence costs nothing. The first move materialises the
 * target list's current order, so the boundary between the two groups never splits a list in half.
 */
const TASK_MANUAL_ORDER = `CASE WHEN position IS NULL THEN 1 ELSE 0 END, position ASC`

/** The room between two written places: an append is a whole step past the end, a drop is the midpoint. */
const TASK_POSITION_STEP = 1000

/**
 * The order each sort key names, with a tiebreaker written into all of them.
 *
 * A page is read by `LIMIT`/`OFFSET`, so rows that share a value have to come out in the same order
 * twice running: without the `id` tail, the row a second page starts on is whichever one the engine
 * happened to reach first, and the reader either loses it or reads it twice.
 */
const TASK_SORT_ORDERS: Record<TaskSort, string> = {
  due: `CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, ${TASK_PRIORITY_ORDER}, created_at ASC, id ASC`,
  priority: `${TASK_PRIORITY_ORDER}, created_at ASC, id ASC`,
  created: `created_at DESC, id DESC`,
  completed: `completed_at DESC, created_at DESC, id DESC`,
}

/**
 * The order a listing answers in.
 *
 * With no key asked for, the view decides, which is the order a completed list has always had and the
 * one a plan or a board is read in — dated rows first, soonest first, then anything undated. A stored
 * manual place leads that order (see `TASK_MANUAL_ORDER`); an explicit sort is the caller's chosen
 * reading and is not second-guessed by a place the reader left behind in another mode.
 */
function taskOrder(sort: TaskSort | undefined, view: TaskView | undefined): string {
  if (sort) return TASK_SORT_ORDERS[sort]
  const fallback = view === 'completed' ? TASK_SORT_ORDERS.completed : TASK_SORT_ORDERS.due
  return `${TASK_MANUAL_ORDER}, ${fallback}`
}

/** How many rows one page of a backwards read carries, and the size of the newest page `messages` hands back. */
const MESSAGE_READ_PAGE = 500

/** Every field a model PATCH may name; anything absent leaves its column exactly as the row has it. */
type ModelPatch = {
  label?: string, model?: string, icon?: string, temperature?: number | null, maxOutputTokens?: number | null,
  reasoning?: AssistantReasoning, contextTokens?: number | null, vision?: boolean, enabled?: boolean,
  purpose?: AssistantModelPurpose, kind?: AssistantModelKind, supportsTools?: boolean,
  noTools?: boolean,
  maxInputTokens?: number | null, topP?: number | null, customParams?: AssistantCustomParam[],
  modalities?: readonly AssistantModelModality[]
  protocol?: AssistantProtocol | null
  /** Null is "no spare"; a value names the model to try when this one cannot answer. */
  fallbackModelId?: string | null
  inputPrice?: number | null
  outputPrice?: number | null
  priceCurrency?: string
  pricePeriods?: AssistantPricePeriod[]
}

/**
 * The patch fields paired with the column each one writes.
 *
 * A partial `UPDATE` has to name columns, so those names come from this fixed list and never from
 * anything the request carried: a caller can only ask for a field the patch type already allows.
 */
const MODEL_UPDATES: readonly {
  readonly key: keyof ModelPatch
  readonly column: string
  readonly bind: (patch: ModelPatch) => unknown
}[] = [
  { key: 'label', column: 'label', bind: (patch) => patch.label },
  { key: 'model', column: 'model', bind: (patch) => patch.model },
  { key: 'icon', column: 'icon', bind: (patch) => parseAssistantIcon(patch.icon) },
  // Null is a value in each field below rather than an absent patch: it is the reader emptying the box,
  // which for temperature and `maxOutputTokens` hands the model back to the account's own setting.
  { key: 'temperature', column: 'temperature', bind: (patch) => patch.temperature },
  { key: 'maxOutputTokens', column: 'max_output_tokens', bind: (patch) => patch.maxOutputTokens },
  { key: 'reasoning', column: 'reasoning', bind: (patch) => patch.reasoning },
  { key: 'contextTokens', column: 'context_tokens', bind: (patch) => patch.contextTokens },
  { key: 'vision', column: 'vision', bind: (patch) => (patch.vision ? 1 : 0) },
  { key: 'enabled', column: 'enabled', bind: (patch) => (patch.enabled ? 1 : 0) },
  { key: 'purpose', column: 'purpose', bind: (patch) => patch.purpose },
  { key: 'kind', column: 'kind', bind: (patch) => patch.kind },
  { key: 'supportsTools', column: 'supports_tools', bind: (patch) => (patch.supportsTools ? 1 : 0) },
  { key: 'noTools', column: 'no_tools', bind: (patch) => (patch.noTools ? 1 : 0) },
  { key: 'maxInputTokens', column: 'max_input_tokens', bind: (patch) => patch.maxInputTokens },
  { key: 'topP', column: 'top_p', bind: (patch) => patch.topP },
  { key: 'customParams', column: 'custom_params', bind: (patch) => JSON.stringify(parseCustomParams(patch.customParams ?? [])) },
  { key: 'modalities', column: 'modalities', bind: (patch) => JSON.stringify(parseModelModalities(patch.modalities ?? [])) },
  // Null is the reader putting the model back on the provider's own protocol.
  { key: 'protocol', column: 'protocol', bind: (patch) => patch.protocol },
  { key: 'fallbackModelId', column: 'fallback_model_id', bind: (patch) => patch.fallbackModelId },
  { key: 'inputPrice', column: 'input_price', bind: (patch) => patch.inputPrice },
  { key: 'outputPrice', column: 'output_price', bind: (patch) => patch.outputPrice },
  { key: 'priceCurrency', column: 'price_currency', bind: (patch) => patch.priceCurrency },
  { key: 'pricePeriods', column: 'price_periods', bind: (patch) => JSON.stringify(parsePricePeriods(patch.pricePeriods ?? [])) },
]

/**
 * A task row's pending reminders as one comma-separated column.
 *
 * A correlated subquery rather than a second read for the page: a listing already loads tags and step
 * counts, and a third round trip made the statement count grow with every page — the contract
 * `tests/todos-server-filter.test.ts` pins. The `(user_id, task_id)` index answers it per row, and the
 * values are parsed back into instants and sorted, because `group_concat` makes no ordering promise.
 * Fired rows stay out: the panel shows what will happen next.
 */
const TASK_REMINDER_TIMES = `(
  SELECT group_concat(r.remind_at, ',') FROM todos_reminders r
   WHERE r.user_id = todos_tasks.user_id AND r.task_id = todos_tasks.id AND r.fired_at IS NULL
) AS reminder_times`

/** The instants `TASK_REMINDER_TIMES` packed into one column, or none. */
function reminderTimesOf(packed: string | null): number[] {
  if (!packed) return []
  return normalizeReminderTimes(packed.split(',').map(Number))
}

export class AssistantStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
    readonly env: Env,
  ) {}

  private rows<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    assertScoped(sql)
    return this.db.prepare(sql).bind(...binds).all<T>().then((r) => r.results ?? [])
  }

  private async one<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
    const list = await this.rows<T>(sql, ...binds)
    return list[0] ?? null
  }

  private async write(sql: string, ...binds: unknown[]): Promise<number> {
    assertScoped(sql)
    const result = await this.db.prepare(sql).bind(this.userId, ...binds).run()
    return result.meta?.changes ?? 0
  }

  /**
   * A write whose binds already carry the account, because a `Query` built them.
   *
   * `write` prepends the user id, which is what every hand-written statement expects; a statement whose
   * WHERE clause came out of `Query` already has it as `?1`, and prepending it again would bind one
   * value more than there are placeholders.
   */
  private async runScoped(sql: string, ...binds: unknown[]): Promise<number> {
    assertScoped(sql)
    const result = await this.db.prepare(sql).bind(...binds).run()
    return result.meta?.changes ?? 0
  }

  /**
   * A partial `UPDATE`: the columns the caller named, and nothing else.
   *
   * Writing the whole row back from a snapshot read before the write is what loses an update two requests
   * make at once — the later one restamps columns it never mentioned with whatever it read at the start.
   * Placeholders are numbered here so a value cannot drift away from its own slot; the table names are
   * literals from this module, and the caller-supplied part is only ever a value.
   */
  private async partialUpdate(
    table: 'chat_models' | 'chat_providers' | 'chat_projects' | 'todos_tasks' | 'todos_lists' | 'todos_tags',
    id: string,
    fields: readonly (readonly [column: string, value: unknown])[],
  ): Promise<number> {
    if (!fields.length) return 0
    const sets = fields.map(([column], index) => `${column} = ?${index + 2}`)
    // The id binds last so its placeholder number follows whatever length the caller ended with.
    return await this.write(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE user_id = ?1 AND id = ?${fields.length + 2}`,
      ...fields.map(([, value]) => value), id,
    )
  }

  // ---------------------------------------------------------------- settings

  async getSettings(): Promise<AssistantSettings> {
    const stored = await this.one<{ config: string }>(
      `SELECT config FROM chat_settings WHERE user_id = ?1`,
      this.userId,
    )
    if (!stored) return { ...DEFAULT_ASSISTANT_SETTINGS }
    return normalizeAssistantSettings(parseJson(stored.config))
  }

  async saveSettings(settings: AssistantSettings): Promise<AssistantSettings> {
    const normalized = normalizeAssistantSettings(settings)
    await this.write(
      `INSERT INTO chat_settings (user_id, config, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      JSON.stringify(normalized), Date.now(),
    )
    return normalized
  }

  // --------------------------------------------------------------- providers

  async listProviders(): Promise<AssistantProvider[]> {
    const list = await this.rows<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM chat_providers WHERE user_id = ?1 ORDER BY created_at`,
      this.userId,
    )
    return list.map(toProvider)
  }

  /** Includes the ciphertext: only the worker may hold it, and only to sign one upstream request. */
  async providerRecord(id: string): Promise<ProviderRow | null> {
    const stored = await this.one<Omit<ProviderRow, 'protocol'> & { protocol: string }>(
      `SELECT id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_hint, key_last_used_at, created_at, updated_at
         FROM chat_providers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    if (!stored) return null
    return { ...stored, protocol: pickEnum(stored.protocol, ASSISTANT_PROTOCOLS, 'openai') }
  }

  async getProvider(id: string): Promise<AssistantProvider | null> {
    const r = await this.one<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM chat_providers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toProvider(r) : null
  }

  async createProvider(input: {
    label: string, icon?: string, protocol: AssistantProtocol, baseUrl: string, apiKey: string,
    endpoints?: Partial<Record<AssistantProtocol, string>>,
    reasoningDialect?: ReasoningDialect | null,
  }): Promise<AssistantProvider> {
    const id = newId()
    const at = Date.now()
    const key = input.apiKey.trim()
    const icon = parseAssistantIcon(input.icon)
    const ciphertext = key ? await encryptAssistantKey(this.env, this.userId, key) : ''
    const dialect = compatibleDialect(input.protocol, input.reasoningDialect)
    // The hint is stored rather than recomputed later: a listing never decrypts a key, so its last four
    // characters have to travel with the row the way an extra key's already do.
    const hint = key ? key.slice(-4) : ''
    await this.write(
      `INSERT INTO chat_providers (id, user_id, label, icon, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_hint, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?12, ?4, ?5, ?9, ?10, ?6, ?11, ?7, ?8)`,
      id, input.label, input.protocol, input.baseUrl, ciphertext, at, at,
      JSON.stringify(input.endpoints ?? {}), dialect, hint, icon,
    )
    return {
      id,
      label: input.label,
      icon,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      endpoints: input.endpoints ?? {},
      reasoningDialect: dialect,
      hasKey: Boolean(ciphertext),
      keyHint: hint,
      createdAt: at,
      updatedAt: at,
    }
  }

  async updateProvider(
    id: string,
    patch: {
      label?: string, icon?: string, protocol?: AssistantProtocol, baseUrl?: string, apiKey?: string | null,
      endpoints?: Partial<Record<AssistantProtocol, string>>,
      reasoningDialect?: ReasoningDialect | null,
    },
  ): Promise<AssistantProvider | null> {
    const existing = await this.providerRecord(id)
    if (!existing) return null
    const fields: (readonly [string, unknown])[] = []
    const set = (column: string, value: unknown): void => { fields.push([column, value]) }
    // An edit that names one field must not restamp the rest of the row from a snapshot taken before it:
    // a blank label is "say nothing", which is what the whole-row write used to mean by falling back to
    // the stored one.
    const label = patch.label?.trim().slice(0, 60)
    if (label) set('label', label)
    if (patch.icon !== undefined) set('icon', parseAssistantIcon(patch.icon))
    const protocol = patch.protocol ?? pickEnum(existing.protocol, ASSISTANT_PROTOCOLS, 'openai')
    if (patch.protocol !== undefined) set('protocol', patch.protocol)
    const baseUrl = patch.baseUrl?.trim()
    if (baseUrl) set('base_url', baseUrl)
    if (patch.endpoints !== undefined) set('endpoints', JSON.stringify(patch.endpoints))
    // A pin survives an edit that does not mention it, and is re-checked against a newly chosen protocol:
    // a Claude effort dialect left on a provider switched to the OpenAI wire would build a body nothing
    // there reads. So the column is written when either half of that decision moved.
    const dialect = compatibleDialect(
      protocol,
      patch.reasoningDialect !== undefined ? patch.reasoningDialect : reasoningDialectValue(existing.reasoning_dialect),
    )
    if (patch.reasoningDialect !== undefined || patch.protocol !== undefined) set('reasoning_dialect', dialect)
    // A patch that says nothing about the key keeps the stored ciphertext and its hint: the row still
    // holds that key, and clearing the hint would make a saved key look missing on the next listing.
    if (patch.apiKey === null) {
      set('key_ciphertext', '')
      set('key_hint', '')
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      set('key_ciphertext', await encryptAssistantKey(this.env, this.userId, patch.apiKey))
      set('key_hint', patch.apiKey.trim().slice(-4))
    }
    set('updated_at', Date.now())
    await this.partialUpdate('chat_providers', id, fields)
    return await this.getProvider(id)
  }

  async deleteProvider(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_models WHERE user_id = ?1 AND provider_id = ?2`, id)
    // The extra keys go with the provider: a key with no address to reach is not something to keep.
    await this.write(`DELETE FROM chat_provider_keys WHERE user_id = ?1 AND provider_id = ?2`, id)
    await this.write(`DELETE FROM chat_providers WHERE user_id = ?1 AND id = ?2`, id)
  }

  /** The extra keys on a provider, oldest first, without their ciphertext. */
  async listProviderKeys(providerId: string): Promise<AssistantProviderKey[]> {
    const rows = await this.rows<ProviderKeyRow>(
      `SELECT ${PROVIDER_KEY_COLUMNS} FROM chat_provider_keys
        WHERE user_id = ?1 AND provider_id = ?2 ORDER BY created_at`,
      this.userId, providerId,
    )
    return rows.map(toProviderKey)
  }

  async createProviderKey(providerId: string, input: { label: string, apiKey: string }): Promise<AssistantProviderKey> {
    const id = newId()
    const at = Date.now()
    const label = input.label.trim().slice(0, 60)
    const key = input.apiKey.trim()
    const ciphertext = await encryptAssistantKey(this.env, this.userId, key)
    await this.write(
      `INSERT INTO chat_provider_keys
         (id, user_id, provider_id, label, key_ciphertext, key_hint, enabled, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
      id, providerId, label, ciphertext, key.slice(-4), at, at,
    )
    return {
      id, providerId, label, hasKey: true, keyHint: key.slice(-4), enabled: true,
      lastUsedAt: null, errorCount: 0, lastError: null, createdAt: at, updatedAt: at,
    }
  }

  async updateProviderKey(
    id: string,
    patch: { label?: string, enabled?: boolean, apiKey?: string | null },
  ): Promise<AssistantProviderKey | null> {
    const existing = await this.one<ProviderKeyRow>(
      `SELECT ${PROVIDER_KEY_COLUMNS} FROM chat_provider_keys WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    if (!existing) return null
    const label = patch.label !== undefined ? patch.label.trim().slice(0, 60) : existing.label
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled
    let ciphertext = existing.key_ciphertext ?? ''
    let hint = existing.key_hint ?? ''
    if (patch.apiKey === null) {
      ciphertext = ''
      hint = ''
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const key = patch.apiKey.trim()
      ciphertext = await encryptAssistantKey(this.env, this.userId, key)
      hint = key.slice(-4)
    }
    const at = Date.now()
    await this.write(
      `UPDATE chat_provider_keys SET label = ?2, enabled = ?3, key_ciphertext = ?4, key_hint = ?5, updated_at = ?6
         WHERE user_id = ?1 AND id = ?7`,
      label, enabled, ciphertext, hint, at, id,
    )
    return { ...toProviderKey(existing), label, enabled: Boolean(enabled), hasKey: Boolean(ciphertext), keyHint: hint, updatedAt: at }
  }

  async deleteProviderKey(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_provider_keys WHERE user_id = ?1 AND id = ?2`, id)
  }

  // ----------------------------------------------------------- search keys
  //
  // One credential per hosted web-search engine, kept in vault ciphertext. What a settings screen may learn
  // about one is `hasKey` and its last four characters; what the search call may learn is the plaintext, and
  // only in the isolate that is about to sign a request with it.

  /**
   * Which engines this reader has a key for.
   *
   * Ids only — not even the hint — because the only question the search tool's gate asks is whether the
   * chosen engine has something to send, and a turn has no business learning what the other engines hold.
   */
  async searchKeyEngines(): Promise<string[]> {
    const rows = await this.rows<{ engine: string }>(
      `SELECT engine FROM chat_search_keys WHERE user_id = ?1 AND length(key_ciphertext) > 0`,
      this.userId,
    )
    return rows.map((row) => row.engine)
  }

  /** Every engine's key state, newest written last: the settings screen's own listing. */
  async listSearchKeys(): Promise<AssistantSearchKey[]> {
    const rows = await this.rows<{ engine: string, has_key?: unknown, key_hint?: string | null, updated_at: number }>(
      `SELECT engine, key_hint, length(key_ciphertext) > 0 AS has_key, updated_at
         FROM chat_search_keys WHERE user_id = ?1 ORDER BY updated_at`,
      this.userId,
    )
    return rows.map(toSearchKeyPresence)
  }

  /**
   * The plaintext key one engine is searched with, or an empty string when none is stored.
   *
   * The one read of the ciphertext in this table, and it is not a listing: a route that answered with this
   * would be handing a credential back to a browser that already proved it owns the account, which is not
   * the same thing as needing the key.
   */
  async searchApiKey(engine: string): Promise<string> {
    const row = await this.one<SearchKeyRow>(
      `SELECT ${SEARCH_KEY_COLUMNS} FROM chat_search_keys WHERE user_id = ?1 AND engine = ?2`,
      this.userId, engine,
    )
    if (!row?.key_ciphertext) return ''
    return (await decryptAssistantKey(this.env, this.userId, row.key_ciphertext)) ?? ''
  }

  /** Stores, or replaces, the key one engine is searched with. */
  async putSearchKey(engine: string, apiKey: string): Promise<AssistantSearchKey> {
    const key = apiKey.trim()
    // `encryptAssistantKey` refuses an empty or over-long key, but only after the vault round trip; refused
    // here first, so the row a reader was told about is the row that changed.
    if (!key) throw new Error('invalid_search_credential')
    const at = Date.now()
    const ciphertext = await encryptAssistantKey(this.env, this.userId, key)
    await this.write(
      `INSERT INTO chat_search_keys (user_id, engine, key_ciphertext, key_hint, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(user_id, engine) DO UPDATE SET
         key_ciphertext = excluded.key_ciphertext, key_hint = excluded.key_hint, updated_at = excluded.updated_at`,
      engine, ciphertext, key.slice(-4), at,
    )
    return { engine, hasKey: true, keyHint: key.slice(-4), updatedAt: at }
  }

  /** Forgets one engine's key. False when there was nothing to forget, which the route answers as not found. */
  async deleteSearchKey(engine: string): Promise<boolean> {
    return await this.write(
      `DELETE FROM chat_search_keys WHERE user_id = ?1 AND engine = ?2 AND length(key_ciphertext) > 0`,
      engine,
    ) > 0
  }

  /**
   * The key this call should sign with, chosen from everything the provider has.
   *
   * The provider's own key is one of the ring rather than a separate path: a reader who added two more
   * expects all three to be used. The least recently used one goes first, which spreads turns without a
   * cursor to keep — a key never used sorts ahead of one used a minute ago, and `created_at` breaks the
   * tie so the order is stable rather than whichever row the database happened to return.
   */
  async pickProviderKey(record: ProviderRow): Promise<{ keyId: string, key: string, label: string } | null> {
    const ring: Array<{ keyId: string, ciphertext: string, lastUsedAt: number, order: number, label: string }> = []
    if (record.key_ciphertext) {
      ring.push({
        keyId: '',
        ciphertext: record.key_ciphertext,
        lastUsedAt: record.key_last_used_at ?? 0,
        order: -1,
        label: record.label,
      })
    }
    const extras = await this.rows<ProviderKeyRow>(
      `SELECT ${PROVIDER_KEY_COLUMNS} FROM chat_provider_keys
        WHERE user_id = ?1 AND provider_id = ?2 AND enabled = 1 ORDER BY created_at`,
      this.userId, record.id,
    )
    for (const row of extras) {
      if (!row.key_ciphertext) continue
      ring.push({ keyId: row.id, ciphertext: row.key_ciphertext, lastUsedAt: row.last_used_at ?? 0, order: row.created_at, label: row.label })
    }
    if (!ring.length) return null
    ring.sort((left, right) => (left.lastUsedAt - right.lastUsedAt) || (left.order - right.order))
    for (const candidate of ring) {
      const key = (await decryptAssistantKey(this.env, this.userId, candidate.ciphertext)) ?? ''
      if (key) return { keyId: candidate.keyId, key, label: candidate.label }
    }
    return null
  }

  /**
   * Every credential one provider holds, decrypted, for the screen that asks each of them the same question.
   *
   * `pickProviderKey` hands out one key because a turn signs with one. A balance is asked of all of them,
   * because a reader with three keys has three wallets and wants three numbers — and a reading that covered
   * only the least recently used key would be a number ascribed to the wrong row. The plaintext leaves this
   * method and no route returns it: what reaches the browser is the last four characters the row already
   * shows, plus what the vendor said about what is left.
   */
  async providerKeySecrets(providerId: string): Promise<{ baseUrl: string, keys: Array<{ keyId: string, key: string, label: string, keyHint: string }> }> {
    const record = await this.providerRecord(providerId)
    if (!record) return { baseUrl: '', keys: [] }
    const out: Array<{ keyId: string, key: string, label: string, keyHint: string }> = []
    if (record.key_ciphertext) {
      const key = (await decryptAssistantKey(this.env, this.userId, record.key_ciphertext)) ?? ''
      // The provider's own key carries no label of its own: its row is the provider, and the screen calls it
      // the primary one. `keyId: ''` is how every other surface already names that same key.
      if (key) out.push({ keyId: '', key, label: '', keyHint: record.key_hint ?? '' })
    }
    const extras = await this.rows<ProviderKeyRow>(
      `SELECT ${PROVIDER_KEY_COLUMNS} FROM chat_provider_keys
        WHERE user_id = ?1 AND provider_id = ?2 AND enabled = 1 ORDER BY created_at`,
      this.userId, providerId,
    )
    for (const row of extras) {
      if (!row.key_ciphertext) continue
      const key = (await decryptAssistantKey(this.env, this.userId, row.key_ciphertext)) ?? ''
      if (key) out.push({ keyId: row.id, key, label: row.label, keyHint: row.key_hint ?? '' })
    }
    return { baseUrl: record.base_url, keys: out }
  }

  /** Records that a key just answered, so the next turn starts from a different one. */
  async markProviderKeyUsed(providerId: string, keyId: string): Promise<void> {
    const at = Date.now()
    if (keyId) {
      await this.write(`UPDATE chat_provider_keys SET last_used_at = ?2 WHERE user_id = ?1 AND id = ?3`, at, keyId)
      return
    }
    await this.write(`UPDATE chat_providers SET key_last_used_at = ?2 WHERE user_id = ?1 AND id = ?3`, at, providerId)
  }

  /** What a key last said when it failed, for the row that has to show which one is broken. */
  async recordProviderKeyError(keyId: string, message: string): Promise<void> {
    if (!keyId) return
    await this.write(
      `UPDATE chat_provider_keys SET error_count = error_count + 1, last_error = ?2, updated_at = ?3
         WHERE user_id = ?1 AND id = ?4`,
      message.slice(0, 300), Date.now(), keyId,
    )
  }

  /**
   * Everything a vendor's own listing endpoint needs, read in one go.
   *
   * `PROVIDER_COLUMNS` deliberately leaves the ciphertext out of every listing, so this reads the row the
   * way `providerRecord` does and hands a decrypted key only to the caller that is about to make a vetted
   * outbound request with it.
   */
  async vendorAccess(id: string): Promise<{ protocol: AssistantProtocol, baseUrl: string, apiKey: string } | null> {
    const row = await this.one<ProviderRow>(
      `SELECT id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_hint, key_last_used_at, created_at, updated_at
         FROM chat_providers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    if (!row) return null
    // The listing goes through the same ring a turn does, so a provider whose first key is spent can
    // still be listed with the one that works.
    const picked = await this.pickProviderKey(row)
    return {
      protocol: pickEnum(row.protocol, ASSISTANT_PROTOCOLS, 'openai'),
      baseUrl: row.base_url,
      apiKey: picked?.key ?? '',
    }
  }

  // ------------------------------------------------------------------ models

  async listModels(): Promise<AssistantModel[]> {
    const list = await this.rows<ModelRow>(
      `SELECT ${MODEL_SELECT_COLUMNS}
         FROM chat_models WHERE user_id = ?1 ORDER BY position, label`,
      this.userId,
    )
    return list.map(toModel)
  }

  async getModel(id: string): Promise<AssistantModel | null> {
    const r = await this.one<ModelRow>(
      `SELECT ${MODEL_SELECT_COLUMNS}
         FROM chat_models WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toModel(r) : null
  }

  async createModel(input: {
    providerId: string
    model: string
    label?: string
    icon?: string
    temperature?: number | null
    maxOutputTokens?: number | null
    reasoning?: AssistantReasoning
    contextTokens?: number | null
    vision?: boolean
    protocol?: AssistantProtocol | null
    /** What the vendor's own listing said this model can hold, when it published a number. */
    vendorContextTokens?: number | null
    vendorMaxOutputTokens?: number | null
  }): Promise<AssistantModel> {
    const id = newId()
    const positionRow = await this.one<{ n: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM chat_models WHERE user_id = ?1`,
      this.userId,
    )
    const temperature = input.temperature ?? DEFAULT_ASSISTANT_SETTINGS.temperature
    // Left as the reader typed it, including unset: writing the account's ceiling in here would claim
    // this model had a number of its own, and a later raise of the account's ceiling would not reach it.
    const maxOutputTokens = input.maxOutputTokens ?? null
    const label = input.label ?? input.model
    const icon = parseAssistantIcon(input.icon)
    const reasoning = input.reasoning ?? 'auto'
    const contextTokens = input.contextTokens ?? null
    const vision = input.vision ?? true
    // What the vendor's published numbers say about the id being written down, learned the moment the row
    // is made. A number the vendor published for *this* model beats the bundled table, which is only a
    // guess about a name; the table is all an OpenAI or Anthropic row can get, since neither listing
    // carries limits at all. An id neither one speaks for keeps null rather than a guess: a made-up
    // ceiling would cut the editor's ladder and warn about a number nobody stated.
    const published = curatedModelLimits(input.model)
    const vendorContextTokens = input.vendorContextTokens ?? published.contextTokens
    const vendorMaxOutputTokens = input.vendorMaxOutputTokens ?? published.maxOutputTokens
    await this.write(
      `INSERT INTO chat_models (id, user_id, provider_id, model, label, icon, temperature, max_output_tokens, reasoning, context_tokens, vendor_context_tokens, vendor_max_output_tokens, vision, enabled, position, protocol)
       VALUES (?2, ?1, ?3, ?4, ?5, ?15, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14)`,
      id, input.providerId, input.model, label, temperature, maxOutputTokens, reasoning, contextTokens,
      vendorContextTokens, vendorMaxOutputTokens, vision ? 1 : 0, positionRow?.n ?? 1,
      input.protocol ?? null, icon,
    )
    // The columns keep their defaults, so the object handed back says the same thing the row does.
    return {
      id, providerId: input.providerId, model: input.model, label, icon, temperature, maxOutputTokens,
      reasoning, contextTokens, vision, enabled: true,
      vendorContextTokens, vendorMaxOutputTokens,
      purpose: 'chat', kind: 'text', supportsTools: true, noTools: false, maxInputTokens: null, modalities: [], topP: null, customParams: [],
      protocol: input.protocol ?? null,
      fallbackModelId: null,
      inputPrice: null, outputPrice: null, priceCurrency: '',
      pricePeriods: [],
    }
  }

  async updateModel(
    id: string,
    patch: ModelPatch,
  ): Promise<AssistantModel | null> {
    const fields: (readonly [string, unknown])[] = []
    for (const entry of MODEL_UPDATES) {
      // Absent means untouched. Null is a value the caller wrote, and the bind above is what stores it.
      if (patch[entry.key] === undefined) continue
      fields.push([entry.column, entry.bind(patch)])
    }
    // Nothing named is nothing to write, so the row is handed back as it stands — and a model that is not
    // this account's is still the caller's 404.
    if (!fields.length) return await this.getModel(id)
    const changes = await this.partialUpdate('chat_models', id, fields)
    // Read back instead of assembled from a merge made before the write: a toggle that landed in between
    // belongs to the row now, and the reply has to say what the reader's screen will show next.
    return changes ? await this.getModel(id) : null
  }

  /**
   * Removes a model, and the spare references that pointed at it.
   *
   * A deleted model cannot answer, so a chain that still names it would stop one model short of where the
   * reader thought it went. Clearing the column here keeps the fallback list honest; the chain would skip
   * a dangling name anyway, but the editor would go on showing a spare that no longer exists.
   */
  async deleteModel(id: string): Promise<void> {
    await this.write(`UPDATE chat_models SET fallback_model_id = NULL WHERE user_id = ?1 AND fallback_model_id = ?2`, id)
    await this.write(`DELETE FROM chat_models WHERE user_id = ?1 AND id = ?2`, id)
  }

  /**
   * The reader's own attachment rows, in the order they were asked for.
   *
   * The chat composer names files by id, so this is the one place that decides whether an id in a
   * request belongs to this account: a row that is not the reader's simply never appears, and the
   * caller says so in the transcript rather than pretending the file arrived.
   */
  async attachmentsFor(ids: readonly string[]): Promise<{ id: string, user_id: string, filename: string, mime: string, size: number, storage: string }[]> {
    if (!ids.length) return []
    type AttachmentFileRow = { id: string, user_id: string, filename: string, mime: string, size: number, storage: string }
    const rows: AttachmentFileRow[] = []
    // Chunked rather than cut off at some count: the list is as long as the caller's request, and a
    // reader who asked for twenty files gets twenty rows or none of them is silently missing.
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      rows.push(...await this.rows<AttachmentFileRow>(
        `SELECT id, user_id, filename, mime, size, storage FROM attachments WHERE ${q.where}`,
        ...q.binds,
      ))
    }
    const order = new Map(ids.map((id, index) => [id, index]))
    return rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  }

  // ------------------------------------------------------- chat attachments

  /** A row for one uploaded file. The key is the reader's own R2 path, written by the caller. */
  async createChatAttachment(input: {
    id: string
    kind: 'image' | 'file'
    filename: string
    mime: string
    size: number
    key: string
    /** The words the bytes carry but the worker cannot read — a PDF's text layer, read in the browser. */
    extractedText?: string
  }): Promise<ChatAttachment> {
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_attachments (user_id, id, kind, filename, mime, size, key, extracted_text, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      input.id, input.kind, input.filename, input.mime, input.size, input.key, input.extractedText ?? null, at,
    )
    return { id: input.id, kind: input.kind, filename: input.filename, mime: input.mime, size: input.size, key: input.key, createdAt: at }
  }

  /**
   * The text a document's own bytes could not be decoded into, by attachment id.
   *
   * Kept out of {@link chatAttachments} because it is model-facing prompt fuel, not a field the client
   * renders, and a whole PDF's text has no business riding in a list response.
   */
  async chatAttachmentTexts(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map()
    // Chunked, not clamped: `MAX_CHAT_ATTACHMENTS` is how many files a turn may *hang*, and a row restored
    // from a backup can legitimately name more than that. Reading only the first eight handed the model a
    // turn with files in it and no word about the ones that went missing.
    const out = new Map<string, string>()
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      const rows = await this.rows<{ id: string, extracted_text: string | null }>(
        `SELECT id, extracted_text FROM chat_attachments WHERE ${q.where}`,
        ...q.binds,
      )
      for (const row of rows) if (row.extracted_text) out.set(row.id, row.extracted_text)
    }
    return out
  }

  /**
   * The reader's own attachment rows, in the order they were named.
   *
   * The list is a batch read, not one turn: the conversation route hands over the ids of every chip on
   * the page it is answering with, so the per-message ceiling (`MAX_CHAT_ATTACHMENTS`, enforced where a
   * turn is written) does not belong here — it would drop files the reader can see in the row and cut
   * the transcript down without a word. Chunking by {@link ID_READ_BATCH} is the bound that does apply.
   */
  async chatAttachments(ids: readonly string[]): Promise<ChatAttachment[]> {
    if (!ids.length) return []
    const rows: ChatAttachmentRow[] = []
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      rows.push(...await this.rows<ChatAttachmentRow>(
        `SELECT id, kind, filename, mime, size, key, created_at FROM chat_attachments WHERE ${q.where}`,
        ...q.binds,
      ))
    }
    const order = new Map(ids.map((id, index) => [id, index]))
    return rows
      .map(toChatAttachment)
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  }

  /**
   * Removes one uploaded file, and every turn's reference to it, in as few batches as the ceiling allows.
   *
   * The row and its bytes are not the whole of it. A message that named the file in its `attachments` array
   * goes on showing a chip for a file that no longer resolves, and the transcript then claims a turn carried
   * something the account no longer owns — so the rewrite is part of the delete rather than a caller's
   * follow-up. D1 gives no transaction to roll back with, and a batch is the one thing that either lands
   * together or not at all: the rewrites and the row removal share a statement batch whenever they fit in
   * {@link MAX_BATCH_STATEMENTS}, which they do for any file a reader has actually attached to a handful of
   * turns. Past that ceiling the rewrites go first and the row last, so a failure partway through leaves the
   * file still there — the reverse order is the one that would leave a turn pointing at nothing.
   *
   * The caller may therefore drop the object from the bucket once this returns: by then nothing this account
   * owns names it.
   */
  async deleteChatAttachment(id: string): Promise<{ removed: ChatAttachment | null, strippedTurns: number }> {
    const [row] = await this.chatAttachments([id])
    if (!row) return { removed: null, strippedTurns: 0 }
    // The id is validated by the caller before it reaches here, and `requiredId`'s charset carries no LIKE
    // metacharacter, so the pattern below can only ever over-match — which the parse-and-filter step sorts
    // out. Scanning this account's messages is the price of a delete that has to find every turn naming the
    // file, and a delete is not a path a reader walks often.
    const referrers = await this.rows<{ id: string, attachments: string | null }>(
      `SELECT id, attachments FROM chat_messages WHERE user_id = ?1 AND attachments LIKE ?2`,
      this.userId, `%${id}%`,
    )
    const rewrites: D1PreparedStatement[] = []
    for (const message of referrers) {
      const before = decodeStringList(message.attachments)
      const kept = before.filter((entry) => entry !== id)
      if (kept.length === before.length) continue
      rewrites.push(this.db
        .prepare(`UPDATE chat_messages SET attachments = ?2 WHERE user_id = ?1 AND id = ?3`)
        .bind(this.userId, JSON.stringify(kept), message.id))
    }
    const removal = this.db
      .prepare(`DELETE FROM chat_attachments WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id)
    // One transaction for the ordinary case. Past the ceiling the rewrites are split, and the row goes with
    // the last chunk: every turn that named the file has stopped naming it before the file can be missed.
    const batches: D1PreparedStatement[][] = []
    for (let start = 0; start < rewrites.length; start += MAX_BATCH_STATEMENTS - 1) {
      batches.push(rewrites.slice(start, start + MAX_BATCH_STATEMENTS - 1))
    }
    if (!batches.length) batches.push([])
    batches[batches.length - 1]!.push(removal)
    for (const batch of batches) await this.db.batch(batch)
    return { removed: row, strippedTurns: rewrites.length }
  }

  // ------------------------------------------------------------------- skills

  // The rows live in `chat_prompts`, the name the table shipped under; the surface was renamed to skills
  // and the storage name was not (see the note in `assistant/schema.ts`). One name for one concept in
  // every statement below, so the mismatch is read once here rather than puzzled over at each query.

  /** The reader's saved skills, newest first; `group` narrows to one folder of them. */
  async listSkills(options: { query?: string, group?: string, limit?: number } = {}): Promise<AssistantSkill[]> {
    const q = new Query(this.userId)
    if (options.group) q.eq(`group_name`, options.group)
    if (options.query) {
      const pattern = q.add(containsPattern(options.query))
      const inBody = q.add(containsPattern(options.query))
      q.raw(`(title LIKE ${pattern} ESCAPE '\\' OR content LIKE ${inBody} ESCAPE '\\')`)
    }
    const limitBind = q.add(options.limit ?? 200)
    const list = await this.rows<SkillRow>(
      `SELECT ${SKILL_SELECT_COLUMNS} FROM chat_prompts
        WHERE ${q.where} ORDER BY updated_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    return list.map(toSkill)
  }

  async getSkill(id: string): Promise<AssistantSkill | null> {
    const r = await this.one<SkillRow>(
      `SELECT ${SKILL_SELECT_COLUMNS}
         FROM chat_prompts WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toSkill(r) : null
  }

  async insertSkill(input: {
    title: string, content: string, group?: string, icon?: string,
    tools?: string[], scopes?: AssistantTurnScope[], modelId?: string | null,
  }): Promise<AssistantSkill> {
    const id = newId()
    const at = Date.now()
    const group = input.group?.trim() ?? ''
    const icon = input.icon?.trim() ?? ''
    const tools = input.tools ?? []
    const scopes = input.scopes ?? []
    const modelId = input.modelId ?? null
    await this.write(
      `INSERT INTO chat_prompts (id, user_id, title, content, group_name, tools, scopes, model_id, icon, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      id, input.title, input.content, group, JSON.stringify(tools), JSON.stringify(scopes), modelId, icon, at,
    )
    return {
      id, title: input.title, content: input.content, group, icon, tools, scopes, modelId,
      createdAt: at, updatedAt: at,
    }
  }

  async updateSkill(id: string, patch: {
    title?: string, content?: string, group?: string, icon?: string,
    tools?: string[], scopes?: AssistantTurnScope[], modelId?: string | null,
  }): Promise<AssistantSkill | null> {
    const existing = await this.getSkill(id)
    if (!existing) return null
    const next: AssistantSkill = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.group !== undefined ? { group: patch.group } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
      updatedAt: Date.now(),
    }
    await this.write(
      `UPDATE chat_prompts SET title = ?2, content = ?3, group_name = ?4, tools = ?5, scopes = ?6,
         model_id = ?7, icon = ?8, updated_at = ?9
         WHERE user_id = ?1 AND id = ?10`,
      next.title, next.content, next.group, JSON.stringify(next.tools), JSON.stringify(next.scopes),
      next.modelId, next.icon, next.updatedAt, id,
    )
    return next
  }

  async deleteSkill(id: string): Promise<boolean> {
    const existing = await this.getSkill(id)
    if (!existing) return false
    await this.write(`DELETE FROM chat_prompts WHERE user_id = ?1 AND id = ?2`, id)
    return true
  }

  /** Every attachment the reader has, newest first — the list the composer's picker walks. */
  async listChatAttachments(limit = 60): Promise<ChatAttachment[]> {
    const q = new Query(this.userId)
    const limitBind = q.add(limit)
    const rows = await this.rows<ChatAttachmentRow>(
      `SELECT id, kind, filename, mime, size, key, created_at FROM chat_attachments
        WHERE ${q.where} ORDER BY created_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    return rows.map(toChatAttachment)
  }

  // ----------------------------------------------------------- conversations

  /**
   * The list, optionally narrowed to one folder (with its subfolders) or one tag (with its subtree).
   *
   * Both halves nest for the same reason: a reader who files things underneath a project, or labels
   * them `work/meeting`, expects the parent to show the lot — which is how the notebook's folder rows
   * and the notes list already behave. A tag filter that matched the exact id alone hid the
   * conversations it was supposed to gather.
   */
  async listConversations(
    query?: string,
    filter: {
      folderId?: string | null
      projectId?: string | null
      /** Narrows to the threads started from one note; an exact id match, bounded by the account. */
      noteId?: string
      tagId?: string
      starred?: boolean
      pinned?: boolean
      archived?: boolean
      limit?: number
      /**
       * Where the previous page stopped. Absent means the first page; the caller passes the cursor it
       * was handed rather than an offset, because a row written between two requests would shift every
       * offset by one and the reader would see a conversation twice or not at all.
       */
      cursor?: ConversationCursor | null
    } = {},
  ): Promise<AssistantConversation[]> {
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 200)
    const q = new Query(this.userId)
    if (filter.folderId !== undefined) {
      const ids = filter.folderId === null ? null : await this.folderSubtree(filter.folderId)
      if (ids && !ids.length) return []
      if (!ids) q.raw('folder_id IS NULL')
      else q.inList('folder_id', ids)
    }
    if (filter.projectId !== undefined) {
      // Projects do not nest the way folders do, so this is an equality rather than a subtree walk.
      if (filter.projectId === null) q.raw('project_id IS NULL')
      else q.eq('project_id', filter.projectId)
    }
    // A note has no thread-tree the way a folder does: the caller names one note, and the answer is the
    // threads started from it. The id is matched exactly, and `user_id = ?1` is already in `q.where`, so a
    // foreign note id can only ever reach this account's own rows.
    if (filter.noteId !== undefined) q.eq('note_id', filter.noteId)
    if (filter.starred) q.raw('starred = 1')
    if (filter.pinned) q.raw('pinned = 1')
    // Absent means "either", which is what the backup and the assistant's own search want: an archived
    // conversation is put away, not gone, and a reader who asks for everything gets everything.
    if (filter.archived === true) q.raw('archived = 1')
    else if (filter.archived === false) q.raw('archived = 0')
    if (filter.tagId) {
      const scope = await this.tagName(filter.tagId)
      // An id the reader does not own scopes nothing, and the answer is an empty list rather than an
      // unfiltered one.
      if (scope === null) return []
      const nameParam = q.add(scope)
      const prefixParam = q.add(likePattern(`${scope}/`))
      q.raw(`EXISTS (SELECT 1 FROM chat_conversation_tags ct
        JOIN tags t ON t.id = ct.tag_id AND t.user_id = ct.user_id
        WHERE ct.user_id = ?1 AND ct.conversation_id = c.id
          AND ${tagScopePredicate('t.name', nameParam, prefixParam)})`)
    }
    if (query) {
      const pattern = q.add(containsPattern(query))
      const inBody = q.add(containsPattern(query))
      // A thread started from a note is also a conversation *about* that note, so its words count as a
      // hit: "which conversation did I have about this?" is the question this list is asked most.
      const inNote = q.add(containsPattern(query))
      q.raw(`(title LIKE ${pattern} ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id
          AND m.user_id = ?1 AND m.content LIKE ${inBody} ESCAPE '\\')
        OR EXISTS (
        SELECT 1 FROM notes n WHERE n.user_id = ?1 AND n.id = c.note_id AND n.deleted_at IS NULL
          AND n.content LIKE ${inNote} ESCAPE '\\'))`)
    }
    const limitBind = q.add(limit)
    // A temporary conversation is never listed. Its reader reaches it by id, which is the only way anyone
    // has it: the list, the starred and pinned shortlists and the assistant's own search all come through
    // here, so this one clause is what keeps the promise the UI makes.
    q.raw('c.ephemeral = 0')
    if (filter.cursor) {
      // Keyset, not OFFSET: the three columns the ORDER BY uses, compared as one tuple. Pinned rows are
      // ahead of everything else, so a page boundary never mixes the two groups.
      const pinned = q.add(filter.cursor.pinned)
      const updatedAt = q.add(filter.cursor.updatedAt)
      const id = q.add(filter.cursor.id)
      q.raw(`(c.pinned < ${pinned} OR (c.pinned = ${pinned} AND (c.updated_at < ${updatedAt}
        OR (c.updated_at = ${updatedAt} AND c.id < ${id}))))`)
    }
    // The tenant predicate here is not only scoping: `idx_chat_messages_conversation` leads with `user_id`,
    // so a correlated count that names just the conversation cannot use the index and reads every message
    // row once per conversation on the page.
    const list = await this.rows<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS},
              (SELECT count(*) FROM chat_messages m
                 WHERE m.user_id = c.user_id AND m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE ${q.where}
         ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    const conversations = list.map(toConversation)
    if (conversations.length) {
      const tags = await this.tagsForConversations(conversations.map((entry) => entry.id))
      for (const conversation of conversations) conversation.tags = tags.get(conversation.id) ?? []
    }
    // One extra query, and only when the reader searched: the row shows where the word was found so the
    // click is not a guess about which thread to open.
    if (query && conversations.length) {
      const matches = await this.firstMatchingMessages(conversations.map((entry) => entry.id), query)
      for (const conversation of conversations) conversation.match = matches.get(conversation.id) ?? null
    }
    return conversations
  }

  /**
   * The earliest message in each conversation that contains the search term.
   *
   * `ROW_NUMBER` rather than a per-conversation query: the list is a page of at most a hundred rows, and
   * one statement over the ids is one round trip instead of a hundred. The earliest hit is the one a
   * reader looking for "where did we talk about this" means, and it is also the one a transcript opens at.
   */
  private async firstMatchingMessages(
    conversationIds: readonly string[],
    query: string,
  ): Promise<Map<string, { messageId: string, snippet: string }>> {
    const found = new Map<string, { messageId: string, snippet: string }>()
    // The listing hands over a page of up to two hundred ids, and one statement may not name them
    // all: D1 binds at most 100 parameters, so the page is read in chunks and merged. The window
    // function keeps the earliest hit per conversation, which is the one the reader means.
    for (const chunk of idChunks(conversationIds)) {
      const q = new Query(this.userId)
      q.inList('conversation_id', chunk)
      const pattern = q.add(containsPattern(query))
      const rows = await this.rows<{ conversation_id: string, id: string, content: string }>(
        `SELECT conversation_id, id, content FROM (
           SELECT conversation_id, id, content,
                  ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at ASC, rowid ASC) AS rn
             FROM chat_messages
            WHERE ${q.where} AND content LIKE ${pattern} ESCAPE '\\'
         ) WHERE rn = 1`,
        ...q.binds,
      )
      for (const row of rows) found.set(row.conversation_id, { messageId: row.id, snippet: searchSnippet(row.content, query) })
    }
    return found
  }

  /** The note folder tree with conversation counts, plus how many conversations hold no folder. */
  async conversationFolderSummary(): Promise<{ folders: ChatFolderNode[], unfiled: number }> {
    const rows = await this.rows<{ id: string, name: string, parent_id: string | null, icon: string | null, color: string | null, n: number }>(
      `SELECT f.id, f.name, f.parent_id, f.icon, f.color,
              (SELECT count(*) FROM chat_conversations c WHERE c.user_id = ?1 AND c.folder_id = f.id AND c.archived = 0 AND c.ephemeral = 0) AS n
         FROM folders f
        WHERE f.user_id = ?1 AND f.deleted_at IS NULL
        ORDER BY f.name`,
      this.userId,
    )
    const unfiled = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE user_id = ?1 AND folder_id IS NULL AND archived = 0 AND ephemeral = 0`,
      this.userId,
    )
    return {
      folders: rows.map((row) => ({
        id: row.id, name: row.name, parentId: row.parent_id ?? null,
        icon: row.icon ?? null, color: row.color ?? null, count: row.n ?? 0,
      })),
      unfiled: unfiled?.n ?? 0,
    }
  }

  /** How many conversations answer under each project, and how many answer under none. */
  async conversationProjectSummary(): Promise<{ projects: ChatProjectNode[], unfiled: number }> {
    const rows = await this.rows<{ id: string, name: string, n: number }>(
      `SELECT p.id, p.name,
              (SELECT count(*) FROM chat_conversations c WHERE c.user_id = ?1 AND c.project_id = p.id AND c.archived = 0 AND c.ephemeral = 0) AS n
         FROM chat_projects p
        WHERE p.user_id = ?1
        ORDER BY p.name`,
      this.userId,
    )
    const unfiled = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE user_id = ?1 AND project_id IS NULL AND archived = 0 AND ephemeral = 0`,
      this.userId,
    )
    return {
      projects: rows.map((row) => ({ id: row.id, name: row.name, count: row.n ?? 0 })),
      unfiled: unfiled?.n ?? 0,
    }
  }

  /** The folder and every folder beneath it, walked to a depth no real tree reaches. */
  private async folderSubtree(rootId: string): Promise<string[]> {
    const found = new Set<string>([rootId])
    let frontier = [rootId]
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      // A wide level is walked in chunks: D1 binds at most 100 parameters per statement, so a level
      // holding a hundred folders or more would fail the whole walk rather than the level.
      const next: string[] = []
      for (const chunk of idChunks(frontier)) {
        const q = new Query(this.userId)
        q.inList('parent_id', chunk)
        const rows = await this.rows<{ id: string }>(
          `SELECT id FROM folders WHERE ${q.where} AND deleted_at IS NULL`,
          ...q.binds,
        )
        for (const row of rows ?? []) {
          if (found.has(row.id)) continue
          found.add(row.id)
          next.push(row.id)
        }
      }
      frontier = next
    }
    return [...found]
  }

  /**
   * Files a conversation under a project, which is what gives it the project's instructions.
   *
   * A project that no longer exists is refused rather than silently kept: a conversation whose project
   * row vanished must not go on answering under instructions nobody can see or edit.
   */
  async setConversationProject(id: string, projectId: string | null): Promise<boolean> {
    if (projectId && !(await this.getProject(projectId))) return false
    const result = await this.write(
      `UPDATE chat_conversations SET project_id = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`,
      id, projectId, Date.now(),
    )
    return result > 0
  }

  async setConversationFolder(id: string, folderId: string | null): Promise<void> {
    if (folderId) {
      const folder = await this.one<{ id: string }>(
        `SELECT id FROM folders WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
        this.userId, folderId,
      )
      if (!folder) throw new Error(`unknown folder ${folderId}`)
    }
    await this.write(
      `UPDATE chat_conversations SET folder_id = ?2, updated_at = ?3 WHERE user_id = ?1 AND id = ?4`,
      folderId, Date.now(), id,
    )
  }

  /** The tags on these conversations, keyed by conversation id. */
  async tagsForConversations(ids: readonly string[]): Promise<Map<string, ConversationTag[]>> {
    const out = new Map<string, ConversationTag[]>()
    // Written out rather than through Query: a join makes the builder's unqualified `user_id = ?1`
    // ambiguous, and the failure is a 500 on every conversation list. The ids arrive a page at a
    // time, so they are cut into chunks before the join rather than named in one statement.
    for (const chunk of idChunks(ids)) {
      const rows = await this.rows<{ conversation_id: string, tag_id: string, name: string, color: string | null }>(
        `SELECT ct.conversation_id, t.id AS tag_id, t.name, t.color
           FROM chat_conversation_tags ct JOIN tags t ON t.user_id = ct.user_id AND t.id = ct.tag_id
          WHERE ct.user_id = ?1 AND ct.conversation_id IN (${chunkMarks(chunk)}) ORDER BY t.name`,
        this.userId, ...chunk,
      )
      for (const row of rows) {
        const list = out.get(row.conversation_id) ?? []
        list.push({ id: row.tag_id, name: row.name, color: row.color ?? null })
        out.set(row.conversation_id, list)
      }
    }
    return out
  }

  async addConversationTag(conversationId: string, tagId: string): Promise<void> {
    await this.write(
      `INSERT OR IGNORE INTO chat_conversation_tags (user_id, conversation_id, tag_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
      conversationId, tagId, Date.now(),
    )
    await this.write(`UPDATE chat_conversations SET updated_at = ?2 WHERE user_id = ?1 AND id = ?3`, Date.now(), conversationId)
  }

  async removeConversationTag(conversationId: string, tagId: string): Promise<void> {
    await this.write(
      `DELETE FROM chat_conversation_tags WHERE user_id = ?1 AND conversation_id = ?2 AND tag_id = ?3`,
      conversationId, tagId,
    )
  }

  /** The reader's own tags, straight from the notebook's tag table. */
  async conversationTags(): Promise<ConversationTag[]> {
    const rows = await this.rows<{ id: string, name: string, color: string | null, is_pinned: number }>(
      // `COLLATE NOCASE` is what the notes tag list orders by, and without it `"Zebra"` beats
      // `"apple"`, which is the one ordering a reader notices.
      `SELECT id, name, color, is_pinned FROM tags WHERE user_id = ?1 ORDER BY name COLLATE NOCASE`,
      this.userId,
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? null,
      isPinned: row.is_pinned === 1,
    }))
  }

  /** A folder the reader actually owns and has not deleted; the route turns a false into a 400. */
  async knownFolder(folderId: string): Promise<boolean> {
    return !!(await this.one<{ id: string }>(
      `SELECT id FROM folders WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      this.userId, folderId,
    ))
  }

  /** Whether this account owns a live note, so a conversation cannot be labelled with a stranger's. */
  async knownNote(noteId: string): Promise<boolean> {
    return !!(await this.one<{ id: string }>(
      `SELECT id FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
      this.userId, noteId,
    ))
  }

  async knownTag(tagId: string): Promise<boolean> {
    return !!(await this.one<{ id: string }>(`SELECT id FROM tags WHERE user_id = ?1 AND id = ?2`, this.userId, tagId))
  }

  /**
   * The name a tag id carries, or `null` when the reader has no such tag.
   *
   * A chat filter arrives as an id, but the tag subtree is spelled in names, so the id has to become
   * its name before `tagScopePredicate()` can gather the descendants. `null` rather than a throw:
   * a filter naming a tag the reader does not own answers "nothing", which is what the route wants.
   */
  private async tagName(tagId: string): Promise<string | null> {
    const row = await this.one<{ name: string }>(
      `SELECT name FROM tags WHERE user_id = ?1 AND id = ?2`,
      this.userId, tagId,
    )
    return row?.name ?? null
  }

  /** How many conversations carry each tag, for the filter row. */
  async conversationTagCounts(): Promise<Map<string, number>> {
    // Joined rather than counted off the join table alone, so a tag's number describes the conversations
    // the reader would actually find under it — an archived one is out of the list the number labels.
    const rows = await this.rows<{ tag_id: string, n: number }>(
      `SELECT ct.tag_id, count(*) AS n
         FROM chat_conversation_tags ct
         JOIN chat_conversations c ON c.user_id = ct.user_id AND c.id = ct.conversation_id AND c.archived = 0 AND c.ephemeral = 0
        WHERE ct.user_id = ?1 GROUP BY ct.tag_id`,
      this.userId,
    )
    return new Map(rows.map((row) => [row.tag_id, row.n]))
  }

  async getConversation(id: string): Promise<AssistantConversation | null> {
    const r = await this.one<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS},
              (SELECT count(*) FROM chat_messages m WHERE m.user_id = c.user_id AND m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE c.user_id = ?1 AND c.id = ?2`,
      this.userId, id,
    )
    return r ? toConversation(r) : null
  }

  async createConversation(
    title: string,
    folderId: string | null = null,
    ephemeral = false,
    parentId: string | null = null,
    /** The note this thread was started from, when it was started from one. */
    noteId: string | null = null,
  ): Promise<AssistantConversation> {
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_conversations (id, user_id, title, folder_id, ephemeral, parent_id, note_id, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      id, title, folderId, ephemeral ? 1 : 0, parentId, noteId, at, at,
    )
    return { id, title, pinned: false, starred: false, archived: false, ephemeral, parentId, folderId, noteId, createdAt: at, updatedAt: at, messageCount: 0, tags: [], summary: null, summaryUpto: null }
  }

  /**
   * Records where a thread came from, once.
   *
   * The first note wins: a conversation that has already said which note it belongs to is not re-labelled
   * by a later turn read beside another one, or the chip would change meaning under the reader.
   */
  async setConversationNote(id: string, noteId: string): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET note_id = ?2 WHERE user_id = ?1 AND id = ?3 AND note_id IS NULL`,
      noteId, id,
    )
  }

  /**
   * Lets the thread go of the note it was started from.
   *
   * The write-once rule above is what keeps a later turn from re-labelling a thread under the reader; it is
   * not a reason a wrong label has to stay. A thread mislabelled at creation would otherwise go on showing
   * up in that note's backlink panel forever, with nothing the reader can do about it. This one is not
   * guarded by `note_id IS NULL` — that is the row it is asked to clear.
   */
  async clearConversationNote(id: string): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET note_id = NULL WHERE user_id = ?1 AND id = ?2`,
      id,
    )
  }

  /**
   * The branch a conversation sits on: the thread it was forked from, and the threads forked off the same
   * point.
   *
   * Siblings are found by parent, not by a copied ancestor id, because a fork's parent is the only thing
   * that records where it came from. A root conversation has no parent and therefore no siblings — the
   * threads forked off it are its children, which is a different question and is answered by their own
   * `parentId`.
   */
  async conversationBranches(id: string): Promise<{
    parent: { id: string, title: string } | null,
    siblings: Array<{ id: string, title: string, updatedAt: number }>,
  } | null> {
    const conversation = await this.getConversation(id)
    if (!conversation) return null
    const parentId = conversation.parentId
    if (!parentId) return { parent: null, siblings: [] }
    const parent = await this.one<{ id: string, title: string }>(
      `SELECT id, title FROM chat_conversations WHERE user_id = ?1 AND id = ?2`,
      this.userId, parentId,
    )
    const siblings = await this.rows<{ id: string, title: string, updated_at: number }>(
      `SELECT id, title, updated_at FROM chat_conversations
        WHERE user_id = ?1 AND parent_id = ?2
        ORDER BY created_at, id`,
      this.userId, parentId,
    )
    return {
      parent: parent ? { id: parent.id, title: parent.title } : null,
      siblings: siblings.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at })),
    }
  }

  /**
   * A new conversation holding this one up to and including one message.
   *
   * The point of branching is to try a different answer without losing the thread that led there, so the
   * rows are copied rather than referenced: the two conversations then diverge freely, and deleting
   * either leaves the other whole. The copied turns keep their words, their thinking, their tools and
   * their verdicts, and the fork keeps the note the thread started from; only the ids and the timestamps
   * are new, because the rowid is what orders a thread.
   *
   * The summary is deliberately not copied. It describes a conversation that ended somewhere else, and
   * carrying it would have the fork summarised by a rollup of turns it does not have.
   */
  async forkConversation(from: string, uptoMessageId: string, title: string, ephemeral = false): Promise<AssistantConversation | null> {
    const source = await this.getConversation(from)
    if (!source) return null
    // Every turn of the source, because the cut can be anywhere in it: a fork made from one page would
    // copy the end of a conversation and leave its beginning behind, and the reader would never be told.
    const rows = await this.allMessages(from)
    const cut = rows.findIndex((row) => row.id === uptoMessageId)
    if (cut < 0) return null
    const fork = await this.createConversation(title, source.folderId, ephemeral, from, source.noteId)
    const base = Date.now()
    for (const [index, row] of rows.slice(0, cut + 1).entries()) {
      await this.addMessage({
        conversationId: fork.id,
        role: row.role,
        content: row.content,
        reasoning: row.reasoning ?? '',
        tools: row.tools,
        attachments: row.attachments ?? [],
        status: row.status,
        error: row.error,
        source: row.source,
        usage: row.usage ?? null,
        durationMs: row.durationMs,
        modelLabel: row.modelLabel,
        // What an answer cited and what the turn was allowed to read are part of the turn, not of the
        // thread: dropped here, a fork would show the same words with the provenance gone, and the reader
        // could no longer tell an answer that was grounded from one that was guessed.
        ...(row.sources ? { sources: row.sources } : {}),
        ...(row.scopes ? { scopes: row.scopes } : {}),
        // One millisecond apart so the copied thread keeps the order it was read in: `addMessage` stamps
        // `created_at` itself and a loop over the same tick would give every row the same one.
        createdAt: base + index,
      })
    }
    return (await this.getConversation(fork.id)) ?? fork
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET title = ?2, updated_at = ?3 WHERE user_id = ?1 AND id = ?4`,
      title, Date.now(), id,
    )
  }

  async setConversationStarred(id: string, starred: boolean): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET starred = ?2 WHERE user_id = ?1 AND id = ?3`,
      starred ? 1 : 0, id,
    )
  }

  async setConversationPinned(id: string, pinned: boolean): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET pinned = ?2 WHERE user_id = ?1 AND id = ?3`,
      pinned ? 1 : 0, id,
    )
  }

  /**
   * Put a conversation away, or take it back out.
   *
   * Archiving is not deleting and not starring: the thread stays whole, stays searchable and stays in the
   * backup, and only the everyday list stops showing it. That is why it is a column of its own rather than
   * a second meaning for one of the two flags already here.
   */
  async setConversationArchived(id: string, archived: boolean): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET archived = ?2 WHERE user_id = ?1 AND id = ?3`,
      archived ? 1 : 0, id,
    )
  }

  async setSummary(id: string, summary: string, upto: number): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET summary = ?2, summary_upto = ?3 WHERE user_id = ?1 AND id = ?4`,
      summary.slice(0, 4000), upto, id,
    )
  }

  /**
   * Drop the rollup a conversation was carrying.
   *
   * The summary is a paragraph about a span of rows, and the next turn only ever rolls forward from the
   * mark it was written at. A transcript that lost a turn — or whose turn was retyped — is no longer the
   * one that paragraph describes, so it goes rather than standing over words that have changed.
   */
  async clearSummary(id: string): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET summary = NULL, summary_upto = NULL WHERE user_id = ?1 AND id = ?2`,
      id,
    )
  }

  /**
   * Note that a conversation wrote a note.
   *
   * Written after the note's own write succeeded, so a thread that tried and failed does not claim a
   * note it never touched. One row per (note, conversation): a thread that appends three times is one
   * origin, and the panel lists threads rather than edits. The timestamp is refreshed on every later
   * write, because the question the panel answers is "which exchange produced this", and the most
   * recent one is the useful answer.
   */
  async recordNoteWrite(noteId: string, conversationId: string): Promise<void> {
    await this.write(
      `INSERT INTO chat_note_writes (user_id, note_id, conversation_id, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, note_id, conversation_id) DO UPDATE SET created_at = excluded.created_at`,
      noteId, conversationId, Date.now(),
    )
  }

  /** The conversations that wrote this note, newest first: the note's "from a conversation" backlinks. */
  async noteWriteOrigins(noteId: string, limit = 5): Promise<Array<{ id: string, title: string, updatedAt: number }>> {
    const rows = await this.rows<{ id: string, title: string, updated_at: number }>(
      `SELECT c.id AS id, c.title AS title, c.updated_at AS updated_at
         FROM chat_note_writes w
         JOIN chat_conversations c ON c.user_id = w.user_id AND c.id = w.conversation_id
        WHERE w.user_id = ?1 AND w.note_id = ?2
        ORDER BY w.created_at DESC LIMIT ?3`,
      this.userId, noteId, Math.max(1, Math.min(20, limit)),
    )
    return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }))
  }

  /**
   * Every file the conversation's turns carried.
   *
   * Read before the rows go, because the ids live inside each message's JSON: once the turns are
   * deleted there is nothing left to say which objects belonged to them, and the bytes would sit in
   * storage for a conversation that no longer exists.
   */
  async conversationAttachmentIds(id: string): Promise<string[]> {
    const rows = await this.rows<{ attachments: string | null }>(
      `SELECT attachments FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2`,
      this.userId, id,
    )
    const ids = new Set<string>()
    for (const row of rows) {
      const parsed = parseJson(row.attachments)
      if (!Array.isArray(parsed)) continue
      for (const value of parsed) if (typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{6,64}$/.test(value)) ids.add(value)
    }
    return [...ids]
  }

  /** Every attachment row this account owns, so "delete everything" can take the bytes too. */
  async allChatAttachments(): Promise<Array<{ id: string, key: string }>> {
    return await this.rows<{ id: string, key: string }>(
      `SELECT id, key FROM chat_attachments WHERE user_id = ?1`,
      this.userId,
    )
  }

  /**
   * The rows behind any number of ids, in batches.
   *
   * `chatAttachments` caps at one turn's worth because that is what a turn carries; deleting a whole
   * thread asks about every file it ever used, which can be far more than one statement's parameter
   * budget allows.
   */
  async chatAttachmentRows(ids: readonly string[]): Promise<Array<{ id: string, key: string }>> {
    const out: Array<{ id: string, key: string }> = []
    for (let index = 0; index < ids.length; index += ATTACHMENT_DELETE_BATCH) {
      const q = new Query(this.userId)
      q.inList('id', ids.slice(index, index + ATTACHMENT_DELETE_BATCH))
      out.push(...await this.rows<{ id: string, key: string }>(
        `SELECT id, key FROM chat_attachments WHERE ${q.where}`,
        ...q.binds,
      ))
    }
    return out
  }

  /** Removes the rows of files whose objects are about to go (or already have). */
  async deleteChatAttachments(ids: readonly string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += ATTACHMENT_DELETE_BATCH) {
      const q = new Query(this.userId)
      q.inList('id', ids.slice(index, index + ATTACHMENT_DELETE_BATCH))
      await this.runScoped(`DELETE FROM chat_attachments WHERE ${q.where}`, ...q.binds)
    }
  }

  async deleteConversation(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_answer_versions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_pending_actions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_active_runs WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_conversation_tags WHERE user_id = ?1 AND conversation_id = ?2`, id)
    // A draft belongs to its thread: a conversation the reader deleted must not leave one behind to be
    // found by nothing, and its history goes with the draft.
    await this.write(`DELETE FROM chat_artifact_versions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_artifacts WHERE user_id = ?1 AND conversation_id = ?2`, id)
    // The origin of a note the thread wrote goes with it: a backlink panel must not offer to open a
    // conversation that no longer exists.
    await this.write(`DELETE FROM chat_note_writes WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_conversations WHERE user_id = ?1 AND id = ?2`, id)
  }

  async deleteAllConversations(): Promise<number> {
    const before = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE user_id = ?1`,
      this.userId,
    )
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_answer_versions WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_pending_actions WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_active_runs WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_conversation_tags WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_artifact_versions WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_artifacts WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_note_writes WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_conversations WHERE user_id = ?1`)
    return before?.n ?? 0
  }

  /**
   * Delete the temporary conversations whose retention has run out.
   *
   * Measured from `updated_at` rather than `created_at`, so a thread the reader came back to is not
   * deleted under them. The cascade is the reader's own delete, because a message or a draft left behind
   * by a sweep is exactly the trace this feature exists to leave behind.
   */
  async purgeEphemeral(before: number, limit = 50): Promise<number> {
    const rows = await this.rows<{ id: string }>(
      `SELECT id FROM chat_conversations
        WHERE user_id = ?1 AND ephemeral = 1 AND updated_at < ?2
        ORDER BY updated_at LIMIT ?3`,
      this.userId, before, limit,
    )
    for (const row of rows) await this.deleteConversation(row.id)
    return rows.length
  }

  // -------------------------------------------------------------------- drafts
  /**
   * The drafts one conversation keeps, newest change first.
   *
   * Ordered by when they were last touched rather than when they were made: a reader working across three
   * of them wants the one they were just in at the top, and the created-at order would bury it.
   */
  async listArtifacts(conversationId: string): Promise<AssistantArtifact[]> {
    const list = await this.rows<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM chat_artifacts
        WHERE user_id = ?1 AND conversation_id = ?2
        ORDER BY updated_at DESC, id DESC`,
      this.userId, conversationId,
    )
    return list.map(toArtifact)
  }

  async getArtifact(id: string): Promise<AssistantArtifact | null> {
    const row = await this.one<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM chat_artifacts WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return row ? toArtifact(row) : null
  }

  /** How many a conversation already carries, so the route can refuse one past the cap before inserting it. */
  async countArtifacts(conversationId: string): Promise<number> {
    const row = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_artifacts WHERE user_id = ?1 AND conversation_id = ?2`,
      this.userId, conversationId,
    )
    return row?.n ?? 0
  }

  /**
   * Make a draft, optionally already linked to the note it became.
   *
   * `note_id` is the link the panel syncs through. It is set at creation only when a caller is making a
   * draft out of an existing note; the ordinary draft starts unlinked and gains the link when the reader
   * files it. The first version is written with the draft so a history opened on a brand-new draft is a
   * list of one rather than an empty panel.
   */
  async createArtifact(input: {
    conversationId: string
    title: string
    content: string
    noteId?: string | null
    source?: 'user' | 'assistant'
    messageId?: string | null
  }): Promise<AssistantArtifact> {
    const id = newId()
    const at = Date.now()
    const title = input.title.slice(0, MAX_ARTIFACT_TITLE_CHARS)
    const content = input.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS)
    const noteId = input.noteId ?? null
    const source = input.source ?? 'user'
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO chat_artifacts (id, user_id, conversation_id, title, content, note_id, version, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
      ).bind(this.userId, id, input.conversationId, title, content, noteId, at),
      this.db.prepare(
        `INSERT INTO chat_artifact_versions
           (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
         VALUES (?2, ?1, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(this.userId, newId(), id, input.conversationId, title, content, source, input.messageId ?? null, at),
    ])
    return {
      id,
      conversationId: input.conversationId,
      title,
      content,
      noteId,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }
  }

  /**
   * Rewrite a draft's name, its body, or the note it is linked to.
   *
   * A field that is not named keeps what it had, so a title typed after a body edit does not blank the
   * body. `noteId: null` is a real answer — it unlinks the draft — which is why it is tested against
   * `undefined` rather than for truthiness.
   *
   * A manual edit updates the head version in place: the reader is still working on the same draft, and
   * a version per keystroke would make the history useless. An assistant edit appends, because its whole
   * point is that the text before it can be returned to. `baseVersion` is the optimistic guard: a writer
   * that read version 4 must not overwrite a version 5 that arrived while it was thinking.
   */
  async updateArtifact(
    id: string,
    patch: { title?: string, content?: string, noteId?: string | null },
    options: { source?: 'user' | 'assistant', baseVersion?: number, messageId?: string | null } = {},
  ): Promise<AssistantArtifact | null> {
    const existing = await this.getArtifact(id)
    if (!existing) return null
    if (options.baseVersion !== undefined && options.baseVersion !== existing.version) {
      throw new ArtifactVersionConflictError(existing)
    }
    const title = patch.title === undefined ? existing.title : patch.title.slice(0, MAX_ARTIFACT_TITLE_CHARS)
    const content = patch.content === undefined ? existing.content : patch.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS)
    const noteId = patch.noteId === undefined ? existing.noteId : patch.noteId
    const at = Date.now()
    const contentChanged = title !== existing.title || content !== existing.content
    const assistant = options.source === 'assistant' && contentChanged
    const nextVersion = assistant ? existing.version + 1 : existing.version
    const statements: D1PreparedStatement[] = [
      // A draft restored from a backup written before versions has no head row. Writing it first keeps
      // the in-place update below from matching zero rows and leaving history without the head.
      this.db.prepare(
        `INSERT OR IGNORE INTO chat_artifact_versions
           (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'user', NULL, ?8)`,
      ).bind(this.userId, newId(), id, existing.conversationId, existing.version, existing.title, existing.content, existing.updatedAt),
    ]
    if (assistant) {
      statements.push(
        this.db.prepare(
          `INSERT INTO chat_artifact_versions
             (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
           VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'assistant', ?8, ?9)`,
        ).bind(this.userId, newId(), id, existing.conversationId, nextVersion, title, content, options.messageId ?? null, at),
      )
    } else if (contentChanged) {
      statements.push(
        this.db.prepare(
          `UPDATE chat_artifact_versions SET title = ?4, content = ?5
            WHERE user_id = ?1 AND artifact_id = ?2 AND version = ?3`,
        ).bind(this.userId, id, existing.version, title, content),
      )
    }
    statements.push(
      this.db.prepare(
        `UPDATE chat_artifacts SET title = ?3, content = ?4, note_id = ?5, version = ?6, updated_at = ?7
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id, title, content, noteId, nextVersion, at),
    )
    // The head is always among the newest fifty: the cutoff is strictly below the version just written,
    // so this can never prune the row the artifact points at.
    const cutoff = nextVersion - MAX_ARTIFACT_VERSIONS
    if (cutoff > 0) {
      statements.push(
        this.db.prepare(
          `DELETE FROM chat_artifact_versions
            WHERE user_id = ?1 AND artifact_id = ?2 AND version <= ?3`,
        ).bind(this.userId, id, cutoff),
      )
    }
    await this.db.batch(statements)
    return { ...existing, title, content, noteId, version: nextVersion, updatedAt: at }
  }

  /**
   * The versions of one draft, newest first, without their bodies.
   *
   * A list of fifty snapshots is not a list if each row carries the document. The single read carries the
   * body. A draft that predates versions (an old backup) gets its head row written here, once; the unique
   * key makes two concurrent reads harmless.
   */
  async listArtifactVersions(artifactId: string): Promise<AssistantArtifactVersion[]> {
    const rows = await this.rows<ArtifactVersionRow>(
      `SELECT id, artifact_id, conversation_id, version, title, '' AS content, source, message_id, created_at
         FROM chat_artifact_versions
        WHERE user_id = ?1 AND artifact_id = ?2
        ORDER BY version DESC`,
      this.userId, artifactId,
    )
    if (rows.length) return rows.map((row) => toArtifactVersion(row, false))
    const artifact = await this.getArtifact(artifactId)
    if (!artifact) return []
    // The id has to be the one the row was written with: the list is the handle the history view uses to
    // read the body, and a synthetic empty id would make the first click on an old draft fail.
    const id = newId()
    await this.db.prepare(
      `INSERT OR IGNORE INTO chat_artifact_versions
         (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'import', NULL, ?8)`,
    ).bind(this.userId, id, artifact.id, artifact.conversationId, artifact.version, artifact.title, artifact.content, artifact.updatedAt).run()
    // Read the row back rather than trusting the generated id: a concurrent first read may have won the
    // insert, and the id it wrote is the only one that exists.
    const row = await this.one<ArtifactVersionRow>(
      `SELECT id, artifact_id, conversation_id, version, title, '' AS content, source, message_id, created_at
         FROM chat_artifact_versions
        WHERE user_id = ?1 AND artifact_id = ?2 AND version = ?3`,
      this.userId, artifactId, artifact.version,
    )
    return row ? [toArtifactVersion(row, false)] : []
  }

  async getArtifactVersion(artifactId: string, versionId: string): Promise<AssistantArtifactVersion | null> {
    const row = await this.one<ArtifactVersionRow>(
      `SELECT ${ARTIFACT_VERSION_COLUMNS} FROM chat_artifact_versions
        WHERE user_id = ?1 AND artifact_id = ?2 AND id = ?3`,
      this.userId, artifactId, versionId,
    )
    return row ? toArtifactVersion(row, true) : null
  }

  /**
   * Bring an old version back as a new head.
   *
   * Append-only on purpose: restoring v2 while the head is v5 must not delete v3..v5 — the reader asked
   * to return to a text, not to forget the way back. The new row is the one the artifact points at.
   */
  async restoreArtifactVersion(artifactId: string, versionId: string): Promise<AssistantArtifact | null> {
    const [existing, old] = await Promise.all([
      this.getArtifact(artifactId),
      this.getArtifactVersion(artifactId, versionId),
    ])
    if (!existing || !old) return null
    const at = Date.now()
    const nextVersion = existing.version + 1
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT OR IGNORE INTO chat_artifact_versions
           (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'user', NULL, ?8)`,
      ).bind(this.userId, newId(), artifactId, existing.conversationId, existing.version, existing.title, existing.content, existing.updatedAt),
      this.db.prepare(
        `INSERT INTO chat_artifact_versions
           (id, user_id, artifact_id, conversation_id, version, title, content, source, message_id, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'restore', NULL, ?8)`,
      ).bind(this.userId, newId(), artifactId, existing.conversationId, nextVersion, old.title, old.content ?? '', at),
      this.db.prepare(
        `UPDATE chat_artifacts SET title = ?3, content = ?4, version = ?5, updated_at = ?6
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, artifactId, old.title, old.content ?? '', nextVersion, at),
    ]
    const cutoff = nextVersion - MAX_ARTIFACT_VERSIONS
    if (cutoff > 0) {
      statements.push(
        this.db.prepare(
          `DELETE FROM chat_artifact_versions
            WHERE user_id = ?1 AND artifact_id = ?2 AND version <= ?3`,
        ).bind(this.userId, artifactId, cutoff),
      )
    }
    await this.db.batch(statements)
    return { ...existing, title: old.title, content: old.content ?? '', version: nextVersion, updatedAt: at }
  }

  async deleteArtifact(id: string): Promise<boolean> {
    const [, artifact] = await this.db.batch([
      this.db.prepare(`DELETE FROM chat_artifact_versions WHERE user_id = ?1 AND artifact_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM chat_artifacts WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id),
    ])
    return (artifact.meta?.changes ?? 0) > 0
  }

  /**
   * One page of a thread, newest last — not the whole thread.
   *
   * Bounded on purpose: opening a conversation costs the newest page, and the context window the model is
   * sent asks the same way. Anything that has to see every turn (an export, a fork, a delete by position)
   * goes through {@link allMessages}, which walks this cursor back to the first row instead of making one
   * page bigger and moving the cliff.
   */
  async messages(
    conversationId: string,
    limit = MESSAGE_READ_PAGE,
    page: {
      /**
       * The oldest message already on screen. Absent reads the newest page; present reads the page just
       * before it, so "load earlier" walks backwards without an offset that a new turn would shift.
       */
      before?: { createdAt: number, id: string } | null
      /**
       * Read the page that *ends* at this message instead of the newest one.
       *
       * A search hit can be hundreds of turns up. Opening the thread at the newest page and walking back
       * would take as many round trips as the hit is old, so the window is asked for around the hit.
       */
      upto?: { createdAt: number, id: string } | null
    } = {},
  ): Promise<AssistantMessage[]> {
    const before = page.before ?? null
    const upto = page.upto ?? null
    const boundary = before
      ? `AND (created_at < ?4 OR (created_at = ?4 AND rowid < (
           SELECT rowid FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2 AND id = ?5)))`
      : upto
        ? `AND (created_at < ?4 OR (created_at = ?4 AND rowid <= (
             SELECT rowid FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2 AND id = ?5)))`
        : ''
    const list = boundary
      ? await this.rows<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}, version_count FROM (
           SELECT rowid AS seq, ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages
            WHERE user_id = ?1 AND conversation_id = ?2 ${boundary}
            ORDER BY created_at DESC, seq DESC LIMIT ?3
         ) ORDER BY ${MESSAGE_ORDER}`,
        this.userId, conversationId, limit, (before ?? upto)!.createdAt, (before ?? upto)!.id,
      )
      : await this.rows<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}, version_count FROM (
           SELECT rowid AS seq, ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages
            WHERE user_id = ?1 AND conversation_id = ?2
            ORDER BY created_at DESC, seq DESC LIMIT ?3
         ) ORDER BY ${MESSAGE_ORDER}`,
        this.userId, conversationId, limit,
      )
    return list.map(toMessage)
  }

  /**
   * The whole thread, oldest first.
   *
   * Walks {@link messages} backwards from its newest page until the rows run out, because one page is not
   * the conversation: an export that took only it silently dropped the beginning and handed back a file
   * that looked complete, and a fork or an edit that looked for a turn above that page found nothing to
   * act on. Raising the page size instead would only move the cliff to wherever the next number lands.
   */
  async allMessages(conversationId: string, page = MESSAGE_READ_PAGE): Promise<AssistantMessage[]> {
    const pages: AssistantMessage[][] = []
    let before: { createdAt: number, id: string } | null = null
    for (;;) {
      const rows = await this.messages(conversationId, page, { before })
      if (!rows.length) break
      pages.unshift(rows)
      if (rows.length < page) break
      // The cursor names the oldest row read so far, so the next page cannot repeat it even when a whole
      // turn was written in the same millisecond.
      before = { createdAt: rows[0]!.createdAt, id: rows[0]!.id }
    }
    return pages.flat()
  }

  /**
   * The turns that follow one message, oldest first, up to `limit` of them.
   *
   * Positioned from the message itself rather than from the newest page, so a turn hundreds of rows up is
   * still found: editing a question has to remove the answer under it, and deleting one has to know what
   * pairs with it. Absent `limit` is the rest of the thread, which is what an edit takes with it.
   */
  async messagesAfter(conversationId: string, messageId: string, limit?: number): Promise<AssistantMessage[]> {
    const anchor = await this.getMessage(messageId)
    if (!anchor || anchor.conversationId !== conversationId) return []
    const q = new Query(this.userId)
    q.eq('conversation_id', conversationId)
    const createdAt = q.add(anchor.createdAt)
    const anchorId = q.add(anchor.id)
    // The rowid breaks a tie the way every other read of a thread does: two turns written in one
    // millisecond still have an order, and `id` is a ULID that says nothing about it.
    q.raw(`(created_at > ${createdAt} OR (created_at = ${createdAt} AND rowid > (
       SELECT rowid FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2 AND id = ${anchorId})))`)
    const cap = limit === undefined ? '' : `LIMIT ${q.add(limit)}`
    const rows = await this.rows<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}, version_count FROM (
         SELECT rowid AS seq, ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages
          WHERE ${q.where}
          ORDER BY created_at ASC, seq ASC ${cap}
       ) ORDER BY ${MESSAGE_ORDER}`,
      ...q.binds,
    )
    return rows.map(toMessage)
  }

  async addMessage(input: {
    conversationId: string
    role: 'user' | 'assistant'
    content: string
    reasoning?: string
    tools?: ToolActivity[]
    attachments?: string[]
    status?: AssistantMessage['status']
    error?: string | null
    id?: string
    usage?: { inputTokens: number, outputTokens: number } | null
    durationMs?: number
    modelLabel?: string
    source?: 'chat' | 'import'
    sources?: AssistantSource[]
    /** What this turn was allowed to read, kept so the transcript can say why an answer knew so little. */
    scopes?: AssistantTurnScope[]
    /** Follow-up chips the naming pass volunteered for this answer, clipped to the same shape the read uses. */
    suggestions?: string[]
    createdAt?: number
  }): Promise<AssistantMessage> {
    const id = input.id ?? newId()
    const at = input.createdAt ?? Date.now()
    const tools = input.tools ?? []
    const attachments = (input.attachments ?? []).slice(0, MAX_CHAT_ATTACHMENTS)
    const status = input.status ?? 'complete'
    const error = input.error ?? null
    const source = input.source ?? 'chat'
    const usage = input.usage ?? null
    const durationMs = Math.max(0, Math.round(input.durationMs ?? 0))
    // The reader's own words are stored as written; a trace is bounded before it lands, because a thinking
    // model can produce more of it than a row should carry.
    const reasoning = clipReasoning(input.reasoning ?? '')
    const suggestionList = clipSuggestionList(input.suggestions ?? [])
    await this.write(
      `INSERT INTO chat_messages
         (id, user_id, conversation_id, role, content, reasoning, tools, attachments, status, error, source, input_tokens, output_tokens, duration_ms, model_label, feedback, sources, scopes, suggestions, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, '', ?17, ?18, ?19, ?16)`,
      id, input.conversationId, input.role, input.content, reasoning, JSON.stringify(tools), JSON.stringify(attachments),
      status, error, source, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, durationMs, input.modelLabel ?? '', at,
      JSON.stringify(input.sources ?? []),
      JSON.stringify((input.scopes ?? []).slice(0, MAX_TURN_SCOPES)),
      JSON.stringify(suggestionList),
    )
    await this.write(
      `UPDATE chat_conversations SET updated_at = ?2 WHERE user_id = ?1 AND id = ?3`,
      Math.max(at, Date.now()), input.conversationId,
    )
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      reasoning,
      tools,
      attachments,
      status,
      error,
      source,
      createdAt: at,
      usage,
      durationMs,
      modelLabel: input.modelLabel ?? '',
      // The pages this answer leaned on are filed above, so they belong on the row handed back: the live
      // turn is rendered from *this* object, and a return that drops them shows an answer that searched
      // with no citation under it until the thread is opened again and read from the table.
      sources: input.sources ?? [],
      ...(suggestionList.length ? { suggestions: suggestionList } : {}),
    }
  }

  /** One message by id, for the routes that have to check it belongs to the thread they were given. */
  async getMessage(id: string): Promise<AssistantMessage | null> {
    const r = await this.one<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toMessage(r) : null
  }

  /**
   * Deletes a set of turns the reader picked out, without the pairing a single delete applies.
   *
   * One message's own delete takes its neighbour with it, because half a turn is not a turn. A selection
   * is different: the reader pointed at exactly these rows, and adding the ones they did not point at
   * would delete something they can see on screen. Ids that are not this conversation's are ignored
   * rather than refused, so a stale screen cannot delete a stranger's row.
   */
  async deleteMessages(conversationId: string, ids: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(ids.filter((id) => /^[0-9a-hjkmnp-tv-z]{6,64}$/.test(id)))]
    if (!wanted.length) return []
    // Named by id and read straight out of the table. Looking them up in one page of the thread would
    // ignore a turn the reader selected in a long conversation, and the selection would come back short
    // with no word about why. Batched because a list of ids becomes a list of bind parameters.
    const removed: { id: string, createdAt: number, seq: number }[] = []
    for (let start = 0; start < wanted.length; start += ATTACHMENT_DELETE_BATCH) {
      const q = new Query(this.userId)
      q.eq('conversation_id', conversationId)
      q.inList('id', wanted.slice(start, start + ATTACHMENT_DELETE_BATCH))
      const rows = await this.rows<{ id: string, created_at: number, seq: number }>(
        `SELECT id, rowid AS seq, created_at FROM chat_messages WHERE ${q.where} ORDER BY created_at ASC, seq ASC`,
        ...q.binds,
      )
      removed.push(...rows.map((row) => ({ id: row.id, createdAt: row.created_at, seq: row.seq })))
    }
    const chosen = removed
      .sort((left, right) => left.createdAt - right.createdAt || left.seq - right.seq)
      .map((row) => row.id)
    for (const id of chosen) await this.deleteMessage(id)
    if (chosen.length) await this.clearSummary(conversationId)
    return chosen
  }

  /**
   * Records the reader's verdict on one answer, or clears it.
   *
   * One row is touched and nothing else: the verdict is about this answer, and rewriting the turn would
   * change its place in the transcript and its version count. A message that is not this account's is
   * not found rather than updated, which is what the caller's 404 is built on.
   *
   * `reason` is kept with the verdict rather than in its own column: `feedback` already exists, and
   * widening that value keeps a downvote's reason travelling through the backup the way the verdict already
   * does, instead of adding a column the import row handling would have to name. `null` clears both.
   */
  async setMessageFeedback(id: string, feedback: MessageFeedback | null, reason?: string): Promise<boolean> {
    const result = await this.write(
      `UPDATE chat_messages SET feedback = ?3 WHERE user_id = ?1 AND id = ?2`,
      id, encodeFeedback(feedback, feedback === 'down' ? reason : undefined),
    )
    return result > 0
  }

  /**
   * Pin the follow-up chips a naming pass volunteered onto the answer that produced them.
   *
   * A separate statement rather than part of `addMessage`, because the answer is filed the moment the model
   * stops, and the chips arrive a beat later out of a second, best-effort call: the row must exist and be
   * complete before there is anything to hang off it. Scoped by `user_id` so a naming pass can only ever write
   * its own account's row — the same guard every message-column write here carries. The list is clipped again
   * on the way in, so a caller that passed a longer one cannot overfill the row. `[]` clears them.
   */
  async setMessageSuggestions(id: string, suggestions: readonly string[]): Promise<boolean> {
    const result = await this.write(
      `UPDATE chat_messages SET suggestions = ?3 WHERE user_id = ?1 AND id = ?2`,
      id, JSON.stringify(clipSuggestionList(suggestions)),
    )
    return result > 0
  }

  /**
   * Flip the reader's keep on one answer, and report what the row now holds.
   *
   * A toggle rather than a set, because the press is the whole request: the reader pointing at a bubble
   * either puts it on the shelf or takes it back, and a client that sent the state it wanted would be
   * trusted by nothing but itself. The flip is one statement — `CASE` reads the column the write is
   * already holding — so two presses that land together cannot both decide the answer is "kept".
   *
   * The value returned is read back after the write rather than computed from the intent, and null means
   * no row of this account matched: the caller's 404 is built on the same fact `setMessageFeedback`'s
   * boolean is, and neither one says anything about a row it did not look at.
   */
  async toggleMessageSaved(id: string, now = Date.now()): Promise<{ saved: boolean, savedAt: number | null } | null> {
    const changed = await this.write(
      `UPDATE chat_messages SET saved_at = CASE WHEN saved_at IS NULL THEN ?2 ELSE NULL END
        WHERE user_id = ?1 AND id = ?3`,
      now, id,
    )
    if (!changed) return null
    const row = await this.one<{ saved_at: number | null }>(
      `SELECT saved_at FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    // The row is this account's but the read came back with nothing, which leaves only a delete between
    // the two statements — a turn removed while the press was in flight. Reported as not found rather
    // than as a keep nobody stored.
    if (!row) return null
    const savedAt = num(row.saved_at)
    return { saved: savedAt !== null, savedAt }
  }

  /**
   * The answers this account kept, most recently kept first, each with the thread it belongs to.
   *
   * Keyset paging on `(saved_at, id)`, the same shape every list here uses: an offset would shift under a
   * keep made while the reader was scrolling, and the shelf is exactly the place where a keep is being
   * made. `id` breaks the tie because two answers can be kept in one millisecond, and the order has to be
   * one the next page can resume from.
   *
   * A temporary conversation is not listed, matching every other read of this table — the reader asked for
   * a thread that would not be kept, and its keeps are part of it. Its turns are deleted with it anyway, so
   * the exclusion only covers the window before the sweep.
   */
  async listSavedMessages(options: {
    limit: number
    /** Where the previous page stopped: the last kept row it showed, as the caller was given it. */
    before?: { savedAt: number, id: string } | null
  }): Promise<SavedMessage[]> {
    const q = new Query(this.userId)
    q.raw('saved_at IS NOT NULL')
    q.raw(`NOT EXISTS (SELECT 1 FROM chat_conversations c
              WHERE c.user_id = chat_messages.user_id AND c.id = chat_messages.conversation_id AND c.ephemeral = 1)`)
    const before = options.before ?? null
    if (before) {
      const savedAt = q.add(before.savedAt)
      const id = q.add(before.id)
      q.raw(`(saved_at < ${savedAt} OR (saved_at = ${savedAt} AND id < ${id}))`)
    }
    const limit = q.add(options.limit)
    // Read past the excerpt's own length: the flattening below drops leading whitespace and code fences
    // would otherwise arrive as a row of blanks, and a shorter slice than the row shows is cheaper than a
    // whole reply per row on a shelf that is only a pointer into the thread.
    const rows = await this.rows<SavedMessageRow>(
      `SELECT id, conversation_id, role, created_at, saved_at,
              substr(content, 1, ?${q.binds.length + 1}) AS excerpt
         FROM chat_messages WHERE ${q.where}
        ORDER BY saved_at DESC, id DESC LIMIT ${limit}`,
      ...q.binds, SAVED_MESSAGE_EXCERPT_READ_CHARS,
    )
    if (!rows.length) return []
    const titles = await this.conversationTitles(rows.map((row) => row.conversation_id))
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: titles.get(row.conversation_id) ?? '',
      role: row.role === 'assistant' ? 'assistant' : 'user',
      excerpt: excerptOf(row.excerpt),
      savedAt: Number(row.saved_at),
      createdAt: row.created_at,
    }))
  }

  /**
   * The titles of the threads one shelf page points into, in one read.
   *
   * The shelf shows the thread's current name rather than one copied when the answer was kept — the reader
   * renames a conversation and expects every pointer to it to follow. A thread that is gone (its turns
   * deleted under an open shelf) simply is not in the map, and the row falls back to the untitled name the
   * list already shows rather than claiming a title nobody has.
   */
  private async conversationTitles(ids: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    for (const chunk of idReadChunks([...new Set(ids)])) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      const rows = await this.rows<{ id: string, title: string }>(
        `SELECT id, title FROM chat_conversations WHERE ${q.where}`, ...q.binds,
      )
      for (const row of rows) titles.set(row.id, row.title)
    }
    return titles
  }

  async deleteMessage(id: string): Promise<void> {    await this.deleteMessageRow(id)
    // A displaced answer is worth nothing once its turn is gone, and leaving it behind would keep the
    // pager's count alive over a row that no longer exists.
    await this.write(`DELETE FROM chat_answer_versions WHERE user_id = ?1 AND message_id = ?2`, id)
  }

  /**
   * Rewrite what the reader asked.
   *
   * Only the words change here: the answer that followed them was drawn from the text that is now gone,
   * so the caller removes that turn and writes a new one. Nothing edits an answer — a model's own output
   * is what it said, and the way to replace it is to ask again.
   */
  async updateMessageContent(id: string, content: string): Promise<void> {
    await this.write(
      `UPDATE chat_messages SET content = ?2 WHERE user_id = ?1 AND id = ?3`,
      content, id,
    )
  }

  /**
   * Remove the turn's row and keep what it displaced.
   *
   * A regeneration is the only caller: it files the outgoing answer, then writes the new one back under
   * the same id. Deleting through `deleteMessage` there would erase the history it just extended.
   */
  async deleteMessageRow(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1 AND id = ?2`, id)
  }

  async lastMessage(conversationId: string): Promise<AssistantMessage | null> {
    const r = await this.one<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages
        WHERE user_id = ?1 AND conversation_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      this.userId, conversationId,
    )
    return r ? toMessage(r) : null
  }

  // ---------------------------------------------------------------- answer versions

  /**
   * File the answer a retry is displacing.
   *
   * Returns null for an answer with no words in it: a turn stopped before the first token, or one that
   * failed, is nothing the reader can page back to, and filing it would push a real answer out of the
   * retained window.
   */
  async archiveAnswerVersion(input: {
    messageId: string
    conversationId: string
    content: string
    reasoning?: string
    tools?: ToolActivity[]
    modelLabel?: string
    usage?: { inputTokens: number, outputTokens: number } | null
    durationMs?: number
    createdAt?: number
  }): Promise<AssistantAnswerVersion | null> {
    if (!input.content.trim())
      return null
    const id = newId()
    const at = input.createdAt ?? Date.now()
    const tools = input.tools ?? []
    const usage = input.usage ?? null
    const durationMs = Math.max(0, Math.round(input.durationMs ?? 0))
    const modelLabel = input.modelLabel ?? ''
    await this.write(
      `INSERT INTO chat_answer_versions
         (id, user_id, message_id, conversation_id, content, reasoning, tools, model_label, input_tokens, output_tokens, duration_ms, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      id, input.messageId, input.conversationId, input.content, input.reasoning ?? '', JSON.stringify(tools), modelLabel,
      usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, durationMs, at,
    )
    await this.write(
      `DELETE FROM chat_answer_versions
        WHERE user_id = ?1 AND message_id = ?2
          AND id NOT IN (SELECT id FROM chat_answer_versions
                          WHERE user_id = ?1 AND message_id = ?2
                          ORDER BY created_at DESC, rowid DESC LIMIT ?3)`,
      input.messageId, MAX_ANSWER_VERSIONS,
    )
    return {
      id,
      messageId: input.messageId,
      conversationId: input.conversationId,
      content: input.content,
      reasoning: input.reasoning ?? '',
      tools,
      modelLabel,
      usage,
      durationMs,
      createdAt: at,
    }
  }

  /** The displaced answers of one turn, oldest first: a pager counts from the first thing it said. */
  async listAnswerVersions(messageId: string): Promise<AssistantAnswerVersion[]> {
    const rows = await this.rows<AnswerVersionRow>(
      `SELECT ${ANSWER_VERSION_COLUMNS}
         FROM chat_answer_versions
        WHERE user_id = ?1 AND message_id = ?2
        ORDER BY created_at ASC, rowid ASC`,
      this.userId, messageId,
    )
    return rows.map(toAnswerVersion)
  }

  /**
   * Exchange the turn's live answer for one of its earlier ones.
   *
   * A swap, not a copy: the displaced answer takes the slot the chosen one vacated, so the pager keeps
   * the same count and the same order while the reader looks at something else. The notes app's version
   * history restores the same way, for the same reason — a reader has to be able to get back.
   */
  async swapAnswerVersion(messageId: string, versionId: string): Promise<AssistantMessage | null> {
    const current = await this.one<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE user_id = ?1 AND id = ?2 AND role = 'assistant'`,
      this.userId, messageId,
    )
    const chosen = await this.one<AnswerVersionRow>(
      `SELECT ${ANSWER_VERSION_COLUMNS} FROM chat_answer_versions WHERE user_id = ?1 AND id = ?2 AND message_id = ?3`,
      this.userId, versionId, messageId,
    )
    if (!current || !chosen)
      return null
    await this.write(
      `UPDATE chat_answer_versions
          SET content = ?2, reasoning = ?3, tools = ?4, model_label = ?5, input_tokens = ?6, output_tokens = ?7, duration_ms = ?8
        WHERE user_id = ?1 AND id = ?9`,
      current.content, current.reasoning ?? '', current.tools, current.model_label ?? '',
      current.input_tokens ?? 0, current.output_tokens ?? 0, current.duration_ms ?? 0, versionId,
    )
    await this.write(
      `UPDATE chat_messages
          SET content = ?2, reasoning = ?3, tools = ?4, status = 'complete', error = NULL, model_label = ?5,
              input_tokens = ?6, output_tokens = ?7, duration_ms = ?8
        WHERE user_id = ?1 AND id = ?9`,
      chosen.content, chosen.reasoning ?? '', chosen.tools, chosen.model_label,
      chosen.input_tokens ?? 0, chosen.output_tokens ?? 0, chosen.duration_ms ?? 0, messageId,
    )
    const reread = await this.one<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, messageId,
    )
    return reread ? toMessage(reread) : null
  }

  /** Drop a conversation's whole answer history with it, so deleting a thread leaves nothing behind. */
  async deleteAnswerVersionsForConversation(conversationId: string): Promise<void> {
    await this.write(`DELETE FROM chat_answer_versions WHERE user_id = ?1 AND conversation_id = ?2`, conversationId)
  }

  // ------------------------------------------------------------ external MCP servers

  /**
   * The reader's own third-party MCP servers.
   *
   * `hasKey` is computed the same way a provider's is — from the ciphertext's length — because the token
   * itself must never be selected, let alone returned by a route: the settings screen has to show whether
   * one is stored without ever carrying it back to the browser.
   */
  async listMcpServers(): Promise<AssistantMcpServer[]> {
    const rows = await this.rows<McpServerRow>(
      `SELECT id, label, url, description, transport, timeout_seconds, length(header_ciphertext) > 0 AS has_key, oauth_meta, enabled, tool_mode, tool_modes, created_at, updated_at
         FROM chat_mcp_servers WHERE user_id = ?1 ORDER BY created_at`,
      this.userId,
    )
    return rows.map(toMcpServer)
  }

  async mcpServerRecord(id: string): Promise<{ row: AssistantMcpServer, headers: Record<string, string>, ciphertext: string } | null> {
    const r = await this.one<McpServerRow & { header_ciphertext: string | null }>(
      `SELECT id, label, url, description, transport, timeout_seconds, header_ciphertext, length(header_ciphertext) > 0 AS has_key, oauth_meta, enabled, tool_mode, tool_modes, created_at, updated_at
         FROM chat_mcp_servers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    if (!r) return null
    const ciphertext = r.header_ciphertext ?? ''
    const plaintext = ciphertext ? (await decryptAssistantKey(this.env, this.userId, ciphertext)) ?? '' : ''
    return { row: toMcpServer(r), ciphertext, headers: parseMcpHeaderBlob(plaintext) }
  }

  /**
   * The stored authorization of one server, both halves.
   *
   * The plain half says what was discovered and whether a token is there; the vaulted half is the token and
   * the client's own credentials. They are read together because nothing that wants one can act on the other:
   * refreshing needs the endpoint *and* the refresh token, and a call needs the token *and* the expiry that
   * says whether to fetch a new one first.
   */
  async mcpAuthorization(id: string): Promise<{ status: McpOAuthStatus, secrets: McpOAuthSecrets } | null> {
    const r = await this.one<{ oauth_ciphertext: string | null, oauth_meta: string | null }>(
      `SELECT ${MCP_OAUTH_COLUMNS} FROM chat_mcp_servers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    const status = r ? parseMcpOAuthMeta(r.oauth_meta) : null
    if (!status) return null
    const ciphertext = r?.oauth_ciphertext ?? ''
    const secrets = ciphertext ? await decryptMcpOAuth<McpOAuthSecrets>(this.env, id, ciphertext) : null
    return { status, secrets: normaliseMcpOAuthSecrets(secrets) }
  }

  /**
   * Save what an authorization round trip produced.
   *
   * Writing the two halves together is deliberate: a status that claims a token exists while the vault holds
   * none would show the reader an authorized server that every call then refuses.
   */
  async setMcpAuthorization(id: string, status: McpOAuthStatus, secrets: McpOAuthSecrets): Promise<void> {
    // The blob is kept while there is anything worth vaulting: a token, a round trip in flight, or a client
    // registration. Writing it away on a bare logout would drop the client id too, and the next Authorize
    // press would register a second client while the first one lived on at the issuer with nothing left to
    // withdraw it.
    const ciphertext = secrets.tokens || secrets.pending || secrets.clientId
      ? await encryptMcpOAuth(this.env, id, secrets)
      : ''
    await this.write(
      `UPDATE chat_mcp_servers SET oauth_ciphertext = ?2, oauth_meta = ?3, updated_at = ?4
         WHERE user_id = ?1 AND id = ?5`,
      ciphertext, JSON.stringify(status), Date.now(), id,
    )
  }

  /**
   * Take the token away, and leave the client registration where it is.
   *
   * This is the reader logging out. The registration at the issuer is a separate thing they did — and a
   * separate thing they may still want to undo — so it stays until they say otherwise. The row keeps its
   * client id and endpoints, which is what lets the next Authorize press reuse the same client instead of
   * registering another.
   */
  async revokeMcpTokens(id: string): Promise<void> {
    const found = await this.mcpAuthorization(id)
    if (!found) return
    const { status, secrets } = found
    await this.setMcpAuthorization(id, { ...status, authorized: false, expiresAt: 0 }, {
      ...secrets, tokens: null, pending: null,
    })
  }

  /** Take the whole authorization away, client registration included: what the reader means by "uninstall". */
  async forgetMcpClient(id: string): Promise<void> {
    await this.write(
      `UPDATE chat_mcp_servers SET oauth_ciphertext = '', oauth_meta = '{}', updated_at = ?2
         WHERE user_id = ?1 AND id = ?3`,
      Date.now(), id,
    )
  }

  async createMcpServer(input: {
    label: string
    url: string
    description?: string
    transport?: AssistantMcpTransport
    timeoutSeconds?: number
    headers?: Record<string, string> | null
    toolMode?: AssistantMcpToolMode
  }): Promise<AssistantMcpServer> {
    const id = newId()
    const at = Date.now()
    const headers = input.headers ?? {}
    const ciphertext = Object.keys(headers).length ? await encryptAssistantKey(this.env, this.userId, JSON.stringify(headers)) : ''
    const label = input.label.slice(0, MAX_MCP_LABEL_CHARS)
    const description = (input.description ?? '').slice(0, MAX_MCP_DESCRIPTION_CHARS)
    const transport = input.transport ?? 'streamableHttp'
    const timeoutSeconds = clampTimeout(input.timeoutSeconds)
    await this.write(
      `INSERT INTO chat_mcp_servers (id, user_id, label, url, description, transport, timeout_seconds, header_ciphertext, enabled, tool_mode, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?10)`,
      id, label, input.url, description, transport, timeoutSeconds, ciphertext, input.toolMode ?? 'ask', at,
    )
    return {
      id, label, url: input.url, description, transport, timeoutSeconds,
      enabled: true, toolMode: input.toolMode ?? 'ask', toolModes: {},
      hasKey: Boolean(ciphertext), authorization: null, createdAt: at, updatedAt: at,
    }
  }

  async updateMcpServer(
    id: string,
    patch: {
      label?: string
      url?: string
      description?: string
      transport?: AssistantMcpTransport
      timeoutSeconds?: number
      headers?: Record<string, string> | null
      enabled?: boolean
      toolMode?: AssistantMcpToolMode
      toolModes?: Record<string, AssistantMcpToolMode>
    },
  ): Promise<AssistantMcpServer | null> {
    const existing = await this.mcpServerRecord(id)
    if (!existing) return null
    const at = Date.now()
    // An untouched header box means keep what is stored rather than clear it, and an empty one clears:
    // the form cannot send back values it was never given.
    let ciphertext = existing.ciphertext
    if (patch.headers === null) ciphertext = ''
    else if (patch.headers && Object.keys(patch.headers).length) {
      ciphertext = await encryptAssistantKey(this.env, this.userId, JSON.stringify(patch.headers))
    }
    // The exceptions are stored trimmed, de-duplicated by name and capped: they are written from a row of
    // switches, and a map that grew with every press would eventually cost more than the listing it filters.
    const toolModes = patch.toolModes === undefined
      ? existing.row.toolModes
      : Object.fromEntries(Object.entries(patch.toolModes)
        .map(([name, mode]) => [name.trim().slice(0, MAX_MCP_TOOL_NAME_CHARS), mode] as const)
        .filter(([name]) => Boolean(name))
        .slice(0, MAX_MCP_TOOL_OVERRIDES))
    // A token is minted for one resource. Retyping the address of the server therefore takes the
    // authorization with it, rather than leaving a bearer from the old issuer to be offered to the new one.
    const urlChanged = patch.url !== undefined && patch.url !== existing.row.url
    await this.write(
      `UPDATE chat_mcp_servers
          SET label = ?2, url = ?3, description = ?4, transport = ?5, timeout_seconds = ?6, header_ciphertext = ?7,
              enabled = ?8, tool_mode = ?9, tool_modes = ?10, updated_at = ?11,
              oauth_ciphertext = CASE WHEN ?12 THEN '' ELSE oauth_ciphertext END,
              oauth_meta = CASE WHEN ?12 THEN '{}' ELSE oauth_meta END
        WHERE user_id = ?1 AND id = ?13`,
      (patch.label ?? existing.row.label).slice(0, MAX_MCP_LABEL_CHARS),
      patch.url ?? existing.row.url,
      (patch.description ?? existing.row.description).slice(0, MAX_MCP_DESCRIPTION_CHARS),
      patch.transport ?? existing.row.transport,
      clampTimeout(patch.timeoutSeconds ?? existing.row.timeoutSeconds),
      ciphertext,
      patch.enabled === undefined ? (existing.row.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      patch.toolMode ?? existing.row.toolMode,
      JSON.stringify(toolModes),
      at,
      urlChanged ? 1 : 0,
      id,
    )
    const reread = await this.one<McpServerRow>(
      `SELECT id, label, url, description, transport, timeout_seconds, length(header_ciphertext) > 0 AS has_key, oauth_meta, enabled, tool_mode, tool_modes, created_at, updated_at
         FROM chat_mcp_servers WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return reread ? toMcpServer(reread) : null
  }

  async deleteMcpServer(id: string): Promise<boolean> {
    return (await this.write(`DELETE FROM chat_mcp_servers WHERE user_id = ?1 AND id = ?2`, id)) > 0
  }

  /** Enabled servers only: a disabled one must not reach the model through any path. */
  async enabledMcpServers(): Promise<AssistantMcpServer[]> {
    return (await this.listMcpServers()).filter((server) => server.enabled && server.toolMode !== 'off')
  }

  // ---------------------------------------------------------------- memories

  /**
   * The status filter as SQL.
   *
   * `review` means "flagged as unsure, or named by an open conflict", which is what the Memory page's
   * needs-review tab has to show; a memory whose review was resolved drops out of it by itself.
   */
  private statusClause(status: string): string {
    switch (status) {
      case 'active': return `status = 'active'`
      case 'current': return `status != 'historical'`
      case 'historical': return `status = 'historical'`
      case 'uncertain': return `status = 'uncertain'`
      case 'review': return `(status = 'uncertain' OR id IN (
        SELECT memory_id FROM chat_memory_reviews WHERE user_id = ?1
        UNION SELECT other_id FROM chat_memory_reviews WHERE user_id = ?1))`
      default: return `1 = 1`
    }
  }

  // ------------------------------------------------------ memory embeddings
  //
  // The vectors live beside the memories, never inside them: a memory row is shown and edited, and a
  // 1024-float blob in every listing would be paid for on every read.

  async upsertMemoryEmbedding(memoryId: string, model: string, vector: ArrayBuffer, norm: number): Promise<void> {
    await this.write(
      `INSERT INTO chat_memory_embeddings (user_id, memory_id, model, vector, norm, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(user_id, memory_id) DO UPDATE SET model = excluded.model, vector = excluded.vector,
         norm = excluded.norm, updated_at = excluded.updated_at`,
      memoryId, model, vector, norm, Date.now(),
    )
  }

  async memoryEmbeddingCount(): Promise<number> {
    const row = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_memory_embeddings WHERE user_id = ?1`,
      this.userId,
    )
    return row?.n ?? 0
  }

  /** Memories a re-index still owes a vector for; historical ones are recalled by their own rules. */
  async memoriesWithoutEmbedding(model: string, limit = 200): Promise<{ id: string, content: string }[]> {
    const q = new Query(this.userId)
    const modelBind = q.add(model)
    const limitBind = q.add(limit)
    return await this.rows<{ id: string, content: string }>(
      `SELECT m.id, m.content FROM chat_memories m
        WHERE ${q.where} AND m.status IN ('active', 'uncertain')
          AND NOT EXISTS (SELECT 1 FROM chat_memory_embeddings e
                           WHERE e.user_id = ?1 AND e.memory_id = m.id AND e.model = ${modelBind})
        ORDER BY m.updated_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
  }

  /** Every stored vector with its memory, for the cosine scan a turn does at recall time. */
  async memoryEmbeddingsWithMemory(
    model: string,
    statuses: readonly string[],
    limit = 500,
    scope?: MemoryScope,
  ): Promise<{ memory: AssistantMemory, vector: ArrayBuffer, norm: number | null }[]> {
    if (!statuses.length) return []
    const q = new Query(this.userId)
    const modelBind = q.add(model)
    q.inList('m.status', statuses)
    // Qualified: both tables in this join carry a `user_id`, so an unqualified column here would be a
    // name the database has to guess at.
    applyMemoryScope(q, scope, 'm.project_id')
    const limitBind = q.add(limit)
    const columns = MEMORY_COLUMNS.split(', ').map((column) => `m.${column}`).join(', ')
    const rows = await this.rows<MemoryRow & { vector: ArrayBuffer, norm: number | null }>(
      `SELECT ${columns}, e.vector, e.norm
         FROM chat_memory_embeddings e JOIN chat_memories m
           ON m.user_id = e.user_id AND m.id = e.memory_id
        WHERE ${q.where} AND e.model = ${modelBind}
        ORDER BY e.updated_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    return rows.map((row) => ({ memory: toMemory(row), vector: row.vector, norm: row.norm }))
  }

  async deleteMemoryEmbedding(memoryId: string): Promise<void> {
    await this.write(
      `DELETE FROM chat_memory_embeddings WHERE user_id = ?1 AND memory_id = ?2`,
      memoryId,
    )
  }

  async clearMemoryEmbeddings(): Promise<number> {
    const before = await this.memoryEmbeddingCount()
    await this.write(`DELETE FROM chat_memory_embeddings WHERE user_id = ?1`)
    return before
  }

  /**
   * The saved facts, narrowed by whatever the caller names.
   *
   * `noteId` is the one filter that arrives from the notebook rather than from the memory page: standing on
   * a page, "what does the assistant remember about this?" is asked by the page, and the answer is the rows
   * that were written out of it. It is an equality on the account's own rows — `Query` puts `user_id = ?1`
   * in front of every clause — so a note id copied out of another account's backup can only ever match
   * nothing here. An empty string is the same kind of mistake as a malformed id and narrows to nothing,
   * which is what the caller asked for; the whole library is what an *absent* filter means.
   */
  async listMemories(opts: { query?: string, category?: string, status?: string, noteId?: string, limit?: number, scope?: MemoryScope } = {}): Promise<AssistantMemory[]> {
    const q = new Query(this.userId).raw(this.statusClause(opts.status ?? 'all'))
    applyMemoryScope(q, opts.scope)
    if (opts.noteId !== undefined) q.eq('note_id', opts.noteId)
    if (opts.category) q.eq(`category`, opts.category)
    if (opts.query) q.raw(`content LIKE ${q.add(containsPattern(opts.query))} ESCAPE '\\'`)
    const limit = q.add(opts.limit ?? 500)
    const list = await this.rows<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE ${q.where} ORDER BY updated_at DESC LIMIT ${limit}`,
      ...q.binds,
    )
    return list.map(toMemory)
  }

  /**
   * How many facts the caller's filter answers with.
   *
   * The note filter rides along with the status because the two are read together by the same route: a
   * listing that says three rows beside a header that counted the account's whole library is a number the
   * answer does not support.
   */
  async countMemories(status?: string, noteId?: string): Promise<number> {
    const q = new Query(this.userId).raw(this.statusClause(status ?? 'all'))
    if (noteId !== undefined) q.eq('note_id', noteId)
    const r = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_memories WHERE ${q.where}`,
      ...q.binds,
    )
    return r?.n ?? 0
  }

  /**
   * Keyword recall for the prompt.
   *
   * LIKE rather than the app's FTS5 index is deliberate: `notes_fts` tokenises with `unicode61`, which
   * treats a whole Chinese sentence as one token, so an FTS memory search would find nothing for the
   * queries this app's readers type. Substring matching over a set that is small by design is what
   * makes a two-character Chinese query recall the sentence that contains it.
   */
  async searchMemories(query: string, limit = 8, status: 'current' | 'all' = 'current', scope?: MemoryScope): Promise<AssistantMemory[]> {
    const terms = memorySearchTerms(query)
    if (!terms.length) return []
    const q = new Query(this.userId)
    if (status === 'current') q.raw(`status != 'historical'`)
    applyMemoryScope(q, scope)
    q.or(terms.map((term) => `content LIKE ${q.add(containsPattern(term))} ESCAPE '\\'`))
    const limitBind = q.add(limit)
    const list = await this.rows<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE ${q.where}
        ORDER BY (CASE WHEN status = 'active' THEN 0 ELSE 1 END), updated_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    return list.map(toMemory)
  }

  async getMemory(id: string): Promise<AssistantMemory | null> {
    const r = await this.one<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toMemory(r) : null
  }

  async getManyMemories(ids: string[]): Promise<AssistantMemory[]> {
    if (!ids.length) return []
    const q = new Query(this.userId)
    const placeholders = ids.map((id) => q.add(id)).join(', ')
    const list = await this.rows<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE user_id = ?1 AND id IN (${placeholders})`,
      ...q.binds,
    )
    return list.map(toMemory)
  }

  async insertMemory(input: {
    content: string
    category: AssistantMemoryCategory
    source: AssistantMemorySource
    validFrom?: string | null
    status?: AssistantMemoryStatus
    /** The project the fact was learned in; null for one that belongs to the account. */
    projectId?: string | null
  }): Promise<AssistantMemory> {
    const id = newId()
    const at = Date.now()
    const status = input.status ?? 'active'
    const validFrom = input.validFrom ?? null
    const projectId = input.projectId ?? null
    await this.write(
      `INSERT INTO chat_memories
         (id, user_id, content, category, source, status, superseded_by, valid_from, valid_until, project_id, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, NULL, ?7, NULL, ?8, ?9, ?10)`,
      id, input.content, input.category, input.source, status, validFrom, projectId, at, at,
    )
    await this.embedQuietly(id, input.content)
    return {
      id,
      content: input.content,
      category: input.category,
      source: input.source,
      status,
      supersededBy: null,
      validFrom,
      validUntil: null,
      projectId,
      noteId: null,
      createdAt: at,
      updatedAt: at,
    }
  }

  /**
   * An identical current memory exists: refresh it rather than storing the same fact twice.
   *
   * Scoped, because the same sentence can be a fact in two different projects and they are two facts:
   * "the budget is 40k" said about one client is not a reason to drop the other client's.
   */
  async findDuplicateMemory(content: string, scope?: MemoryScope): Promise<AssistantMemory | null> {
    const q = new Query(this.userId)
    const contentBind = q.add(content)
    applyMemoryScope(q, scope)
    const r = await this.one<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories
        WHERE ${q.where} AND content = ${contentBind} COLLATE NOCASE AND status != 'historical'
        ORDER BY updated_at DESC LIMIT 1`,
      ...q.binds,
    )
    if (!r) return null
    const at = Date.now()
    await this.write(`UPDATE chat_memories SET updated_at = ?2 WHERE user_id = ?1 AND id = ?3`, at, r.id)
    return toMemory({ ...r, updated_at: at })
  }

  async updateMemoryContent(id: string, content: string, category: AssistantMemoryCategory): Promise<AssistantMemory | null> {
    await this.write(
      `UPDATE chat_memories SET content = ?2, category = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?5`,
      content, category, Date.now(), id,
    )
    const updated = await this.getMemory(id)
    if (updated) await this.embedQuietly(updated.id, updated.content)
    return updated
  }

  /**
   * Point a memory at the note it was written out as.
   *
   * The note is created by the client — it has to choose the folder and the title, and the notes module
   * owns creating a note — so this stores the link rather than making one. A null clears it, which is
   * what a reader who deleted the note gets: the fact stays, the pointer goes.
   */
  async setMemoryNote(id: string, noteId: string | null): Promise<AssistantMemory | null> {
    await this.write(
      `UPDATE chat_memories SET note_id = ?2, updated_at = ?3 WHERE user_id = ?1 AND id = ?4`,
      noteId, Date.now(), id,
    )
    return this.getMemory(id)
  }

  async setMemoryLifecycle(
    id: string,
    fields: { status?: AssistantMemoryStatus, supersededBy?: string | null, validFrom?: string | null, validUntil?: string | null },
  ): Promise<AssistantMemory | null> {
    const existing = await this.getMemory(id)
    if (!existing) return null
    const next: AssistantMemory = {
      ...existing,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.supersededBy !== undefined ? { supersededBy: fields.supersededBy } : {}),
      ...(fields.validFrom !== undefined ? { validFrom: fields.validFrom } : {}),
      ...(fields.validUntil !== undefined ? { validUntil: fields.validUntil } : {}),
      updatedAt: Date.now(),
    }
    await this.write(
      `UPDATE chat_memories SET status = ?2, superseded_by = ?3, valid_from = ?4, valid_until = ?5, updated_at = ?6
         WHERE user_id = ?1 AND id = ?7`,
      next.status, next.supersededBy, next.validFrom, next.validUntil, next.updatedAt, id,
    )
    return next
  }

  async predecessors(id: string): Promise<AssistantMemory[]> {
    const list = await this.rows<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE user_id = ?1 AND superseded_by = ?2 ORDER BY created_at`,
      this.userId, id,
    )
    return list.map(toMemory)
  }

  /**
   * Retires one memory in favour of another, and drops the review between them, in one batch.
   *
   * The two writes are one decision: a memory marked historical whose conflict card survives would
   * offer the reader a choice that has already been made, and D1 gives no transaction to roll back
   * with — so the pair either lands together or not at all.
   */
  async supersedePair(oldId: string, newId: string, validUntil: string | null): Promise<AssistantMemory | null> {
    const at = Date.now()
    await this.db.batch([
      this.db.prepare(
        `UPDATE chat_memories SET status = 'historical', superseded_by = ?2, valid_until = ?3, updated_at = ?4
          WHERE user_id = ?1 AND id = ?5`,
      ).bind(this.userId, newId, validUntil, at, oldId),
      this.db.prepare(
        `DELETE FROM chat_memory_reviews WHERE user_id = ?1
          AND ((memory_id = ?2 AND other_id = ?3) OR (memory_id = ?3 AND other_id = ?2))`,
      ).bind(this.userId, newId, oldId),
    ])
    return this.getMemory(oldId)
  }

  /**
   * Embedding is best-effort and lives here rather than in each caller: a memory the reader saved
   * outranks a vector that failed, and a missing vector is simply reported as pending and rebuilt.
   * Doing it where the row is written is what stops the tool path, the review path and a backup
   * import from each forgetting their own copy of the rule.
   */
  private async embedQuietly(memoryId: string, content: string): Promise<void> {
    if (!this.env.AI) return
    const settings = await this.getSettings()
    if (!settings.semanticMemory) return
    try {
      const { embedMemory } = await import('./semantic')
      await embedMemory(this, this.env, { id: memoryId, content }, settings.limits.maxEmbeddingsPerDay, settings.semanticModel)
    } catch {
      // The memory is saved; the index catches up on the next write or a re-index.
    }
  }

  async deleteMemory(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_memory_reviews WHERE user_id = ?1 AND (memory_id = ?2 OR other_id = ?2)`, id)
    await this.write(`UPDATE chat_memories SET superseded_by = NULL WHERE user_id = ?1 AND superseded_by = ?2`, id)
    await this.write(`DELETE FROM chat_memories WHERE user_id = ?1 AND id = ?2`, id)
    // The vector goes with the memory: a count of stored vectors that includes a memory the reader has
    // forgotten is a number the settings card would keep showing as still indexed.
    await this.write(`DELETE FROM chat_memory_embeddings WHERE user_id = ?1 AND memory_id = ?2`, id)
  }

  async deleteAllMemories(): Promise<number> {
    const before = await this.one<{ n: number }>(`SELECT count(*) AS n FROM chat_memories WHERE user_id = ?1`, this.userId)
    await this.write(`DELETE FROM chat_memory_reviews WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_memories WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_memory_embeddings WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_activity WHERE user_id = ?1 AND type = 'memory.created'`)
    return before?.n ?? 0
  }

  async createReview(input: {
    memoryId: string
    otherId: string
    relationship: 'contradiction' | 'possible_update'
    reason: string
  }): Promise<MemoryReviewRow | null> {
    const existing = await this.one<MemoryReviewRow>(
      `SELECT * FROM chat_memory_reviews WHERE user_id = ?1 AND memory_id = ?2 AND other_id = ?3`,
      this.userId, input.memoryId, input.otherId,
    )
    if (existing) return existing
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_memory_reviews (id, user_id, memory_id, other_id, relationship, reason, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
      id, input.memoryId, input.otherId, input.relationship, input.reason.slice(0, 60), at,
    )
    return {
      id,
      memory_id: input.memoryId,
      other_id: input.otherId,
      relationship: input.relationship,
      reason: input.reason,
      created_at: at,
    }
  }

  /** Reviews whose two memories still exist; a review left pointing at a deleted memory is removed. */
  async listReviews(limit = 50): Promise<MemoryReview[]> {
    const stored = await this.rows<MemoryReviewRow>(
      `SELECT * FROM chat_memory_reviews WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
      this.userId, limit,
    )
    if (!stored.length) return []
    const ids = [...new Set(stored.flatMap((r) => [r.memory_id, r.other_id]))]
    const memories = new Map((await this.getManyMemories(ids)).map((memory) => [memory.id, memory]))
    const out: MemoryReview[] = []
    const orphan: string[] = []
    for (const r of stored) {
      const memory = memories.get(r.memory_id)
      const other = memories.get(r.other_id)
      if (!memory || !other) {
        orphan.push(r.id)
        continue
      }
      out.push({
        id: r.id,
        memory,
        other,
        relationship: r.relationship === 'possible_update' ? 'possible_update' : 'contradiction',
        reason: r.reason,
        createdAt: r.created_at,
      })
    }
    for (const id of orphan) await this.deleteReview(id)
    return out
  }

  async getReview(id: string): Promise<MemoryReviewRow | null> {
    return this.one<MemoryReviewRow>(`SELECT * FROM chat_memory_reviews WHERE user_id = ?1 AND id = ?2`, this.userId, id)
  }

  async deleteReview(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_memory_reviews WHERE user_id = ?1 AND id = ?2`, id)
  }

  async deleteReviewsBetween(a: string, b: string): Promise<void> {
    await this.write(
      `DELETE FROM chat_memory_reviews WHERE user_id = ?1 AND ((memory_id = ?2 AND other_id = ?3) OR (memory_id = ?3 AND other_id = ?2))`,
      a, b,
    )
  }

  // ------------------------------------------------------------------- tasks

  /**
   * The starting clause every task read shares: this account, and only rows that are not in the trash.
   *
   * The one place a query about the reader's tasks is opened. A statement that begins from `Query`
   * itself instead is how a soft-deleted row stays visible somewhere while every test of the app's
   * main list still passes.
   */
  private taskQuery(): Query {
    return new Query(this.userId).raw(TASK_LIVE_PREDICATE)
  }

  /**
   * The WHERE clause one query names, with its binds.
   *
   * One builder rather than a query per view: the smart lists differ only in this clause, and a second
   * copy of "what is due today" is how the app and the reminder sweep start disagreeing. Both the page
   * of rows and its count go through here, which is the only reason the two can be trusted to be about
   * the same tasks.
   *
   * Async only because the today view's second half is a stored calendar day: a caller that did not
   * name one gets it from the account's zone, read here rather than re-derived by every caller. The
   * route names it, so the page and the badge below share one string even when the request lands on
   * midnight.
   */
  private async taskFilter(query: TaskQuery = {}): Promise<Query> {
    const q = this.taskQuery()
    const status = query.status ?? 'all'
    if (Array.isArray(status)) q.inList(`status`, status)
    else if (status === 'open') q.raw(`status != 'done'`)
    else if (status !== 'all') q.eq(`status`, status)
    const now = Date.now()
    const dayEnd = query.dayEnd ?? now
    const upcomingEnd = dayEnd + UPCOMING_DAYS * 24 * 60 * 60 * 1000
    const today = query.view === 'today'
      ? query.today ?? localDate(now, (await this.getSettings()).timezone)
      : null
    switch (query.view) {
      case 'inbox':
        q.raw(`status != 'done' AND list_id IS NULL`)
        break
      case 'today':
        // Today is two questions with one badge: what is owed by the end of the day, and what the
        // reader picked for it. A plan from an earlier day is not cleared — it simply stops equalling
        // today's string — which is what makes the rollover need no sweep.
        q.raw(`status != 'done' AND ((due_at IS NOT NULL AND due_at < ${q.add(dayEnd)})
          OR (due_at IS NULL AND status = 'in_progress')
          ${today === null ? '' : `OR planned_for = ${q.add(today)}`})`)
        break
      case 'upcoming':
        q.raw(`status != 'done' AND due_at IS NOT NULL AND due_at >= ${q.add(dayEnd)} AND due_at < ${q.add(upcomingEnd)}`)
        break
      case 'overdue':
        q.raw(`status != 'done' AND due_at IS NOT NULL AND due_at < ${q.add(now)}`)
        break
      case 'open':
        q.raw(`status != 'done'`)
        break
      case 'completed':
        q.raw(`status = 'done'`)
        break
      case 'starred':
        q.raw(`status != 'done' AND starred = 1`)
        break
      default:
        break
    }
    if (query.projectId) q.eq(`project_id`, query.projectId)
    if (query.listId === null) q.raw(`list_id IS NULL`)
    else if (query.listId) q.eq(`list_id`, query.listId)
    if (query.tagId) {
      q.raw(`id IN (SELECT task_id FROM todos_tag_links WHERE user_id = ?1 AND tag_id = ${q.add(query.tagId)})`)
    }
    if (query.priority) q.eq(`priority`, query.priority)
    if (query.starred) q.raw(`starred = 1`)
    // An undated task is in no due window: a range asks when something is owed, and a task with no date
    // answers that question with "not yet decided", not with "any time you like".
    if (query.dueFrom !== undefined) q.raw(`due_at IS NOT NULL AND due_at >= ${q.add(query.dueFrom)}`)
    if (query.dueTo !== undefined) q.raw(`due_at IS NOT NULL AND due_at < ${q.add(query.dueTo)}`)
    // A completion window is a calendar-day window on the day the row was finished, not a due window:
    // the two ends are half-open and the comparison is lexical, which is exact for `YYYY-MM-DD`.
    // `NULL` fails both comparisons, so a finished row with no recorded day is in no window.
    if (query.completedFrom !== undefined) q.raw(`completed_on >= ${q.add(query.completedFrom)}`)
    if (query.completedTo !== undefined) q.raw(`completed_on < ${q.add(query.completedTo)}`)
    if (query.query) {
      const pattern = q.add(containsPattern(query.query))
      // A tag's name is part of what a reader sees on the row, so it is part of what a search for
      // those words should find. The subquery is correlated and tenant-filtered: one statement for
      // the whole page, not one per tag, and no link from another account can answer it.
      const byTag = `EXISTS (
        SELECT 1 FROM todos_tag_links l
          JOIN todos_tags tag ON tag.user_id = l.user_id AND tag.id = l.tag_id
         WHERE l.user_id = ?1 AND l.task_id = todos_tasks.id AND tag.name LIKE ${pattern} ESCAPE '\\'
      )`
      q.or([
        `title LIKE ${pattern} ESCAPE '\\'`,
        `description LIKE ${pattern} ESCAPE '\\'`,
        byTag,
      ])
    }
    return q
  }

  /**
   * The rows a query matches, before tags and step counts are attached.
   *
   * The page is cut here rather than in the caller: a reader scrolling for more is asking the database
   * for the next rows, not asking for a bigger copy of the same answer.
   */
  private async taskRows(query: TaskQuery = {}): Promise<TaskRow[]> {
    const q = await this.taskFilter(query)
    const pageSize = query.view === 'completed' ? COMPLETED_PAGE_SIZE : MAX_TASKS_PER_QUERY
    const limit = q.add(Math.min(query.limit ?? pageSize, MAX_TASKS_PER_QUERY))
    const offset = query.offset && query.offset > 0 ? ` OFFSET ${q.add(Math.trunc(query.offset))}` : ''
    return await this.rows<TaskRow>(
      `SELECT *, ${TASK_REMINDER_TIMES} FROM todos_tasks WHERE ${q.where}
        ORDER BY ${taskOrder(query.sort, query.view)} LIMIT ${limit}${offset}`,
      ...q.binds,
    )
  }

  /**
   * How many tasks a filter matches, whichever page of them is being shown.
   *
   * The same clause the rows come from, so the number cannot describe a different question than the
   * list beside it. It is one `COUNT`, not one per row or per page, and it is what lets a listing say
   * "there is more" instead of leaving the reader to guess whether the screen is the whole answer.
   */
  async countTasks(query: TaskQuery = {}): Promise<number> {
    const q = await this.taskFilter(query)
    const row = await this.one<{ n: number | null }>(
      `SELECT COUNT(*) AS n FROM todos_tasks WHERE ${q.where}`,
      ...q.binds,
    )
    return row?.n ?? 0
  }

  /** The step counts of many tasks in one query, so a listing is not a query per row. */
  private async stepCounts(ids: readonly string[]): Promise<Map<string, { total: number; done: number }>> {
    const out = new Map<string, { total: number; done: number }>()
    for (const chunk of idChunks(ids)) {
      const list = await this.rows<{ task_id: string; total: number; done: number | null }>(
        `SELECT task_id, COUNT(*) AS total, SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
           FROM todos_steps WHERE user_id = ?1 AND task_id IN (${chunkMarks(chunk)}) GROUP BY task_id`,
        this.userId, ...chunk,
      )
      for (const row of list) out.set(row.task_id, { total: row.total, done: row.done ?? 0 })
    }
    return out
  }

  /** The tags of many tasks in one query, keyed by task. */
  private async tagsForTasks(ids: readonly string[]): Promise<Map<string, TaskTag[]>> {
    const out = new Map<string, TaskTag[]>()
    for (const chunk of idChunks(ids)) {
      const list = await this.rows<TaskTagRow & { task_id: string }>(
        `SELECT l.task_id, t.id, t.name, t.color, t.created_at, t.updated_at
           FROM todos_tag_links l
           JOIN todos_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
          WHERE l.user_id = ?1 AND l.task_id IN (${chunkMarks(chunk)})
          ORDER BY t.name COLLATE NOCASE`,
        this.userId, ...chunk,
      )
      for (const row of list) {
        const bucket = out.get(row.task_id) ?? []
        bucket.push(toTaskTag(row, 0))
        out.set(row.task_id, bucket)
      }
    }
    return out
  }

  private async tasksWithDetails(rows: TaskRow[]): Promise<TodoTask[]> {
    if (!rows.length) return []
    const ids = rows.map((row) => row.id)
    const [steps, tags] = await Promise.all([this.stepCounts(ids), this.tagsForTasks(ids)])
    return rows.map((row) => toTask(row, {
      tags: tags.get(row.id) ?? [],
      stepTotal: steps.get(row.id)?.total ?? 0,
      stepDone: steps.get(row.id)?.done ?? 0,
      // The page's own select packed these in; no separate reminder read per listing.
      reminders: reminderTimesOf(row.reminder_times),
    }))
  }

  async listTasks(query: TaskQuery = {}): Promise<TodoTask[]> {
    return await this.tasksWithDetails(await this.taskRows(query))
  }

  async getTask(id: string): Promise<TodoTask | null> {
    const q = this.taskQuery().eq('id', id)
    const row = await this.one<TaskRow>(
      `SELECT *, ${TASK_REMINDER_TIMES} FROM todos_tasks WHERE ${q.where}`,
      ...q.binds,
    )
    if (!row) return null
    const [task] = await this.tasksWithDetails([row])
    return task ?? null
  }

  /**
   * The reader's calendar day for a task's day column.
   *
   * `created_on` and `completed_on` hold `YYYY-MM-DD` in the account's zone, because a day derived at
   * query time drifts across DST and files work under the wrong date. The zone is the one every due
   * date and every "today" is already read in; a caller that has just resolved it (`completeTask`)
   * passes it on, so the two rows one completion writes cannot land on different days.
   */
  private async taskDay(at: number, timeZone?: string): Promise<string> {
    return localDate(at, timeZone ?? (await this.getSettings()).timezone)
  }

  /**
   * One row of a task's history: its birth, or one step from one status to another.
   *
   * The event is written in the same batch as the row that caused it, which is the whole point of
   * the table: a task holding a status its history does not explain would replay as work that
   * vanished from the flow, and a birth that never landed would make the replay subtract a task it
   * never counted. `on_day` is the account's calendar day of `at`, computed here at write time for
   * the reason `created_on` is — a day derived at query time drifts across DST and files the event
   * under the wrong one. A birth's `from_status` is NULL: it only ever adds.
   */
  private taskEvent(
    taskId: string,
    at: number,
    onDay: string,
    kind: 'born' | 'status',
    fromStatus: TaskStatus | null,
    toStatus: TaskStatus,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO todos_task_events (user_id, id, task_id, at, on_day, kind, from_status, to_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(this.userId, newId(), taskId, at, onDay, kind, fromStatus, toStatus)
  }

  /**
   * Writes one task's named columns and moves its revision on.
   *
   * The bump rides in the same statement as the edit, so a revision can never describe a row that did
   * not move with it. With `expectedRev` the statement also matches that revision: a stale caller
   * changes no row, and the caller above turns the empty result into a conflict.
   *
   * `also` carries the statements that must land with the edit or not at all — today the one history
   * event a status change owes. They ride in the same `db.batch`, so a task can never hold a status
   * its event table does not explain.
   */
  private async updateTaskRow(
    id: string,
    fields: readonly (readonly [column: string, value: unknown])[],
    expectedRev?: number,
    also?: readonly D1PreparedStatement[],
  ): Promise<number> {
    const sets = fields.map(([column], index) => `${column} = ?${index + 2}`)
    sets.push('rev = rev + 1')
    const guard = expectedRev === undefined ? '' : ` AND rev = ?${fields.length + 3}`
    const sql = `UPDATE todos_tasks SET ${sets.join(', ')}
        WHERE user_id = ?1 AND id = ?${fields.length + 2} AND ${TASK_LIVE_PREDICATE}${guard}`
    assertScoped(sql)
    const update = this.db.prepare(sql).bind(
      this.userId, ...fields.map(([, value]) => value), id, ...(expectedRev === undefined ? [] : [expectedRev]),
    )
    if (also?.length) {
      const results = await this.db.batch([update, ...also])
      return Number(results[0]?.meta?.changes ?? 0)
    }
    const result = await update.run()
    return result.meta?.changes ?? 0
  }

  /**
   * The refusal a guarded task write answers with: the row moved since the caller read it.
   *
   * The revision that actually stands rides in `details`, so a client can offer "reload and reapply"
   * without a second read, and the shape is the one every 409 in this repo already has.
   */
  private taskConflict(id: string, current: TodoTask): ApiError {
    return ApiError.conflict(
      'The task changed since it was read. Reload it and try again.',
      { id, rev: current.rev },
    )
  }

  async createTask(input: NewTask, timeZone?: string): Promise<TodoTask> {
    const id = newId()
    const at = Date.now()
    const status = input.status ?? 'todo'
    const repeat = input.repeat ?? null
    const createdOn = await this.taskDay(at, timeZone)
    // The task's birth rides in the same batch as the row it opens: a task whose history starts
    // late would replay as work the flow never saw arrive.
    const insert = this.db.prepare(
      `INSERT INTO todos_tasks
         (id, user_id, title, description, status, priority, due_at, start_at, project_id, list_id,
          icon, color, starred, repeat_rule, note_id, conversation_id, created_at, updated_at,
          completed_at, created_on, completed_on)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    ).bind(
      this.userId, id, input.title.trim().slice(0, 300), input.description ?? '', status, input.priority ?? 'medium',
      input.dueAt ?? null, input.startAt ?? null, input.projectId ?? null, input.listId ?? null,
      taskIconOrNull(input.icon), taskColorOrNull(input.color), input.starred ? 1 : 0,
      repeat ? JSON.stringify(repeat) : null, input.noteId ?? null,
      input.conversationId ?? null, at, at, status === 'done' ? at : null,
      createdOn, status === 'done' ? createdOn : null,
    )
    await this.db.batch([insert, this.taskEvent(id, at, createdOn, 'born', null, status)])
    if (input.tags?.length) await this.replaceTaskTags(id, input.tags)
    for (const text of input.steps ?? []) await this.addStep(id, text)
    const reminders = input.reminders ?? (input.remindAt != null ? [input.remindAt] : [])
    if (reminders.length) await this.replaceTaskReminders(id, reminders)
    const created = await this.getTask(id)
    if (!created) throw new Error(`The task ${id} was written but could not be read back.`)
    return created
  }

  /**
   * Writes one task's pending reminders, replacing whatever was still to fire.
   *
   * One batch, so a list is either the list the reader saved or the one they had before — never half
   * of each. Fired rows are left alone: they are the record that a reminder was delivered, and
   * deleting them would erase history the notification list still refers to.
   */
  private async replaceTaskReminders(taskId: string, times: readonly number[]): Promise<void> {
    const at = Date.now()
    const statements = [
      this.db.prepare(
        `DELETE FROM todos_reminders WHERE user_id = ?1 AND task_id = ?2 AND fired_at IS NULL`,
      ).bind(this.userId, taskId),
      ...normalizeReminderTimes(times).map((remindAt) => this.db.prepare(
        `INSERT INTO todos_reminders (user_id, id, task_id, remind_at, fired_at, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
      ).bind(this.userId, newId(), taskId, remindAt, at)),
    ]
    await this.db.batch(statements)
  }

  /**
   * Adds one reminder to a task, leaving the ones it already carries in place.
   *
   * This is what a "remind me again" press means: a second chance at the same task, not a cancellation
   * of the reminders the reader set earlier. The route owns the ceiling and the finished-task refusal;
   * this answers with the row as it now reads, or null when the task is gone.
   */
  async snoozeTask(id: string, remindAt: number): Promise<TodoTask | null> {
    const existing = await this.getTask(id)
    if (!existing) return null
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO todos_reminders (user_id, id, task_id, remind_at, fired_at, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
      ).bind(this.userId, newId(), id, Math.trunc(remindAt), Date.now()),
      this.db.prepare(`UPDATE todos_tasks SET updated_at = ?3, rev = rev + 1 WHERE user_id = ?1 AND id = ?2`)
        .bind(this.userId, id, Date.now()),
    ])
    return await this.getTask(id)
  }

  /** Moves every pending reminder with its due date, which is what editing the date used to do. */
  private async shiftTaskReminders(taskId: string, delta: number): Promise<void> {
    if (!delta) return
    await this.write(
      `UPDATE todos_reminders SET remind_at = remind_at + ?3
        WHERE user_id = ?1 AND task_id = ?2 AND fired_at IS NULL`,
      taskId, delta,
    )
  }

  /**
   * A partial write: only the columns the caller named.
   *
   * Writing the whole row back from a snapshot read a moment earlier is how two edits made at once
   * lose one of themselves, and it is how a column this method does not know about gets cleared.
   *
   * `expectedRev` is the revision the caller read: the statement matches only that one, so a stale
   * edit is refused with a conflict and writes nothing at all. The revision it needs back is in the
   * error's `details`.
   */
  async updateTask(
    id: string,
    patch: Partial<NewTask>,
    timeZone?: string,
    expectedRev?: number,
  ): Promise<TodoTask | null> {
    const existing = await this.getTask(id)
    if (!existing) return null
    if (expectedRev !== undefined && existing.rev !== expectedRev) throw this.taskConflict(id, existing)
    const at = Date.now()
    const fields: (readonly [string, unknown])[] = []
    if (patch.title !== undefined) fields.push(['title', patch.title.trim().slice(0, 300)])
    if (patch.description !== undefined) fields.push(['description', patch.description])
    if (patch.priority !== undefined) fields.push(['priority', patch.priority])
    if (patch.dueAt !== undefined) fields.push(['due_at', patch.dueAt])
    if (patch.startAt !== undefined) fields.push(['start_at', patch.startAt])
    if (patch.projectId !== undefined) fields.push(['project_id', patch.projectId])
    if (patch.listId !== undefined) fields.push(['list_id', patch.listId])
    // The two face columns answer to the same guards the write above and the route do: a caller that
    // names an unusable value gets null rather than the value, and null is how a reader clears a
    // face back to the list's. The guards live in shared so the client can pre-check the same rule.
    if (patch.icon !== undefined) fields.push(['icon', taskIconOrNull(patch.icon)])
    if (patch.color !== undefined) fields.push(['color', taskColorOrNull(patch.color)])
    if (patch.starred !== undefined) fields.push(['starred', patch.starred ? 1 : 0])
    if (patch.repeat !== undefined) fields.push(['repeat_rule', patch.repeat ? JSON.stringify(patch.repeat) : null])
    if (patch.noteId !== undefined) fields.push(['note_id', patch.noteId])
    if (patch.conversationId !== undefined) fields.push(['conversation_id', patch.conversationId])
    let event: D1PreparedStatement | null = null
    if (patch.status !== undefined) {
      const completedAt = patch.status === 'done' ? (existing.completedAt ?? at) : null
      fields.push(['status', patch.status])
      fields.push(['completed_at', completedAt])
      // The day column follows the same transition: reopened clears it, finished files it under the
      // reader's day. Left untouched when the status did not change, so a zone edit never rewrites a
      // day that was already recorded.
      if (patch.status !== existing.status) {
        const completedOn = completedAt === null ? null : await this.taskDay(completedAt, timeZone)
        fields.push(['completed_on', completedOn])
        // One event per real transition, written with the row it explains. Its instant is the one
        // the row records — the completion's own moment when it has one, the write's otherwise —
        // and its day is the account's calendar day of that instant, so a completion's row and its
        // event cannot disagree about when it happened. A patch naming the status the row already
        // has moves nothing and records nothing.
        event = this.taskEvent(
          id,
          completedAt ?? at,
          completedOn ?? (await this.taskDay(at, timeZone)),
          'status',
          existing.status,
          patch.status,
        )
      }
    }
    fields.push(['updated_at', at])
    const changes = await this.updateTaskRow(id, fields, expectedRev, event ? [event] : undefined)
    if (!changes) {
      // The row was gone, or (with a guard) moved between the read and the write. Re-read so the
      // conflict names the revision that actually stands; the guarded statement wrote nothing.
      const current = await this.getTask(id)
      if (!current) return null
      throw this.taskConflict(id, current)
    }
    if (patch.tags !== undefined) await this.replaceTaskTags(id, patch.tags)
    // Reminders follow their due date unless the caller named a list (or the single instant the
    // assistant's tools speak). `reminders` wins: it is the whole pending list, not an addition.
    const named = patch.reminders ?? (patch.remindAt !== undefined
      ? patch.remindAt === null ? [] : [patch.remindAt]
      : undefined)
    if (named !== undefined) await this.replaceTaskReminders(id, named)
    else if (patch.dueAt !== undefined && patch.dueAt !== null && existing.dueAt !== null) {
      await this.shiftTaskReminders(id, patch.dueAt - existing.dueAt)
    }
    return await this.getTask(id)
  }

  /**
   * Places one task before another in a list, or at the end when the anchor is null.
   *
   * The anchor is a task id rather than an index because two devices can move rows between the read
   * and the write: "before this row" means the same thing after somebody else's drop, while "index
   * three" has already moved. The target collection is the task's own unless the caller names one,
   * and naming it is what makes a cross-list move one write rather than a move followed by a patch.
   *
   * Positions are REAL and folded between the two neighbours, exactly as folders already do it. A
   * target whose rows have never been moved has no places at all, so the first move writes the order
   * the list reads in today — otherwise the moved row would sort ahead of every unplaced sibling and
   * jump to the top of a list the reader only nudged. A gap with no room left is renumbered the same
   * way and then folded again; a second failure is a conflict rather than a duplicated place.
   */
  async moveTask(
    id: string,
    placement: { beforeId: string | null; listId?: string | null },
  ): Promise<TodoTask | null> {
    const existing = await this.getTask(id)
    if (!existing) return null
    const listId = placement.listId === undefined ? existing.listId : placement.listId
    // `IS` rather than `=` so an inbox move (null) is one shape with a list move, and the order is the
    // one a listing reads before any manual place exists.
    const siblings = await this.rows<{ id: string; position: number | null }>(
      `SELECT id, position FROM todos_tasks
        WHERE user_id = ?1 AND list_id IS ?2 AND id != ?3 AND ${TASK_LIVE_PREDICATE}
        ORDER BY ${TASK_MANUAL_ORDER}, ${TASK_SORT_ORDERS.due}`,
      this.userId, listId, id,
    )
    const index = placement.beforeId === null
      ? siblings.length
      : siblings.findIndex((row) => row.id === placement.beforeId)
    if (index < 0) throw ApiError.badRequest('The task to land before is not in that list.')

    if (siblings.some((row) => row.position === null)) await this.materializeTaskPositions(siblings)
    let position = insertionPosition(siblings[index - 1]?.position ?? undefined, siblings[index]?.position ?? undefined)
    if (position === null) {
      await this.materializeTaskPositions(siblings)
      position = insertionPosition(siblings[index - 1]?.position ?? undefined, siblings[index]?.position ?? undefined)
      if (position === null) throw ApiError.conflict('The task order changed. Try again.')
    }

    const changes = await this.updateTaskRow(id, [
      ['position', position],
      ['list_id', listId],
      ['updated_at', Date.now()],
    ])
    if (!changes) return null
    return await this.getTask(id)
  }

  /**
   * Writes a whole sibling run as evenly spaced places, in the order it was read.
   *
   * This is bookkeeping rather than an edit: no revision moves, because a reader holding one of these
   * rows did not change it and a conflict would be a lie. The caller has already put the run in the
   * order the listing reads, so the numbers only make that order explicit.
   */
  private async materializeTaskPositions(rows: { id: string; position: number | null }[]): Promise<void> {
    const statements = rows.map((row, index) => {
      const position = (index + 1) * TASK_POSITION_STEP
      row.position = position
      return this.db.prepare(
        `UPDATE todos_tasks SET position = ?3 WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, row.id, position)
    })
    if (statements.length) await this.db.batch(statements)
  }

  /**
   * Moves one task to the trash.
   *
   * The row stays, stamped, with its steps, tag links and pending reminders untouched: that is what
   * makes a restore the same task rather than a copy, and what lets an undo after a delete put the
   * original row back instead of minting a second one. The stamp and the revision move together, so a
   * client holding the row sees a changed version. Every task read filters the stamp out; the reminder
   * sweep joins the task and skips a trashed one, so a pending reminder cannot be delivered while the
   * task is away.
   */
  async deleteTask(id: string): Promise<void> {
    const at = Date.now()
    await this.write(
      `UPDATE todos_tasks SET deleted_at = ?3, updated_at = ?3, rev = rev + 1
        WHERE user_id = ?1 AND id = ?2 AND ${TASK_LIVE_PREDICATE}`,
      id, at,
    )
  }

  /**
   * Takes one trashed task back out of the trash.
   *
   * Only a stamped row matches, so restoring a live task is a 404 at the route rather than a silent
   * success that suggests it had been deleted. Nothing is re-created: the same row — with its steps,
   * tags, reminders and original id — becomes visible again to every read.
   */
  async restoreTask(id: string): Promise<TodoTask | null> {
    const changed = await this.write(
      `UPDATE todos_tasks SET deleted_at = NULL, updated_at = ?3, rev = rev + 1
        WHERE user_id = ?1 AND id = ?2 AND ${TASK_TRASHED_PREDICATE}`,
      id, Date.now(),
    )
    if (!changed) return null
    return await this.getTask(id)
  }

  /**
   * One page of the trash, newest deletion first.
   *
   * A separate read rather than a view on `listTasks`: these are the rows every other query hides, and
   * they carry when they were deleted so the screen can say how long is left. The account and the stamp
   * are the index `idx_todos_tasks_trash`, and the page is read and counted in the same shape the main
   * listing uses so `total` is the size of the whole trash and not of the page.
   */
  async listTrash(options: { limit?: number, offset?: number } = {}): Promise<{ tasks: TodoTask[], total: number }> {
    const totalRow = await this.one<{ n: number | null }>(
      `SELECT COUNT(*) AS n FROM todos_tasks WHERE user_id = ?1 AND ${TASK_TRASHED_PREDICATE}`,
      this.userId,
    )
    const q = new Query(this.userId).raw(TASK_TRASHED_PREDICATE)
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? MAX_TASKS_PER_QUERY)), MAX_TASKS_PER_QUERY)
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const rows = await this.rows<TaskRow>(
      `SELECT *, ${TASK_REMINDER_TIMES} FROM todos_tasks WHERE ${q.where}
        ORDER BY deleted_at DESC, id DESC LIMIT ${q.add(limit)} OFFSET ${q.add(offset)}`,
      ...q.binds,
    )
    return { tasks: await this.tasksWithDetails(rows), total: totalRow?.n ?? 0 }
  }

  /**
   * Removes one trashed task for good.
   *
   * Only a stamped row qualifies: the endpoint is the trash's own door, and a live task sent here is a
   * 404 rather than a delete that bypasses the trash. The five statements run as one batch, so a
   * task cannot lose its steps while keeping its row.
   */
  async purgeTask(id: string): Promise<boolean> {
    const row = await this.one<{ id: string }>(
      `SELECT id FROM todos_tasks WHERE user_id = ?1 AND id = ?2 AND ${TASK_TRASHED_PREDICATE}`,
      this.userId, id,
    )
    if (!row) return false
    await this.db.batch(purgeTaskStatements(this.db, this.userId, [id]))
    return true
  }

  /**
   * Picks a task into a day, or clears the pick with `null`.
   *
   * The day is a plain `YYYY-MM-DD` in the account's zone and the route is what decides it is a real
   * calendar day: the store's boundary is the account, not the shape of the text. Planning twice is
   * one row either way, and a day in the past is kept as written — a backfilled record is still a
   * record, it simply is not today. Does not touch the due date, the reminder or the status.
   */
  async planTask(id: string, date: string | null): Promise<TodoTask | null> {
    const changed = await this.updateTaskRow(id, [
      ['planned_for', date],
      ['updated_at', Date.now()],
    ])
    if (!changed) return null
    return await this.getTask(id)
  }

  /**
   * Completes a task, and returns the next occurrence when it repeats.
   *
   * The finished row stays: "I did write that report last week" is a fact worth keeping, and a task
   * that silently moved its own due date forward would erase it. The next one is a new row with the
   * same content, its steps unchecked, and a due date counted from the old one.
   */
  async completeTask(id: string, timeZone: string): Promise<{ task: TodoTask; next: TodoTask | null } | null> {
    const existing = await this.getTask(id)
    if (!existing) return null
    if (existing.status === 'done') return { task: existing, next: null }
    const task = await this.updateTask(id, { status: 'done' }, timeZone)
    if (!task) return null
    if (!existing.repeat) return { task, next: null }
    const anchor = existing.dueAt ?? Date.now()
    const dueAt = nextOccurrence(anchor, existing.repeat, timeZone)
    // Every pending reminder keeps its distance from the due date on the next occurrence, the way the
    // single reminder used to. A task with no due date has no distance to keep, so its next copy
    // carries none: a reminder anchored to nothing is not a reminder.
    const anchorDue = existing.dueAt
    const offsets = anchorDue === null ? [] : (existing.reminders ?? []).map((remindAt) => remindAt - anchorDue)
    // A start date is a lead time before the due date, so it travels with the occurrence: shifting the
    // due date forward without the start would make the next copy immediately actionable. A row with
    // no due date has no distance to keep, so its next copy starts undated too.
    const startAt = existing.startAt == null || anchorDue === null
      ? null
      : dueAt + (existing.startAt - anchorDue)
    const steps = await this.listSteps(id)
    const next = await this.createTask({
      title: existing.title,
      description: existing.description,
      priority: existing.priority,
      dueAt,
      startAt,
      projectId: existing.projectId,
      listId: existing.listId,
      starred: existing.starred,
      repeat: existing.repeat,
      reminders: offsets.map((offset) => dueAt + offset),
      noteId: existing.noteId,
      conversationId: existing.conversationId,
      tags: existing.tags.map((tag) => tag.name),
      steps: steps.map((step) => step.text),
    }, timeZone)
    return { task, next }
  }

  /** By id, or by a title match that is unambiguous: the assistant must not guess which task was meant. */
  async resolveTask(ref: string): Promise<TodoTask | null> {
    const direct = await this.getTask(ref)
    if (direct) return direct
    const q = this.taskQuery()
    q.raw(`title LIKE ${q.add(containsPattern(ref))} ESCAPE '\\'`)
    const list = await this.rows<TaskRow>(
      `SELECT *, ${TASK_REMINDER_TIMES} FROM todos_tasks WHERE ${q.where}
        ORDER BY status = 'done', updated_at DESC LIMIT 2`,
      ...q.binds,
    )
    if (list.length !== 1) return null
    const [task] = await this.tasksWithDetails(list)
    return task ?? null
  }

  /**
   * The counts every smart list and every sidebar row shows.
   *
   * Computed here rather than in the browser because "today" is a span in the reader's timezone:
   * two implementations would disagree for exactly the hours around midnight. A list and a tag each
   * carry an open and a finished number, because a collection's own view shows both groups and one
   * number cannot be checked against either of them.
   *
   * `today` is the account-zone day the today view adds its picked rows by; the route passes the one
   * it listed with, so the badge and the page cannot land on different sides of midnight. Callers
   * that do not name it (the MCP and assistant surfaces) get the account's own day, read here.
   */
  async taskCounts(dayEnd: number, today?: string): Promise<TaskCounts> {
    const now = Date.now()
    const pickedFor = today ?? localDate(now, (await this.getSettings()).timezone)
    const upcomingEnd = dayEnd + UPCOMING_DAYS * 24 * 60 * 60 * 1000
    const totals = await this.one<{
      inbox: number | null; today: number | null; upcoming: number | null; overdue: number | null
      open: number | null; completed: number | null; starred: number | null
    }>(
      // A put-away list's work is out of every count this account shows: the shelf is not part of
      // what the reader is looking at, and a badge that still counted it would point at a screen
      // with no row for it. The join keeps inbox rows (no list) and rows whose list was deleted.
      `SELECT
         SUM(CASE WHEN t.status != 'done' AND t.list_id IS NULL THEN 1 ELSE 0 END) AS inbox,
         SUM(CASE WHEN t.status != 'done' AND ((t.due_at IS NOT NULL AND t.due_at < ?2)
              OR (t.due_at IS NULL AND t.status = 'in_progress')
              OR t.planned_for = ?5) THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN t.status != 'done' AND t.due_at IS NOT NULL AND t.due_at >= ?2 AND t.due_at < ?3 THEN 1 ELSE 0 END) AS upcoming,
         SUM(CASE WHEN t.status != 'done' AND t.due_at IS NOT NULL AND t.due_at < ?4 THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN t.status != 'done' AND t.starred = 1 THEN 1 ELSE 0 END) AS starred
       FROM todos_tasks t
       LEFT JOIN todos_lists l ON l.user_id = t.user_id AND l.id = t.list_id
       WHERE t.user_id = ?1 AND l.archived_at IS NULL AND ${taskLive('t')}`,
      this.userId, dayEnd, upcomingEnd, now, pickedFor,
    )
    // The inbox is folded in under its own key: a card shows the same `done / total` line whether
    // the list is the reader's or the one every unfiled task lands in.
    const perList = await this.rows<{ list_id: string; status: string; n: number }>(
      `SELECT COALESCE(list_id, 'inbox') AS list_id, status, COUNT(*) AS n FROM todos_tasks
        WHERE user_id = ?1 AND ${TASK_LIVE_PREDICATE} GROUP BY COALESCE(list_id, 'inbox'), status`,
      this.userId,
    )
    const byList: Record<string, { open: number; done: number }> = {}
    for (const row of perList) {
      const bucket = byList[row.list_id] ?? { open: 0, done: 0 }
      if (row.status === 'done') bucket.done += row.n
      else bucket.open += row.n
      byList[row.list_id] = bucket
    }
    const perTag = await this.rows<{ tag_id: string; status: string; n: number }>(
      `SELECT l.tag_id, t.status, COUNT(*) AS n FROM todos_tag_links l
         JOIN todos_tasks t ON t.user_id = l.user_id AND t.id = l.task_id
        WHERE l.user_id = ?1 AND ${taskLive('t')} GROUP BY l.tag_id, t.status`,
      this.userId,
    )
    const byTag: Record<string, { open: number; done: number }> = {}
    for (const row of perTag) {
      const bucket = byTag[row.tag_id] ?? { open: 0, done: 0 }
      if (row.status === 'done') bucket.done += row.n
      else bucket.open += row.n
      byTag[row.tag_id] = bucket
    }
    return {
      inbox: totals?.inbox ?? 0,
      today: totals?.today ?? 0,
      upcoming: totals?.upcoming ?? 0,
      overdue: totals?.overdue ?? 0,
      all: totals?.open ?? 0,
      completed: totals?.completed ?? 0,
      starred: totals?.starred ?? 0,
      byList,
      byTag,
    }
  }

  // ------------------------------------------------------------------- lists

  async listTaskLists(options: { archived?: boolean } = {}): Promise<TaskListEntry[]> {
    const where = options.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'
    const lists = await this.rows<TaskListRow>(
      `SELECT * FROM todos_lists WHERE user_id = ?1 AND ${where} ORDER BY position ASC, name COLLATE NOCASE ASC`,
      this.userId,
    )
    const counts = await this.rows<{ list_id: string; status: string; n: number }>(
      `SELECT list_id, status, COUNT(*) AS n FROM todos_tasks
        WHERE user_id = ?1 AND list_id IS NOT NULL AND ${TASK_LIVE_PREDICATE} GROUP BY list_id, status`,
      this.userId,
    )
    const byList = new Map<string, { open: number; done: number }>()
    for (const row of counts) {
      const bucket = byList.get(row.list_id) ?? { open: 0, done: 0 }
      if (row.status === 'done') bucket.done += row.n
      else bucket.open += row.n
      byList.set(row.list_id, bucket)
    }
    return lists.map((row) => toTaskList(row, byList.get(row.id) ?? { open: 0, done: 0 }))
  }

  async getTaskList(id: string): Promise<TaskListEntry | null> {
    const row = await this.one<TaskListRow>(`SELECT * FROM todos_lists WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    if (!row) return null
    const counts = await this.one<{ open: number | null; done: number | null }>(
      `SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS open
         FROM todos_tasks WHERE user_id = ?1 AND list_id = ?2 AND ${TASK_LIVE_PREDICATE}`,
      this.userId, id,
    )
    return toTaskList(row, { open: counts?.open ?? 0, done: counts?.done ?? 0 })
  }

  async findTaskListByName(name: string): Promise<TaskListEntry | null> {
    const row = await this.one<TaskListRow>(
      `SELECT * FROM todos_lists WHERE user_id = ?1 AND lower(name) = lower(?2) LIMIT 1`,
      this.userId, name.trim(),
    )
    return row ? await this.getTaskList(row.id) : null
  }

  async resolveTaskList(ref: string): Promise<TaskListEntry | null> {
    return (await this.getTaskList(ref)) ?? (await this.findTaskListByName(ref))
  }

  async createTaskList(input: { name: string; icon?: string | null; color?: string | null }): Promise<TaskListEntry> {
    const name = input.name.trim().slice(0, MAX_LIST_NAME_CHARS)
    if (!name) throw new Error('A list needs a name.')
    const existing = await this.findTaskListByName(name)
    if (existing) return existing
    const id = newId()
    const at = Date.now()
    const position = await this.nextListPosition()
    await this.write(
      `INSERT INTO todos_lists (id, user_id, name, icon, color, position, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id, name, input.icon ?? null, input.color ?? defaultColorFor(name), position, at, at,
    )
    const created = await this.getTaskList(id)
    if (!created) throw new Error(`The list ${id} was written but could not be read back.`)
    return created
  }

  async updateTaskList(id: string, patch: { name?: string; icon?: string | null; color?: string | null; position?: number; archivedAt?: number | null; parentId?: string | null }): Promise<TaskListEntry | null> {
    const existing = await this.getTaskList(id)
    if (!existing) return null
    const fields: (readonly [string, unknown])[] = []
    if (patch.name !== undefined) fields.push(['name', patch.name.trim().slice(0, MAX_LIST_NAME_CHARS)])
    if (patch.icon !== undefined) fields.push(['icon', patch.icon])
    if (patch.color !== undefined) fields.push(['color', patch.color])
    if (patch.position !== undefined) fields.push(['position', Math.trunc(patch.position)])
    if (patch.archivedAt !== undefined) fields.push(['archived_at', patch.archivedAt])
    if (patch.parentId !== undefined) fields.push(['parent_id', patch.parentId])
    fields.push(['updated_at', Date.now()])
    await this.partialUpdate('todos_lists', id, fields)
    return await this.getTaskList(id)
  }

  /** How many lists call this one their container. Used to keep grouping one level deep. */
  async countTaskListChildren(id: string): Promise<number> {
    const row = await this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM todos_lists WHERE user_id = ?1 AND parent_id = ?2`,
      this.userId, id,
    )
    return row?.n ?? 0
  }

  /**
   * Deletes a list. Its tasks are not deleted with it: they move to the inbox, where nothing is lost.
   * Its child lists are lifted to the top level for the same reason — deleting a container is not a
   * statement about the lists inside it.
   */
  async deleteTaskList(id: string): Promise<void> {
    await this.write(`UPDATE todos_tasks SET list_id = NULL, updated_at = ?3, rev = rev + 1 WHERE user_id = ?1 AND list_id = ?2`, id, Date.now())
    await this.write(`UPDATE todos_lists SET parent_id = NULL, updated_at = ?3 WHERE user_id = ?1 AND parent_id = ?2`, id, Date.now())
    await this.write(`DELETE FROM todos_lists WHERE user_id = ?1 AND id = ?2`, id)
  }

  private async nextListPosition(): Promise<number> {
    const row = await this.one<{ next: number | null }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todos_lists WHERE user_id = ?1`,
      this.userId,
    )
    return row?.next ?? 0
  }

  // -------------------------------------------------------------------- tags

  async listTaskTags(): Promise<TaskTag[]> {
    const tags = await this.rows<TaskTagRow>(
      `SELECT * FROM todos_tags WHERE user_id = ?1 ORDER BY name COLLATE NOCASE ASC`,
      this.userId,
    )
    const counts = await this.rows<{ tag_id: string; n: number }>(
      `SELECT l.tag_id, COUNT(*) AS n FROM todos_tag_links l
         JOIN todos_tasks t ON t.user_id = l.user_id AND t.id = l.task_id
        WHERE l.user_id = ?1 AND t.status != 'done' AND ${taskLive('t')} GROUP BY l.tag_id`,
      this.userId,
    )
    const byTag = new Map(counts.map((row) => [row.tag_id, row.n]))
    return tags.map((row) => toTaskTag(row, byTag.get(row.id) ?? 0))
  }

  async getTaskTag(id: string): Promise<TaskTag | null> {
    const row = await this.one<TaskTagRow>(`SELECT * FROM todos_tags WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    return row ? toTaskTag(row, 0) : null
  }

  async findTaskTagByName(name: string): Promise<TaskTag | null> {
    const row = await this.one<TaskTagRow>(
      `SELECT * FROM todos_tags WHERE user_id = ?1 AND lower(name) = lower(?2) LIMIT 1`,
      this.userId, name.trim(),
    )
    return row ? toTaskTag(row, 0) : null
  }

  async resolveTaskTag(ref: string): Promise<TaskTag | null> {
    return (await this.getTaskTag(ref)) ?? (await this.findTaskTagByName(ref))
  }

  async createTaskTag(input: { name: string; color?: string | null }): Promise<TaskTag> {
    const name = input.name.trim().slice(0, MAX_TAG_NAME_CHARS)
    if (!name) throw new Error('A tag needs a name.')
    const existing = await this.findTaskTagByName(name)
    if (existing) return existing
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO todos_tags (id, user_id, name, color, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      id, name, input.color ?? defaultColorFor(name), at, at,
    )
    const created = await this.getTaskTag(id)
    if (!created) throw new Error(`The tag ${id} was written but could not be read back.`)
    return created
  }

  async updateTaskTag(id: string, patch: { name?: string; color?: string | null }): Promise<TaskTag | null> {
    const existing = await this.getTaskTag(id)
    if (!existing) return null
    const fields: (readonly [string, unknown])[] = []
    if (patch.name !== undefined) fields.push(['name', patch.name.trim().slice(0, MAX_TAG_NAME_CHARS)])
    if (patch.color !== undefined) fields.push(['color', patch.color])
    fields.push(['updated_at', Date.now()])
    await this.partialUpdate('todos_tags', id, fields)
    return await this.getTaskTag(id)
  }

  async deleteTaskTag(id: string): Promise<void> {
    await this.write(`DELETE FROM todos_tag_links WHERE user_id = ?1 AND tag_id = ?2`, id)
    await this.write(`DELETE FROM todos_tags WHERE user_id = ?1 AND id = ?2`, id)
  }

  /**
   * Replaces a task's tags with the names given, creating the ones this account does not have.
   *
   * Names rather than ids because that is what the model and the reader type; the tag list is the
   * account's own vocabulary, and a name it has not used yet is a new word, not an error. A tag edit
   * is a task edit, so the row's revision moves on with it.
   */
  async setTaskTags(taskId: string, names: readonly string[]): Promise<TaskTag[]> {
    const wanted = await this.replaceTaskTags(taskId, names)
    await this.updateTaskRow(taskId, [])
    return wanted
  }

  /**
   * The link replacement both tag writers share.
   *
   * It deliberately leaves the revision alone: `createTask` and `updateTask` call it as part of a
   * write that has already moved (or, at creation, is about to settle on) the row's version, and a
   * second bump there would make one edit count as two.
   */
  private async replaceTaskTags(taskId: string, names: readonly string[]): Promise<TaskTag[]> {
    const wanted: TaskTag[] = []
    for (const name of normalizeTagNames(names)) wanted.push(await this.createTaskTag({ name }))
    await this.write(`DELETE FROM todos_tag_links WHERE user_id = ?1 AND task_id = ?2`, taskId)
    for (const tag of wanted) {
      await this.write(
        `INSERT OR IGNORE INTO todos_tag_links (user_id, task_id, tag_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
        taskId, tag.id, Date.now(),
      )
    }
    return wanted
  }

  // ------------------------------------------------------------------- steps

  async listSteps(taskId: string): Promise<TaskStep[]> {
    const rows = await this.rows<TaskStepRow>(
      `SELECT * FROM todos_steps WHERE user_id = ?1 AND task_id = ?2 ORDER BY position ASC, created_at ASC`,
      this.userId, taskId,
    )
    return rows.map(toTaskStep)
  }

  /** Appends a step. Returns null when the task already holds the maximum, rather than growing forever. */
  async addStep(taskId: string, text: string): Promise<TaskStep | null> {
    const clean = text.trim().slice(0, MAX_STEP_TEXT_CHARS)
    if (!clean) return null
    const count = await this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM todos_steps WHERE user_id = ?1 AND task_id = ?2`,
      this.userId, taskId,
    )
    if ((count?.n ?? 0) >= MAX_STEPS_PER_TASK) return null
    const id = newId()
    await this.write(
      `INSERT INTO todos_steps (id, user_id, task_id, text, done, position, created_at)
       VALUES (?2, ?1, ?3, ?4, 0,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM todos_steps WHERE user_id = ?1 AND task_id = ?3), ?5)`,
      id, taskId, clean, Date.now(),
    )
    const row = await this.one<TaskStepRow>(`SELECT * FROM todos_steps WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    return row ? toTaskStep(row) : null
  }

  async updateStep(taskId: string, stepId: string, patch: { text?: string; done?: boolean }): Promise<TaskStep | null> {
    const fields: (readonly [string, unknown])[] = []
    if (patch.text !== undefined) fields.push(['text', patch.text.trim().slice(0, MAX_STEP_TEXT_CHARS)])
    if (patch.done !== undefined) fields.push(['done', patch.done ? 1 : 0])
    if (!fields.length) return null
    const changes = await this.write(
      `UPDATE todos_steps SET ${fields.map(([column], index) => `${column} = ?${index + 3}`).join(', ')}
        WHERE user_id = ?1 AND task_id = ?2 AND id = ?${fields.length + 3}`,
      taskId, ...fields.map(([, value]) => value), stepId,
    )
    if (!changes) return null
    const row = await this.one<TaskStepRow>(
      `SELECT * FROM todos_steps WHERE user_id = ?1 AND task_id = ?2 AND id = ?3`,
      this.userId, taskId, stepId,
    )
    return row ? toTaskStep(row) : null
  }

  /**
   * Moves one step in its task's order.
   *
   * The caller names either the sibling the step should sit before (`null` for the end) or the
   * zero-based index it should land on; both are resolved against the rows as they stand, so a move
   * that already matches the order writes nothing. The order itself is fractional: the moved row
   * takes the midpoint between its new neighbours, and only when that gap is exhausted are the
   * siblings renumbered to whole thousands — the same scheme folders use, and the reason a reorder
   * does not rewrite every row on every press.
   *
   * Returns null when the step is not this account's: another account's id is a 404, not a 403.
   */
  async moveStep(
    taskId: string,
    stepId: string,
    placement: { beforeStepId: string | null } | { position: number },
  ): Promise<TaskStep | null> {
    const rows = await this.rows<TaskStepRow>(
      `SELECT * FROM todos_steps WHERE user_id = ?1 AND task_id = ?2 ORDER BY position ASC, created_at ASC, id ASC`,
      this.userId, taskId,
    )
    const movingAt = rows.findIndex((row) => row.id === stepId)
    if (movingAt < 0) return null
    const siblings = rows.filter((row) => row.id !== stepId)
    let index: number
    if ('beforeStepId' in placement) {
      index = placement.beforeStepId === null
        ? siblings.length
        : siblings.findIndex((row) => row.id === placement.beforeStepId)
      if (index < 0) throw ApiError.badRequest('That step is not on this task.')
    } else {
      // An index past the end is the end: the caller asked for the last place, not for an error.
      index = Math.min(Math.max(placement.position, 0), siblings.length)
    }
    if (index === movingAt) return toTaskStep(rows[movingAt]!)

    let position = insertionPosition(siblings[index - 1]?.position, siblings[index]?.position)
    if (position === null) {
      // The neighbours sit on the same value, or too close for another midpoint. Renumbering to
      // whole thousands keeps the order the reader is looking at and opens a gap again.
      for (let at = 0; at < siblings.length; at++) {
        const sibling = siblings[at]!
        const next = (at + 1) * 1000
        if (sibling.position === next) continue
        const changes = await this.write(
          `UPDATE todos_steps SET position = ?2 WHERE user_id = ?1 AND task_id = ?3 AND id = ?4`,
          next, taskId, sibling.id,
        )
        if (!changes) throw ApiError.conflict('The step order changed. Try again.')
        sibling.position = next
      }
      position = insertionPosition(siblings[index - 1]?.position, siblings[index]?.position)
      if (position === null) throw ApiError.conflict('The step order changed. Try again.')
    }

    const changes = await this.write(
      `UPDATE todos_steps SET position = ?2 WHERE user_id = ?1 AND task_id = ?3 AND id = ?4`,
      position, taskId, stepId,
    )
    if (!changes) return null
    const row = await this.one<TaskStepRow>(
      `SELECT * FROM todos_steps WHERE user_id = ?1 AND task_id = ?2 AND id = ?3`,
      this.userId, taskId, stepId,
    )
    return row ? toTaskStep(row) : null
  }

  async deleteStep(taskId: string, stepId: string): Promise<boolean> {
    const changes = await this.write(
      `DELETE FROM todos_steps WHERE user_id = ?1 AND task_id = ?2 AND id = ?3`,
      taskId, stepId,
    )
    return changes > 0
  }

  // ---------------------------------------------------------------- projects

  async listProjects(): Promise<Project[]> {
    const list = await this.rows<ProjectRow>(
      `SELECT * FROM chat_projects WHERE user_id = ?1 ORDER BY name COLLATE NOCASE`,
      this.userId,
    )
    return list.map(toProject)
  }

  async getProject(id: string): Promise<Project | null> {
    const r = await this.one<ProjectRow>(`SELECT * FROM chat_projects WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    return r ? toProject(r) : null
  }

  async findProjectByName(name: string): Promise<Project | null> {
    const r = await this.one<ProjectRow>(
      `SELECT * FROM chat_projects WHERE user_id = ?1 AND lower(name) = lower(?2) LIMIT 1`,
      this.userId, name.trim(),
    )
    return r ? toProject(r) : null
  }

  async createProject(input: {
    name: string, description?: string, instructions?: string, noteScope?: string[], noteIds?: string[], modelId?: string | null,
  }): Promise<Project> {
    const id = newId()
    const at = Date.now()
    const name = input.name.trim()
    const description = input.description ?? ''
    const instructions = input.instructions ?? ''
    const noteScope = input.noteScope ?? []
    const noteIds = input.noteIds ?? []
    const modelId = input.modelId ?? null
    await this.write(
      `INSERT INTO chat_projects
         (id, user_id, name, description, instructions, note_scope, note_ids, model_id, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      id, name, description, instructions, JSON.stringify(noteScope), JSON.stringify(noteIds), modelId, at, at,
    )
    return { id, name, description, instructions, noteScope, noteIds, modelId, createdAt: at, updatedAt: at }
  }

  async updateProject(id: string, patch: {
    name?: string, description?: string, instructions?: string,
    noteScope?: string[], noteIds?: string[], modelId?: string | null,
  }): Promise<Project | null> {
    const fields: (readonly [string, unknown])[] = []
    const set = (column: string, value: unknown): void => { fields.push([column, value]) }
    // Only the fields the patch names: a project's instructions saved from one panel must not stamp the
    // model or the note scope another panel wrote in between. `modelId: null` is a value — the project
    // stops filing its facts anywhere.
    if (patch.name !== undefined) set('name', patch.name.trim())
    if (patch.description !== undefined) set('description', patch.description)
    if (patch.instructions !== undefined) set('instructions', patch.instructions)
    if (patch.noteScope !== undefined) set('note_scope', JSON.stringify(patch.noteScope))
    if (patch.noteIds !== undefined) set('note_ids', JSON.stringify(patch.noteIds))
    if (patch.modelId !== undefined) set('model_id', patch.modelId)
    set('updated_at', Date.now())
    const changes = await this.partialUpdate('chat_projects', id, fields)
    return changes ? await this.getProject(id) : null
  }

  async deleteProject(id: string): Promise<void> {
    // The project's facts go with it. Neither alternative is acceptable: keeping them would either
    // resurrect them as the account's own — one client's facts surfacing in every other conversation —
    // or strand them under a project that no longer exists, listed on the memory page and unreachable by
    // any turn. A conversation is a record and stays; a fact about a context that is gone does not.
    const filed = await this.rows<{ id: string, content: string }>(
      `SELECT id, content FROM chat_memories WHERE user_id = ?1 AND project_id = ?2`, id,
    )
    if (filed.length) {
      // The vectors go with the facts: `memoryEmbeddingCount` is a plain count of rows, so a vector whose
      // memory is gone would keep inflating the number on the settings card while no turn could recall it.
      // The review rows are not cleaned here — `listReviews` already drops the ones whose memory is
      // missing, so a delete would be a second copy of that rule. A project with a hundred facts or
      // more deletes in chunks, for the same bound-parameter reason the listings do.
      for (const chunk of idChunks(filed.map((memory) => memory.id))) {
        await this.write(`DELETE FROM chat_memory_embeddings WHERE user_id = ?1 AND memory_id IN (${chunkMarks(chunk)})`, ...chunk)
      }
    }
    await this.write(`DELETE FROM chat_memories WHERE user_id = ?1 AND project_id = ?2`, id)
    // The activity feed quoted each fact when it was learned; the fact is gone, so the quote goes too —
    // the same promise `deleteMemory` keeps, for the same reason.
    for (const memory of filed) await this.deleteActivityQuoting('memory.created', memory.content)
    await this.write(`UPDATE todos_tasks SET project_id = NULL, rev = rev + 1 WHERE user_id = ?1 AND project_id = ?2`, id)
    await this.write(`DELETE FROM chat_projects WHERE user_id = ?1 AND id = ?2`, id)
  }

  async resolveProject(ref: string): Promise<Project | null> {
    return (await this.getProject(ref)) ?? (await this.findProjectByName(ref))
  }

  // ------------------------------------------------------------- automations

  async listAutomations(): Promise<Automation[]> {
    const list = await this.rows<AutomationRow>(
      `SELECT * FROM chat_automations WHERE user_id = ?1
        ORDER BY enabled DESC, (next_run IS NULL), next_run ASC, created_at DESC`,
      this.userId,
    )
    return list.flatMap(toAutomation)
  }

  async getAutomation(id: string): Promise<Automation | null> {
    const r = await this.one<AutomationRow>(`SELECT * FROM chat_automations WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    return r ? (toAutomation(r)[0] ?? null) : null
  }

  async insertAutomation(input: {
    name: string
    kind: AutomationKind
    message: string
    schedule: ScheduleSpec
    enabled: boolean
    status: AutomationStatus
    nextRun: number | null
    targetFolderId: string | null
    targetNoteId: string | null
  }): Promise<Automation> {
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_automations
         (id, user_id, name, kind, message, schedule, enabled, status, next_run, run_count,
          target_folder_id, target_note_id, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)`,
      id, input.name, input.kind, input.message, JSON.stringify(input.schedule),
      input.enabled ? 1 : 0, input.status, input.nextRun,
      input.targetFolderId, input.targetNoteId, at, at,
    )
    return {
      id,
      name: input.name,
      kind: input.kind,
      message: input.message,
      schedule: input.schedule,
      enabled: input.enabled,
      status: input.status,
      nextRun: input.nextRun,
      lastRun: null,
      lastResult: null,
      lastError: null,
      runCount: 0,
      targetFolderId: input.targetFolderId,
      targetNoteId: input.targetNoteId,
      createdAt: at,
      updatedAt: at,
    }
  }

  async updateAutomation(
    id: string,
    patch: Partial<{
      name: string
      message: string
      schedule: ScheduleSpec
      enabled: boolean
      status: AutomationStatus
      nextRun: number | null
      lastRun: number | null
      lastResult: string | null
      lastError: string | null
      runCount: number
      claimedAt: number | null
    }>,
  ): Promise<void> {
    const sets: string[] = []
    const binds: unknown[] = [this.userId]
    const assign = (column: string, value: unknown) => {
      binds.push(value)
      sets.push(`${column} = ?${binds.length}`)
    }
    if (patch.name !== undefined) assign('name', patch.name)
    if (patch.message !== undefined) assign('message', patch.message)
    if (patch.schedule !== undefined) assign('schedule', JSON.stringify(patch.schedule))
    if (patch.enabled !== undefined) assign('enabled', patch.enabled ? 1 : 0)
    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.nextRun !== undefined) assign('next_run', patch.nextRun)
    if (patch.lastRun !== undefined) assign('last_run', patch.lastRun)
    if (patch.lastResult !== undefined) assign('last_result', patch.lastResult)
    if (patch.lastError !== undefined) assign('last_error', patch.lastError)
    if (patch.runCount !== undefined) assign('run_count', patch.runCount)
    if (patch.claimedAt !== undefined) assign('claimed_at', patch.claimedAt)
    assign('updated_at', Date.now())
    binds.push(id)
    await this.db.prepare(
      `UPDATE chat_automations SET ${sets.join(', ')} WHERE user_id = ?1 AND id = ?${binds.length}`,
    ).bind(...binds).run()
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_automations WHERE user_id = ?1 AND id = ?2`, id)
  }

  async startRun(automation: Automation): Promise<string> {
    const id = newId()
    await this.write(
      `INSERT INTO chat_runs (id, user_id, automation_id, automation_name, started_at, status)
       VALUES (?2, ?1, ?3, ?4, ?5, 'running')`,
      id, automation.id, automation.name, Date.now(),
    )
    return id
  }

  /**
   * Closes a run's receipt.
   *
   * `noteId` names the page the run wrote, when it wrote one: a schedule that files a note every morning
   * has to be readable afterwards as "which one", and the result string is cut to make room for nothing.
   * Null is the honest value for a run that filed no page, including every failed one.
   */
  async finishRun(
    runId: string,
    status: AutomationRun['status'],
    result: string | null,
    error: string | null,
    noteId: string | null = null,
  ): Promise<void> {
    await this.write(
      `UPDATE chat_runs SET status = ?2, result = ?3, error = ?4, note_id = ?5, finished_at = ?6
        WHERE user_id = ?1 AND id = ?7`,
      status, result?.slice(0, 4000) ?? null, error?.slice(0, 1000) ?? null, noteId, Date.now(), runId,
    )
  }

  async listRuns(limit = 30): Promise<AutomationRun[]> {
    const list = await this.rows<RunRow>(
      `SELECT * FROM chat_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT ?2`,
      this.userId, limit,
    )
    return list.map(toRun)
  }

  async pruneRuns(keep = 200): Promise<void> {
    await this.write(
      `DELETE FROM chat_runs WHERE user_id = ?1 AND id NOT IN (
         SELECT id FROM chat_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT ?2
       )`,
      keep,
    )
  }

  // ----------------------------------------------------------- notifications

  async listNotifications(opts: { unreadOnly?: boolean, limit?: number } = {}): Promise<AssistantNotification[]> {
    const q = new Query(this.userId)
    if (opts.unreadOnly) q.raw(`read_at IS NULL`)
    const limit = q.add(opts.limit ?? 50)
    const list = await this.rows<NotificationRow>(
      `SELECT * FROM chat_notifications WHERE ${q.where} ORDER BY created_at DESC LIMIT ${limit}`,
      ...q.binds,
    )
    return list.map(toNotification)
  }

  async createNotification(input: {
    title: string
    body: string
    automationId?: string | null
    /**
     * Where the notice is about, as `<app>:<id>` — `todo:<task id>` first.
     *
     * Not a URL, and not the caller's to shape: the client resolves the pair inside its own origin, so a
     * writer cannot aim a reader's press somewhere this deployment never chose. Absent or blank is a notice
     * that points nowhere — a digest, a finished run — which the notification centre expands instead of
     * navigating on. Clamped like the title, because the column is a pointer and not a place to park text.
     */
    link?: string | null
    subscriptionId?: string | null
  }): Promise<AssistantNotification> {
    const id = newId()
    const at = Date.now()
    const title = input.title.slice(0, 200)
    const body = input.body.slice(0, 8000)
    const link = (input.link ?? '').trim().slice(0, NOTIFICATION_LINK_MAX_CHARS) || null
    await this.write(
      `INSERT INTO chat_notifications (id, user_id, title, body, automation_id, link, subscription_id, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id, title, body, input.automationId ?? null, link, input.subscriptionId ?? null, at,
    )
    return { id, title, body, automationId: input.automationId ?? null, link, subscriptionId: input.subscriptionId ?? null, readAt: null, createdAt: at }
  }

  async unreadCount(): Promise<number> {
    const r = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_notifications WHERE user_id = ?1 AND read_at IS NULL`,
      this.userId,
    )
    return r?.n ?? 0
  }

  /**
   * The rows this account has never been nudged about, oldest first.
   *
   * `pushed_at IS NULL` is the delivery fact and `read_at IS NULL` the reader's: a row they have opened does
   * not need a device told about it again. Ids only — a catch-up fire has no use for a title, and reading one
   * here would put the reader's text somewhere a payload could reach it. Oldest first so the backlog works
   * off the row that has waited longest, rather than the newest one being reported over and over while the
   * oldest decays out of the window unnoticed.
   */
  async listUnpushedNotificationIds(sinceAt: number, limit: number): Promise<string[]> {
    const q = new Query(this.userId)
    q.raw(`read_at IS NULL`)
      .raw(`pushed_at IS NULL`)
      .raw(`created_at >= ${q.add(sinceAt)}`)
    const list = await this.rows<{ id: string }>(
      `SELECT id FROM chat_notifications WHERE ${q.where} ORDER BY created_at LIMIT ${q.add(limit)}`,
      ...q.binds,
    )
    return list.map((row) => row.id)
  }

  /**
   * Stamps the rows a push service accepted the nudge for.
   *
   * This is the marker that makes a later catch-up fire idempotent, so it is written only after an
   * acceptance: a refusal leaves the row eligible, which is the whole point — the next fire tries again until
   * the window says the news is no longer news. Chunked because D1 bounds one statement's bind count, and a
   * tick that delivered a great many things must not fail on the way to marking them.
   */
  async markNotificationsPushed(ids: readonly string[], at = Date.now()): Promise<number> {
    let marked = 0
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.raw(`pushed_at IS NULL`).inList('id', chunk)
      // The stamped value is added last, so its number follows the id list it sits outside of in the text:
      // SQLite binds by index, and a `Query` cannot name a value it was never given.
      const stamp = q.add(at)
      marked += await this.runScoped(
        `UPDATE chat_notifications SET pushed_at = ${stamp} WHERE ${q.where}`,
        ...q.binds,
      )
    }
    return marked
  }

  async markRead(id?: string): Promise<void> {
    if (id) {
      await this.write(`UPDATE chat_notifications SET read_at = ?2 WHERE user_id = ?1 AND id = ?3`, Date.now(), id)
      return
    }
    await this.write(`UPDATE chat_notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL`, Date.now())
  }

  async deleteNotification(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_notifications WHERE user_id = ?1 AND id = ?2`, id)
  }

  // ----------------------------------------------------- push subscriptions

  /**
   * One browser device's Web Push subscription.
   *
   * `endpoint`, `p256dh` and `auth` are a credential triple: together they are the ability to place a
   * notification on that device, so this record is never handed to an export, a share or a log line. The
   * route that lists subscriptions returns a redacted description of each, and `describeEndpoint` in
   * `push.ts` is what turns one into text that is safe to store in `lastError`.
   */
  async upsertPushSubscription(input: { endpoint: string, p256dh: string, auth: string }): Promise<AssistantPushSubscription> {
    const id = newId()
    // A renewed subscription overwrites its own keys and clears the failure ledger: the browser re-subscribing
    // at the same endpoint is evidence the device is still there, and a count carried over from the old keys
    // would delete a working subscription on the fifth send after the reader had just asked to be notified.
    // The conflict target is the account-qualified unique index, so two accounts can never overwrite
    // each other's row even if a push service ever handed out the same endpoint string twice.
    await this.write(
      `INSERT INTO chat_push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, failures, last_error)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, 0, NULL)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         failures = 0, last_error = NULL`,
      id, input.endpoint, input.p256dh, input.auth, Date.now(),
    )
    const row = await this.one<PushSubscriptionRow>(
      `SELECT * FROM chat_push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`,
      this.userId, input.endpoint,
    )
    if (!row) throw new Error('the push subscription write produced no row')
    return toPushSubscription(row)
  }

  async listPushSubscriptions(): Promise<AssistantPushSubscription[]> {
    const q = new Query(this.userId)
    const list = await this.rows<PushSubscriptionRow>(
      `SELECT * FROM chat_push_subscriptions WHERE ${q.where} ORDER BY created_at`,
      ...q.binds,
    )
    return list.map(toPushSubscription)
  }

  /** Drops one endpoint of this account, and answers whether anything was there to drop. */
  async deletePushSubscription(endpoint: string): Promise<boolean> {
    return await this.write(`DELETE FROM chat_push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`, endpoint) > 0
  }

  /**
   * Drops one of this account's rows by its id, and answers whether anything was there to drop.
   *
   * The endpoint form above is what a send has to use — the sender holds the credential and no id — but a
   * surface may not be handed a credential just to let a reader remove their own device, and the redacted
   * list it can read carries only the head of each endpoint. This is the delete that list is answered from:
   * the row's own id, and the account it belongs to, and nothing else. An id that names another account's
   * row matches no row here and returns false, so the caller says 404 without ever telling the reader whose
   * row it was not.
   */
  async deletePushSubscriptionById(id: string): Promise<boolean> {
    return await this.write(`DELETE FROM chat_push_subscriptions WHERE user_id = ?1 AND id = ?2`, id) > 0
  }

  /**
   * Records a send this subscription refused, and drops it once refusals have made it worthless.
   *
   * The caller passes text already safe to keep: an endpoint never belongs in `last_error`, because a
   * database dump or a support screenshot of this column would otherwise carry a live credential. A
   * refusal that reaches the limit is not a subscription to keep trying — the device has said nothing for
   * five sends, and a row that cannot be delivered to is only a leak waiting to be read.
   */
  async notePushFailure(endpoint: string, error: string): Promise<{ failures: number, dropped: boolean }> {
    const touched = await this.write(
      `UPDATE chat_push_subscriptions SET failures = failures + 1, last_error = ?2 WHERE user_id = ?1 AND endpoint = ?3`,
      error.slice(0, PUSH_SUBSCRIPTION_ERROR_CHARS), endpoint,
    )
    if (!touched) return { failures: 0, dropped: false }
    const row = await this.one<{ failures: number }>(
      `SELECT failures FROM chat_push_subscriptions WHERE user_id = ?1 AND endpoint = ?2`,
      this.userId, endpoint,
    )
    const failures = row?.failures ?? 0
    if (failures < PUSH_SUBSCRIPTION_FAILURE_LIMIT) return { failures, dropped: false }
    await this.deletePushSubscription(endpoint)
    return { failures, dropped: true }
  }

  // --------------------------------------------------------- pending actions

  async createPendingAction(input: {
    conversationId: string, tool: string, targetId: string, targetLabel: string,
    /** Kept so an external call can be replayed after the reader approves it. */
    args?: Record<string, unknown>
  }): Promise<PendingAction> {
    const id = newId()
    const at = Date.now()
    const expires = at + PENDING_ACTION_TTL_MS
    const label = input.targetLabel.slice(0, 300)
    await this.write(
      `INSERT INTO chat_pending_actions
         (id, user_id, conversation_id, tool, target_id, target_label, args, status, created_at, expires_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)`,
      id, input.conversationId, input.tool, input.targetId, label, JSON.stringify(input.args ?? {}), at, expires,
    )
    return {
      id,
      tool: input.tool,
      conversationId: input.conversationId,
      targetId: input.targetId,
      targetLabel: label,
      args: input.args ?? {},
      status: 'pending',
      error: null,
      createdAt: at,
      expiresAt: expires,
    }
  }

  async getPendingAction(id: string): Promise<PendingAction | null> {
    const r = await this.one<ActionRow>(
      `SELECT * FROM chat_pending_actions WHERE user_id = ?1 AND id = ?2`,
      this.userId, id,
    )
    return r ? toAction(r) : null
  }

  /** Claims a pending action exactly once; false means another press already handled it. */
  async claimPendingAction(id: string, status: 'approved' | 'cancelled'): Promise<boolean> {
    return await this.write(
      `UPDATE chat_pending_actions SET status = ?2, resolved_at = ?3
         WHERE user_id = ?1 AND id = ?4 AND status = 'pending'`,
      status, Date.now(), id,
    ) > 0
  }

  async resolvePendingAction(id: string, patch: { status: PendingActionStatus, error?: string | null }): Promise<void> {
    await this.write(
      `UPDATE chat_pending_actions SET status = ?2, error = ?3, resolved_at = ?4 WHERE user_id = ?1 AND id = ?5`,
      patch.status, patch.error ?? null, Date.now(), id,
    )
  }

  /**
   * Current state of every action a conversation holds.
   *
   * A stored tool part carries the approval as it looked when that turn ended; without this the card
   * would keep offering Approve after the reader pressed it, or after it expired.
   */
  async actionStatesForConversation(conversationId: string): Promise<Map<string, PendingAction>> {
    const list = await this.rows<ActionRow>(
      `SELECT * FROM chat_pending_actions WHERE user_id = ?1 AND conversation_id = ?2`,
      this.userId, conversationId,
    )
    const out = new Map<string, PendingAction>()
    for (const r of list) {
      const action = toAction(r)
      out.set(action.id, action)
    }
    return out
  }

  /** Rewrites one tool entry inside a stored message's `tools` JSON. */
  async attachActionToMessage(messageId: string, toolId: string, action: PendingAction, result?: string): Promise<void> {
    const r = await this.one<{ tools: string | null }>(
      `SELECT tools FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, messageId,
    )
    if (!r) return
    const tools = decodeTools(r.tools).map((tool) => (tool.id === toolId
      ? { ...tool, approval: action, ...(result ? { result: clipToolPayload(result) } : {}) }
      : tool))
    await this.write(`UPDATE chat_messages SET tools = ?2 WHERE user_id = ?1 AND id = ?3`, JSON.stringify(tools), messageId)
  }

  /**
   * Add files to an answer that has already been filed.
   *
   * The approval path is the only caller: a tool that drew a picture ran a minute after the turn it
   * belongs to was written, so there is no `addMessage` left to carry the id. Merged rather than replaced,
   * because an answer may already carry files, and deduped because approving twice must not list the same
   * one twice.
   */
  async appendMessageAttachments(messageId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return
    const row = await this.one<{ attachments: string | null }>(
      `SELECT attachments FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, messageId,
    )
    if (!row) return
    const merged = [...new Set([...decodeStringList(row.attachments), ...ids])].slice(0, MAX_CHAT_ATTACHMENTS)
    await this.write(`UPDATE chat_messages SET attachments = ?2 WHERE user_id = ?1 AND id = ?3`, JSON.stringify(merged), messageId)
  }

  /** Which message holds a proposal, so approving it can refresh the right bubble. */
  async messageForAction(actionId: string): Promise<{ messageId: string, toolId: string } | null> {
    const list = await this.rows<{ id: string, tools: string | null }>(
      `SELECT id, tools FROM chat_messages WHERE user_id = ?1 AND tools LIKE ?2`,
      this.userId, `%${actionId}%`,
    )
    for (const r of list) {
      for (const tool of decodeTools(r.tools)) {
        if (tool.approval?.id === actionId) return { messageId: r.id, toolId: tool.id }
      }
    }
    return null
  }

  // ------------------------------------------------------------------- usage

  /**
   * The reader's zone, resolved once per store.
   *
   * Every counter below is keyed by a calendar day, and a day only means something somewhere: the daily
   * ceiling is read as "today", so the day it rolls over is the reader's, not the deployment's. Kept here
   * rather than passed in by each caller because one writer using a different key than its readers is
   * exactly the mistake — the split would be invisible until a quota emptied eight hours early.
   */
  private zoneRequested?: Promise<string>

  /** The day the usage counters are keyed by: `YYYY-MM-DD` where the reader lives. */
  async currentUsageDay(at = new Date()): Promise<string> {
    return usageDay(at, await this.usageZone())
  }

  private async usageZone(): Promise<string> {
    this.zoneRequested ??= this.getSettings().then((settings) => settings.timezone)
    return await this.zoneRequested
  }

  /**
   * Adds to the day's counters.
   *
   * The record the caller holds is camelCase, the column it lands in is not, so the name is looked up
   * rather than written into the SQL: an unmapped key is dropped instead of becoming a column reference
   * that fails the statement — and a failing statement here would mark a finished answer as an error.
   *
   * `chargeDay` false is for the one counter a caller has already spent in its own statement: the daily
   * ceiling is enforced where the day's `requests` moves (`reserveRequests`), and charging it twice would
   * read back double.
   */
  async incrementUsage(
    counters: Partial<UsageCounters>,
    day?: string,
    modelLabel = '',
    keyRef?: { providerId: string, providerLabel: string, keyId?: string, keyLabel?: string },
    chargeDay = true,
    at = new Date(),
  ): Promise<void> {
    const today = day ?? await this.currentUsageDay()
    await this.write(`INSERT INTO chat_usage_daily (user_id, day) VALUES (?1, ?2) ON CONFLICT(user_id, day) DO NOTHING`, today)
    // The model row is opened before the counters are applied so the two are written the same way, and
    // only when a label was given: a scheduled embedding or a failed call belongs to the day's totals
    // without belonging to any model's.
    //
    // `model_id` is resolved from the label here rather than passed in, because the caller that holds the
    // model (the runner) files only the label. Resolving at write time captures the id while the label is
    // still the model's current one, so a later rename cannot detach this row; it is set only when exactly
    // one of the account's models carries that label, so a reused or already-renamed-away label leaves it
    // NULL and the read path falls back to matching by label rather than guessing an attribution.
    if (modelLabel) {
      await this.write(
        `INSERT INTO chat_usage_daily_model (user_id, day, model_label, model_id)
         VALUES (?1, ?2, ?3, CASE WHEN (
             SELECT COUNT(*) FROM chat_models m WHERE m.user_id = ?1 AND m.label = ?3
           ) = 1 THEN (
             SELECT m.id FROM chat_models m WHERE m.user_id = ?1 AND m.label = ?3
           ) ELSE NULL END)
         ON CONFLICT(user_id, day, model_label) DO NOTHING`,
        today, modelLabel.slice(0, 120),
      )
    }
    // A third row records which provider and key answered, so a reader rotating keys can see what each
    // one spent. It is opened only when a provider is known: a failed call that never resolved a model
    // has no key to charge.
    if (keyRef?.providerId) {
      await this.write(
        `INSERT INTO chat_usage_daily_key (user_id, day, model_label, provider_id, provider_label, key_id, key_label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, day, model_label, provider_id, key_id) DO NOTHING`,
        today, modelLabel.slice(0, 120), keyRef.providerId.slice(0, 60), keyRef.providerLabel.slice(0, 120),
        (keyRef.keyId ?? '').slice(0, 60), (keyRef.keyLabel ?? '').slice(0, 120),
      )
    }
    const periodTokens = {
      input: Math.max(0, Math.round(counters.inputTokens ?? 0)),
      output: Math.max(0, Math.round(counters.outputTokens ?? 0)),
    }
    if (modelLabel && (periodTokens.input || periodTokens.output)) {
      // One model per label is the same condition the model row uses to claim an id. A label shared by
      // two rows has no single price schedule, so its tokens stay at the base rate instead of being
      // billed against whichever row happened to come back first.
      const priced = await this.db.prepare(
        `SELECT CASE WHEN COUNT(*) = 1 THEN MAX(id) END AS id,
                CASE WHEN COUNT(*) = 1 THEN MAX(price_periods) END AS periods
           FROM chat_models WHERE user_id = ?1 AND label = ?2`,
      ).bind(this.userId, modelLabel.slice(0, 120)).first<{ id: string | null, periods: string | null }>()
      const period = activePricePeriod(parsePricePeriods(parseJson(priced?.periods)), at, await this.usageZone())
      if (period && (period.inputPrice !== null || period.outputPrice !== null)) {
        const providerId = (keyRef?.providerId ?? '').slice(0, 60)
        const keyId = (keyRef?.keyId ?? '').slice(0, 60)
        await this.write(
          `INSERT INTO chat_usage_daily_period
             (user_id, day, model_label, model_id, period_id, provider_id, key_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(user_id, day, model_label, period_id, provider_id, key_id) DO NOTHING`,
          today, modelLabel.slice(0, 120), priced?.id ?? null, period.id, providerId, keyId,
        )
        await this.db.prepare(
          `UPDATE chat_usage_daily_period
              SET input_tokens = input_tokens + ?7, output_tokens = output_tokens + ?8
            WHERE user_id = ?1 AND day = ?2 AND model_label = ?3 AND period_id = ?4
              AND provider_id = ?5 AND key_id = ?6`,
        ).bind(this.userId, today, modelLabel.slice(0, 120), period.id, providerId, keyId, periodTokens.input, periodTokens.output).run()
      }
    }
    const targets: Array<{ table: string, guard: string, extra: unknown[] }> = []
    if (chargeDay) targets.push({ table: 'chat_usage_daily', guard: 'user_id = ?1 AND day = ?2', extra: [] })
    if (modelLabel) {
      targets.push({
        table: 'chat_usage_daily_model',
        guard: 'user_id = ?1 AND day = ?2 AND model_label = ?3',
        extra: [modelLabel.slice(0, 120)],
      })
    }
    if (keyRef?.providerId) {
      targets.push({
        table: 'chat_usage_daily_key',
        guard: 'user_id = ?1 AND day = ?2 AND model_label = ?3 AND provider_id = ?4 AND key_id = ?5',
        extra: [modelLabel.slice(0, 120), keyRef.providerId.slice(0, 60), (keyRef.keyId ?? '').slice(0, 60)],
      })
    }
    for (const { table, guard, extra } of targets) {
      const sets: string[] = []
      const binds: unknown[] = [this.userId, today, ...extra]
      for (const [key, amount] of Object.entries(counters) as [keyof UsageCounters, number][]) {
        const column = USAGE_COLUMNS[key]
        if (!column || !amount) continue
        binds.push(Math.round(amount))
        sets.push(`${column} = ${column} + ?${binds.length}`)
      }
      if (!sets.length) continue
      await this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${guard}`)
        .bind(...binds).run()
    }
  }

  /**
   * Spends `count` of the reader's daily requests, and answers whether the ceiling had room for them.
   *
   * Reading the day's total and then writing it is what let two turns both pass: each saw one request left
   * and both charged it, so `maxRequestsPerDay` was a number the reader could not count on. Here the guard
   * is part of the UPDATE, so the database judges it against the row at the moment the write lands, and
   * the answer is whether the row moved — false spends nothing anywhere.
   *
   * The per-model and per-key breakdowns follow a charge that succeeded rather than leading it. A turn
   * that was refused never reached a model, so it belongs in no model's count; a day's counters are the
   * number the ceiling is judged against, so they are the one statement that has to be right on time.
   */
  async reserveRequests(
    count: number,
    maxPerDay: number,
    modelLabel = '',
    keyRef?: { providerId: string, providerLabel: string, keyId?: string, keyLabel?: string },
  ): Promise<boolean> {
    const request = Math.max(0, Math.round(count))
    const today = await this.currentUsageDay()
    // The day has to have a row before a guard can be read off it; opening it charges nothing.
    await this.write(`INSERT INTO chat_usage_daily (user_id, day) VALUES (?1, ?2) ON CONFLICT(user_id, day) DO NOTHING`, today)
    const charged = await this.db.prepare(
      `UPDATE chat_usage_daily SET requests = requests + ?3
        WHERE user_id = ?1 AND day = ?2 AND requests + ?3 <= ?4`,
    ).bind(this.userId, today, request, Math.max(0, Math.round(maxPerDay))).run()
    if ((charged.meta?.changes ?? 0) <= 0) return false
    await this.incrementUsage({ requests: request }, today, modelLabel, keyRef, false)
    return true
  }


  /**
   * Heal the per-model dimension for usage written before it existed.
   *
   * The by-model rows arrived after readers already had history, so everything recorded before that lives
   * only in the plain day counters — a day's tokens are there and its model is not, which reads as a chart
   * of zeros. The message rows are the truth those counters were computed from, so a missing (day, model)
   * pair is rebuilt from them once: `INSERT OR IGNORE` makes a second pass a no-op rather than a second
   * charge, and a day that already has a row for that model keeps the live counters.
   *
   * Only days before today are healed. Today's row can be half-written while this runs — a turn inserts
   * the day and its model row before the counters are applied — and mixing that live row with a
   * message-derived one would count the same turn twice.
   *
   * What is rebuilt is what the messages can prove: `requests` counts assistant turns rather than the
   * reserve() calls a multi-step turn makes, and tool calls are read from the tools each turn stored. A
   * turn that failed before resolving a model has no model to be filed under and stays in the day's
   * totals alone, which is the honest reading: it belonged to no model.
   */
  async backfillModelUsage(today = usageDay()): Promise<number> {
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO chat_usage_daily_model
         (user_id, day, model_label, requests, input_tokens, output_tokens, tool_calls, errors)
       SELECT m.user_id, m.day, m.model_label, COUNT(*),
              COALESCE(SUM(m.input_tokens), 0), COALESCE(SUM(m.output_tokens), 0),
              COALESCE(SUM(CASE WHEN json_valid(m.tools) THEN json_array_length(m.tools) ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN m.status = 'error' THEN 1 ELSE 0 END), 0)
         FROM (
           SELECT user_id, model_label, input_tokens, output_tokens, tools, status,
                  strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day
             FROM chat_messages
            WHERE user_id = ?1 AND role = 'assistant' AND model_label <> ''
         ) m
         JOIN chat_usage_daily d ON d.user_id = m.user_id AND d.day = m.day
        WHERE d.day < ?2
        GROUP BY m.user_id, m.day, m.model_label`,
    ).bind(this.userId, today).run()
    return result.meta?.changes ?? 0
  }
  /**
   * The per-provider-and-key rows between two days, most used first.
   *
   * One row per (model, provider, key), so a key that ran two models is summed here rather than losing
   * one of them. Rows written before the key dimension existed are absent, which is the honest reading:
   * their key was never recorded.
   */
  async keyUsageRange(from: string, to: string): Promise<Array<{
    providerId: string
    providerLabel: string
    keyId: string
    keyLabel: string
    modelLabel: string
  } & UsageCounters>> {
    const { results } = await this.db.prepare(
      `SELECT provider_id, provider_label, key_id, key_label, model_label,
              SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key
        WHERE user_id = ?1 AND day >= ?2 AND day <= ?3
        GROUP BY provider_id, provider_label, key_id, key_label, model_label
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, provider_label ASC`,
    ).bind(this.userId, from, to).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
      providerId: String(row.provider_id ?? ''),
      providerLabel: String(row.provider_label ?? ''),
      keyId: String(row.key_id ?? ''),
      keyLabel: String(row.key_label ?? ''),
      modelLabel: String(row.model_label ?? ''),
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      scheduledRuns: 0,
      embeddings: 0,
      errors: Number(row.errors ?? 0),
    }))
  }

  /** The per-model rows between two days, most used first. */
  async modelUsageRange(from: string, to: string): Promise<Array<{ modelLabel: string, modelId: string } & UsageCounters>> {
    const { results } = await this.db.prepare(
      `SELECT model_label, MAX(model_id) AS model_id, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_model
        WHERE user_id = ?1 AND day >= ?2 AND day <= ?3
        GROUP BY model_label
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, model_label ASC`,
    ).bind(this.userId, from, to).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
      modelLabel: String(row.model_label ?? ''),
      modelId: String(row.model_id ?? ''),
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      scheduledRuns: 0,
      embeddings: 0,
      errors: Number(row.errors ?? 0),
    }))
  }

  /**
   * Tokens filed under a pricing window, one row per day, model, window and key.
   *
   * The daily totals already carry these tokens; this is the split that says which rate they were under.
   * A day with no row for a model's tokens is not missing data — it is the base-rate remainder.
   */
  async periodUsageRange(from: string, to: string): Promise<Array<{
    day: string
    modelLabel: string
    modelId: string | null
    periodId: string
    providerId: string
    keyId: string
    inputTokens: number
    outputTokens: number
  }>> {
    const { results } = await this.db.prepare(
      `SELECT day, model_label, MAX(model_id) AS model_id, period_id, provider_id, key_id,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
         FROM chat_usage_daily_period
        WHERE user_id = ?1 AND day >= ?2 AND day <= ?3
        GROUP BY day, model_label, period_id, provider_id, key_id
        ORDER BY day ASC, model_label ASC`,
    ).bind(this.userId, from, to).all<Record<string, number | string | null>>()
    return (results ?? []).map((row) => ({
      day: String(row.day ?? ''),
      modelLabel: String(row.model_label ?? ''),
      modelId: typeof row.model_id === 'string' ? row.model_id : null,
      periodId: String(row.period_id ?? ''),
      providerId: String(row.provider_id ?? ''),
      keyId: String(row.key_id ?? ''),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    }))
  }

  /** The `AND` suffix a stats filter adds to a dimension-table query, binding its values as it goes. */
  private dimensionWhere(filter: UsageFilter, binds: unknown[]): string {
    const clauses: string[] = []
    if (filter.model) {
      binds.push(filter.model)
      clauses.push(`model_label = ?${binds.length}`)
    }
    if (filter.providerId) {
      binds.push(filter.providerId)
      clauses.push(`provider_id = ?${binds.length}`)
    }
    if (filter.keyId !== undefined) {
      binds.push(filter.keyId)
      clauses.push(`key_id = ?${binds.length}`)
    }
    return clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
  }

  /** Whether a filter can be answered from the model dimension alone: no provider or key was named. */
  private modelDimensionOnly(filter: UsageFilter): boolean {
    return !filter.providerId && filter.keyId === undefined
  }

  /** The counters one dimension-table aggregate holds, read the same way whichever dimension answered. */
  private dimensionCounters(row: Record<string, number | string | null> | null | undefined): UsageCounters {
    if (!row) return { ...EMPTY_USAGE }
    return {
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      scheduledRuns: 0,
      embeddings: 0,
      errors: Number(row.errors ?? 0),
    }
  }

  /** Day rows from either dimension table, as the API's own counters. */
  private dimensionDays(rows: Array<Record<string, number | string>> | null | undefined): Array<{ day: string } & UsageCounters> {
    return (rows ?? []).map((row) => ({ day: String(row.day ?? ''), ...this.dimensionCounters(row) }))
  }

  /** Per-model rows from either dimension table, most-used labels kept by the caller's own ordering. */
  private dimensionModels(rows: Array<Record<string, number | string>> | null | undefined): Array<{ modelLabel: string, modelId: string } & UsageCounters> {
    return (rows ?? []).map((row) => ({ modelLabel: String(row.model_label ?? ''), modelId: String(row.model_id ?? ''), ...this.dimensionCounters(row) }))
  }

  /** One day-and-model slice of the usage series, whichever dimension table answered it. */
  private dimensionSeries(rows: Array<Record<string, number | string>> | null | undefined, keyed: boolean): UsageSeriesRow[] {
    return (rows ?? []).map((row) => ({
      day: String(row.day ?? ''),
      modelLabel: String(row.model_label ?? ''),
      modelId: String(row.model_id ?? ''),
      providerId: keyed ? String(row.provider_id ?? '') : '',
      providerLabel: keyed ? String(row.provider_label ?? '') : '',
      keyId: keyed ? String(row.key_id ?? '') : '',
      keyLabel: keyed ? String(row.key_label ?? '') : '',
      ...this.dimensionCounters(row),
    }))
  }
  /**
   * The day totals for one slice of the key dimension.
   *
   * Read from `chat_usage_daily_key` rather than the plain day table because only that table knows which
   * model or key a token came from. Rows written before the dimension existed are absent, so a filtered
   * view starts from the day it was added — the unfiltered view stays the whole history.
   */
  async usageRangeIn(from: string, to: string, filter: UsageFilter): Promise<UsageCounters> {
    // A model-only filter is answered from the model dimension: it holds every labelled call, including
    // the history `backfillModelUsage` rebuilt, while the key table only starts on the day a key was
    // recorded. A provider or key filter still reads the key table, because only it knows who paid.
    if (this.modelDimensionOnly(filter)) {
      const binds: unknown[] = [this.userId, from, to]
      const where = filter.model ? ' AND model_label = ?4' : ''
      if (filter.model) binds.push(filter.model)
      return this.dimensionCounters(await this.one<Record<string, number | null>>(
        `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls,
                COALESCE(SUM(errors),0) AS errors
           FROM chat_usage_daily_model WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}`,
        ...binds,
      ))
    }
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    return this.dimensionCounters(await this.one<Record<string, number | null>>(
      `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls,
              COALESCE(SUM(errors),0) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}`,
      ...binds,
    ))
  }

  /** The day rows for one slice of either dimension, for the trend and the heat map. */
  async usageDaysIn(from: string, to: string, filter: UsageFilter): Promise<Array<{ day: string } & UsageCounters>> {
    if (this.modelDimensionOnly(filter)) {
      const binds: unknown[] = [this.userId, from, to]
      const where = filter.model ? ' AND model_label = ?4' : ''
      if (filter.model) binds.push(filter.model)
      const { results } = await this.db.prepare(
        `SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
           FROM chat_usage_daily_model WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
          GROUP BY day ORDER BY day ASC`,
      ).bind(...binds).all<Record<string, number | string>>()
      return this.dimensionDays(results)
    }
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const { results } = await this.db.prepare(
      `SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
        GROUP BY day ORDER BY day ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return this.dimensionDays(results)
  }

  /** The per-model rows for one slice of either dimension, most used first. */
  async modelUsageRangeIn(from: string, to: string, filter: UsageFilter): Promise<Array<{ modelLabel: string, modelId: string } & UsageCounters>> {
    if (this.modelDimensionOnly(filter)) {
      const binds: unknown[] = [this.userId, from, to]
      const where = filter.model ? ' AND model_label = ?4' : ''
      if (filter.model) binds.push(filter.model)
      const { results } = await this.db.prepare(
        `SELECT model_label, MAX(model_id) AS model_id, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
           FROM chat_usage_daily_model WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
          GROUP BY model_label
          ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, model_label ASC`,
      ).bind(...binds).all<Record<string, number | string>>()
      return this.dimensionModels(results)
    }
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const { results } = await this.db.prepare(
      `SELECT model_label, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
        GROUP BY model_label
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, model_label ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return this.dimensionModels(results)
  }

  /**
   * The window broken down by day *and* by what paid for it.
   *
   * The charts need the same rows read two ways — a bar per day grouped by model, or the same bars grouped
   * by key — and the per-model cards need them a third time, per model across days. The key dimension is
   * asked when a provider or key is named, because only it knows who paid.
   *
   * A model filter is answered from the model dimension instead: it holds every labelled call, including
   * the history `backfillModelUsage` rebuilt, while asking the key table would drop every rebuilt day for
   * having no key to name. The unfiltered chart reads both and adds the rebuilt days the key table has
   * never heard of, so history does not draw as a gap.
   */
  async usageSeries(from: string, to: string, filter: UsageFilter): Promise<UsageSeriesRow[]> {
    const keyed = Boolean(filter.providerId) || filter.keyId !== undefined
    if (!keyed && filter.model) return this.dimensionSeries(await this.keylessSeries(from, to, filter.model), false)
    const keyedRows = await this.keyedSeries(from, to, filter)
    if (keyed) return keyedRows
    const rebuilt = await this.keylessSeries(from, to, undefined, true)
    return [...keyedRows, ...this.dimensionSeries(rebuilt, false)]
      .sort((left, right) => left.day.localeCompare(right.day))
  }

  /** The key dimension's rows, filtered the way the caller asked. */
  private async keyedSeries(from: string, to: string, filter: UsageFilter): Promise<UsageSeriesRow[]> {
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const { results } = await this.db.prepare(
      `SELECT day, model_label, provider_id, provider_label, key_id, key_label,
              SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
        GROUP BY day, model_label, provider_id, provider_label, key_id, key_label
        ORDER BY day ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return this.dimensionSeries(results, true)
  }

  /**
   * The model dimension's rows for one label or for every label.
   *
   * `rebuiltOnly` keeps the days the key table has no row for: those are the days the backfill healed,
   * and they are exactly what the unfiltered chart would otherwise leave as a gap. It never runs beside a
   * keyed day, so a day with both dimensions is counted by the keyed query alone.
   */
  private async keylessSeries(
    from: string,
    to: string,
    modelLabel: string | undefined,
    rebuiltOnly = false,
  ): Promise<Array<Record<string, number | string>>> {
    const binds: unknown[] = [this.userId, from, to]
    const where = modelLabel ? ' AND model_label = ?4' : ''
    if (modelLabel) binds.push(modelLabel)
    const unkeyed = rebuiltOnly
      ? ` AND NOT EXISTS (
           SELECT 1 FROM chat_usage_daily_key k
            WHERE k.user_id = chat_usage_daily_model.user_id AND k.day = chat_usage_daily_model.day
         )`
      : ''
    const { results } = await this.db.prepare(
      `SELECT day, model_label, MAX(model_id) AS model_id, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_model WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}${unkeyed}
        GROUP BY day, model_label ORDER BY day ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return results ?? []
  }

  /**
   * The account's own numbers, over its whole life rather than a window.
   *
   * The activity map is every day the reader has ever spent anything on and the streaks are runs of those
   * days, so none of this can be answered from a range the reader picked — the panel's range control belongs
   * to the trend below these, not to them. `chat_usage_daily` is the table to ask, because it is the one
   * that holds the whole history rather than only the days the key dimension has existed for.
   */
  async usageOverview(): Promise<{
    totalTokens: number
    peakDay: string | null
    peakTokens: number
    longestTurnMs: number
    currentStreak: number
    longestStreak: number
    activity: Array<{ day: string, tokens: number }>
  }> {
    const [total, peak, longest, rows] = await Promise.all([
      this.one<{ tokens: number | null }>(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM chat_usage_daily WHERE user_id = ?1`,
        this.userId,
      ),
      this.one<{ day: string, tokens: number }>(
        `SELECT day, (input_tokens + output_tokens) AS tokens FROM chat_usage_daily
          WHERE user_id = ?1 ORDER BY tokens DESC, day ASC LIMIT 1`,
        this.userId,
      ),
      // Only the assistant's own turns: a reader's message is filed with no duration, and the number this
      // answers is how long a turn took rather than how long the row sat there.
      this.one<{ ms: number | null }>(
        `SELECT MAX(duration_ms) AS ms FROM chat_messages WHERE user_id = ?1 AND role = 'assistant'`,
        this.userId,
      ),
      this.db.prepare(
        `SELECT day, (input_tokens + output_tokens) AS tokens FROM chat_usage_daily
          WHERE user_id = ?1 AND (input_tokens + output_tokens) > 0 ORDER BY day ASC`,
      ).bind(this.userId).all<Record<string, number | string>>(),
    ])
    const activity = (rows.results ?? []).map((row) => ({ day: String(row.day ?? ''), tokens: Number(row.tokens ?? 0) }))
    return {
      totalTokens: Number(total?.tokens ?? 0),
      peakDay: peak?.day ?? null,
      peakTokens: Number(peak?.tokens ?? 0),
      longestTurnMs: Number(longest?.ms ?? 0),
      ...usageStreaks(activity.map((entry) => entry.day), await this.currentUsageDay()),
      activity,
    }
  }

  /** The first day this account has any usage on, so "all" has somewhere to start. */
  async firstUsageDay(): Promise<string | null> {
    const row = await this.one<{ day: string | null }>(
      `SELECT MIN(day) AS day FROM chat_usage_daily WHERE user_id = ?1`,
      this.userId,
    )
    return row?.day ?? null
  }

  /**
   * The conversations that spent the most in a window, by the turns they hold.
   *
   * Counted from the messages rather than from a per-conversation counter, because a message is what
   * actually cost anything and a counter would have to be kept in step with every delete and every
   * restored backup — the rows are the truth, so they are what is read.
   */
  async usageByConversation(from: string, to: string, limit = 8): Promise<Array<{
    id: string
    title: string
    requests: number
    inputTokens: number
    outputTokens: number
    updatedAt: number
  }>> {
    // The window is in the reader's days, and their turns are stored in real milliseconds: bounded at UTC
    // midnight the first hours of the oldest day would fall outside a list that says it covers them.
    const zone = await this.usageZone()
    const { results } = await this.db.prepare(
      `SELECT c.id AS id, c.title AS title, c.updated_at AS updated_at,
              COUNT(m.id) AS requests,
              COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(m.output_tokens), 0) AS output_tokens
         FROM chat_messages m
         JOIN chat_conversations c ON c.user_id = m.user_id AND c.id = m.conversation_id
        WHERE m.user_id = ?1 AND m.created_at >= ?2 AND m.created_at < ?3
        GROUP BY c.id, c.title, c.updated_at
        ORDER BY (COALESCE(SUM(m.input_tokens), 0) + COALESCE(SUM(m.output_tokens), 0)) DESC, c.updated_at DESC
        LIMIT ?4`,
    ).bind(this.userId, startOfDayMillis(from, zone), startOfDayMillis(to, zone) + 86_400_000, Math.max(1, Math.min(50, limit)))
      .all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }))
  }

  /** Every day in the range that has a number on it, for the trend and the heat map. */
  async usageDays(from: string, to: string): Promise<Array<{ day: string } & UsageCounters>> {
    const { results } = await this.db.prepare(
      `SELECT day, requests, input_tokens, output_tokens, tool_calls, scheduled_runs, embeddings, errors
         FROM chat_usage_daily WHERE user_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day ASC`,
    ).bind(this.userId, from, to).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
      day: String(row.day ?? ''),
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      scheduledRuns: Number(row.scheduled_runs ?? 0),
      embeddings: Number(row.embeddings ?? 0),
      errors: Number(row.errors ?? 0),
    }))
  }

  async usageRange(from: string, to: string): Promise<UsageCounters> {
    const r = await this.one<Record<string, number | null>>(
      `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls,
              COALESCE(SUM(scheduled_runs),0) AS scheduled_runs, COALESCE(SUM(embeddings),0) AS embeddings,
              COALESCE(SUM(errors),0) AS errors
         FROM chat_usage_daily WHERE user_id = ?1 AND day >= ?2 AND day <= ?3`,
      this.userId, from, to,
    )
    if (!r) return { ...EMPTY_USAGE }
    return {
      requests: r.requests ?? 0,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      toolCalls: r.tool_calls ?? 0,
      scheduledRuns: r.scheduled_runs ?? 0,
      embeddings: r.embeddings ?? 0,
      errors: r.errors ?? 0,
    }
  }

  async todayUsage(): Promise<UsageCounters> {
    const day = await this.currentUsageDay()
    return this.usageRange(day, day)
  }

  // ---------------------------------------------------------------- activity

  async recordActivity(type: string, summary: string): Promise<void> {
    await this.write(
      `INSERT INTO chat_activity (id, user_id, type, summary, created_at) VALUES (?2, ?1, ?3, ?4, ?5)`,
      newId(), type.slice(0, 60), summary.slice(0, 500), Date.now(),
    )
    await this.write(
      `DELETE FROM chat_activity WHERE user_id = ?1 AND id NOT IN (
         SELECT id FROM chat_activity WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 500
       )`,
    )
  }

  async listActivity(limit = 100): Promise<ActivityRow[]> {
    return this.rows<ActivityRow>(
      `SELECT id, type, summary, created_at FROM chat_activity WHERE user_id = ?1
        ORDER BY created_at DESC LIMIT ?2`,
      this.userId, limit,
    )
  }

  /**
   * Removes the log line that quoted a memory, when the memory itself is forgotten.
   *
   * The activity list shows what the assistant did and why; a line that survives the thing it names
   * would keep the fact readable after the reader asked to be forgotten.
   */
  async deleteActivityQuoting(type: string, summary: string): Promise<void> {
    await this.write(
      `DELETE FROM chat_activity WHERE user_id = ?1 AND type = ?2 AND summary = ?3`,
      type, summary.slice(0, 500),
    )
  }

  // -------------------------------------------------------------- run leases

  /**
   * Claims a conversation for one turn, returning the token that proves the caller owns it.
   *
   * A second message while a reply is streaming would start a second run whose output interleaves into
   * the same assistant message. The read-then-write this replaces let two requests both see a free row
   * and both start a turn; one conditional upsert now decides it in the database — the insert takes a
   * free conversation, and the conflict branch only moves the lease when the old one has expired.
   * The lease expires on purpose: a stream abandoned by a closed laptop must not lock a conversation.
   *
   * The token is the claim's `started_at`. `releaseRun` takes it back, so a turn that overran its lease
   * cannot let go of a claim somebody else has taken in the meantime.
   *
   * A takeover is also the last moment a dead turn's half answer exists anywhere else, so it is the moment
   * it gets filed: the upsert below clears `partial_text` — deliberately, since a new answer must never
   * start from another turn's first half — and without the read above that would delete the only copy of
   * what a killed Worker had already written. See `adoptRunPartial` for why this is not done by the read
   * that shows the fragment instead.
   */
  async claimRun(conversationId: string, now = Date.now()): Promise<number | null> {
    // One extra read per turn, on the row this statement is about to write anyway, and it files anything
    // only when the claim has aged out: a lease somebody is holding has nothing to adopt, and `adoptRunPartial`
    // refuses it again under the same condition.
    const held = await this.readRunLease(conversationId, now)
    if (held.text) await this.adoptRunPartial(conversationId, held, now)
    const result = await this.db.prepare(
      `INSERT INTO chat_active_runs (conversation_id, user_id, started_at, lease_until)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, conversation_id) DO UPDATE SET
         started_at = excluded.started_at, lease_until = excluded.lease_until, partial_text = NULL
       WHERE chat_active_runs.lease_until <= ?3`,
    ).bind(conversationId, this.userId, now, now + RUN_LEASE_MS).run()
    return (result.meta?.changes ?? 0) > 0 ? now : null
  }

  /**
   * Keeps a claim alive, and with a token only the claim that token owns.
   *
   * A turn that knows its token renews with `touchRun`, which answers whether the claim is still its own.
   * This is for a caller that holds the lease itself and never hands the token out: with nothing to
   * compare, an unguarded renewal extends whatever claim the conversation has.
   *
   * The words the turn has written so far ride along on the same statement. A turn that dies without
   * running its `finish` — a Worker isolate out of CPU leaves no assistant row at all — otherwise leaves
   * the conversation holding a lease and nothing else, which is the half answer this repository keeps
   * losing. Nothing here waits for that case: the renewal is the only write a live turn makes anyway.
   */
  async renewRun(conversationId: string, token?: number, now = Date.now(), partialText?: string | null): Promise<void> {
    const guard = token === undefined ? '' : ' AND started_at = ?4'
    const binds: (string | number | null)[] = token === undefined
      ? [conversationId, now + RUN_LEASE_MS, this.userId]
      : [conversationId, now + RUN_LEASE_MS, this.userId, token]
    // Bringing no draft is not the same as bringing an empty one: the timestamp moves and what the turn
    // wrote earlier stays. Clearing takes saying so, because a renewal that knows nothing about the column
    // must not be able to empty a thread somebody is still reading.
    const carry = partialText === undefined ? null : clipRunPartial(partialText)
    const set = partialText === undefined
      ? 'lease_until = ?2'
      : `lease_until = ?2, partial_text = ?${binds.length + 1}`
    if (partialText !== undefined) binds.push(carry)
    await this.db.prepare(`UPDATE chat_active_runs SET ${set} WHERE conversation_id = ?1 AND user_id = ?3${guard}`)
      .bind(...binds).run()
  }

  /**
   * Renews a claim and says whether the caller still holds it, in one statement.
   *
   * Renewal and ownership cannot be two reads, because the gap between them is the bug: a turn that
   * renewed blindly kept a conversation it had already lost, and a turn that only asked whether the
   * conversation was live read whoever was streaming and carried on — which is how two answers came to be
   * written into one thread. The token is the `started_at` the claim was made under, so the UPDATE moves
   * this claim's row and no other: false means somebody else owns the conversation now, and the caller
   * stops.
   *
   * Expiry is deliberately not part of the guard. A step that outlived the lease is still this turn's
   * step, and a claim only the owner can extend is what makes that safe. A lease nobody touches is still
   * open for the next `claimRun` to take, so a laptop that closes its tab does not lock a conversation.
   *
   * `partialText` is the answer as the turn has it right now, cut to the ceiling the column may carry. It
   * is written by the same statement rather than a second one, because the renewal happens every
   * sixteenth event and an extra round trip on that path is a price the streaming turn pays for something
   * it may never need. Absent is a caller with no draft to report and leaves the column alone; null or an
   * empty string is a turn that has written nothing yet, and clears it.
   */
  async touchRun(conversationId: string, token: number, now = Date.now(), partialText?: string | null): Promise<boolean> {
    const binds: (string | number | null)[] = [conversationId, this.userId, now + RUN_LEASE_MS, token]
    const set = partialText === undefined ? 'lease_until = ?3' : 'lease_until = ?3, partial_text = ?5'
    if (partialText !== undefined) binds.push(clipRunPartial(partialText))
    const result = await this.db.prepare(
      `UPDATE chat_active_runs SET ${set}
        WHERE conversation_id = ?1 AND user_id = ?2 AND started_at = ?4`,
    ).bind(...binds).run()
    return (result.meta?.changes ?? 0) > 0
  }

  /**
   * The claim on a conversation as it stands: whether it is live, and what had been written under it.
   *
   * `isRunning` answers the first question and clears a claim nobody is holding any more. This answers the
   * other one too, and deliberately does not clear anything: the row is the only place an interrupted
   * turn's words still exist, so the read that reports them has to leave them for whoever asks next.
   * Ownership is the `user_id` in the WHERE clause — a lease is keyed by account, and one account can read
   * neither another's claim nor another's half answer.
   */
  async readRunLease(conversationId: string, now = Date.now()): Promise<RunLease> {
    const row = await this.one<{ started_at: number, lease_until: number, partial_text: string | null }>(
      `SELECT started_at, lease_until, partial_text FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2`,
      conversationId, this.userId,
    )
    if (!row) return { claimed: false, running: false, token: null, text: null, truncated: false }
    const text = typeof row.partial_text === 'string' && row.partial_text.length > 0 ? row.partial_text : null
    return {
      claimed: true,
      running: row.lease_until > now,
      token: row.started_at,
      text,
      // The column is only ever written at or below the ceiling, so filling it is the whole of what a
      // truncation can be detected from. Guessing "probably complete" here is the lie this exists to stop:
      // an exact-multiple-of-the-ceiling answer is reported as cut short, which is the safe direction.
      truncated: text !== null && text.length >= RUN_PARTIAL_MAX_CHARS,
    }
  }

  /**
   * Files a dead turn's fragment as the unfinished answer it is, and lets go of the claim with it.
   *
   * This is what makes the half answer continuable rather than merely visible. A continuation picks an
   * answer up out of `chat_messages` — `routes/assistant.ts` refuses one whose newest row is not an
   * assistant row with words in it, and `runner.ts` reads the same row to start writing from — so a
   * fragment that only ever lives on the lease has nothing for the control to carry on from, and a screen
   * that offered it would be offering a turn the worker refuses. Filing the row turns the interrupted-
   * worker case into the state that path was already written for: an answer with content and a status
   * that says it did not finish.
   *
   * Called from `claimRun`, which is where the fragment is about to be destroyed, and not from the
   * conversation read that shows it. That read is how the half answer reaches the screen at all, and a
   * read that also filed the row would delete the claim it has just reported — so the reader would have
   * to re-open the thread to keep the words they were just shown. `tests/assistant-run-partial.test.ts`
   * pins both halves of that: the read reports a stale claim's fragment, and the claim still holds it
   * after the read returned.
   *
   * Only a claim nobody holds any more is taken this way. A lease inside its window may belong to an
   * isolate that is still writing, and a fragment lifted from under a live turn would leave that answer
   * arriving beside a copy of its own first half. The delete names the token the caller read *and* the
   * window, in one statement: two turns reaching one dead claim file one answer, and the one that loses
   * the race finds nothing to take and files nothing.
   *
   * No model label and no usage, deliberately. A turn killed before `finish` never settled which model
   * was answering, and its request was already charged when the turn started — charging it again would
   * spend the reader's daily ceiling twice for work no vendor finished selling.
   */
  async adoptRunPartial(conversationId: string, lease: RunLease, now = Date.now()): Promise<AssistantMessage | null> {
    if (!lease.text || lease.token === null || lease.running) return null
    const result = await this.db.prepare(
      `DELETE FROM chat_active_runs
        WHERE conversation_id = ?1 AND user_id = ?2 AND started_at = ?3 AND lease_until <= ?4`,
    ).bind(conversationId, this.userId, lease.token, now).run()
    if ((result.meta?.changes ?? 0) === 0) return null
    return this.addMessage({
      conversationId,
      role: 'assistant',
      content: lease.text,
      // `error`, not `cancelled`: nobody stopped this turn, and the transcript has to say which of the two
      // happened. An error row with words in it is also the exact shape the continue control already admits.
      status: 'error',
      error: lease.truncated
        // Both halves of the truth, because each alone reads as the other: the deployment cut the turn off,
        // and the ceiling on the column that carried it cut what is filed here off again.
        ? `The worker writing this answer ran out of time before it finished, so it stops where it does; the model did not choose this ending. Only the first ${RUN_PARTIAL_MAX_CHARS} characters of what it had written were kept, so more was written than is shown above.`
        : 'The worker writing this answer ran out of time before it finished, so it stops where it does; the model did not choose this ending. Everything above is what it had written.',
    })
  }

  /**
   * Lets go of a claim, and only of one's own when a token is given.
   *
   * The token is what `claimRun` returned. Without it a turn that outlived its lease could finish after
   * another tab had claimed the conversation and delete that newer claim, letting a third turn in beside
   * a live one. A stop carries the token of the turn it stopped for the same reason: press stop and send
   * again straight away, and an unguarded delete here would unlock — and so abort — the turn that had just
   * begun. No token is right for a conversation being deleted, where there is no turn whose claim to
   * protect and the point is exactly to release whatever is held.
   */
  async releaseRun(conversationId: string, token?: number): Promise<void> {
    const guard = token === undefined ? '' : ' AND started_at = ?3'
    const binds = token === undefined ? [conversationId, this.userId] : [conversationId, this.userId, token]
    await this.db.prepare(`DELETE FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2${guard}`)
      .bind(...binds).run()
  }

  /**
   * Whether somebody is streaming into this conversation right now — a read, for the UI.
   *
   * A running turn asks this question of its own lease and gets the wrong answer when the row has been
   * taken over: an expired claim deleted here reads as "not running", while another run's fresh claim
   * reads as "still mine". `touchRun` is what a turn checks; this one stays here because the conversation
   * screen only wants to know whether a reply is arriving.
   */
  async isRunning(conversationId: string, now = Date.now()): Promise<boolean> {
    const r = await this.one<{ lease_until: number, started_at: number }>(
      `SELECT lease_until, started_at FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2`,
      conversationId, this.userId,
    )
    if (!r) return false
    if (r.lease_until > now) return true
    // Only the expired claim this read saw is cleared: a fresh one taken between the read and the
    // delete belongs to a turn that is running right now.
    await this.releaseRun(conversationId, r.started_at)
    return false
  }

  // ------------------------------------------------------------------ import

  /** The columns an imported row may set, read off the allowlist before any SQL is assembled. */
  private importColumns(table: string): readonly string[] {
    const columns = EXPORT_COLUMNS[table]
    if (!columns) throw new Error(`unknown assistant export table ${table}`)
    return columns
  }

  /**
   * One imported row, written only for the columns the row itself names.
   *
   * The partial `UPDATE` below has always worked this way — a key the file never carried says nothing, and the
   * patch skips it — and the insert had to agree, because binding an absent key as NULL into a `NOT NULL`
   * column that has a default makes `INSERT OR IGNORE` drop the whole row without a word. That silent drop is
   * what a new column does to an import: three times this table has paid for a caller that did not know the
   * list, so the primitive now defers to the column's own default instead of depending on every caller to
   * remember it. A key the row does carry is still written exactly as given, including an explicit `null`.
   */
  private importInsert(table: string, columns: readonly string[], row: Record<string, unknown>): D1PreparedStatement {
    const named = columns.filter((column) => column in row)
    const names = ['user_id', ...named]
    const placeholders = names.map((_, index) => `?${index + 1}`).join(', ')
    const values = [this.userId, ...named.map((column) => normaliseBind(row[column]))]
    return this.db.prepare(`INSERT OR IGNORE INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
      .bind(...values)
  }

  /**
   * A partial `UPDATE` for one imported row, or null when it names no column this table holds.
   *
   * Only the columns the caller named are written: a restore that rewrote a column the file never
   * carried would blank local data the backup had nothing to say about.
   */
  private importPatch(table: string, columns: readonly string[], id: string, row: Record<string, unknown>): D1PreparedStatement | null {
    const sets: string[] = []
    const binds: unknown[] = [this.userId]
    for (const column of columns) {
      if (column === 'id' || column === 'user_id') continue
      if (!(column in row)) continue
      binds.push(normaliseBind(row[column]))
      sets.push(`${column} = ?${binds.length}`)
    }
    if (!sets.length) return null
    binds.push(id)
    return this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE user_id = ?1 AND id = ?${binds.length}`)
      .bind(...binds)
  }

  async importRow(table: string, row: Record<string, unknown>): Promise<void> {
    await this.importInsert(table, this.importColumns(table), row).run()
  }

  async importUpdate(table: string, id: string, row: Record<string, unknown>): Promise<void> {
    await this.importPatch(table, this.importColumns(table), id, row)?.run()
  }

  /**
   * A page of imported rows, written as few times as D1 allows.
   *
   * Each chunk is one batch and a batch is one transaction, so a chunk is all-or-nothing; that is the
   * whole of the atomicity a restore can have here, because no D1 transaction spans two of them. Which is
   * why the rows are counted as each chunk lands rather than once at the end: a restore that stops between
   * two batches has to report the rows that are really in the account, and the caller is the only thing
   * that can hear them.
   */
  async importRows(table: string, rows: readonly Record<string, unknown>[], onLanded?: (landed: number) => void): Promise<void> {
    if (!rows.length) return
    const columns = this.importColumns(table)
    await this.runImportBatch(rows.map((row) => this.importInsert(table, columns, row)), onLanded)
    // A task row names its reminder in the `remind_at` field the backup format has always carried;
    // the column itself is no longer written (see `EXPORT_COLUMNS`), this turns the field into the
    // row that now owns the instants. They are written after the tasks they belong to, and only when
    // the same instant is not already pending here: importing one file twice must not double its
    // alarms.
    if (table === 'todos_tasks') await this.importTaskReminders(rows)
  }

  /** The `remind_at` fields a backup attached to its task rows, as rows of `todos_reminders`. */
  private async importTaskReminders(rows: readonly Record<string, unknown>[]): Promise<void> {
    const at = Date.now()
    const statements: D1PreparedStatement[] = []
    for (const row of rows) {
      const taskId = typeof row.id === 'string' ? row.id : ''
      if (!taskId) continue
      const times = Array.isArray(row.reminders)
        ? row.reminders as number[]
        : typeof row.remind_at === 'number' ? [row.remind_at] : []
      for (const remindAt of normalizeReminderTimes(times)) {
        statements.push(this.db.prepare(
          `INSERT INTO todos_reminders (user_id, id, task_id, remind_at, fired_at, created_at)
           SELECT ?1, ?2, ?3, ?4, NULL, ?5
            WHERE NOT EXISTS (
              SELECT 1 FROM todos_reminders
               WHERE user_id = ?1 AND task_id = ?3 AND remind_at = ?4 AND fired_at IS NULL
            )`,
        ).bind(this.userId, newId(), taskId, remindAt, at))
      }
    }
    await this.runImportBatch(statements)
  }

  /** The same, for the rows this account already holds and the file is allowed to rewrite. */
  async importUpdates(table: string, patches: readonly { id: string, row: Record<string, unknown> }[], onLanded?: (landed: number) => void): Promise<void> {
    if (!patches.length) return
    const columns = this.importColumns(table)
    const statements = patches
      .map((patch) => this.importPatch(table, columns, patch.id, patch.row))
      .filter((statement): statement is D1PreparedStatement => statement !== null)
    await this.runImportBatch(statements, onLanded)
    // The reminder named by a newer file joins the local task's pending list; the task's own edit
    // still wins for every column above, and a duplicate instant is not added twice.
    if (table === 'todos_tasks') await this.importTaskReminders(patches.map((patch) => patch.row))
  }

  private async runImportBatch(statements: readonly D1PreparedStatement[], onLanded?: (landed: number) => void): Promise<void> {
    for (let start = 0; start < statements.length; start += MAX_BATCH_STATEMENTS) {
      const results = await this.db.batch(statements.slice(start, start + MAX_BATCH_STATEMENTS))
      onLanded?.(results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0))
    }
  }

  /** Which of these ids this account already holds — one chunked read, not one round trip per row. */
  async hasRows(table: string, ids: readonly string[]): Promise<Set<string>> {
    if (!this.importColumns(table).includes('id')) throw new Error(`assistant export table ${table} has no id column`)
    const found = new Set<string>()
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      const list = await this.rows<{ id: string }>(`SELECT id FROM ${table} WHERE ${q.where}`, ...q.binds)
      for (const row of list) found.add(row.id)
    }
    return found
  }

  /**
   * When this account's own copy of each named row was last edited, for the ids it has one for.
   *
   * An import merges by id, and the one rule it must never break is not to replace a newer local edit
   * with an older copy out of the file. That needs the stored timestamp before deciding, so it is read
   * through the same column map `importRow` already trusts rather than a table name out of the file —
   * and read for the whole page at once, because a restore of a big library is a lot of rows.
   */
  async storedUpdatedAts(table: string, ids: readonly string[]): Promise<Map<string, number>> {
    if (!this.importColumns(table).includes('updated_at')) throw new Error(`unknown assistant export table ${table}`)
    const stored = new Map<string, number>()
    for (const chunk of idReadChunks(ids)) {
      const q = new Query(this.userId)
      q.inList('id', chunk)
      const list = await this.rows<{ id: string, updated_at: number }>(
        `SELECT id, updated_at FROM ${table} WHERE ${q.where}`, ...q.binds,
      )
      for (const row of list) stored.set(row.id, Number(row.updated_at))
    }
    return stored
  }

  /**
   * Every conversation id this account holds, for deciding which dependent rows an import may keep.
   *
   * Read as ids rather than through `listConversations`, whose page is capped: a library larger than one
   * page would otherwise restore its newest threads whole and silently drop the messages of every older
   * one, which is the quiet half of a data loss.
   */
  async conversationIds(): Promise<string[]> {
    const list = await this.rows<{ id: string }>(`SELECT id FROM chat_conversations WHERE user_id = ?1`, this.userId)
    return list.map((row) => row.id)
  }

  /**
   * Everything a backup carries.
   *
   * A temporary conversation is left out, and so is everything hanging off it. The reader asked for a
   * thread that would not be kept, and a file they hand to somebody else is the last place it should
   * reappear. The dependent tables are filtered through the conversation rather than by a column of their
   * own, because none of them carries the flag.
   */
  async exportTables(): Promise<Record<string, Record<string, unknown>[]>> {
    const onlyKept = 'conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = ?1 AND ephemeral = 0)'
    const select = (table: string, extra = '') => this.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 ${extra} ORDER BY created_at`)
      .bind(this.userId).all<Record<string, unknown>>().then((r) => r.results ?? [])
    // The trash is not part of a backup. A file is a snapshot of what the account still has; a task
    // the reader deleted is on its way out (the retention sweep will remove it within 30 days), and a
    // restore must not bring back what they deliberately put away. The children follow their task, so
    // filtering the task alone would leave orphaned steps, links and reminders in the file.
    const liveTask = `task_id IN (SELECT id FROM todos_tasks WHERE user_id = ?1 AND ${TASK_LIVE_PREDICATE})`
    const tasks = await select('todos_tasks', `AND ${TASK_LIVE_PREDICATE}`)
    // The stamp of a live row is null and carries no information into another account; the format
    // does not have the column (see `EXPORT_COLUMNS`), so `SELECT *` has to drop it here or a restore
    // would read a key the allowlist never accepts.
    for (const task of tasks) delete task.deleted_at
    // A reminder travels on its task. The backup format has one row per task and no table for these,
    // so the first pending instant is written into the `remind_at` field the format already had; the
    // import reads it back as a row of `todos_reminders`. Fired rows stay behind: a restore is not a
    // delivery, and history the file does not need is not a reason to write it into another account.
    // The task row's own `remind_at` column is not read — it is superseded and this value is derived
    // from the reminder rows, then overwritten either way.
    const pending = await select('todos_reminders', `AND fired_at IS NULL AND ${liveTask}`)
    const byTask = new Map<string, number[]>()
    for (const row of pending) {
      const taskId = typeof row.task_id === 'string' ? row.task_id : ''
      const remindAt = typeof row.remind_at === 'number' ? row.remind_at : null
      if (!taskId || remindAt === null) continue
      const bucket = byTask.get(taskId) ?? []
      bucket.push(remindAt)
      byTask.set(taskId, bucket)
    }
    for (const task of tasks) {
      const list = typeof task.id === 'string' ? byTask.get(task.id) : undefined
      task.remind_at = list?.length ? normalizeReminderTimes(list)[0]! : null
    }
    return {
      conversations: await select('chat_conversations', 'AND ephemeral = 0'),
      artifacts: await select('chat_artifacts', `AND ${onlyKept}`),
      artifact_versions: await select('chat_artifact_versions', `AND ${onlyKept}`),
      conversation_tags: await select('chat_conversation_tags', `AND ${onlyKept}`),
      messages: await select('chat_messages', `AND ${onlyKept}`),
      answer_versions: await select('chat_answer_versions', `AND ${onlyKept}`),
      memories: await select('chat_memories'),
      tasks,
      task_lists: await select('todos_lists'),
      task_steps: await select('todos_steps', `AND ${liveTask}`),
      task_tags: await select('todos_tags'),
      task_tag_links: await select('todos_tag_links', `AND ${liveTask}`),
      projects: await select('chat_projects'),
      automations: await select('chat_automations'),
      notifications: await select('chat_notifications'),
    }
  }
}

/**
 * Every column an imported row may set.
 *
 * The table name reaches `importRow` from a backup file, and a column list is built from the same
 * object, so this map is what keeps a hostile file from naming a table or a column at all: an entry
 * that is not here is refused before any SQL is assembled.
 *
 * `chat_push_subscriptions` is absent on purpose, and so is `chat_active_runs`: a push subscription is a
 * credential — endpoint plus p256dh plus auth is the right to place a notification on somebody's device — so
 * it goes nowhere near an export, a share or an off-site snapshot, and it is not what a restore is for. The
 * device re-subscribes itself. Adding it here is a privacy regression, not a missing feature, and
 * `tests/push-subscription-store.test.ts` fails the moment the triple reaches any export path.
 *
 * `chat_active_runs` stays out for the same kind of reason, and its `partial_text` is the sharper case of it.
 * A lease is a transient state: it says what one request was doing at the instant it held the conversation,
 * and it stops meaning anything the moment that request is gone. `partial_text` is what such a dead request
 * left behind, and a restore is not the surface that should decide what to do with it — the reader who
 * restores a backup onto a machine that has never seen the turn gets a half answer with no interrupted turn
 * to attach it to, filed nowhere in the transcript and never cleared by a second one. `exportTables()` reads
 * the same allowlist, so one list keeps both sides honest. What does deserve to survive a restore is the
 * answer once it is finished, and that is `chat_messages.content`, which is on the list; the fragment is
 * adopted into such a row by `claimRun`, the statement that would otherwise overwrite it, so nothing that
 * should be kept depends on this table.
 */
const EXPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // `project_id` and `parent_id` are part of a stored thread even though the backup did not always
  // carry them: a restore that lost them put every thread back at the account's root, and a fork
  // forgot what it was forked from.
  // `note_id` rides along for the same reason: a thread restored without it forgets which note it came
  // from, and the chip that says so has nothing left to say.
  chat_conversations: ['id', 'title', 'summary', 'summary_upto', 'pinned', 'starred', 'archived', 'folder_id', 'project_id', 'parent_id', 'note_id', 'created_at', 'updated_at'],
  chat_artifacts: ['id', 'conversation_id', 'title', 'content', 'note_id', 'version', 'created_at', 'updated_at'],
  // Every snapshot travels: a restore onto another device that kept only the head would turn a document
  // with history into one that has never been edited, which is the opposite of what the panel promises.
  chat_artifact_versions: ['id', 'artifact_id', 'conversation_id', 'version', 'title', 'content', 'source', 'message_id', 'created_at'],
  chat_conversation_tags: ['conversation_id', 'tag_id', 'created_at'],
  // `sources` is where a searched answer says what it read, and `feedback` is the reader's own verdict:
  // both are shown by the transcript, so a restored row without them is a different row.
  // `saved_at` rides with them for the sharper reason: the shelf that lists keeps is built from this column,
  // so a restore that lost it leaves the reader with a thread whose answer they had kept, kept nowhere — and
  // because the column is nullable, `INSERT OR IGNORE` drops nothing on the way back in. The row lands with
  // the mark gone, which is the quiet version of the loss rather than the loud one.
  chat_messages: ['id', 'conversation_id', 'role', 'content', 'reasoning', 'tools', 'attachments', 'status', 'error', 'source', 'input_tokens', 'output_tokens', 'duration_ms', 'model_label', 'sources', 'feedback', 'scopes', 'suggestions', 'saved_at', 'created_at'],
  chat_answer_versions: ['id', 'message_id', 'conversation_id', 'content', 'reasoning', 'tools', 'model_label', 'input_tokens', 'output_tokens', 'duration_ms', 'created_at'],
  // `note_id` is the note a fact was written out as: a pointer the management screen shows, so it
  // travels with the fact it belongs to.
  chat_memories: ['id', 'content', 'category', 'source', 'status', 'superseded_by', 'valid_from', 'valid_until', 'project_id', 'note_id', 'created_at', 'updated_at'],
  // Every column the app reads travels, not only the ones the tool layer writes: a task restored
  // without its list, star, repeat or note link is a different task, and `reminded_at` is the one
  // exception — a restore is not a delivery, so the next sweep may announce it again.
  // `created_on` and `completed_on` are the statistics' day columns: a restore that dropped them
  // would leave every restored task with no day until a boot backfilled it, and the fingerprint note
  // means a boot after a restore does not come back through the repair. They are nullable, so an old
  // backup without the keys still lands.
  // `remind_at` is deliberately absent: the single reminder column is superseded by `todos_reminders`,
  // and a restore turns the backup's `remind_at` field into a row of that table instead of writing a
  // column nothing reads. The field still travels in the file, because that is the format's shape.
  // `deleted_at` is absent for a different reason: trashed rows are not exported at all (see
  // `exportTables`), so a column that would only ever be null is not part of the format.
  // `icon` and `color` are the task's own face: a restore that dropped them would silently hand every
  // restored task back its list's, which is a different row than the one that was backed up. Both are
  // nullable, so an old backup without the keys still lands.
  todos_tasks: ['id', 'title', 'description', 'status', 'priority', 'due_at', 'start_at', 'project_id', 'list_id', 'icon', 'color', 'starred', 'repeat_rule', 'note_id', 'conversation_id', 'created_at', 'updated_at', 'completed_at', 'created_on', 'completed_on'],
  todos_lists: ['id', 'name', 'icon', 'color', 'position', 'created_at', 'updated_at'],
  todos_steps: ['id', 'task_id', 'text', 'done', 'position', 'created_at'],
  todos_tags: ['id', 'name', 'color', 'created_at', 'updated_at'],
  // A link has no id of its own: its key is the pair, so it is only ever inserted, never patched.
  todos_tag_links: ['task_id', 'tag_id', 'created_at'],
  // The brief and the folders a project reads are what make it a context rather than a folder; a
  // restored project without them is the same name over an empty brief. `note_ids` travels with them: a
  // project that named three pages and came back naming none would answer from the whole vault, which is
  // the opposite of what the reader picked. `model_id` is left out on purpose: models are not in the
  // backup, so a carried id could only point at nothing.
  chat_projects: ['id', 'name', 'description', 'instructions', 'note_scope', 'note_ids', 'created_at', 'updated_at'],
  // The two targets travel with the schedule: a routine that was told to file its answer into one folder,
  // or to refill one standing page, restored without that pointer would have to be re-pointed by hand —
  // and a reader who restores a backup expecting their morning log page to keep being written would find
  // a schedule that writes nothing and says nothing about it.
  chat_automations: ['id', 'name', 'kind', 'message', 'schedule', 'enabled', 'status', 'next_run', 'last_run', 'last_result', 'last_error', 'run_count', 'target_folder_id', 'target_note_id', 'created_at', 'updated_at'],
  // `pushed_at` stays out on purpose, unlike the rest of the row: it is this deployment's bookkeeping about
  // devices that a restored machine does not have. Carrying it over would hand the restore a shelf of
  // notifications the new devices were never told about and a marker saying they were — the reader would get
  // no nudge for news they have not seen, which is the quiet direction of the mistake this table has made
  // twice before for the opposite reason.
  //
  // `link` does travel, and that is a decision rather than an oversight: it is the notice's own statement of
  // what it was about, the reader's press is what reads it, and the tasks it points at are in this same file.
  // A restore that brought back a reminder and threw away its pointer would leave a notice that looks the
  // same and does less than the one the reader had.
  chat_notifications: ['id', 'title', 'body', 'automation_id', 'link', 'subscription_id', 'read_at', 'created_at'],
}

/**
 * The ids of one read, deduplicated and cut into chunks that keep every statement under the
 * bind-variable ceiling D1 imposes — the same reason the delete loops above page themselves.
 */
function idReadChunks(ids: readonly string[]): string[][] {
  return idChunks([...new Set(ids)])
}

function normaliseBind(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Accounts whose next run has arrived, claimed as it is read.
 *
 * The cron tick is the only caller and it spans every account, so this is the one query in the module
 * that is not scoped to a user — which is why each result carries its own `user_id` and the executor
 * opens a store for that account rather than the caller's. The claim is a conditional update, so two
 * overlapping ticks cannot both run the same automation.
 */
export async function dueAutomations(
  db: D1Database,
  now: number,
  limit = 20,
): Promise<{ userId: string, automation: Automation }[]> {
  const { results } = await db.prepare(
    `SELECT * FROM chat_automations
      WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?1
        AND (claimed_at IS NULL OR claimed_at < ?2)
      ORDER BY next_run LIMIT ?3`,
  ).bind(now, now - AUTOMATION_CLAIM_MS, limit).all<AutomationRow & { user_id: string }>()
  const out: { userId: string, automation: Automation }[] = []
  for (const r of results ?? []) {
    const claimed = await db.prepare(
      `UPDATE chat_automations SET claimed_at = ?1
         WHERE user_id = ?2 AND id = ?3 AND (claimed_at IS NULL OR claimed_at < ?4)`,
    ).bind(now, r.user_id, r.id, now - AUTOMATION_CLAIM_MS).run()
    if (!claimed.meta?.changes) continue
    const automation = toAutomation(r)[0]
    if (automation) out.push({ userId: r.user_id, automation })
  }
  return out
}

/**
 * Sweep away the temporary conversations that have outlived their retention.
 *
 * The hourly cron is the only caller and it spans every account, so this is the second query in the module
 * that is not scoped to a user — hence the returned ids and the per-account store opened for each, the
 * same shape `dueAutomations` uses. The work is bounded per fire: a backlog is drained over several ticks
 * rather than in one invocation nobody is watching.
 */
export async function purgeExpiredEphemeralConversations(
  db: D1Database,
  env: Env,
  now = Date.now(),
  limit = 20,
): Promise<number> {
  const before = now - EPHEMERAL_CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const { results } = await db.prepare(
    `SELECT user_id FROM chat_conversations
      WHERE ephemeral = 1 AND updated_at < ?1
      GROUP BY user_id ORDER BY min(updated_at) LIMIT ?2`,
  ).bind(before, limit).all<{ user_id: string }>()
  let removed = 0
  for (const row of results ?? []) {
    removed += await new AssistantStore(db, row.user_id, env).purgeEphemeral(before)
  }
  return removed
}

/**
 * The five statements that remove one account's trashed tasks for good.
 *
 * Shared by the endpoint and the retention sweep so the trash is emptied one way: steps, tag links,
 * reminders and the task's history go with their task, and the task delete repeats the trash
 * predicate so a live row can never be caught by a stale id. The `IN` list is built here from ids
 * the account already owns, one place after a scoped read — and cut into chunks, because a sweep
 * page (`TODO_TRASH_PURGE_LIMIT`) names more ids than one statement may bind. The history goes and
 * the trash's soft delete does not: a trashed task still happened, and only a purge says it did
 * not.
 */
function purgeTaskStatements(db: D1Database, userId: string, ids: readonly string[]): D1PreparedStatement[] {
  if (!ids.length) return []
  const statements: D1PreparedStatement[] = []
  for (const chunk of idChunks(ids)) {
    const marks = chunkMarks(chunk)
    const binds = [userId, ...chunk]
    statements.push(
      db.prepare(`DELETE FROM todos_steps WHERE user_id = ?1 AND task_id IN (${marks})`).bind(...binds),
      db.prepare(`DELETE FROM todos_tag_links WHERE user_id = ?1 AND task_id IN (${marks})`).bind(...binds),
      db.prepare(`DELETE FROM todos_reminders WHERE user_id = ?1 AND task_id IN (${marks})`).bind(...binds),
      // The history asks the trash the same question the task delete does, and for the same reason:
      // a stale id must not be able to catch a live row. Without the predicate, a restore that won
      // the race would keep its task while the batch erased the past the task came back with.
      db.prepare(
        `DELETE FROM todos_task_events
          WHERE user_id = ?1 AND task_id IN (
            SELECT id FROM todos_tasks WHERE user_id = ?1 AND id IN (${marks}) AND ${TASK_TRASHED_PREDICATE}
          )`,
      ).bind(...binds),
      db.prepare(
        `DELETE FROM todos_tasks WHERE user_id = ?1 AND id IN (${marks}) AND ${TASK_TRASHED_PREDICATE}`,
      ).bind(...binds),
    )
  }
  return statements
}

/**
 * Empties the trash that has outlived its retention window, oldest deletion first.
 *
 * The hourly cron is the only caller and it spans every account, so this is another query in the
 * module that is not scoped to one reader — hence the returned ids and the per-account batches below,
 * the shape `purgeExpiredEphemeralConversations` already uses. The work is bounded per fire: a backlog
 * is drained over several ticks rather than in one invocation nobody is watching, and the ceiling is
 * a named constant so a test can pin it.
 */
export async function purgeExpiredTodoTrash(
  db: D1Database,
  now = Date.now(),
  limit = TODO_TRASH_PURGE_LIMIT,
): Promise<number> {
  const cutoff = now - TODO_TRASH_RETENTION_DAYS * DAY_MS
  const capped = Math.min(TODO_TRASH_PURGE_LIMIT, Math.max(1, Math.trunc(limit)))
  const { results } = await db.prepare(
    `SELECT user_id, id FROM todos_tasks
      WHERE ${TASK_TRASHED_PREDICATE} AND deleted_at < ?1
      ORDER BY deleted_at ASC, id ASC LIMIT ?2`,
  ).bind(cutoff, capped).all<{ user_id: string, id: string }>()

  // One account is one batch of five statements, however many of its rows the page holds.
  const byUser = new Map<string, string[]>()
  for (const row of results ?? []) {
    const bucket = byUser.get(row.user_id) ?? []
    bucket.push(row.id)
    byUser.set(row.user_id, bucket)
  }
  let removed = 0
  for (const [userId, ids] of byUser) {
    await db.batch(purgeTaskStatements(db, userId, ids))
    removed += ids.length
  }
  return removed
}

/**
 * The accounts holding a notification no device has ever been told about, inside the window.
 *
 * A catch-up fire is the third query in this module that is not scoped to one reader, and it is the same
 * shape as the two above it: it goes straight to `db.prepare`, it returns ids and nothing else, and every
 * read that follows one is made through a store bound to that account. It has to be cross-account because
 * the fire is looking for the sweep that did not happen — a process killed between writing the row and
 * sending the nudge leaves no trace anybody could ask a per-account reader about.
 *
 * `limit` is per fire, so a restored backup or a week of a deployment without VAPID keys is worked off over
 * several ticks rather than in one invocation nobody is watching.
 */
export async function accountsWithUnpushedNotifications(
  db: D1Database,
  sinceAt: number,
  limit: number,
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT user_id FROM chat_notifications
      WHERE pushed_at IS NULL AND read_at IS NULL AND created_at >= ?1
      GROUP BY user_id ORDER BY min(created_at) LIMIT ?2`,
  ).bind(sinceAt, limit).all<{ user_id: string }>()
  return (results ?? []).map((row) => row.user_id)
}

/** Terms worth searching a memory with: the words a reader would actually type. */
export function memorySearchTerms(query: string): string[] {
  const cleaned = query.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  const han = cleaned.match(/[\p{Script=Han}]+/gu) ?? []
  const latin = cleaned.match(/[a-zA-Z0-9]{3,}/g) ?? []
  const terms = new Set<string>()
  for (const run of han) {
    terms.add(run)
    // A long Han run rarely appears verbatim in a memory; its two-character parts are what match.
    for (let index = 0; index + 2 <= run.length; index++) terms.add(run.slice(index, index + 2))
  }
  for (const word of latin) terms.add(word)
  return [...terms].slice(0, 8)
}

/**
 * The day a usage counter is filed under.
 *
 * With a zone it is that reader's calendar day; without one it is UTC, which is what the arithmetic in
 * `dayBefore` wants — stepping a day string back never needs to know where anybody is.
 */
export function usageDay(date = new Date(), timezone?: string): string {
  return timezone ? localDate(date, timezone) : date.toISOString().slice(0, 10)
}

/**
 * Where a `YYYY-MM-DD` day begins, in UTC milliseconds.
 *
 * A day is a reader's day when a zone is given, and an arbitrary UTC frame when it is not — the latter is
 * only ever used to step between day strings, so the exact instant behind them does not matter there.
 */
export function startOfDayMillis(day: string, timezone?: string): number {
  if (timezone) {
    const [year, month, date] = day.split('-').map(Number)
    if (year && month && date) return zonedTimeToUtc(year, month, date, 0, 0, timezone).getTime()
  }
  const parsed = Date.parse(`${day}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** The day `count` days before `day`, so a window of 7 includes today. */
export function dayBefore(day: string, count: number): string {
  return usageDay(new Date(startOfDayMillis(day) - count * 86_400_000))
}

/**
 * The runs of consecutive days a reader has spent something on.
 *
 * The current run counts back from today, and a day not yet spent on does not break it — otherwise a reader
 * would watch their own streak read zero every morning until their first question. The longest run is just
 * the longest the whole history has ever been, so a broken streak is not a number lost.
 */
function usageStreaks(days: readonly string[], today: string): { currentStreak: number, longestStreak: number } {
  const spent = new Set(days)
  let longest = 0
  let run = 0
  let previous: string | null = null
  for (const day of [...spent].sort()) {
    run = previous !== null && dayBefore(day, 1) === previous ? run + 1 : 1
    previous = day
    if (run > longest) longest = run
  }
  let current = 0
  for (let cursor = spent.has(today) ? today : dayBefore(today, 1); spent.has(cursor); cursor = dayBefore(cursor, 1)) current++
  return { currentStreak: current, longestStreak: longest }
}

export interface MemoryReviewRow {
  id: string
  memory_id: string
  other_id: string
  relationship: string
  reason: string
  created_at: number
}

export interface ActivityRow {
  id: string
  type: string
  summary: string
  created_at: number
}

export interface ProviderRow {
  id: string
  label: string
  icon?: string | null
  protocol: AssistantProtocol
  base_url: string
  endpoints?: string | null
  reasoning_dialect?: string | null
  key_ciphertext?: string | null
  /** The last four characters of the stored key, written when the key is; never derived by decrypting. */
  key_hint?: string | null
  /** When the provider's own key last signed a call; null until it has been used once. */
  key_last_used_at?: number | null
  has_key?: number | null
  created_at: number
  updated_at: number
}

/**
 * A pin that can be honoured on this wire, or null.
 *
 * The dialects are not interchangeable across protocols — an effort shape means nothing to a Gemini body —
 * so a value that does not belong to the protocol is dropped rather than stored and then ignored at the
 * far end of a request.
 */
function compatibleDialect(protocol: AssistantProtocol, value: ReasoningDialect | null | undefined): ReasoningDialect | null {
  if (!value) return null
  return dialectsForProtocol(protocol).includes(value) ? value : null
}

function toProvider(r: ProviderRow): AssistantProvider {
  return {
    id: r.id,
    label: r.label,
    icon: parseAssistantIcon(r.icon),
    protocol: pickEnum(r.protocol, ASSISTANT_PROTOCOLS, 'openai'),
    baseUrl: r.base_url,
    endpoints: parseProviderEndpoints(r.endpoints),
    reasoningDialect: reasoningDialectValue(r.reasoning_dialect),
    hasKey: bool(r.has_key ?? Boolean(r.key_ciphertext)),
    // Stored beside the ciphertext, so the listing proves which key it holds without decrypting it.
    keyHint: r.key_hint ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface ProviderKeyRow {
  id: string
  provider_id: string
  label: string
  key_ciphertext?: string | null
  key_hint?: string | null
  enabled: number
  last_used_at?: number | null
  error_count: number
  last_error?: string | null
  created_at: number
  updated_at: number
}

function toProviderKey(r: ProviderKeyRow): AssistantProviderKey {
  return {
    id: r.id,
    providerId: r.provider_id,
    label: r.label,
    hasKey: Boolean(r.key_ciphertext),
    keyHint: r.key_hint ?? '',
    enabled: bool(r.enabled),
    lastUsedAt: r.last_used_at ?? null,
    errorCount: r.error_count ?? 0,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface SearchKeyRow {
  engine: string
  key_ciphertext?: string | null
  key_hint?: string | null
  created_at: number
  updated_at: number
}

/**
 * What a search engine's row says about its key: that one is there, and what it ends with.
 *
 * The ciphertext is read into nothing here — a row that carried it out of this file would be a secret in an
 * API response, which is the one thing this table exists to avoid. The listing computes `has_key` from its
 * length in SQL, so no statement that feeds this converter ever selects the column at all.
 */
function toSearchKeyPresence(r: { engine: string, has_key?: unknown, key_hint?: string | null, updated_at: number }): AssistantSearchKey {
  return {
    engine: r.engine,
    hasKey: bool(r.has_key ?? false),
    keyHint: r.key_hint ?? '',
    updatedAt: r.updated_at,
  }
}

/**
 * The columns a model row is read with. One list, because two hand-copied ones are how a new column
 * ends up written but never read back: the editor saved `purpose` and the reader saw the old value.
 */
export const MODEL_SELECT_COLUMNS = `id, provider_id, model, label, icon, temperature, max_output_tokens,
  reasoning, context_tokens, vendor_context_tokens, vendor_max_output_tokens, vision, purpose, kind, supports_tools, no_tools, max_input_tokens, modalities, top_p,
  custom_params, protocol, fallback_model_id, input_price, output_price, price_currency, price_periods, enabled, position`

/**
 * The columns a skill row is read with. One list, because two hand-copied ones are how a new column ends
 * up written but never read back: the editor saved an icon and the reader saw the old blank.
 */
const SKILL_SELECT_COLUMNS = `id, title, content, group_name, tools, scopes, model_id, icon, created_at, updated_at`

interface SkillRow {
  id: string
  title: string
  content: string
  group_name: string | null
  tools: string | null
  scopes: string | null
  model_id: string | null
  icon: string | null
  created_at: number
  updated_at: number
}

function toSkill(r: SkillRow): AssistantSkill {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    group: r.group_name ?? '',
    icon: r.icon ?? '',
    tools: decodeStringList(r.tools),
    scopes: decodeScopes(r.scopes),
    modelId: r.model_id ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

/**
 * The knowledge a saved skill reads, decoded the forgiving way the transcript reads its tools.
 *
 * A row written before these columns existed holds nothing, and one half-written holds a shape that is
 * not a scope; both read as "no extra folders" rather than failing the list.
 */
interface ModelRow {
  id: string
  provider_id: string
  model: string
  label: string
  icon?: string | null
  temperature: number | null
  max_output_tokens: number | null
  reasoning: string | null
  context_tokens: number | null
  vendor_context_tokens: number | null
  vendor_max_output_tokens: number | null
  vision: number | null
  purpose: string | null
  kind: string | null
  supports_tools: number | null
  no_tools: number
  max_input_tokens: number | null
  modalities: string | null
  top_p: number | null
  custom_params: string | null
  protocol: string | null
  fallback_model_id: string | null
  input_price: number | null
  output_price: number | null
  price_currency: string | null
  price_periods: string | null
  enabled: number
  position: number
}

function toModel(r: ModelRow): AssistantModel {
  return {
    id: r.id,
    providerId: r.provider_id,
    model: r.model,
    label: r.label || r.model,
    icon: parseAssistantIcon(r.icon),
    // Null is the reader's own choice — "leave the vendor default alone" — so it must not be turned
    // back into a number on the way out.
    temperature: num(r.temperature),
    // Null is "the reader has not set one", which the runner answers for; turning it into the account's
    // number here made every model look hand-set and froze the fallback at whatever it was that day.
    maxOutputTokens: num(r.max_output_tokens),
    reasoning: reasoningValue(r.reasoning),
    contextTokens: num(r.context_tokens),
    // Null here is "nobody has said", not the reader's "inherit the account's ceiling" that the two fields
    // above it mean; the editor's ladder and its warning are the only things that read them.
    vendorContextTokens: num(r.vendor_context_tokens),
    vendorMaxOutputTokens: num(r.vendor_max_output_tokens),
    vision: r.vision === null ? true : bool(r.vision),
    purpose: pickEnum(r.purpose, ASSISTANT_MODEL_PURPOSES, 'chat'),
    kind: pickEnum(r.kind, ASSISTANT_MODEL_KINDS, 'text'),
    supportsTools: r.supports_tools === null ? true : bool(r.supports_tools),
    // The column is `NOT NULL DEFAULT 0`, so a row that predates it reads as the switch never touched.
    noTools: bool(r.no_tools),
    maxInputTokens: num(r.max_input_tokens),
    modalities: parseModelModalities(parseJson(r.modalities)),
    topP: num(r.top_p),
    customParams: parseCustomParams(parseJson(r.custom_params)),
    // Null is "follow the provider", so an unknown value has to read back as null rather than a protocol.
    protocol: typeof r.protocol === 'string' && (ASSISTANT_PROTOCOLS as readonly string[]).includes(r.protocol)
      ? r.protocol as AssistantProtocol
      : null,
    // A dangling name — the spare has since been deleted — reads back as "no spare" rather than as an id
    // nothing can resolve, because the chain would stop there anyway.
    fallbackModelId: r.fallback_model_id ?? null,
    inputPrice: num(r.input_price),
    outputPrice: num(r.output_price),
    priceCurrency: r.price_currency ?? '',
    pricePeriods: parsePricePeriods(parseJson(r.price_periods)),
    enabled: bool(r.enabled),
  }
}

interface ChatAttachmentRow {
  id: string
  kind: string
  filename: string
  mime: string
  size: number
  key: string
  created_at: number
}

function toChatAttachment(r: ChatAttachmentRow): ChatAttachment {
  return {
    id: r.id,
    kind: r.kind === 'image' ? 'image' : 'file',
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    key: r.key,
    createdAt: r.created_at,
  }
}

const ARTIFACT_COLUMNS = `id, conversation_id, title, content, note_id, version, created_at, updated_at`
const ARTIFACT_VERSION_COLUMNS = `id, artifact_id, conversation_id, version, title, content, source, message_id, created_at`

/**
 * The conversation row, as every reader of it spells it.
 *
 * One list because there were two: the thread and the list each spelled the columns out, so a column
 * added to one and not the other read back as a default in exactly one of the two surfaces — which is how
 * a flag comes to be set and still look unset.
 */
const CONVERSATION_COLUMNS = `c.id, c.title, c.summary, c.summary_upto, c.pinned, c.starred, c.archived, c.ephemeral, c.parent_id, c.folder_id, c.project_id, c.note_id, c.created_at, c.updated_at`

interface ArtifactRow {
  id: string
  conversation_id: string
  title: string
  content: string
  note_id: string | null
  version: number
  created_at: number
  updated_at: number
}

function toArtifact(row: ArtifactRow): AssistantArtifact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    content: row.content,
    noteId: row.note_id ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ArtifactVersionRow {
  id: string
  artifact_id: string
  conversation_id: string
  version: number
  title: string
  content: string
  source: AssistantArtifactVersionSource
  message_id: string | null
  created_at: number
}

function toArtifactVersion(row: ArtifactVersionRow, includeContent: boolean): AssistantArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    conversationId: row.conversation_id,
    version: row.version,
    title: row.title,
    ...(includeContent ? { content: row.content } : {}),
    source: row.source,
    messageId: row.message_id ?? null,
    createdAt: row.created_at,
  }
}

/**
 * The draft changed since the caller read it.
 *
 * The store throws this rather than returning a conflict value because every caller has to answer it and
 * an ignored return value would silently overwrite the newer text. The route turns it into a 409; the
 * tools turn it into an error the model can read and retry after `read_artifact`.
 */
export class ArtifactVersionConflictError extends Error {
  constructor(readonly current: AssistantArtifact) {
    super('artifact_version_conflict')
    this.name = 'ArtifactVersionConflictError'
  }
}

interface ConversationRow {
  id: string
  title: string
  summary: string | null
  summary_upto: number | null
  pinned: number
  starred: number
  archived: number
  ephemeral: number
  parent_id: string | null
  folder_id: string | null
  project_id: string | null
  note_id: string | null
  created_at: number
  updated_at: number
  message_count: number
}

function toConversation(r: ConversationRow): AssistantConversation {
  return {
    id: r.id,
    title: r.title,
    pinned: bool(r.pinned),
    starred: bool(r.starred),
    archived: bool(r.archived),
    ephemeral: bool(r.ephemeral),
    parentId: r.parent_id ?? null,
    folderId: r.folder_id ?? null,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    noteId: r.note_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count ?? 0,
    summary: r.summary,
    summaryUpto: num(r.summary_upto),
  }
}

interface MemoryRow {
  id: string
  content: string
  category: string
  source: string
  status: string
  superseded_by: string | null
  valid_from: string | null
  valid_until: string | null
  project_id: string | null
  note_id: string | null
  created_at: number
  updated_at: number
}

function toMemory(r: MemoryRow): AssistantMemory {
  return {
    id: r.id,
    content: r.content,
    category: pickEnum(r.category, ASSISTANT_MEMORY_CATEGORIES, 'other'),
    source: pickEnum(r.source, MEMORY_SOURCES, 'manual'),
    status: pickEnum(r.status, MEMORY_STATUS_VALUES, 'active'),
    supersededBy: r.superseded_by,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    projectId: r.project_id,
    noteId: r.note_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface TaskRow {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  /** The reader's place among the list's rows, or null while nobody has moved it. */
  position: number | null
  due_at: number | null
  start_at: number | null
  project_id: string | null
  list_id: string | null
  /** The task's own icon, or null while it wears its list's. */
  icon: string | null
  /** The task's own colour, or null while it wears its list's. */
  color: string | null
  starred: number | null
  repeat_rule: string | null
  /** `TASK_REMINDER_TIMES`: the pending instants, comma-separated, or null when there are none. */
  reminder_times: string | null
  planned_for: string | null
  note_id: string | null
  conversation_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  /** The row's version: 1 when written, moved on by every write path. */
  rev: number
  /** When the row was moved to the trash, or null while it is live. */
  deleted_at: number | null
}

interface TaskListRow {
  id: string
  name: string
  icon: string | null
  color: string | null
  position: number
  /** When the reader put the list away; null while it is in use. */
  archived_at: number | null
  /** The container this list sits under, or null for a top-level list. */
  parent_id: string | null
  created_at: number
  updated_at: number
}

interface TaskTagRow {
  id: string
  name: string
  color: string | null
  created_at: number
  updated_at: number
}

interface TaskStepRow {
  id: string
  task_id: string
  text: string
  done: number
  position: number
  created_at: number
}

function toTask(
  r: TaskRow,
  extras: { tags: TaskTag[]; stepTotal: number; stepDone: number; reminders: number[] },
): TodoTask {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? '',
    status: pickEnum(r.status, TASK_STATUS_VALUES, 'todo'),
    priority: pickEnum(r.priority, TASK_PRIORITY_VALUES, 'medium'),
    position: num(r.position),
    dueAt: num(r.due_at),
    startAt: num(r.start_at),
    projectId: r.project_id,
    listId: r.list_id,
    icon: r.icon,
    color: r.color,
    tags: extras.tags,
    starred: (r.starred ?? 0) === 1,
    repeat: parseRepeatRule(parseJson(r.repeat_rule)),
    reminders: extras.reminders,
    // The single reminder the quick-add preview and the assistant's task tool read: the next one to
    // fire, or none. `remindedAt` is always null now — delivery lives on the reminder row itself.
    remindAt: extras.reminders[0] ?? null,
    remindedAt: null,
    plannedFor: r.planned_for ?? null,
    noteId: r.note_id,
    conversationId: r.conversation_id,
    stepTotal: extras.stepTotal,
    stepDone: extras.stepDone,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: num(r.completed_at),
    rev: r.rev,
    deletedAt: num(r.deleted_at),
  }
}

function toTaskList(r: TaskListRow, counts: { open: number; done: number }): TaskListEntry {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    position: r.position,
    archivedAt: r.archived_at ?? null,
    parentId: r.parent_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    openCount: counts.open,
    doneCount: counts.done,
  }
}

function toTaskTag(r: TaskTagRow, openCount: number): TaskTag {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    openCount,
  }
}

function toTaskStep(r: TaskStepRow): TaskStep {
  return {
    id: r.id,
    taskId: r.task_id,
    text: r.text,
    done: r.done === 1,
    position: r.position,
    createdAt: r.created_at,
  }
}

/**
 * A position strictly between two neighbours, or null when that gap has no room left.
 *
 * An undefined neighbour is an end: a run's first slot starts at 1000 and an append is a whole
 * thousand past the last, so the ordinary case does not depend on the midpoint at all. Steps and
 * tasks share the rule because both store a REAL order and both fold a drop between two rows.
 */
function insertionPosition(previous: number | undefined, next: number | undefined): number | null {
  if (previous === undefined && next === undefined) return 1000
  if (previous === undefined) return next! - 1000
  if (next === undefined) return previous + 1000
  const position = previous + (next - previous) / 2
  return Number.isFinite(position) && position > previous && position < next ? position : null
}

interface ProjectRow {
  id: string
  name: string
  description: string | null
  instructions: string | null
  note_scope: string | null
  note_ids: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    instructions: r.instructions ?? '',
    noteScope: decodeStringList(r.note_scope),
    noteIds: decodeStringList(r.note_ids),
    modelId: r.model_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface AutomationRow {
  id: string
  name: string
  kind: string
  message: string | null
  schedule: string
  enabled: number
  status: string
  next_run: number | null
  last_run: number | null
  last_result: string | null
  last_error: string | null
  run_count: number | null
  claimed_at: number | null
  target_folder_id: string | null
  target_note_id: string | null
  created_at: number
  updated_at: number
}

/** Returns nothing for a row whose schedule no longer parses, rather than inventing one. */
function toAutomation(r: AutomationRow): Automation[] {
  const schedule = parseScheduleSpec(parseJson(r.schedule))
  if (!schedule) return []
  return [{
    id: r.id,
    name: r.name,
    kind: pickEnum(r.kind, AUTOMATION_KINDS, 'reminder'),
    message: r.message ?? '',
    schedule,
    enabled: bool(r.enabled),
    status: pickEnum(r.status, AUTOMATION_STATUS_VALUES, 'scheduled'),
    nextRun: num(r.next_run),
    lastRun: num(r.last_run),
    lastResult: r.last_result,
    lastError: r.last_error,
    runCount: r.run_count ?? 0,
    targetFolderId: r.target_folder_id ?? null,
    targetNoteId: r.target_note_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }]
}

interface RunRow {
  id: string
  automation_id: string
  automation_name: string
  started_at: number
  finished_at: number | null
  status: string
  result: string | null
  error: string | null
  note_id: string | null
}

function toRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    automationId: r.automation_id,
    automationName: r.automation_name,
    startedAt: r.started_at,
    finishedAt: num(r.finished_at),
    status: pickEnum(r.status, RUN_STATUSES, 'running'),
    result: r.result,
    error: r.error,
    noteId: r.note_id ?? null,
  }
}

interface NotificationRow {
  id: string
  title: string
  body: string | null
  automation_id: string | null
  link: string | null
  read_at: number | null
  created_at: number
  subscription_id: string | null
}

function toNotification(r: NotificationRow): AssistantNotification {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? '',
    automationId: r.automation_id,
    link: r.link ?? null,
    subscriptionId: r.subscription_id,
    readAt: num(r.read_at),
    createdAt: r.created_at,
  }
}

interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  created_at: number
  failures: number
  last_error: string | null
}

function toPushSubscription(r: PushSubscriptionRow): AssistantPushSubscription {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
    failures: num(r.failures) ?? 0,
    lastError: r.last_error ?? null,
  }
}

interface ActionRow {
  id: string
  conversation_id: string
  tool: string
  target_id: string
  target_label: string | null
  args?: string | null
  status: string
  error: string | null
  created_at: number
  expires_at: number
}

/** A JSON column that should hold an object; anything else reads as no arguments. */
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function toAction(r: ActionRow): PendingAction {
  const stored = pickEnum(r.status, ACTION_STATUSES, 'pending')
  // An unanswered request that ran out of time reads as expired, so a card cannot keep offering Approve
  // on a target the reader has long since moved on from.
  const status: PendingActionStatus = stored === 'pending' && r.expires_at <= Date.now() ? 'expired' : stored
  return {
    id: r.id,
    tool: r.tool,
    conversationId: r.conversation_id,
    targetId: r.target_id,
    targetLabel: r.target_label ?? '',
    args: recordValue(parseJson(r.args ?? '{}')),
    status,
    error: r.error,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
}
