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

import { ASSISTANT_MODEL_KINDS, ASSISTANT_MODEL_PURPOSES, clipToolPayload, parseCustomParams, isNoteSourceId, isSourceUrl } from '@shared/assistant'
import type {
  AssistantArtifact,
  AssistantConversation,
  AssistantMemory,
  AssistantMemoryCategory,
  AssistantMemorySource,
  AssistantMemoryStatus,
  AssistantMessage,
  AssistantModel,
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
  Task,
  TaskPriority,
  TaskStatus,
  ToolActivity,
  UsageCounters,
  ReasoningDialect,
} from '@shared/assistant'
import { dialectsForProtocol } from '@shared/reasoning'
import type { McpOAuthSecrets, McpOAuthStatus } from './mcp-oauth'
import { ASSISTANT_MCP_TOOL_MODES, ASSISTANT_MCP_TRANSPORTS, DEFAULT_MCP_TIMEOUT_SECONDS, EPHEMERAL_CONVERSATION_RETENTION_DAYS, MAX_MCP_DESCRIPTION_CHARS, MAX_MCP_TOOL_OVERRIDES, MAX_MCP_HEADER_VALUE_CHARS, MAX_MCP_LABEL_CHARS, MAX_MCP_TOOL_NAME_CHARS, MAX_MCP_TIMEOUT_SECONDS, MIN_MCP_TIMEOUT_SECONDS, MAX_ARTIFACT_CONTENT_CHARS, MAX_ARTIFACT_TITLE_CHARS, MAX_ANSWER_VERSIONS, MAX_CHAT_ATTACHMENTS, clipReasoning, isMcpHeaderName, parseModelModalities, parseProviderEndpoints, reasoningDialectValue, reasoningValue, type AssistantAnswerVersion, type AssistantMcpServer, type AssistantMcpToolMode, type AssistantMcpTransport, type AssistantModelModality, type ChatAttachment } from '@shared/assistant'
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
import { parseScheduleSpec, type ScheduleSpec } from '@shared/assistant-schedule'
import { likePattern } from '@shared/markdown-utils'
import type { Env } from '../env'
import { tagScopePredicate } from '../db/rows'
import { newId } from '../lib/id'
import { parseStoredJson } from '../lib/json'
import { decryptAssistantKey, decryptMcpOAuth, encryptAssistantKey, encryptMcpOAuth } from '../lib/crypto'

/** How long a reader has to approve a destructive proposal. */
export const PENDING_ACTION_TTL_MS = 30 * 60 * 1000

/** How long a chat turn may hold its conversation's lease before it counts as abandoned. */
export const RUN_LEASE_MS = 3 * 60 * 1000

/** How long an automation may be claimed by a tick that never finished before another may take it. */
export const AUTOMATION_CLAIM_MS = 10 * 60 * 1000

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
  = `id, content, category, source, status, superseded_by, valid_from, valid_until, project_id, created_at, updated_at`

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
const PROVIDER_COLUMNS = `id, label, protocol, base_url, endpoints, reasoning_dialect, length(key_ciphertext) > 0 AS has_key, created_at, updated_at`

/** A provider key row, ciphertext included: read only by the rotation, never by a listing. */
const PROVIDER_KEY_COLUMNS = `id, provider_id, label, key_ciphertext, key_hint, enabled, last_used_at, error_count, last_error, created_at, updated_at`

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
  created_at: number
  version_count?: number | null
}

const MESSAGE_COLUMNS
  = `id, conversation_id, role, content, reasoning, tools, attachments, status, error, source, input_tokens, output_tokens, duration_ms, model_label, feedback, sources, created_at`
/** How many answers this turn has already displaced; only the transcript list pays for it. */
const MESSAGE_VERSION_COUNT
  = `(SELECT COUNT(*) FROM chat_answer_versions v WHERE v.user_id = chat_messages.user_id AND v.message_id = chat_messages.id) AS version_count`

/**
 * Two messages written in the same millisecond are common — a turn saves the reader's line and the
 * reply within one tick — and a ULID id says nothing about which came first. The rowid does, so
 * every read of a conversation orders by it rather than by `id`.
 */
const MESSAGE_ORDER = `created_at ASC, seq ASC`

function toMessage(r: MessageRow): AssistantMessage {
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
    ...(r.feedback === 'up' || r.feedback === 'down' ? { feedback: r.feedback } : {}),
    ...(r.sources ? { sources: decodeSources(r.sources) } : {}),
    versionCount: r.version_count ?? undefined,
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
  projectId?: string | null
}

export interface TaskQuery {
  status?: TaskStatus | 'open' | 'all'
  view?: 'today' | 'upcoming' | 'overdue' | 'completed' | 'all'
  projectId?: string
  query?: string
  limit?: number
  /** End of the reader's local day, in UTC milliseconds. */
  dayEnd?: number
}

