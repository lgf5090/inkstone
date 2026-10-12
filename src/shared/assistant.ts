/**
 * The chat assistant's data model, its settings shape, and the rules that need no database.
 *
 * Validation here is hand-written rather than schema-generated on purpose: every value that arrives
 * from a client, a backup file or a stored row goes through `normalize*` before it is trusted, and the
 * helpers clamp, enumerate and drop rather than throw, so one bad field cannot turn a saved setting
 * into a 500. This mirrors how `mergeSettings` treats the rest of the app's settings.
 */

import { isValidTimeZone, parseScheduleSpec, type ScheduleSpec } from './assistant-schedule'
import type { MessageKey } from './locales/en-US'

export type AssistantProtocol = 'openai' | 'anthropic' | 'gemini'

export const ASSISTANT_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const

export const ASSISTANT_MEMORY_CATEGORIES = [
  'preference',
  'fact',
  'goal',
  'habit',
  'person',
  'place',
  'other',
] as const
export type AssistantMemoryCategory = (typeof ASSISTANT_MEMORY_CATEGORIES)[number]

export const ASSISTANT_MEMORY_STATUSES = ['active', 'historical', 'uncertain'] as const
export type AssistantMemoryStatus = (typeof ASSISTANT_MEMORY_STATUSES)[number]

export const ASSISTANT_MEMORY_SOURCES = ['manual', 'assistant', 'import'] as const
export type AssistantMemorySource = (typeof ASSISTANT_MEMORY_SOURCES)[number]

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const AUTOMATION_KINDS = ['reminder', 'task_digest', 'assistant_prompt'] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]

export const AUTOMATION_STATUSES = ['scheduled', 'running', 'paused', 'completed', 'failed'] as const
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number]

export const PENDING_ACTION_STATUSES = ['pending', 'approved', 'cancelled', 'expired', 'failed'] as const
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number]

export const MEMORY_REVIEW_ACTIONS = ['keep_both', 'mark_historical', 'replace', 'discard'] as const
export type MemoryReviewAction = (typeof MEMORY_REVIEW_ACTIONS)[number]

export const MAX_MESSAGE_CHARS = 16_000
export const MAX_MEMORY_CHARS = 2_000
export const MAX_TASK_TITLE_CHARS = 300
export const MAX_TASK_NOTES_CHARS = 10_000
export const MAX_AUTOMATION_MESSAGE_CHARS = 4_000
export const MAX_CONVERSATION_TITLE_CHARS = 200

/**
 * What the assistant's provider records look like. `apiKey` never appears: the ciphertext lives in the
 * `assistant_providers` row and the plaintext only ever exists inside the worker call that signs the
 * upstream request, so no route can echo a key back to a browser.
 */
export interface AssistantProvider {
  id: string
  label: string
  protocol: AssistantProtocol
  baseUrl: string
  hasKey: boolean
  /** Last four characters, for the settings row that has to prove which key is stored. */
  keyHint: string
  createdAt: number
  updatedAt: number
}

export interface AssistantModel {
  id: string
  providerId: string
  model: string
  label: string
  temperature: number
  maxOutputTokens: number
  enabled: boolean
}

export interface AssistantLimits {
  maxOutputTokens: number
  maxContextTokens: number
  maxToolCalls: number
  maxAgentSteps: number
  maxRequestsPerDay: number
  maxScheduledRunsPerDay: number
}

export const LIMIT_RANGES = {
  maxOutputTokens: [64, 8192],
  maxContextTokens: [1000, 64_000],
  maxToolCalls: [0, 20],
  maxAgentSteps: [1, 10],
  maxRequestsPerDay: [1, 2000],
  maxScheduledRunsPerDay: [0, 48],
} as const satisfies Record<keyof AssistantLimits, readonly [number, number]>

export const DEFAULT_LIMITS: AssistantLimits = {
  maxOutputTokens: 1024,
  maxContextTokens: 6000,
  maxToolCalls: 6,
  maxAgentSteps: 4,
  maxRequestsPerDay: 200,
  maxScheduledRunsPerDay: 6,
}

