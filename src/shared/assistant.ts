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
 * `chat_providers` row and the plaintext only ever exists inside the worker call that signs the
 * upstream request, so no route can echo a key back to a browser.
 */
export interface AssistantProvider {
  id: string
  label: string
  protocol: AssistantProtocol
  baseUrl: string
  /**
   * A second address per protocol, for the gateway that answers on more than one wire.
   *
   * Only the protocols the reader filled in are here; a model that asks for a protocol this map carries is
   * called through that address instead of `baseUrl`.
   */
  endpoints: Partial<Record<AssistantProtocol, string>>
  hasKey: boolean
  /** Last four characters, for the settings row that has to prove which key is stored. */
  keyHint: string
  createdAt: number
  updatedAt: number
}

/** Tolerant by design: a backup written by an older build must not lose the rest of the provider. */
export function parseProviderEndpoints(value: unknown): Partial<Record<AssistantProtocol, string>> {
  let record: unknown = value
  if (typeof value === 'string') {
    try {
      record = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (typeof record !== 'object' || record === null) return {}
  const out: Partial<Record<AssistantProtocol, string>> = {}
  for (const [protocol, url] of Object.entries(record as Record<string, unknown>)) {
    if (!(ASSISTANT_PROTOCOLS as readonly string[]).includes(protocol)) continue
    if (typeof url !== 'string' || !url.trim()) continue
    out[protocol as AssistantProtocol] = url.trim().slice(0, 300)
  }
  return out
}

/** One row of a vendor's own listing: what this key can call, named the way the vendor names it. */
export interface AssistantVendorModel {
  id: string
  label: string
  ownedBy: string | null
  created: number | null
}

/** What a model is asked to do, so the picker only offers the ones that answer. */
export const ASSISTANT_MODEL_PURPOSES = ['chat', 'image_generate', 'image_edit'] as const
export type AssistantModelPurpose = (typeof ASSISTANT_MODEL_PURPOSES)[number]

/** The kind of endpoint behind the id: only `text` models can hold a conversation. */
export const ASSISTANT_MODEL_KINDS = ['text', 'image', 'embedding', 'rerank'] as const
export type AssistantModelKind = (typeof ASSISTANT_MODEL_KINDS)[number]

/**
 * What the reader says the model can be *given*.
 *
 * `image` is deliberately absent: the older `vision` switch already owns that fact, the runner and its
 * tests read it, and a second column saying the same thing is a future disagreement. These three are the
 * modalities nothing else speaks for.
 */
export const ASSISTANT_MODEL_MODALITIES = ['audio', 'video'] as const
export type AssistantModelModality = (typeof ASSISTANT_MODEL_MODALITIES)[number]

export function parseModelModalities(value: unknown): AssistantModelModality[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is AssistantModelModality =>
    ASSISTANT_MODEL_MODALITIES.includes(entry as AssistantModelModality)))]
}

/**
 * Quick picks, so the reader is not typing 262144 into a number field to get 256K. Each value is a round
 * thousand on purpose: the label under the button is produced by dividing by 1000, and a binary step such
 * as 32_768 would print as 33K and read like a different setting than the one it is.
 */
export const CONTEXT_WINDOW_STEPS: readonly number[] = [128_000, 200_000, 256_000, 400_000, 512_000, 1_000_000]
export const MAX_OUTPUT_STEPS: readonly number[] = [1000, 4000, 8000, 16_000, 32_000, 64_000]
/** A ceiling on what the model can be *sent*, which is not the same number as its context window. */
export const MAX_INPUT_STEPS: readonly number[] = [8000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000]

export function formatTokenStep(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return `${tokens}`
}

/** One extra field spliced into the upstream request body, typed so a number is not sent as a string. */
export const ASSISTANT_PARAM_TYPES = ['string', 'number', 'boolean'] as const
export type AssistantParamType = (typeof ASSISTANT_PARAM_TYPES)[number]

