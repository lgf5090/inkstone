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

import type {
  AssistantConversation,
  AssistantMemory,
  AssistantMemoryCategory,
  AssistantMemorySource,
  AssistantMemoryStatus,
  AssistantMessage,
  AssistantModel,
  AssistantNotification,
  AssistantProvider,
  AssistantSettings,
  Automation,
  AutomationKind,
  AutomationRun,
  AutomationStatus,
  ChatFolderNode,
  ConversationTag,
  PendingAction,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  ToolActivity,
  UsageCounters,
} from '@shared/assistant'
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
import type { Env } from '../env'
import { newId } from '../lib/id'
import { decryptAssistantKey, encryptAssistantKey } from '../lib/crypto'

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
  = `id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at`

/**
 * The provider columns a listing may read.
 *
 * `length(key_ciphertext) > 0` answers "is a key stored" without the ciphertext ever leaving the row,
 * so no provider listing can carry a key out even if a route is added carelessly later.
 */
const PROVIDER_COLUMNS = `id, label, protocol, base_url, length(key_ciphertext) > 0 AS has_key, created_at, updated_at`

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
 */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
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
  status: string
  error: string | null
  source: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_at: number
}

const MESSAGE_COLUMNS
  = `id, conversation_id, role, content, tools, status, error, source, input_tokens, output_tokens, created_at`

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
    tools: decodeTools(r.tools),
    status: pickEnum(r.status, MESSAGE_STATUSES, 'complete'),
    error: r.error,
    source: r.source === 'import' ? 'import' : 'chat',
    createdAt: r.created_at,
    usage: { inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 },
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
      `SELECT id, label, protocol, base_url, key_ciphertext, created_at, updated_at
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

  async createProvider(input: { label: string, protocol: AssistantProtocol, baseUrl: string, apiKey: string }): Promise<AssistantProvider> {
    const id = newId()
    const at = Date.now()
    const key = input.apiKey.trim()
    const ciphertext = key ? await encryptAssistantKey(this.env, this.userId, key) : ''
    await this.write(
      `INSERT INTO chat_providers (id, user_id, label, protocol, base_url, key_ciphertext, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id, input.label, input.protocol, input.baseUrl, ciphertext, at, at,
    )
    return {
      id,
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      hasKey: Boolean(ciphertext),
      keyHint: key ? key.slice(-4) : '',
      createdAt: at,
      updatedAt: at,
    }
  }

  async updateProvider(
    id: string,
    patch: { label?: string, protocol?: AssistantProtocol, baseUrl?: string, apiKey?: string | null },
  ): Promise<AssistantProvider | null> {
    const existing = await this.providerRecord(id)
    if (!existing) return null
    const label = patch.label?.trim().slice(0, 60) || existing.label
    const protocol = patch.protocol ?? pickEnum(existing.protocol, ASSISTANT_PROTOCOLS, 'openai')
    const baseUrl = patch.baseUrl?.trim() || existing.base_url
    let ciphertext = existing.key_ciphertext ?? ''
    let hint = ''
    if (patch.apiKey === null) ciphertext = ''
    else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      ciphertext = await encryptAssistantKey(this.env, this.userId, patch.apiKey)
      hint = patch.apiKey.trim().slice(-4)
    }
    const at = Date.now()
    await this.write(
      `UPDATE chat_providers SET label = ?2, protocol = ?3, base_url = ?4, key_ciphertext = ?5, updated_at = ?6
         WHERE user_id = ?1 AND id = ?7`,
      label, protocol, baseUrl, ciphertext, at, id,
    )
    return {
      id,
      label,
      protocol,
      baseUrl,
      hasKey: Boolean(ciphertext),
      keyHint: hint,
      createdAt: existing.created_at,
      updatedAt: at,
    }
  }

  async deleteProvider(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_models WHERE user_id = ?1 AND provider_id = ?2`, id)
    await this.write(`DELETE FROM chat_providers WHERE user_id = ?1 AND id = ?2`, id)
  }

  /** The plaintext key for one upstream call. No route returns this value. */
  async providerKey(record: ProviderRow): Promise<string> {
    const ciphertext = record.key_ciphertext ?? ''
    if (!ciphertext) return ''
    return (await decryptAssistantKey(this.env, this.userId, ciphertext)) ?? ''
  }

  // ------------------------------------------------------------------ models

  async listModels(): Promise<AssistantModel[]> {
    const list = await this.rows<ModelRow>(
      `SELECT id, provider_id, model, label, temperature, max_output_tokens, enabled, position
         FROM chat_models WHERE user_id = ?1 ORDER BY position, label`,
      this.userId,
    )
    return list.map(toModel)
  }

  async getModel(id: string): Promise<AssistantModel | null> {
    const r = await this.one<ModelRow>(
      `SELECT id, provider_id, model, label, temperature, max_output_tokens, enabled, position
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
  }): Promise<AssistantModel> {
    const id = newId()
    const positionRow = await this.one<{ n: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM chat_models WHERE user_id = ?1`,
      this.userId,
    )
    const temperature = input.temperature ?? DEFAULT_ASSISTANT_SETTINGS.temperature
    const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_ASSISTANT_SETTINGS.limits.maxOutputTokens
    const label = input.label ?? input.model
    await this.write(
      `INSERT INTO chat_models (id, user_id, provider_id, model, label, temperature, max_output_tokens, enabled, position)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, 1, ?8)`,
      id, input.providerId, input.model, label, temperature, maxOutputTokens, positionRow?.n ?? 1,
    )
    return { id, providerId: input.providerId, model: input.model, label, temperature, maxOutputTokens, enabled: true }
  }

  async updateModel(
    id: string,
    patch: { label?: string, model?: string, temperature?: number | null, maxOutputTokens?: number | null, enabled?: boolean },
  ): Promise<AssistantModel | null> {
    const existing = await this.getModel(id)
    if (!existing) return null
    const next: AssistantModel = {
      ...existing,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.temperature !== undefined ? { temperature: patch.temperature ?? existing.temperature } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens ?? existing.maxOutputTokens } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    }
    await this.write(
      `UPDATE chat_models SET label = ?2, model = ?3, temperature = ?4, max_output_tokens = ?5, enabled = ?6
         WHERE user_id = ?1 AND id = ?7`,
      next.label, next.model, next.temperature, next.maxOutputTokens, next.enabled ? 1 : 0, id,
    )
    return next
  }

  async deleteModel(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_models WHERE user_id = ?1 AND id = ?2`, id)
  }

  // ----------------------------------------------------------- conversations

  /**
   * The list, optionally narrowed to one folder (with its subfolders) or one tag.
   *
   * A folder's view includes what its children hold: a reader who files things underneath a project
   * folder expects its parent to show the lot, the same way the notebook's folder rows do.
   */
  async listConversations(
    query?: string,
    filter: { folderId?: string | null, tagId?: string, starred?: boolean, pinned?: boolean, limit?: number } = {},
  ): Promise<AssistantConversation[]> {
    const limit = filter.limit ?? 100
    const q = new Query(this.userId)
    if (filter.folderId !== undefined) {
      const ids = filter.folderId === null ? null : await this.folderSubtree(filter.folderId)
      if (ids && !ids.length) return []
      if (!ids) q.raw('folder_id IS NULL')
      else q.inList('folder_id', ids)
    }
    if (filter.starred) q.raw('starred = 1')
    if (filter.pinned) q.raw('pinned = 1')
    if (filter.tagId) {
      const tag = q.add(filter.tagId)
      q.raw(`EXISTS (SELECT 1 FROM chat_conversation_tags ct
        WHERE ct.user_id = ?1 AND ct.conversation_id = c.id AND ct.tag_id = ${tag})`)
    }
    if (query) {
      const pattern = q.add(containsPattern(query))
      const inBody = q.add(containsPattern(query))
      q.raw(`(title LIKE ${pattern} ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id
          AND m.user_id = ?1 AND m.content LIKE ${inBody} ESCAPE '\\'))`)
    }
    const limitBind = q.add(limit)
    const list = await this.rows<ConversationRow>(
      `SELECT c.id, c.title, c.summary, c.summary_upto, c.pinned, c.starred, c.folder_id, c.created_at, c.updated_at,
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
              (SELECT count(*) FROM chat_conversations c WHERE c.user_id = ?1 AND c.folder_id = f.id) AS n
         FROM folders f
        WHERE f.user_id = ?1 AND f.deleted_at IS NULL
        ORDER BY f.name`,
      this.userId,
    )
    const unfiled = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE user_id = ?1 AND folder_id IS NULL`,
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
    const rows = await this.rows<{ id: string, name: string, color: string | null }>(
      `SELECT id, name, color FROM tags WHERE user_id = ?1 ORDER BY name`,
      this.userId,
    )
    return rows.map((row) => ({ id: row.id, name: row.name, color: row.color ?? null }))
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

  /** How many conversations carry each tag, for the filter row. */
  async conversationTagCounts(): Promise<Map<string, number>> {
    const rows = await this.rows<{ tag_id: string, n: number }>(
      `SELECT tag_id, count(*) AS n FROM chat_conversation_tags WHERE user_id = ?1 GROUP BY tag_id`,
      this.userId,
    )
    return new Map(rows.map((row) => [row.tag_id, row.n]))
  }

  async getConversation(id: string): Promise<AssistantConversation | null> {
    const r = await this.one<ConversationRow>(
      `SELECT c.id, c.title, c.summary, c.summary_upto, c.pinned, c.starred, c.folder_id, c.created_at, c.updated_at,
              (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE c.user_id = ?1 AND c.id = ?2`,
      this.userId, id,
    )
    return r ? toConversation(r) : null
  }

  async createConversation(title: string, folderId: string | null = null): Promise<AssistantConversation> {
    const id = newId()
    const at = Date.now()
    await this.write(
      `INSERT INTO chat_conversations (id, user_id, title, folder_id, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      id, title, folderId, at, at,
    )
    return { id, title, pinned: false, starred: false, folderId, createdAt: at, updatedAt: at, messageCount: 0, tags: [], summary: null, summaryUpto: null }
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

  async setSummary(id: string, summary: string, upto: number): Promise<void> {
    await this.write(
      `UPDATE chat_conversations SET summary = ?2, summary_upto = ?3 WHERE user_id = ?1 AND id = ?4`,
      summary.slice(0, 4000), upto, id,
    )
  }

  async deleteConversation(id: string): Promise<void> {
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_pending_actions WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_active_runs WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_conversation_tags WHERE user_id = ?1 AND conversation_id = ?2`, id)
    await this.write(`DELETE FROM chat_conversations WHERE user_id = ?1 AND id = ?2`, id)
  }

  async deleteAllConversations(): Promise<number> {
    const before = await this.one<{ n: number }>(
      `SELECT count(*) AS n FROM chat_conversations WHERE user_id = ?1`,
      this.userId,
    )
    await this.write(`DELETE FROM chat_messages WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_pending_actions WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_active_runs WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_conversation_tags WHERE user_id = ?1`)
    await this.write(`DELETE FROM chat_conversations WHERE user_id = ?1`)
    return before?.n ?? 0
  }

  async messages(conversationId: string, limit = 500): Promise<AssistantMessage[]> {
    const list = await this.rows<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM (
         SELECT rowid AS seq, ${MESSAGE_COLUMNS} FROM chat_messages
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
    tools?: ToolActivity[]
    status?: AssistantMessage['status']
    error?: string | null
    id?: string
    usage?: { inputTokens: number, outputTokens: number } | null
    source?: 'chat' | 'import'
    createdAt?: number
  }): Promise<AssistantMessage> {
    const id = input.id ?? newId()
    const at = input.createdAt ?? Date.now()
    const tools = input.tools ?? []
    const status = input.status ?? 'complete'
    const error = input.error ?? null
    const source = input.source ?? 'chat'
    const usage = input.usage ?? null
    await this.write(
      `INSERT INTO chat_messages
         (id, user_id, conversation_id, role, content, tools, status, error, source, input_tokens, output_tokens, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      id, input.conversationId, input.role, input.content, JSON.stringify(tools), status, error, source,
      usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, at,
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
      tools,
      status,
      error,
      source,
      createdAt: at,
      usage,
    }
  }

  async deleteMessage(id: string): Promise<void> {
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
  ): Promise<{ memory: AssistantMemory, vector: ArrayBuffer, norm: number | null }[]> {
    if (!statuses.length) return []
    const q = new Query(this.userId)
    const modelBind = q.add(model)
    q.inList('m.status', statuses)
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

  async listMemories(opts: { query?: string, category?: string, status?: string, limit?: number } = {}): Promise<AssistantMemory[]> {
    const q = new Query(this.userId).raw(this.statusClause(opts.status ?? 'all'))
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
  async searchMemories(query: string, limit = 8, status: 'current' | 'all' = 'current'): Promise<AssistantMemory[]> {
    const terms = memorySearchTerms(query)
    if (!terms.length) return []
    const q = new Query(this.userId)
    if (status === 'current') q.raw(`status != 'historical'`)
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
  }): Promise<AssistantMemory> {
    const id = newId()
    const at = Date.now()
    const status = input.status ?? 'active'
    const validFrom = input.validFrom ?? null
    await this.write(
      `INSERT INTO chat_memories
         (id, user_id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, NULL, ?7, NULL, ?8, ?9)`,
      id, input.content, input.category, input.source, status, validFrom, at, at,
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
      createdAt: at,
      updatedAt: at,
    }
  }

  /** An identical current memory exists: refresh it rather than storing the same fact twice. */
  async findDuplicateMemory(content: string): Promise<AssistantMemory | null> {
    const r = await this.one<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM chat_memories
        WHERE user_id = ?1 AND content = ?2 COLLATE NOCASE AND status != 'historical'
        ORDER BY updated_at DESC LIMIT 1`,
      this.userId, content,
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

  async createProject(input: { name: string, description?: string }): Promise<Project> {
    const id = newId()
    const at = Date.now()
    const name = input.name.trim()
    const description = input.description ?? ''
    await this.write(
      `INSERT INTO chat_projects (id, user_id, name, description, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      id, name, description, at, at,
    )
    return { id, name, description, createdAt: at, updatedAt: at }
  }

  async updateProject(id: string, patch: { name?: string, description?: string }): Promise<Project | null> {
    const existing = await this.getProject(id)
    if (!existing) return null
    const next: Project = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: Date.now(),
    }
    await this.write(
      `UPDATE chat_projects SET name = ?2, description = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?5`,
      next.name, next.description, next.updatedAt, id,
    )
    return next
  }

  async deleteProject(id: string): Promise<void> {
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

  async createPendingAction(input: { conversationId: string, tool: string, targetId: string, targetLabel: string }): Promise<PendingAction> {
    const id = newId()
    const at = Date.now()
    const expires = at + PENDING_ACTION_TTL_MS
    const label = input.targetLabel.slice(0, 300)
    await this.write(
      `INSERT INTO chat_pending_actions
         (id, user_id, conversation_id, tool, target_id, target_label, status, created_at, expires_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
      id, input.conversationId, input.tool, input.targetId, label, at, expires,
    )
    return {
      id,
      tool: input.tool,
      conversationId: input.conversationId,
      targetId: input.targetId,
      targetLabel: label,
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
  async attachActionToMessage(messageId: string, toolId: string, action: PendingAction): Promise<void> {
    const r = await this.one<{ tools: string | null }>(
      `SELECT tools FROM chat_messages WHERE user_id = ?1 AND id = ?2`,
      this.userId, messageId,
    )
    if (!r) return
    const tools = decodeTools(r.tools).map((tool) => (tool.id === toolId ? { ...tool, approval: action } : tool))
    await this.write(`UPDATE chat_messages SET tools = ?2 WHERE user_id = ?1 AND id = ?3`, JSON.stringify(tools), messageId)
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
  async incrementUsage(counters: Partial<UsageCounters>, day = usageDay()): Promise<void> {
    await this.write(`INSERT INTO chat_usage_daily (user_id, day) VALUES (?1, ?2) ON CONFLICT(user_id, day) DO NOTHING`, day)
    const sets: string[] = []
    const binds: unknown[] = [this.userId, day]
    for (const [key, amount] of Object.entries(counters) as [keyof UsageCounters, number][]) {
      const column = USAGE_COLUMNS[key]
      if (!column || !amount) continue
      binds.push(Math.round(amount))
      sets.push(`${column} = ${column} + ?${binds.length}`)
    }
    if (!sets.length) return
    await this.db.prepare(`UPDATE chat_usage_daily SET ${sets.join(', ')} WHERE user_id = ?1 AND day = ?2`)
      .bind(...binds).run()
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

  async exportTables(): Promise<Record<string, Record<string, unknown>[]>> {
    const select = (table: string) => this.db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 ORDER BY created_at`)
      .bind(this.userId).all<Record<string, unknown>>().then((r) => r.results ?? [])
    return {
      conversations: await select('chat_conversations'),
      conversation_tags: await select('chat_conversation_tags'),
      messages: await select('chat_messages'),
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
  chat_conversations: ['id', 'title', 'summary', 'summary_upto', 'pinned', 'starred', 'folder_id', 'created_at', 'updated_at'],
  chat_conversation_tags: ['conversation_id', 'tag_id', 'created_at'],
  chat_messages: ['id', 'conversation_id', 'role', 'content', 'tools', 'status', 'error', 'source', 'input_tokens', 'output_tokens', 'created_at'],
  chat_memories: ['id', 'content', 'category', 'source', 'status', 'superseded_by', 'valid_from', 'valid_until', 'created_at', 'updated_at'],
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
  key_ciphertext?: string | null
  has_key?: number | null
  created_at: number
  updated_at: number
}

function toProvider(r: ProviderRow): AssistantProvider {
  return {
    id: r.id,
    label: r.label,
    protocol: pickEnum(r.protocol, ASSISTANT_PROTOCOLS, 'openai'),
    baseUrl: r.base_url,
    hasKey: bool(r.has_key ?? Boolean(r.key_ciphertext)),
    // The ciphertext is never decrypted to build a view, so no listing can carry a key out.
    keyHint: '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface ModelRow {
  id: string
  provider_id: string
  model: string
  label: string
  temperature: number | null
  max_output_tokens: number | null
  enabled: number
  position: number
}

function toModel(r: ModelRow): AssistantModel {
  return {
    id: r.id,
    providerId: r.provider_id,
    model: r.model,
    label: r.label || r.model,
    temperature: r.temperature ?? DEFAULT_ASSISTANT_SETTINGS.temperature,
    maxOutputTokens: r.max_output_tokens ?? DEFAULT_ASSISTANT_SETTINGS.limits.maxOutputTokens,
    enabled: bool(r.enabled),
  }
}

interface ConversationRow {
  id: string
  title: string
  summary: string | null
  summary_upto: number | null
  pinned: number
  starred: number
  folder_id: string | null
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
    folderId: r.folder_id ?? null,
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
  created_at: number
  updated_at: number
}

function toProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, description: r.description ?? '', createdAt: r.created_at, updatedAt: r.updated_at }
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
  status: string
  error: string | null
  created_at: number
  expires_at: number
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
    status,
    error: r.error,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }
}