export interface AssistantSettings {
  agentName: string
  language: 'en-US' | 'zh-CN'
  timezone: string
  activeModelId: string | null
  temperature: number
  limits: AssistantLimits
  /** Let the assistant store a lasting preference without being asked. */
  autoMemory: boolean
  /** Notice when a new memory replaces or contradicts an older one. Rule-based, no AI. */
  conflictReview: boolean
  /** Ask the model to double-check an ambiguous conflict. One request per check. */
  aiConflictCheck: boolean
  /** Answer from the offline stub instead of a provider, so the app is usable with no key. */
  offlineMode: boolean
  /** Which of the assistant's surfaces the container opens on. */
  startView: 'chat' | 'memory' | 'tasks' | 'automations' | 'settings'
  /** Folders the assistant may read notes from; empty means the whole vault. */
  noteScope: string[]
  sendOnEnter: boolean
}

export const ASSISTANT_START_VIEWS = ['chat', 'memory', 'tasks', 'automations', 'settings'] as const

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  agentName: 'Inkstone Assistant',
  language: 'en-US',
  timezone: 'UTC',
  activeModelId: null,
  temperature: 0.4,
  limits: { ...DEFAULT_LIMITS },
  autoMemory: false,
  conflictReview: true,
  aiConflictCheck: false,
  offlineMode: false,
  startView: 'chat',
  noteScope: [],
  sendOnEnter: true,
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return Math.trunc(numberInRange(value, min, max, fallback))
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function stringList(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().slice(0, itemMax)
    if (trimmed) seen.add(trimmed)
    if (seen.size >= max) break
  }
  return [...seen]
}

export function normalizeLimits(value: unknown): AssistantLimits {
  const raw = record(value)
  const limits: AssistantLimits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof AssistantLimits)[]) {
    const [min, max] = LIMIT_RANGES[key]
    limits[key] = integerInRange(raw[key], min, max, DEFAULT_LIMITS[key])
  }
  return limits
}

/**
 * A stored or submitted settings blob is never trusted: an unknown timezone would make every due date
 * and schedule uncomputable, and a limit outside its range would either be rejected by the upstream or
 * spend the reader's quota. Anything unusable falls back to the default rather than being stored.
 */
export function normalizeAssistantSettings(value: unknown): AssistantSettings {
  const raw = record(value)
  const limits = normalizeLimits(raw.limits)
  const startView = enumValue(raw.startView, ASSISTANT_START_VIEWS, DEFAULT_ASSISTANT_SETTINGS.startView)
  return {
    agentName: stringValue(raw.agentName, DEFAULT_ASSISTANT_SETTINGS.agentName, 60),
    language: enumValue(raw.language, ['en-US', 'zh-CN'] as const, DEFAULT_ASSISTANT_SETTINGS.language),
    timezone: isValidTimeZone(typeof raw.timezone === 'string' ? raw.timezone : '')
      ? (raw.timezone as string)
      : DEFAULT_ASSISTANT_SETTINGS.timezone,
    activeModelId: typeof raw.activeModelId === 'string' && raw.activeModelId ? raw.activeModelId.slice(0, 26) : null,
    temperature: numberInRange(raw.temperature, 0, 1.5, DEFAULT_ASSISTANT_SETTINGS.temperature),
    limits,
    autoMemory: booleanValue(raw.autoMemory, DEFAULT_ASSISTANT_SETTINGS.autoMemory),
    conflictReview: booleanValue(raw.conflictReview, DEFAULT_ASSISTANT_SETTINGS.conflictReview),
    aiConflictCheck: booleanValue(raw.aiConflictCheck, DEFAULT_ASSISTANT_SETTINGS.aiConflictCheck),
    offlineMode: booleanValue(raw.offlineMode, DEFAULT_ASSISTANT_SETTINGS.offlineMode),
    startView,
    noteScope: stringList(raw.noteScope, 12, 26),
    sendOnEnter: booleanValue(raw.sendOnEnter, DEFAULT_ASSISTANT_SETTINGS.sendOnEnter),
  }
}

/**
 * Rough token counts for budgeting.
 *
 * The four-characters-per-token rule the reference project used is about right for English and wrong
 * by a factor of three for Chinese: a Han character carries roughly a whole word, so 600 Han
 * characters are near 600 tokens, not 150. Budgeting English at 4 chars/token and counting every Han
 * character (and each Japanese kana, which behaves the same way) as one token is what keeps a Chinese
 * vault from sending four times the content a Chinese reader's setting appeared to allow.
 */