export interface AssistantCustomParam {
  name: string
  type: AssistantParamType
  value: string
}

/**
 * How many ids a new provider may be seeded with, in one create call.
 *
 * The form can offer a vendor's whole list, which is hundreds of rows for some accounts, and creating a
 * model row per id is a write each. The cap is shared so the picker can refuse the extra ticks where the
 * reader makes them instead of the route dropping them after the fact.
 */
export const MAX_PROVIDER_MODELS = 20

export const MAX_CUSTOM_PARAMS = 12

/** Parses the stored JSON, dropping anything malformed rather than sending half a request body. */
export function parseCustomParams(value: unknown): AssistantCustomParam[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry): AssistantCustomParam | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const record = entry as Record<string, unknown>
      if (typeof record.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,40}$/.test(record.name)) return null
      const type = ASSISTANT_PARAM_TYPES.includes(record.type as AssistantParamType)
        ? record.type as AssistantParamType : 'string'
      return { name: record.name, type, value: typeof record.value === 'string' ? record.value.slice(0, 400) : '' }
    })
    .filter((entry): entry is AssistantCustomParam => entry !== null)
    .slice(0, MAX_CUSTOM_PARAMS)
}

/**
 * The body fragment the reader's own parameters add, with values coerced to the type they declared.
 *
 * The request's own skeleton is off limits: a parameter named `stream` or `messages` would otherwise
 * turn the streaming parser into a silent failure, and `tools` would let the box take back the tool
 * list the reader just switched off.
 */
const RESERVED_PARAM_NAMES = new Set([
  'model', 'messages', 'prompt', 'contents', 'systemInstruction', 'stream', 'stream_options',
  'tools', 'tool_choice', 'generationConfig', 'max_tokens', 'max_output_tokens', 'stop', 'input',
])
export function customParamBody(params: readonly AssistantCustomParam[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const param of params) {
    if (!param.value || RESERVED_PARAM_NAMES.has(param.name)) continue
    if (param.type === 'number') {
      const numeric = Number(param.value)
      if (Number.isFinite(numeric)) out[param.name] = numeric
    } else if (param.type === 'boolean') {
      out[param.name] = param.value === 'true'
    } else out[param.name] = param.value
  }
  return out
}

export interface AssistantModel {
  id: string
  providerId: string
  model: string
  label: string
  /** Null leaves the vendor default alone: the composer temperature switch off means exactly that. */
  temperature: number | null
  maxOutputTokens: number
  enabled: boolean
  /** How much the model is asked to think before answering; `auto` leaves the vendor's choice alone. */
  reasoning: AssistantReasoning
  /** This model's own context budget, so a 1M model is not fed like a 4K one. Null uses the global limit. */
  contextTokens: number | null
  /** Whether the model may be shown a picture. On by default; a text-only upstream is turned off here. */
  vision: boolean
  /** Only a `chat` model answers the composer; the rest are listed for their own callers. */
  purpose: AssistantModelPurpose
  kind: AssistantModelKind
  /** False stops the tool schemas going out at all, which is what a model that hallucinates calls needs. */
  supportsTools: boolean
  /** Null means the reader has not said: the global limit answers for it. */
  maxInputTokens: number | null
  /** What the reader says may be given to it, beyond a picture — see ASSISTANT_MODEL_MODALITIES. */
  modalities: AssistantModelModality[]
  /** Null leaves the vendor default alone, which is what the Top-P switch off means. */
  topP: number | null
  customParams: AssistantCustomParam[]
  /**
   * Which wire this model is called on. Null follows the provider; a value is what lets one gateway key
   * serve an Anthropic-shaped model beside an OpenAI-shaped one.
   */
  protocol: AssistantProtocol | null
}

/**
 * The thinking levels the composer offers.
 *
 * `low`/`medium`/`high` reach the vendor as `reasoning_effort`, which some servers honour and others
 * ignore, so they also ask for thinking explicitly; `off` is the one level that works everywhere it is
 * supported, and `auto` sends nothing at all.
 */