const TASK_PRIORITY_ORDER = `CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`

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
      `SELECT id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_last_used_at, created_at, updated_at
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
    label: string, protocol: AssistantProtocol, baseUrl: string, apiKey: string,
    endpoints?: Partial<Record<AssistantProtocol, string>>,
    reasoningDialect?: ReasoningDialect | null,
  }): Promise<AssistantProvider> {
    const id = newId()
    const at = Date.now()
    const key = input.apiKey.trim()
    const ciphertext = key ? await encryptAssistantKey(this.env, this.userId, key) : ''
    const dialect = compatibleDialect(input.protocol, input.reasoningDialect)
    await this.write(
      `INSERT INTO chat_providers (id, user_id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?9, ?10, ?6, ?7, ?8)`,
      id, input.label, input.protocol, input.baseUrl, ciphertext, at, at,
      JSON.stringify(input.endpoints ?? {}), dialect,
    )
    return {
      id,
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      endpoints: input.endpoints ?? {},
      reasoningDialect: dialect,
      hasKey: Boolean(ciphertext),
      keyHint: key ? key.slice(-4) : '',
      createdAt: at,
      updatedAt: at,
    }
  }

  async updateProvider(
    id: string,
    patch: {
      label?: string, protocol?: AssistantProtocol, baseUrl?: string, apiKey?: string | null,
      endpoints?: Partial<Record<AssistantProtocol, string>>,
      reasoningDialect?: ReasoningDialect | null,
    },
  ): Promise<AssistantProvider | null> {
    const existing = await this.providerRecord(id)
    if (!existing) return null
    const label = patch.label?.trim().slice(0, 60) || existing.label
    const protocol = patch.protocol ?? pickEnum(existing.protocol, ASSISTANT_PROTOCOLS, 'openai')
    const baseUrl = patch.baseUrl?.trim() || existing.base_url
    const endpoints = patch.endpoints ?? parseProviderEndpoints(existing.endpoints)
    // A pin survives an edit that does not mention it, and is re-checked against a newly chosen protocol:
    // a Claude effort dialect left on a provider switched to the OpenAI wire would build a body nothing
    // there reads.
    const dialect = compatibleDialect(
      protocol,
      patch.reasoningDialect !== undefined ? patch.reasoningDialect : reasoningDialectValue(existing.reasoning_dialect),
    )
    let ciphertext = existing.key_ciphertext ?? ''
    let hint = ''
    if (patch.apiKey === null) ciphertext = ''
    else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      ciphertext = await encryptAssistantKey(this.env, this.userId, patch.apiKey)
      hint = patch.apiKey.trim().slice(-4)
    }
    const at = Date.now()
    await this.write(
      `UPDATE chat_providers SET label = ?2, protocol = ?3, base_url = ?4, key_ciphertext = ?5, updated_at = ?6, endpoints = ?8, reasoning_dialect = ?9
         WHERE user_id = ?1 AND id = ?7`,
      label, protocol, baseUrl, ciphertext, at, id, JSON.stringify(endpoints), dialect,
    )
    return {
      id,
      label,
      protocol,
      baseUrl,
      endpoints,
      reasoningDialect: dialect,
      hasKey: Boolean(ciphertext),
      keyHint: hint,
      createdAt: existing.created_at,
      updatedAt: at,
    }
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
      `SELECT id, label, protocol, base_url, endpoints, reasoning_dialect, key_ciphertext, key_last_used_at, created_at, updated_at
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
    temperature?: number | null
    maxOutputTokens?: number | null
    reasoning?: AssistantReasoning
    contextTokens?: number | null
    vision?: boolean
    protocol?: AssistantProtocol | null
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
    const reasoning = input.reasoning ?? 'auto'
    const contextTokens = input.contextTokens ?? null
    const vision = input.vision ?? true
    await this.write(
      `INSERT INTO chat_models (id, user_id, provider_id, model, label, temperature, max_output_tokens, reasoning, context_tokens, vision, enabled, position, protocol)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12)`,
      id, input.providerId, input.model, label, temperature, maxOutputTokens, reasoning, contextTokens, vision ? 1 : 0, positionRow?.n ?? 1,
      input.protocol ?? null,
    )
    // The columns keep their defaults, so the object handed back says the same thing the row does.
    return {
      id, providerId: input.providerId, model: input.model, label, temperature, maxOutputTokens,
      reasoning, contextTokens, vision, enabled: true,
      purpose: 'chat', kind: 'text', supportsTools: true, maxInputTokens: null, modalities: [], topP: null, customParams: [],
      protocol: input.protocol ?? null,
      fallbackModelId: null,
      inputPrice: null, outputPrice: null, priceCurrency: '',
    }
  }

  async updateModel(
    id: string,
    patch: {
      label?: string, model?: string, temperature?: number | null, maxOutputTokens?: number | null,
      reasoning?: AssistantReasoning, contextTokens?: number | null, vision?: boolean, enabled?: boolean,
      purpose?: AssistantModelPurpose, kind?: AssistantModelKind, supportsTools?: boolean,
      maxInputTokens?: number | null, topP?: number | null, customParams?: AssistantCustomParam[],
      modalities?: readonly AssistantModelModality[]
      protocol?: AssistantProtocol | null
      /** Null is "no spare"; a value names the model to try when this one cannot answer. */
      fallbackModelId?: string | null
      inputPrice?: number | null
      outputPrice?: number | null
      priceCurrency?: string
    },
  ): Promise<AssistantModel | null> {
    const existing = await this.getModel(id)
    if (!existing) return null
    const next: AssistantModel = {
      ...existing,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      // Null is a value here, not an absent patch: it is the switch being turned off.
      ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
      // Null is a value here: it is the reader emptying the field, which hands the model back to the
      // account's own ceiling.
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.contextTokens !== undefined ? { contextTokens: patch.contextTokens } : {}),
      ...(patch.vision !== undefined ? { vision: patch.vision } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.supportsTools !== undefined ? { supportsTools: patch.supportsTools } : {}),
      ...(patch.maxInputTokens !== undefined ? { maxInputTokens: patch.maxInputTokens } : {}),
      ...(patch.modalities !== undefined ? { modalities: parseModelModalities(patch.modalities) } : {}),
      ...(patch.topP !== undefined ? { topP: patch.topP } : {}),
      ...(patch.customParams !== undefined ? { customParams: parseCustomParams(patch.customParams) } : {}),
      ...(patch.protocol !== undefined ? { protocol: patch.protocol } : {}),
      ...(patch.fallbackModelId !== undefined ? { fallbackModelId: patch.fallbackModelId } : {}),
      ...(patch.inputPrice !== undefined ? { inputPrice: patch.inputPrice } : {}),
      ...(patch.outputPrice !== undefined ? { outputPrice: patch.outputPrice } : {}),
      ...(patch.priceCurrency !== undefined ? { priceCurrency: patch.priceCurrency } : {}),
    }
    await this.write(
      `UPDATE chat_models SET label = ?2, model = ?3, temperature = ?4, max_output_tokens = ?5,
         reasoning = ?6, context_tokens = ?7, vision = ?8, enabled = ?9,
         purpose = ?11, kind = ?12, supports_tools = ?13, max_input_tokens = ?14,
         modalities = ?17, top_p = ?15, custom_params = ?16, protocol = ?18,
         input_price = ?19, output_price = ?20, price_currency = ?21, fallback_model_id = ?22
         WHERE user_id = ?1 AND id = ?10`,
      next.label, next.model, next.temperature, next.maxOutputTokens,
      next.reasoning, next.contextTokens, next.vision ? 1 : 0, next.enabled ? 1 : 0, id,
      next.purpose, next.kind, next.supportsTools ? 1 : 0, next.maxInputTokens,
      next.topP, JSON.stringify(next.customParams), JSON.stringify(next.modalities), next.protocol,
      next.inputPrice, next.outputPrice, next.priceCurrency, next.fallbackModelId,
    )
    return next
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
    const q = new Query(this.userId)
    q.inList('id', ids.slice(0, 20))
    const rows = await this.rows<{ id: string, user_id: string, filename: string, mime: string, size: number, storage: string }>(
      `SELECT id, user_id, filename, mime, size, storage FROM attachments WHERE ${q.where}`,
      ...q.binds,
    )
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
    const q = new Query(this.userId)
    q.inList('id', ids.slice(0, MAX_CHAT_ATTACHMENTS))
    const rows = await this.rows<{ id: string, extracted_text: string | null }>(
      `SELECT id, extracted_text FROM chat_attachments WHERE ${q.where}`,
      ...q.binds,
    )
    return new Map(rows.filter((row) => row.extracted_text).map((row) => [row.id, row.extracted_text as string]))
  }

  /** The reader's own attachment rows, in the order they were named. */
  async chatAttachments(ids: readonly string[]): Promise<ChatAttachment[]> {
    if (!ids.length) return []
    const q = new Query(this.userId)
    q.inList('id', ids.slice(0, MAX_CHAT_ATTACHMENTS))
    const rows = await this.rows<ChatAttachmentRow>(
      `SELECT id, kind, filename, mime, size, key, created_at FROM chat_attachments WHERE ${q.where}`,
      ...q.binds,
    )
    const order = new Map(ids.map((id, index) => [id, index]))
    return rows
      .map(toChatAttachment)
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  }

  async deleteChatAttachment(id: string): Promise<ChatAttachment | null> {
    const [row] = await this.chatAttachments([id])
    if (!row) return null
    await this.write(`DELETE FROM chat_attachments WHERE user_id = ?1 AND id = ?2`, id)
    return row
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
    filter: { folderId?: string | null, projectId?: string | null, tagId?: string, starred?: boolean, pinned?: boolean, archived?: boolean, limit?: number } = {},
  ): Promise<AssistantConversation[]> {
    const limit = filter.limit ?? 100
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
      q.raw(`(title LIKE ${pattern} ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id
          AND m.user_id = ?1 AND m.content LIKE ${inBody} ESCAPE '\\'))`)
    }
    const limitBind = q.add(limit)
    // A temporary conversation is never listed. Its reader reaches it by id, which is the only way anyone
    // has it: the list, the starred and pinned shortlists and the assistant's own search all come through
    // here, so this one clause is what keeps the promise the UI makes.
    q.raw('c.ephemeral = 0')
    const list = await this.rows<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS},
              (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE ${q.where}
         ORDER BY c.updated_at DESC LIMIT ${limitBind}`,
      ...q.binds,
    )
    const conversations = list.map(toConversation)
    if (conversations.length) {
      const tags = await this.tagsForConversations(conversations.map((entry) => entry.id))
      for (const conversation of conversations) conversation.tags = tags.get(conversation.id) ?? []
    }
    return conversations
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
      const q = new Query(this.userId)
      q.inList('parent_id', frontier)
      const rows = await this.rows<{ id: string }>(
        `SELECT id FROM folders WHERE ${q.where} AND deleted_at IS NULL`,
        ...q.binds,
      )
      frontier = []
      for (const row of rows ?? []) {
        if (found.has(row.id)) continue
        found.add(row.id)
        frontier.push(row.id)
      }
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
    if (!ids.length) return out
    // Written out rather than through Query: a join makes the builder's unqualified `user_id = ?1`
    // ambiguous, and the failure is a 500 on every conversation list.
    const marks = ids.map((_, index) => `?${index + 2}`).join(', ')
    const rows = await this.rows<{ conversation_id: string, tag_id: string, name: string, color: string | null }>(
      `SELECT ct.conversation_id, t.id AS tag_id, t.name, t.color
         FROM chat_conversation_tags ct JOIN tags t ON t.user_id = ct.user_id AND t.id = ct.tag_id
        WHERE ct.user_id = ?1 AND ct.conversation_id IN (${marks}) ORDER BY t.name`,
      this.userId, ...ids,
    )
    for (const row of rows) {
      const list = out.get(row.conversation_id) ?? []
      list.push({ id: row.tag_id, name: row.name, color: row.color ?? null })
      out.set(row.conversation_id, list)
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
              (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE c.user_id = ?1 AND c.id = ?2`,
      this.userId, id,
    )
    return r ? toConversation(r) : null
  }

  async createConversation(title: string, folderId: string | null = null, ephemeral = false): Promise<AssistantConversation> {
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_conversations (id, user_id, title, folder_id, ephemeral, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
      id, title, folderId, ephemeral ? 1 : 0, at, at,
    )
    return { id, title, pinned: false, starred: false, archived: false, ephemeral, folderId, createdAt: at, updatedAt: at, messageCount: 0, tags: [], summary: null, summaryUpto: null }
  }

  /**
   * A new conversation holding this one up to and including one message.
   *
   * The point of branching is to try a different answer without losing the thread that led there, so the
   * rows are copied rather than referenced: the two conversations then diverge freely, and deleting
   * either leaves the other whole. The copied turns keep their words, their thinking, their tools and
   * their verdicts; only the ids and the timestamps are new, because the rowid is what orders a thread.
   *
   * The summary is deliberately not copied. It describes a conversation that ended somewhere else, and
   * carrying it would have the fork summarised by a rollup of turns it does not have.
   */
  async forkConversation(from: string, uptoMessageId: string, title: string): Promise<AssistantConversation | null> {
    const source = await this.getConversation(from)
    if (!source) return null
    const rows = await this.messages(from)
    const cut = rows.findIndex((row) => row.id === uptoMessageId)
    if (cut < 0) return null
    const fork = await this.createConversation(title, source.folderId)
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

  async deleteConversation(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_answer_versions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_pending_actions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_active_runs WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_conversation_tags WHERE user_id = ?1 AND conversation_id = ?2`, id)
    // A draft belongs to its thread: a conversation the reader deleted must not leave one behind to be
    // found by nothing.
    await this.write(`DELETE FROM chat_artifacts WHERE user_id = ?1 AND conversation_id = ?2`, id)
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
    await this.write(`DELETE FROM chat_artifacts WHERE user_id = ?1`)
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
   * Make a draft.
   *
   * `note_id` is written as null and is the seam a later build fills to sync a draft back into the
   * notebook; there is deliberately no way to set it yet, so the column is a reservation rather than a
   * second, half-wired link. Adding one later is an additive change to this signature.
   */
  async createArtifact(input: { conversationId: string, title: string, content: string }): Promise<AssistantArtifact> {
    const id = newId()
    const at = Date.now()
    const title = input.title.slice(0, MAX_ARTIFACT_TITLE_CHARS)
    const content = input.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS)
    await this.write(
      `INSERT INTO chat_artifacts (id, user_id, conversation_id, title, content, note_id, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id, input.conversationId, title, content, null, at, at,
    )
    return {
      id,
      conversationId: input.conversationId,
      title,
      content,
      noteId: null,
      createdAt: at,
      updatedAt: at,
    }
  }

  /**
   * Rewrite a draft's name or its body.
   *
   * A field that is not named keeps what it had, so a title typed after a body edit does not blank the
   * body. `note_id` is carried across rather than written, for the same reason: an edit here is not a
   * statement about the link, and the surface that sets one does not exist yet.
   */
  async updateArtifact(
    id: string,
    patch: { title?: string, content?: string },
  ): Promise<AssistantArtifact | null> {
    const existing = await this.getArtifact(id)
    if (!existing) return null
    const title = patch.title === undefined ? existing.title : patch.title.slice(0, MAX_ARTIFACT_TITLE_CHARS)
    const content = patch.content === undefined ? existing.content : patch.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS)
    const at = Date.now()
    await this.write(
      `UPDATE chat_artifacts SET title = ?2, content = ?3, note_id = ?4, updated_at = ?5
        WHERE user_id = ?1 AND id = ?6`,
      title, content, existing.noteId, at, id,
    )
    return { ...existing, title, content, updatedAt: at }
  }

  async deleteArtifact(id: string): Promise<boolean> {
    return (await this.write(`DELETE FROM chat_artifacts WHERE user_id = ?1 AND id = ?2`, id)) > 0
  }

  async messages(conversationId: string, limit = 500): Promise<AssistantMessage[]> {
    const list = await this.rows<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}, version_count FROM (
         SELECT rowid AS seq, ${MESSAGE_COLUMNS}, ${MESSAGE_VERSION_COUNT} FROM chat_messages
          WHERE user_id = ?1 AND conversation_id = ?2
          ORDER BY created_at DESC, seq DESC LIMIT ?3
       ) ORDER BY ${MESSAGE_ORDER}`,
      this.userId, conversationId, limit,
    )
    return list.map(toMessage)
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
    await this.write(
      `INSERT INTO chat_messages
         (id, user_id, conversation_id, role, content, reasoning, tools, attachments, status, error, source, input_tokens, output_tokens, duration_ms, model_label, feedback, sources, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, '', ?17, ?16)`,
      id, input.conversationId, input.role, input.content, reasoning, JSON.stringify(tools), JSON.stringify(attachments),
      status, error, source, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, durationMs, input.modelLabel ?? '', at,
      JSON.stringify(input.sources ?? []),
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
    const wanted = new Set(ids.filter((id) => /^[0-9a-hjkmnp-tv-z]{6,64}$/.test(id)))
    if (!wanted.size) return []
    const rows = await this.messages(conversationId)
    const removed = rows.filter((row) => wanted.has(row.id)).map((row) => row.id)
    for (const id of removed) await this.deleteMessage(id)
    if (removed.length) await this.clearSummary(conversationId)
    return removed
  }

  /**
   * Records the reader's verdict on one answer, or clears it.
   *
   * One row is touched and nothing else: the verdict is about this answer, and rewriting the turn would
   * change its place in the transcript and its version count. A message that is not this account's is
   * not found rather than updated, which is what the caller's 404 is built on.
   */
  async setMessageFeedback(id: string, feedback: MessageFeedback | null): Promise<boolean> {
    const result = await this.write(
      `UPDATE chat_messages SET feedback = ?3 WHERE user_id = ?1 AND id = ?2`,
      id, feedback ?? '',
    )
    return result > 0
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

  async listMemories(opts: { query?: string, category?: string, status?: string, limit?: number, scope?: MemoryScope } = {}): Promise<AssistantMemory[]> {
    const q = new Query(this.userId).raw(this.statusClause(opts.status ?? 'all'))
    applyMemoryScope(q, opts.scope)
    if (opts.category) q.eq(`category`, opts.category)
    if (opts.query) q.raw(`content LIKE ${q.add(containsPattern(opts.query))} ESCAPE '\\'`)
    const limit = q.add(opts.limit ?? 500)
    const list = await this.rows<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories WHERE ${q.where} ORDER BY updated_at DESC LIMIT ${limit}`,
      ...q.binds,
    )
    return list.map(toMemory)
  }

  async countMemories(status?: string): Promise<number> {
    const q = new Query(this.userId).raw(this.statusClause(status ?? 'all'))
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

  async listTasks(query: TaskQuery = {}): Promise<Task[]> {
    const q = new Query(this.userId)
    const status = query.status ?? 'all'
    if (status === 'open') q.raw(`status != 'done'`)
    else if (status !== 'all') q.eq(`status`, status)
    const now = Date.now()
    switch (query.view) {
      case 'today':
        q.raw(`status != 'done' AND ((due_at IS NOT NULL AND due_at < ${q.add(query.dayEnd ?? now)})
          OR (due_at IS NULL AND status = 'in_progress'))`)
        break
      case 'upcoming':
        q.raw(`status != 'done' AND (due_at IS NULL OR due_at >= ${q.add(query.dayEnd ?? now)})`)
        break
      case 'overdue':
        q.raw(`status != 'done' AND due_at IS NOT NULL AND due_at < ${q.add(now)}`)
        break
      case 'completed':
        q.raw(`status = 'done'`)
        break
      default:
        break
    }
    if (query.projectId) q.eq(`project_id`, query.projectId)
    if (query.query) {
      const pattern = q.add(containsPattern(query.query))
      q.or([`title LIKE ${pattern} ESCAPE '\\'`, `description LIKE ${pattern} ESCAPE '\\'`])
    }
    const limit = q.add(query.limit ?? 200)
    const order = query.view === 'completed'
      ? `completed_at DESC`
      : `CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, ${TASK_PRIORITY_ORDER}, created_at ASC`
    const list = await this.rows<TaskRow>(
      `SELECT * FROM chat_tasks WHERE ${q.where} ORDER BY ${order} LIMIT ${limit}`,
      ...q.binds,
    )
    return list.map(toTask)
  }

  async getTask(id: string): Promise<Task | null> {
    const r = await this.one<TaskRow>(`SELECT * FROM chat_tasks WHERE user_id = ?1 AND id = ?2`, this.userId, id)
    return r ? toTask(r) : null
  }

  async createTask(input: NewTask): Promise<Task> {
    const id = newId()
    const at = Date.now()
    const status = input.status ?? 'todo'
    const task: Task = {
      id,
      title: input.title.trim(),
      description: input.description ?? '',
      status,
      priority: input.priority ?? 'medium',
      dueAt: input.dueAt ?? null,
      projectId: input.projectId ?? null,
      createdAt: at,
      updatedAt: at,
      completedAt: status === 'done' ? at : null,
    }
    await this.write(
      `INSERT INTO chat_tasks
         (id, user_id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      id, task.title, task.description, task.status, task.priority, task.dueAt, task.projectId, at, at, task.completedAt,
    )
    return task
  }

  async updateTask(id: string, patch: Partial<NewTask>): Promise<Task | null> {
    const existing = await this.getTask(id)
    if (!existing) return null
    const at = Date.now()
    const next: Task = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      updatedAt: at,
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      next.completedAt = patch.status === 'done' ? at : null
    }
    await this.write(
      `UPDATE chat_tasks SET title = ?2, description = ?3, status = ?4, priority = ?5, due_at = ?6,
              project_id = ?7, updated_at = ?8, completed_at = ?9 WHERE user_id = ?1 AND id = ?10`,
      next.title, next.description, next.status, next.priority, next.dueAt, next.projectId, at, next.completedAt, id,
    )
    return next
  }

  async deleteTask(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_tasks WHERE user_id = ?1 AND id = ?2`, id)
  }

  /** By id, or by a title match that is unambiguous: the assistant must not guess which task was meant. */
  async resolveTask(ref: string): Promise<Task | null> {
    const direct = await this.getTask(ref)
    if (direct) return direct
    const list = await this.rows<TaskRow>(
      `SELECT * FROM chat_tasks WHERE user_id = ?1 AND title LIKE ?2 ESCAPE '\\'
        ORDER BY status = 'done', updated_at DESC LIMIT 2`,
      this.userId, containsPattern(ref),
    )
    return list.length === 1 ? toTask(list[0]!) : null
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
    name: string, description?: string, instructions?: string, noteScope?: string[], modelId?: string | null,
  }): Promise<Project> {
    const id = newId()
    const at = Date.now()
    const name = input.name.trim()
    const description = input.description ?? ''
    const instructions = input.instructions ?? ''
    const noteScope = input.noteScope ?? []
    const modelId = input.modelId ?? null
    await this.write(
      `INSERT INTO chat_projects
         (id, user_id, name, description, instructions, note_scope, model_id, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      id, name, description, instructions, JSON.stringify(noteScope), modelId, at, at,
    )
    return { id, name, description, instructions, noteScope, modelId, createdAt: at, updatedAt: at }
  }

  async updateProject(id: string, patch: {
    name?: string, description?: string, instructions?: string,
    noteScope?: string[], modelId?: string | null,
  }): Promise<Project | null> {
    const existing = await this.getProject(id)
    if (!existing) return null
    const next: Project = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.noteScope !== undefined ? { noteScope: patch.noteScope } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
      updatedAt: Date.now(),
    }
    await this.write(
      `UPDATE chat_projects SET name = ?2, description = ?3, instructions = ?4, note_scope = ?5,
         model_id = ?6, updated_at = ?7 WHERE user_id = ?1 AND id = ?8`,
      next.name, next.description, next.instructions, JSON.stringify(next.noteScope),
      next.modelId, next.updatedAt, id,
    )
    return next
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
      // missing, so a delete would be a second copy of that rule.
      const marks = filed.map((_, index) => `?${index + 2}`).join(', ')
      await this.write(`DELETE FROM chat_memory_embeddings WHERE user_id = ?1 AND memory_id IN (${marks})`, ...filed.map((memory) => memory.id))
    }
    await this.write(`DELETE FROM chat_memories WHERE user_id = ?1 AND project_id = ?2`, id)
    // The activity feed quoted each fact when it was learned; the fact is gone, so the quote goes too —
    // the same promise `deleteMemory` keeps, for the same reason.
    for (const memory of filed) await this.deleteActivityQuoting('memory.created', memory.content)
    await this.write(`UPDATE chat_tasks SET project_id = NULL WHERE user_id = ?1 AND project_id = ?2`, id)
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
  }): Promise<Automation> {
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_automations
         (id, user_id, name, kind, message, schedule, enabled, status, next_run, run_count, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)`,
      id, input.name, input.kind, input.message, JSON.stringify(input.schedule),
      input.enabled ? 1 : 0, input.status, input.nextRun, at, at,
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

  async finishRun(runId: string, status: AutomationRun['status'], result: string | null, error: string | null): Promise<void> {
    await this.write(
      `UPDATE chat_runs SET status = ?2, result = ?3, error = ?4, finished_at = ?5 WHERE user_id = ?1 AND id = ?6`,
      status, result?.slice(0, 4000) ?? null, error?.slice(0, 1000) ?? null, Date.now(), runId,
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

  async createNotification(input: { title: string, body: string, automationId?: string | null }): Promise<AssistantNotification> {
    const id = newId()
    const at = Date.now()
    const title = input.title.slice(0, 200)
    const body = input.body.slice(0, 8000)
    await this.write(
      `INSERT INTO chat_notifications (id, user_id, title, body, automation_id, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      id, title, body, input.automationId ?? null, at,
    )
    return { id, title, body, automationId: input.automationId ?? null, readAt: null, createdAt: at }
  }

  async unreadCount(): Promise<number> {
    const r = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_notifications WHERE user_id = ?1 AND read_at IS NULL`,
      this.userId,
    )
    return r?.n ?? 0
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
   * Adds to today's counters.
   *
   * The record the caller holds is camelCase, the column it lands in is not, so the name is looked up
   * rather than written into the SQL: an unmapped key is dropped instead of becoming a column reference
   * that fails the statement — and a failing statement here would mark a finished answer as an error.
   */
  async incrementUsage(
    counters: Partial<UsageCounters>,
    day = usageDay(),
    modelLabel = '',
    keyRef?: { providerId: string, providerLabel: string, keyId?: string, keyLabel?: string },
  ): Promise<void> {
    await this.write(`INSERT INTO chat_usage_daily (user_id, day) VALUES (?1, ?2) ON CONFLICT(user_id, day) DO NOTHING`, day)
    // The model row is opened before the counters are applied so the two are written the same way, and
    // only when a label was given: a scheduled embedding or a failed call belongs to the day's totals
    // without belonging to any model's.
    if (modelLabel) {
      await this.write(
        `INSERT INTO chat_usage_daily_model (user_id, day, model_label) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, day, model_label) DO NOTHING`,
        day, modelLabel.slice(0, 120),
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
        day, modelLabel.slice(0, 120), keyRef.providerId.slice(0, 60), keyRef.providerLabel.slice(0, 120),
        (keyRef.keyId ?? '').slice(0, 60), (keyRef.keyLabel ?? '').slice(0, 120),
      )
    }
    const targets: Array<{ table: string, guard: string, extra: unknown[] }> = [
      { table: 'chat_usage_daily', guard: 'user_id = ?1 AND day = ?2', extra: [] },
    ]
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
      const binds: unknown[] = [this.userId, day, ...extra]
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
  async modelUsageRange(from: string, to: string): Promise<Array<{ modelLabel: string } & UsageCounters>> {
    const { results } = await this.db.prepare(
      `SELECT model_label, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_model
        WHERE user_id = ?1 AND day >= ?2 AND day <= ?3
        GROUP BY model_label
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, model_label ASC`,
    ).bind(this.userId, from, to).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
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

  /**
   * The day totals for one slice of the key dimension.
   *
   * Read from `chat_usage_daily_key` rather than the plain day table because only that table knows which
   * model or key a token came from. Rows written before the dimension existed are absent, so a filtered
   * view starts from the day it was added — the unfiltered view stays the whole history.
   */
  async usageRangeIn(from: string, to: string, filter: UsageFilter): Promise<UsageCounters> {
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const r = await this.one<Record<string, number | null>>(
      `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls,
              COALESCE(SUM(errors),0) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}`,
      ...binds,
    )
    if (!r) return { ...EMPTY_USAGE }
    return {
      requests: r.requests ?? 0,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      toolCalls: r.tool_calls ?? 0,
      scheduledRuns: 0,
      embeddings: 0,
      errors: r.errors ?? 0,
    }
  }

  /** The day rows for one slice of the key dimension, for the trend and the heat map. */
  async usageDaysIn(from: string, to: string, filter: UsageFilter): Promise<Array<{ day: string } & UsageCounters>> {
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const { results } = await this.db.prepare(
      `SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
        GROUP BY day ORDER BY day ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
      day: String(row.day ?? ''),
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      scheduledRuns: 0,
      embeddings: 0,
      errors: Number(row.errors ?? 0),
    }))
  }

  /** The per-model rows for one slice of the key dimension, most used first. */
  async modelUsageRangeIn(from: string, to: string, filter: UsageFilter): Promise<Array<{ modelLabel: string } & UsageCounters>> {
    const binds: unknown[] = [this.userId, from, to]
    const where = this.dimensionWhere(filter, binds)
    const { results } = await this.db.prepare(
      `SELECT model_label, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(tool_calls) AS tool_calls, SUM(errors) AS errors
         FROM chat_usage_daily_key WHERE user_id = ?1 AND day >= ?2 AND day <= ?3${where}
        GROUP BY model_label
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC, model_label ASC`,
    ).bind(...binds).all<Record<string, number | string>>()
    return (results ?? []).map((row) => ({
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

  /**
   * The window broken down by day *and* by what paid for it.
   *
   * The charts need the same rows read two ways — a bar per day grouped by model, or the same bars grouped
   * by key — and the per-model cards need them a third time, per model across days. One query answers all
   * three: three queries would be three chances to disagree about the window, and the client is the only
   * place that knows which grouping the reader asked for.
   */
  async usageSeries(from: string, to: string, filter: UsageFilter): Promise<Array<{
    day: string
    modelLabel: string
    providerId: string
    providerLabel: string
    keyId: string
    keyLabel: string
  } & UsageCounters>> {
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
    return (results ?? []).map((row) => ({
      day: String(row.day ?? ''),
      modelLabel: String(row.model_label ?? ''),
      providerId: String(row.provider_id ?? ''),
      providerLabel: String(row.provider_label ?? ''),
      keyId: String(row.key_id ?? ''),
      keyLabel: String(row.key_label ?? ''),
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
      ...usageStreaks(activity.map((entry) => entry.day), usageDay()),
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
    ).bind(this.userId, startOfDayMillis(from), startOfDayMillis(to) + 86_400_000, Math.max(1, Math.min(50, limit)))
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
    const day = usageDay()
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
   * Claims a conversation for one turn.
   *
   * A second message while a reply is streaming would start a second run whose output interleaves into
   * the same assistant message, so the claim is taken before anything is awaited. The lease expires on
   * purpose: a stream abandoned by a closed laptop must not lock a conversation for the day.
   */
  async claimRun(conversationId: string, now = Date.now()): Promise<boolean> {
    const existing = await this.one<{ lease_until: number }>(
      `SELECT lease_until FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2`,
      conversationId, this.userId,
    )
    if (existing && existing.lease_until > now) return false
    await this.db.prepare(
      `INSERT INTO chat_active_runs (conversation_id, user_id, started_at, lease_until)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, conversation_id) DO UPDATE SET started_at = excluded.started_at, lease_until = excluded.lease_until`,
    ).bind(conversationId, this.userId, now, now + RUN_LEASE_MS).run()
    return true
  }

  async renewRun(conversationId: string, now = Date.now()): Promise<void> {
    await this.db.prepare(`UPDATE chat_active_runs SET lease_until = ?2 WHERE conversation_id = ?1 AND user_id = ?3`)
      .bind(conversationId, now + RUN_LEASE_MS, this.userId).run()
  }

  async releaseRun(conversationId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2`)
      .bind(conversationId, this.userId).run()
  }

  async isRunning(conversationId: string, now = Date.now()): Promise<boolean> {
    const r = await this.one<{ lease_until: number }>(
      `SELECT lease_until FROM chat_active_runs WHERE conversation_id = ?1 AND user_id = ?2`,
      conversationId, this.userId,
    )
    if (!r) return false
    if (r.lease_until > now) return true
    await this.releaseRun(conversationId)
    return false
  }

  // ------------------------------------------------------------------ import

  async importRow(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = EXPORT_COLUMNS[table]
    if (!columns) throw new Error(`unknown assistant export table ${table}`)
    const names = ['user_id', ...columns]
    const placeholders = names.map((_, index) => `?${index + 1}`).join(', ')
    const values = [this.userId, ...columns.map((column) => normaliseBind(row[column]))]
    await this.db.prepare(`INSERT OR IGNORE INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
      .bind(...values).run()
  }

  async importUpdate(table: string, id: string, row: Record<string, unknown>): Promise<void> {
    const columns = EXPORT_COLUMNS[table]
    if (!columns) throw new Error(`unknown assistant export table ${table}`)
    const sets: string[] = []
    const binds: unknown[] = [this.userId]
    for (const column of columns) {
      if (column === 'id' || column === 'user_id') continue
      if (!(column in row)) continue
      binds.push(normaliseBind(row[column]))
      sets.push(`${column} = ?${binds.length}`)
    }
    if (!sets.length) return
    binds.push(id)
    await this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE user_id = ?1 AND id = ?${binds.length}`)
      .bind(...binds).run()
  }

  async hasRow(table: string, id: string): Promise<boolean> {
    if (!EXPORT_COLUMNS[table]) throw new Error(`unknown assistant export table ${table}`)
    const r = await this.db.prepare(`SELECT 1 AS x FROM ${table} WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id).first<{ x: number }>()
    return Boolean(r)
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
    return {
      conversations: await select('chat_conversations', 'AND ephemeral = 0'),
      artifacts: await select('chat_artifacts', `AND ${onlyKept}`),
      conversation_tags: await select('chat_conversation_tags', `AND ${onlyKept}`),
      messages: await select('chat_messages', `AND ${onlyKept}`),
      answer_versions: await select('chat_answer_versions', `AND ${onlyKept}`),
      memories: await select('chat_memories'),
      tasks: await select('chat_tasks'),
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
 */
const EXPORT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  chat_conversations: ['id', 'title', 'summary', 'summary_upto', 'pinned', 'starred', 'archived', 'folder_id', 'created_at', 'updated_at'],
  chat_artifacts: ['id', 'conversation_id', 'title', 'content', 'note_id', 'created_at', 'updated_at'],
  chat_conversation_tags: ['conversation_id', 'tag_id', 'created_at'],
  chat_messages: ['id', 'conversation_id', 'role', 'content', 'reasoning', 'tools', 'attachments', 'status', 'error', 'source', 'input_tokens', 'output_tokens', 'duration_ms', 'model_label', 'created_at'],
  chat_answer_versions: ['id', 'message_id', 'conversation_id', 'content', 'reasoning', 'tools', 'model_label', 'input_tokens', 'output_tokens', 'duration_ms', 'created_at'],
  chat_memories: ['id', 'content', 'category', 'source', 'status', 'superseded_by', 'valid_from', 'valid_until', 'project_id', 'created_at', 'updated_at'],
  chat_tasks: ['id', 'title', 'description', 'status', 'priority', 'due_at', 'project_id', 'created_at', 'updated_at', 'completed_at'],
  chat_projects: ['id', 'name', 'description', 'created_at', 'updated_at'],
  chat_automations: ['id', 'name', 'kind', 'message', 'schedule', 'enabled', 'status', 'next_run', 'last_run', 'last_result', 'last_error', 'run_count', 'created_at', 'updated_at'],
  chat_notifications: ['id', 'title', 'body', 'automation_id', 'read_at', 'created_at'],
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

export function usageDay(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/** Midnight UTC of a `YYYY-MM-DD` day, which is the frame the daily counters are written in. */
export function startOfDayMillis(day: string): number {
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
  protocol: AssistantProtocol
  base_url: string
  endpoints?: string | null
  reasoning_dialect?: string | null
  key_ciphertext?: string | null
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
    protocol: pickEnum(r.protocol, ASSISTANT_PROTOCOLS, 'openai'),
    baseUrl: r.base_url,
    endpoints: parseProviderEndpoints(r.endpoints),
    reasoningDialect: reasoningDialectValue(r.reasoning_dialect),
    hasKey: bool(r.has_key ?? Boolean(r.key_ciphertext)),
    // The ciphertext is never decrypted to build a view, so no listing can carry a key out.
    keyHint: '',
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

/**
 * The columns a model row is read with. One list, because two hand-copied ones are how a new column
 * ends up written but never read back: the editor saved `purpose` and the reader saw the old value.
 */
export const MODEL_SELECT_COLUMNS = `id, provider_id, model, label, temperature, max_output_tokens,
  reasoning, context_tokens, vision, purpose, kind, supports_tools, max_input_tokens, modalities, top_p,
  custom_params, protocol, fallback_model_id, input_price, output_price, price_currency, enabled, position`

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
    scopes: decodeTurnScopes(r.scopes),
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
function decodeTurnScopes(value: unknown): AssistantTurnScope[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((entry): entry is AssistantTurnScope =>
      Boolean(entry) && typeof entry === 'object'
        && typeof (entry as { id?: unknown }).id === 'string'
        && ((entry as { kind?: unknown }).kind === 'tag' || (entry as { kind?: unknown }).kind === 'folder'))
    .map((entry) => ({ kind: entry.kind, id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' }))
}

interface ModelRow {
  id: string
  provider_id: string
  model: string
  label: string
  temperature: number | null
  max_output_tokens: number | null
  reasoning: string | null
  context_tokens: number | null
  vision: number | null
  purpose: string | null
  kind: string | null
  supports_tools: number | null
  max_input_tokens: number | null
  modalities: string | null
  top_p: number | null
  custom_params: string | null
  protocol: string | null
  fallback_model_id: string | null
  input_price: number | null
  output_price: number | null
  price_currency: string | null
  enabled: number
  position: number
}

function toModel(r: ModelRow): AssistantModel {
  return {
    id: r.id,
    providerId: r.provider_id,
    model: r.model,
    label: r.label || r.model,
    // Null is the reader's own choice — "leave the vendor default alone" — so it must not be turned
    // back into a number on the way out.
    temperature: num(r.temperature),
    // Null is "the reader has not set one", which the runner answers for; turning it into the account's
    // number here made every model look hand-set and froze the fallback at whatever it was that day.
    maxOutputTokens: num(r.max_output_tokens),
    reasoning: reasoningValue(r.reasoning),
    contextTokens: num(r.context_tokens),
    vision: r.vision === null ? true : bool(r.vision),
    purpose: pickEnum(r.purpose, ASSISTANT_MODEL_PURPOSES, 'chat'),
    kind: pickEnum(r.kind, ASSISTANT_MODEL_KINDS, 'text'),
    supportsTools: r.supports_tools === null ? true : bool(r.supports_tools),
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

const ARTIFACT_COLUMNS = `id, conversation_id, title, content, note_id, created_at, updated_at`

/**
 * The conversation row, as every reader of it spells it.
 *
 * One list because there were two: the thread and the list each spelled the columns out, so a column
 * added to one and not the other read back as a default in exactly one of the two surfaces — which is how
 * a flag comes to be set and still look unset.
 */
const CONVERSATION_COLUMNS = `c.id, c.title, c.summary, c.summary_upto, c.pinned, c.starred, c.archived, c.ephemeral, c.folder_id, c.project_id, c.created_at, c.updated_at`

interface ArtifactRow {
  id: string
  conversation_id: string
  title: string
  content: string
  note_id: string | null
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  folder_id: string | null
  project_id: string | null
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
    folderId: r.folder_id ?? null,
    ...(r.project_id ? { projectId: r.project_id } : {}),
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
  due_at: number | null
  project_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? '',
    status: pickEnum(r.status, TASK_STATUS_VALUES, 'todo'),
    priority: pickEnum(r.priority, TASK_PRIORITY_VALUES, 'medium'),
    dueAt: num(r.due_at),
    projectId: r.project_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: num(r.completed_at),
  }
}

interface ProjectRow {
  id: string
  name: string
  description: string | null
  instructions: string | null
  note_scope: string | null
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
  }
}

interface NotificationRow {
  id: string
  title: string
  body: string | null
  automation_id: string | null
  read_at: number | null
  created_at: number
}

function toNotification(r: NotificationRow): AssistantNotification {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? '',
    automationId: r.automation_id,
    readAt: num(r.read_at),
    createdAt: r.created_at,
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