const CJK_TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  CJK_TOKEN_PATTERN.lastIndex = 0
  while (CJK_TOKEN_PATTERN.exec(text) !== null) cjk++
  const other = text.length - cjk
  return cjk + Math.ceil(other / 4)
}

/**
 * Clause-final marks, in both the half- and the full-width shape, that a long first line may be cut
 * after. Han is written without spaces, so the mark is the only boundary available.
 */
const TITLE_BREAK_PUNCTUATION = ['，', '。', '、', '；', ',', '.']

/**
 * The first line of a conversation, shortened the way a reader would shorten it.
 *
 * A word boundary only exists in scripts that use spaces, so cutting an unspaced title at the last
 * space would run to the full 60 characters and then some; the Han case just takes the first clause
 * and marks the cut. An empty answer is deliberate: the row keeps no title and the client prints the
 * localized "New conversation" for it, instead of an English string frozen into the reader's database.
 */
export function titleFromMessage(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const limit = 48
  if (clean.length <= limit) return clean
  const cut = clean.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  let lastClause = -1
  for (const mark of TITLE_BREAK_PUNCTUATION) lastClause = Math.max(lastClause, cut.lastIndexOf(mark))
  const breakAt = Math.max(lastSpace > 20 ? lastSpace : -1, lastClause > 8 ? lastClause : -1)
  return breakAt > 0 ? cut.slice(0, breakAt) : cut
}

export interface AssistantConversation {
  id: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Rolling summary of the messages that no longer fit the context window. */
  summary?: string | null
  summaryUpto?: number | null
}

export interface ToolActivity {
  id: string
  /** One of `ASSISTANT_TOOL_SPECS[].name`; the client renders the chip's words from the catalog. */
  name: string
  /** The fragment the tool acted on — a task title, a note name. User text, never invented copy. */
  detail?: string
  status: 'running' | 'success' | 'error'
  error?: string
  approval?: PendingAction
}

export interface PendingAction {
  id: string
  tool: string
  conversationId: string
  targetId: string
  /** The target's own title, quoted on the approval card. */
  targetLabel: string
  status: PendingActionStatus
  error: string | null
  createdAt: number
  expiresAt: number
}

export type ToolPermission = 'read' | 'write' | 'destructive'

export interface AssistantToolSpec {
  name: string
  labelKey: MessageKey
  /** Only a destructive tool has one: the approval card names what will be removed. */
  approvalKey?: MessageKey
  permission: ToolPermission
}

/**
 * Every tool the assistant can reach, named once for both sides.
 *
 * The client needs the label keys and the worker needs the names, and a tool that exists in one list
 * but not the other is either a chip that renders blank or a call no reader can approve.
 * `tests/assistant-tool-specs.test.ts` proves the two directions.
 */
export const ASSISTANT_TOOL_SPECS: readonly AssistantToolSpec[] = [
  { name: 'create_task', labelKey: 'assistant.tool.create_task', permission: 'write' },
  { name: 'list_tasks', labelKey: 'assistant.tool.list_tasks', permission: 'read' },
  { name: 'update_task', labelKey: 'assistant.tool.update_task', permission: 'write' },
  { name: 'complete_task', labelKey: 'assistant.tool.complete_task', permission: 'write' },
  { name: 'delete_task', labelKey: 'assistant.tool.delete_task', approvalKey: 'assistant.approval.delete_task', permission: 'destructive' },
  { name: 'remember', labelKey: 'assistant.tool.remember', permission: 'write' },
  { name: 'search_memories', labelKey: 'assistant.tool.search_memories', permission: 'read' },
  { name: 'update_memory', labelKey: 'assistant.tool.update_memory', permission: 'write' },
  { name: 'forget_memory', labelKey: 'assistant.tool.forget_memory', approvalKey: 'assistant.approval.forget_memory', permission: 'destructive' },
  { name: 'search_notes', labelKey: 'assistant.tool.search_notes', permission: 'read' },
  { name: 'read_note', labelKey: 'assistant.tool.read_note', permission: 'read' },
  { name: 'create_note', labelKey: 'assistant.tool.create_note', permission: 'write' },
  { name: 'update_note', labelKey: 'assistant.tool.update_note', permission: 'write' },
  { name: 'delete_note', labelKey: 'assistant.tool.delete_note', approvalKey: 'assistant.approval.delete_note', permission: 'destructive' },
  { name: 'create_reminder', labelKey: 'assistant.tool.create_reminder', permission: 'write' },
  { name: 'create_automation', labelKey: 'assistant.tool.create_automation', permission: 'write' },
  { name: 'list_automations', labelKey: 'assistant.tool.list_automations', permission: 'read' },
  { name: 'cancel_automation', labelKey: 'assistant.tool.cancel_automation', approvalKey: 'assistant.approval.cancel_automation', permission: 'destructive' },
  { name: 'list_projects', labelKey: 'assistant.tool.list_projects', permission: 'read' },
  { name: 'create_project', labelKey: 'assistant.tool.create_project', permission: 'write' },
  { name: 'search', labelKey: 'assistant.tool.search', permission: 'read' },
  { name: 'notify_reader', labelKey: 'assistant.tool.notify_reader', permission: 'write' },
]