export type AssistantReasoning = 'auto' | 'off' | 'low' | 'medium' | 'high'

export const ASSISTANT_REASONING_LEVELS: readonly AssistantReasoning[] = ['auto', 'off', 'low', 'medium', 'high']

/** Token budgets a level means for the protocols that take a number rather than a name. */
export const REASONING_BUDGET_TOKENS: Record<'low' | 'medium' | 'high', number> = { low: 1024, medium: 4096, high: 10_240 }

/** The context budgets the composer's slider snaps to, in tokens. */
/** The largest per-model context window the field will store — a ceiling on the number, not a menu. */
export const MAX_CONTEXT_BUDGET_TOKENS = 4_000_000

export const CONTEXT_TOKEN_STEPS: readonly number[] = [4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144]

export function reasoningValue(value: unknown): AssistantReasoning {
  return typeof value === 'string' && (ASSISTANT_REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as AssistantReasoning)
    : 'auto'
}

export interface AssistantLimits {
  maxOutputTokens: number
  maxContextTokens: number
  maxToolCalls: number
  maxAgentSteps: number
  maxRequestsPerDay: number
  maxScheduledRunsPerDay: number
  maxEmbeddingsPerDay: number
}

export const LIMIT_RANGES = {
  maxOutputTokens: [64, 8192],
  maxContextTokens: [1000, 64_000],
  maxToolCalls: [0, 20],
  maxAgentSteps: [1, 10],
  maxRequestsPerDay: [1, 2000],
  maxScheduledRunsPerDay: [0, 48],
  maxEmbeddingsPerDay: [0, 2000],
} as const satisfies Record<keyof AssistantLimits, readonly [number, number]>

export const DEFAULT_LIMITS: AssistantLimits = {
  maxOutputTokens: 1024,
  maxContextTokens: 6000,
  maxToolCalls: 6,
  maxAgentSteps: 4,
  maxRequestsPerDay: 200,
  maxScheduledRunsPerDay: 6,
  maxEmbeddingsPerDay: 200,
}

/** A Workers AI text-embedding model id: the two hubs the binding can reach, and nothing else. */
export const SEMANTIC_MODEL_PATTERN = /^@(?:cf|hf)\/[\w./-]{1,160}$/
export const DEFAULT_SEMANTIC_MODEL = '@cf/baai/bge-m3'

/** An unusable model id is replaced by the default rather than stored, so no request can name a path. */
export function semanticModelValue(value: unknown, fallback = DEFAULT_SEMANTIC_MODEL): string {
  return typeof value === 'string' && SEMANTIC_MODEL_PATTERN.test(value.trim()) ? value.trim() : fallback
}

export interface AssistantSettings {
  agentName: string
  language: 'en-US' | 'zh-CN'
  timezone: string
  activeModelId: string | null
  temperature: number
  limits: AssistantLimits
  /** Recall memories by vector as well as by shared words; needs the deployment's AI binding. */
  semanticMemory: boolean
  /**
   * Which Workers AI embedding model the memory vectors come from. Any text-embedding model id works,
   * but a change orphans every stored vector until the index is rebuilt, because a vector from one
   * encoder is not comparable with one from another.
   */
  semanticModel: string
  /** Let the assistant store a lasting preference without being asked. */
  autoMemory: boolean
  /** Notice when a new memory replaces or contradicts an older one. Rule-based, no AI. */
  conflictReview: boolean
  /** Ask the model to double-check an ambiguous conflict. One request per check. */
  aiConflictCheck: boolean
  /**
   * Run the assistant's write tools immediately instead of holding each one for approval. Reads never
   * need approval either way; this is the difference between a chat that edits the notebook while you
   * watch and one that asks first.
   */
  autoApproveWrites: boolean
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
  semanticMemory: true,
  semanticModel: DEFAULT_SEMANTIC_MODEL,
  autoMemory: false,
  conflictReview: true,
  aiConflictCheck: false,
  autoApproveWrites: false,
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

/**
 * Every settings field a client may patch, as one list rather than as a route that names them.
 *
 * A hand-copied list is how a field stops saving without any test going red: the switch renders, the
 * request goes out, and the route forwards everything except the one key nobody added.
 */
export const ASSISTANT_SETTING_KEYS = Object.keys(DEFAULT_ASSISTANT_SETTINGS) as (keyof AssistantSettings)[]

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
    semanticMemory: booleanValue(raw.semanticMemory, DEFAULT_ASSISTANT_SETTINGS.semanticMemory),
    semanticModel: semanticModelValue(raw.semanticModel, DEFAULT_ASSISTANT_SETTINGS.semanticModel),
    autoMemory: booleanValue(raw.autoMemory, DEFAULT_ASSISTANT_SETTINGS.autoMemory),
    conflictReview: booleanValue(raw.conflictReview, DEFAULT_ASSISTANT_SETTINGS.conflictReview),
    aiConflictCheck: booleanValue(raw.aiConflictCheck, DEFAULT_ASSISTANT_SETTINGS.aiConflictCheck),
    autoApproveWrites: booleanValue(raw.autoApproveWrites, DEFAULT_ASSISTANT_SETTINGS.autoApproveWrites),
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

/**
 * One of the reader's own tags, as the chat list shows it. Tags live in the note tag table.
 *
 * `isPinned` is optional because the two producers are different reads of that table: the filter list
 * carries it so the assistant can pin like the notebook sidebar does, while the chips shown on a
 * conversation are just its labels. A consumer that has to sort or group on it should treat a missing
 * value as unpinned rather than guess.
 */
export interface ConversationTag {
  id: string
  name: string
  color: string | null
  isPinned?: boolean
}

/** How many files one message may carry: enough for a comparison, small enough for one request body. */
export const MAX_CHAT_ATTACHMENTS = 8

/** One uploaded file, as the composer and the transcript both show it. */
export interface ChatAttachment {
  id: string
  kind: 'image' | 'file'
  filename: string
  mime: string
  size: number
  /** The R2 path (`chat/images/<user>/<id>.png`); the client never needs it, the server always does. */
  key: string
  createdAt: number
}

/** A note tag or folder the reader pinned to one turn with `#`. */
export interface AssistantTurnScope {
  kind: 'tag' | 'folder'
  id: string
  name: string
}

/** One saved prompt: the reader's own words, kept out of the model's way until asked for. */
export const MAX_PROMPT_TITLE_CHARS = 120
export const MAX_PROMPT_CONTENT_CHARS = 8_000

export interface ChatPrompt {
  id: string
  title: string
  content: string
  /** Free-text grouping; empty means the prompt is unfiled. */
  group: string
  createdAt: number
  updatedAt: number
}

/** Ceilings for one turn's inline picks, so a composer cannot ask for the whole vault. */
export const MAX_TURN_TOOLS = 6
export const MAX_TURN_SCOPES = 6

export interface AssistantConversation {
  id: string
  title: string
  pinned: boolean
  /** The reader's own shortlist, separate from the pinned order the list opens in. */
  starred: boolean
  /** A folder from the notebook's own tree; null means the conversation is unfiled. */
  folderId: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Only the list endpoints fill these in, so the thread view stays cheap. */
  tags?: ConversationTag[]
  /** Rolling summary of the messages that no longer fit the context window. */
  summary?: string | null
  summaryUpto?: number | null
}

/** A folder of the note tree, with how many conversations it holds. */
export interface ChatFolderNode {
  id: string
  name: string
  parentId: string | null
  icon: string | null
  color: string | null
  count: number
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
  /**
   * The arguments the model proposed, kept only so an external tool call can be replayed after approval:
   * a note deletion can be redone from its target id, a remote search cannot.
   */
  args?: Record<string, unknown>
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
 * An external MCP server the reader added.
 *
 * `toolMode` is the whole safety story for a third party: its tools can be hidden from the model, offered
 * but gated behind an approval card for every call, or run on the model's own say-so. Nothing is auto by
 * default — a server the reader pasted in from a blog post gets no write access to their notes silently.
 */
export const ASSISTANT_MCP_TOOL_MODES = ['off', 'ask', 'auto'] as const
export type AssistantMcpToolMode = (typeof ASSISTANT_MCP_TOOL_MODES)[number]

export interface AssistantMcpServer {
  id: string
  label: string
  url: string
  enabled: boolean
  toolMode: AssistantMcpToolMode
  /** Whether a bearer header is stored. The value itself never leaves the worker. */
  hasKey: boolean
  createdAt: number
  updatedAt: number
}

export const MAX_MCP_SERVERS = 8
export const MAX_MCP_TOOLS_PER_SERVER = 24
/** A tool name the upstreams accept: `^[a-zA-Z0-9_-]{1,64}$` after namespacing. */
export const MAX_MCP_TOOL_NAME_CHARS = 64
export const MAX_MCP_LABEL_CHARS = 60
export const MAX_MCP_URL_CHARS = 2048

/** What one external tool looks like after listing, in the shape the composer and executor both need. */
export interface AssistantMcpTool {
  /** The namespaced name the model is offered. */
  name: string
  /** The server's own name for it, which is what `tools/call` must carry. */
  remoteName: string
  serverId: string
  serverLabel: string
  description: string
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
  /**
   * Attachment ids this message carries, in the order the reader added them. The bytes live under the
   * chat's own object prefix; the ids are what both the transcript and the model call need.
   */
  attachments?: string[]
  status: 'complete' | 'error' | 'cancelled'
  error: string | null
  createdAt: number
  /** `import` marks a message restored from a backup: it is data, never live owner input. */
  source: 'chat' | 'import'
  usage?: { inputTokens: number, outputTokens: number } | null
  /** How long the model took, in milliseconds — the denominator of the tokens-per-second figure. */
  durationMs?: number
  /** The model that answered, kept as text for the same reason a version keeps it. */
  modelLabel?: string
  /**
   * Answers the reader has since regenerated away from, still kept for this turn. The count drives the
   * pager under the bubble; the bodies are fetched when the pager is opened, the same way the notes
   * app's version history lists its snapshots.
   */
  versionCount?: number
}

/**
 * One earlier answer of the same turn.
 *
 * A retry does not stack a second bubble any more: the outgoing answer is filed here and the turn keeps
 * one row, so the reader can page back through what the model actually said and bring any of them back.
 */
export interface AssistantAnswerVersion {
  id: string
  messageId: string
  conversationId: string
  content: string
  tools: ToolActivity[]
  /** The model that produced it, kept as text: the model may be deleted while the answer is not. */
  modelLabel: string
  usage: { inputTokens: number, outputTokens: number } | null
  durationMs: number
  createdAt: number
}

/**
 * How many displaced answers one turn keeps. The notes app caps its history the same way; without a cap
 * a reader who regenerates twenty times stores twenty answers forever.
 */
export const MAX_ANSWER_VERSIONS = 5

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
  /** Answers the reader had paged away from, restored with their threads. */
  answerVersions: number
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
  embeddings: number
  errors: number
}

export type AssistantUsage = UsageCounters

export const EMPTY_USAGE: UsageCounters = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  scheduledRuns: 0,
  embeddings: 0,
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
  { id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { id: 'mistral', label: 'Mistral AI', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'] },
  { id: 'xai', label: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4.7', 'grok-4.6'] },
  { id: 'kimi', label: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'kimi-latest'] },
  { id: 'qwen', label: 'Qwen (DashScope)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo'] },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['deepseek/deepseek-chat'] },
  // The eight below were added after checking each vendor's own documentation for the address and the
  // ids; a preset whose address was guessed is worse than no preset, because the reader has no reason to
  // doubt it.
  //
  // Groq, Mistral and xAI sit above that line because their own pages could not be opened from a build
  // machine (403 or a timeout), so only what those pages say about themselves in the search index could be
  // read: Groq's OpenAI-compatibility page names `https://api.groq.com/openai/v1` as its base URL and the
  // same page's `…/openai/v1/models` as the listing, Mistral's reference answers under `/v1`, and x.ai's
  // own API page names `https://api.x.ai/v1`. The ids beside them come from a public catalogue of the same
  // listings rather than from a page this machine could read. The address is the half a preset has to get
  // right — the listing, which the add form can ask for before anything is saved, is what replaces the
  // ids — so a wrong address is the one mistake worth refusing to guess at.
  { id: 'siliconflow', label: 'SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.com/v1', models: ['Qwen/Qwen3-32B', 'deepseek-ai/DeepSeek-V4-Flash'] },
  { id: 'zhipu', label: 'Zhipu GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3'] },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1', models: ['MiniMax-M3', 'MiniMax-M2.7'] },
  { id: 'together', label: 'Together AI', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1', models: ['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-V4-Pro-0813'] },
  { id: 'cerebras', label: 'Cerebras', protocol: 'openai', baseUrl: 'https://api.cerebras.ai/v1', models: ['gpt-oss-120b', 'qwen-3.8-27b'] },
  { id: 'fireworks', label: 'Fireworks AI', protocol: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/kimi-k2p5', 'accounts/fireworks/models/deepseek-v3p2'] },
  { id: 'deepinfra', label: 'DeepInfra', protocol: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', models: ['deepseek-ai/DeepSeek-V4-Flash-0731'] },
  { id: 'ollama-cloud', label: 'Ollama Cloud', protocol: 'openai', baseUrl: 'https://ollama.com/v1', models: ['gemma4:31b'] },
  { id: 'other', label: 'Gateway / other (https)', protocol: 'openai', baseUrl: 'https://', models: [''] },
]

/**
 * What one address field says, before anybody tries to reach it.
 *
 * The form and the route share this so the reader is told "that is not an address" beside the box they
 * typed it in, instead of through a 400 that names nothing. Reachability is deliberately not judged here:
 * a private host has the right shape and the route is what refuses it, so splitting the two rules keeps
 * each one in the place that can enforce it.
 */
export function endpointFieldState(value: string): 'empty' | 'invalid' | 'ok' {
  const trimmed = (value ?? '').trim()
  // A bare scheme is what the preset seeds and what an autofill can leave behind: nothing was entered.
  if (!trimmed || /^https?:\/{0,2}$/i.test(trimmed)) return 'empty'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'invalid'
  }
  // Only the two schemes the request path can speak. A host is not checked separately because a WHATWG
  // parser refuses an http(s) URL without one, so `https:///` is already caught above.
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'ok' : 'invalid'
}

/** A model id the settings form will accept, so a stray space cannot poison a request. */
export function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, '').slice(0, 120) : ''
}

export interface ChatStreamEvent {
  type: 'start' | 'text' | 'reasoning' | 'tool' | 'title' | 'stage' | 'usage' | 'error' | 'done' | 'mcp_problem'
  conversationId?: string
  userMessageId?: string
  assistantMessageId?: string
  title?: string
  delta?: string
  tool?: ToolActivity
  stage?: 'reading' | 'searching' | 'generating' | 'waiting'
  usage?: { inputTokens: number, outputTokens: number }
  /** For `mcp_problem`: which external server failed to list, and why. */
  server?: string
  error?: string
  code?: string
  message?: string
  finalMessage?: AssistantMessage
}

export function normalizeScheduleForStorage(value: unknown): ScheduleSpec | null {
  return parseScheduleSpec(value)
}