export const ASSISTANT_TOOL_BY_NAME: ReadonlyMap<string, AssistantToolSpec> = new Map(
  ASSISTANT_TOOL_SPECS.map((spec) => [spec.name, spec]),
)

export interface AssistantMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  tools: ToolActivity[]
  status: 'complete' | 'error' | 'cancelled'
  error: string | null
  createdAt: number
  /** `import` marks a message restored from a backup: it is data, never live owner input. */
  source: 'chat' | 'import'
  usage?: { inputTokens: number, outputTokens: number } | null
}

export interface AssistantMemory {
  id: string
  content: string
  category: AssistantMemoryCategory
  source: AssistantMemorySource
  status: AssistantMemoryStatus
  supersededBy: string | null
  /** Only when the text stated one: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Never guessed. */
  validFrom: string | null
  validUntil: string | null
  createdAt: number
  updatedAt: number
}

export interface MemoryReview {
  id: string
  memory: AssistantMemory
  other: AssistantMemory
  relationship: 'contradiction' | 'possible_update'
  reason: string
  createdAt: number
}

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  dueAt: number | null
  projectId: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface Project {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface Automation {
  id: string
  name: string
  kind: AutomationKind
  message: string
  schedule: ScheduleSpec
  enabled: boolean
  status: AutomationStatus
  nextRun: number | null
  lastRun: number | null
  lastResult: string | null
  lastError: string | null
  runCount: number
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  automationName: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error' | 'skipped'
  result: string | null
  error: string | null
}

export interface AssistantNotification {
  id: string
  title: string
  body: string
  automationId: string | null
  readAt: number | null
  createdAt: number
}

/** What an assistant backup reported after a merge, so the toast can say what arrived. */
export interface AssistantImportSummary {
  conversations: number
  messages: number
  memories: number
  tasks: number
  projects: number
  automations: number
  notifications: number
  skipped: string[]
}

export interface UsageCounters {
  requests: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  scheduledRuns: number
  errors: number
}

export type AssistantUsage = UsageCounters

export const EMPTY_USAGE: UsageCounters = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  scheduledRuns: 0,
  errors: 0,
}

/**
 * Provider presets the settings form offers. A preset is only a starting point: the base URL and the
 * key are editable, and any other OpenAI-compatible endpoint works by picking that protocol.
 */
export const PROVIDER_PRESETS: readonly { id: string, label: string, protocol: AssistantProtocol, baseUrl: string, models: readonly string[] }[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4.1-mini'] },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  { id: 'kimi', label: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'kimi-latest'] },
  { id: 'qwen', label: 'Qwen (DashScope)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat'] },
  { id: 'local', label: 'Local / other', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [''] },
]

/** A model id the settings form will accept, so a stray space cannot poison a request. */
export function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, '').slice(0, 120) : ''
}

export interface ChatStreamEvent {
  type: 'start' | 'text' | 'reasoning' | 'tool' | 'title' | 'stage' | 'usage' | 'error' | 'done'
  conversationId?: string
  userMessageId?: string
  assistantMessageId?: string
  title?: string
  delta?: string
  tool?: ToolActivity
  stage?: 'reading' | 'searching' | 'generating' | 'waiting'
  usage?: { inputTokens: number, outputTokens: number }
  code?: string
  message?: string
  finalMessage?: AssistantMessage
}

export function normalizeScheduleForStorage(value: unknown): ScheduleSpec | null {
  return parseScheduleSpec(value)
}
