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

/**
 * A vendor's thinking contract, as `reasoning.ts` names them.
 *
 * It is part of the provider record because a provider is where the reader can pin it: the rest of the time
 * it is read off the address and the model's own name, which is right for every service that announces
 * itself and no help at all for a gateway that does not.
 */
export const REASONING_DIALECTS = [
  'openai', 'deepseek', 'qwen', 'openrouter', 'gemini-budget', 'gemini-level', 'claude-budget', 'claude-effort',
] as const
export type ReasoningDialect = (typeof REASONING_DIALECTS)[number]

export function reasoningDialectValue(value: unknown): ReasoningDialect | null {
  return typeof value === 'string' && (REASONING_DIALECTS as readonly string[]).includes(value)
    ? (value as ReasoningDialect)
    : null
}

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
  /**
   * The thinking shape the reader pinned for this address, or null to let it be read off the address.
   *
   * A service that announces itself in its hostname and model names needs no pin; a gateway, a proxy or a
   * vendor whose naming is guesswork is exactly what this is for.
   */
  reasoningDialect: ReasoningDialect | null
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

/**
 * The wire a model is called on: the protocol it names, and that protocol's address.
 *
 * A gateway can answer on more than one wire with one key, so a model may name its protocol and the
 * provider supplies the matching address; a protocol with no address of its own falls back to the
 * provider's base URL, which is what every provider written before the per-protocol map had. The worker
 * builds the request out of this pair and the settings screens read the model's thinking dialect off it, so
 * the rule is stated once instead of twice with room to disagree.
 */
export function modelWire(
  model: Pick<AssistantModel, 'protocol'>,
  provider: Pick<AssistantProvider, 'protocol' | 'baseUrl' | 'endpoints'>,
): { protocol: AssistantProtocol, baseUrl: string } {
  const protocol = model.protocol ?? provider.protocol
  return { protocol, baseUrl: provider.endpoints[protocol] || provider.baseUrl }
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
 * Quick picks, so the reader is not typing 1048576 into a number field to get 1M.
 *
 * Every step counts in the unit a token is counted in: 1K is 1024, and the label under the button is the
 * same division, so the number the button saves is the number it says. A round thousand would print
 * 32_768 as 33K and read like a different setting than the one it is. The two ceilings — what a model
 * may be sent and what it may write back — share one ladder because they are read off the same scale.
 */
export const TOKEN_STEPS: readonly number[] = [1024, 4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576]
/** The context window's own picks: the sizes vendors publish, on that same binary scale. */
export const CONTEXT_WINDOW_STEPS: readonly number[] = [131_072, 204_800, 262_144, 409_600, 524_288, 1_048_576]

export function formatTokenStep(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`
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
  /**
   * What this model's answer may spend.
   *
   * This model's own number is the one that is sent; the account's ceiling answers only for a model the
   * reader has not set. Null is that "not set" — it is not a second way of writing 1024, and the two
   * used to be taken as a minimum of one another, so a model set to 64K still answered with 1024.
   */
  maxOutputTokens: number | null
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
  /**
   * What a million tokens of this model costs, as the provider publishes it.
   *
   * Null is "not priced" rather than free — a local model and an unpriced one look the same in a total,
   * and the statistics say which models they could not price instead of counting them as zero. Prices
   * are per million of the side they name, which is the unit every provider quotes in.
   */
  inputPrice: number | null
  outputPrice: number | null
  /** The currency those two numbers are in, free text: `USD`, `CNY`, whatever the bill is in. */
  priceCurrency: string
}

/**
 * How much thinking a model is asked for.
 *
 * The scale runs from `off` to `max` and is the app's own, because the services do not agree on one: Claude
 * publishes five rungs of effort, a 3.x Gemini three levels, DeepSeek four, and Qwen only a switch. A model
 * is therefore offered the rungs its own service has (`reasoningRungs` in `reasoning.ts`) rather than all of
 * these, and `auto` — leaving the decision to the model — is the one value every service shares.
 */
export type AssistantReasoning = 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const ASSISTANT_REASONING_LEVELS: readonly AssistantReasoning[] = [
  'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

/** Token budgets a rung means for the protocols that take a number rather than a name. */
export const REASONING_BUDGET_TOKENS: Record<Exclude<AssistantReasoning, 'auto' | 'off'>, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 10_240,
  xhigh: 32_768,
  max: 65_536,
}

/** The context budgets the composer's slider snaps to, in tokens. */
/**
 * The largest number any of the three token fields will store — the context window, the input ceiling and
 * the output ceiling alike. A ceiling on the number, not a menu: it is past every window a vendor
 * publishes, so it is what "no smaller ceiling than that" is written as.
 */
export const MAX_TOKEN_CEILING = 4_000_000

export const CONTEXT_TOKEN_STEPS: readonly number[] = [4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144]

/**
 * The history budget one turn is fed.
 *
 * Both ceilings in it behave the same way: the model's own number when it has one, the assistant's when it
 * does not. The smaller of the two wins, because one is the window the model publishes and the other is
 * what the reader says may be sent to it — reading the second as "no ceiling" for a model that left it
 * unset made the account's setting unreachable for every one of them.
 */
export function contextBudgetFor(
  model: Pick<AssistantModel, 'contextTokens' | 'maxInputTokens'>,
  limits: AssistantLimits,
): number {
  return Math.min(model.contextTokens ?? limits.maxContextTokens, model.maxInputTokens ?? limits.maxInputTokens)
}

export function reasoningValue(value: unknown): AssistantReasoning {
  return typeof value === 'string' && (ASSISTANT_REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as AssistantReasoning)
    : 'auto'
}

export interface AssistantLimits {
  maxOutputTokens: number
  maxContextTokens: number
  /** The ceiling behind a model whose own input ceiling is unset, the way the two above are. */
  maxInputTokens: number
  maxToolCalls: number
  maxAgentSteps: number
  maxRequestsPerDay: number
  maxScheduledRunsPerDay: number
  maxEmbeddingsPerDay: number
}

export const LIMIT_RANGES = {
  // The same scale the per-model fields use, so a ceiling set here can be inherited by a model without
  // one — a range that stopped at 8192 could not answer for a model the reader had set to 64K.
  maxOutputTokens: [64, MAX_TOKEN_CEILING],
  maxContextTokens: [1000, MAX_TOKEN_CEILING],
  maxInputTokens: [1, MAX_TOKEN_CEILING],
  maxToolCalls: [0, 20],
  maxAgentSteps: [1, 10],
  maxRequestsPerDay: [1, 2000],
  maxScheduledRunsPerDay: [0, 48],
  maxEmbeddingsPerDay: [0, 2000],
} as const satisfies Record<keyof AssistantLimits, readonly [number, number]>

export const DEFAULT_LIMITS: AssistantLimits = {
  // An answer worth reading is longer than a thousand tokens, which is roughly a page of Chinese; a turn
  // that hits this is reported as cut off with the number, so the ceiling is a real one either way.
  maxOutputTokens: 8192,
  maxContextTokens: 6000,
  // The widest ceiling there is, because this one answers for every model that has not set its own: it is
  // the number, not a limit on it, and anything smaller here would silently cap those models.
  maxInputTokens: MAX_TOKEN_CEILING,
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
  /**
   * What applying the prompt arranges for the turn, in the same shapes the composer's own `/` and `#`
   * picks use. A prompt that only carries words has three empty bindings, which is how every prompt
   * written before these columns existed still reads.
   */
  tools: string[]
  scopes: AssistantTurnScope[]
  /** Whichever model should answer; null leaves the reader's current pick alone. */
  modelId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * What the reader writes into a prompt, as opposed to what comes back.
 *
 * Every field is optional because both halves of an edit arrive from the same form and the server keeps
 * whatever the request did not name; the timestamps and id are the server's to assign.
 */
export interface ChatPromptInput {
  title?: string
  content?: string
  group?: string
  tools?: string[]
  scopes?: AssistantTurnScope[]
  modelId?: string | null
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
  /** The project this conversation belongs to, whose instructions and knowledge it inherits. */
  projectId?: string | null
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

/** A project, with how many conversations answer under its brief. */
export interface ChatProjectNode {
  id: string
  name: string
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
  /**
   * What the model asked the tool for, as JSON — and what came back.
   *
   * Both are the same text the tool itself worked from and the model was handed, kept so the thread can
   * show a reader *why* a call happened when they open it: a chip that says "searched notes" is not
   * answerable to anything, while the query that was searched is. Capped by `MAX_TOOL_PAYLOAD_CHARS` at
   * both ends, because a listing tool can return a whole note and a message row is not a file store.
   */
  args?: string
  result?: string
}

/**
 * How much of a tool's arguments or answer one activity may carry.
 *
 * A payload past this is truncated with a marker rather than dropped: the reader sees that the call did
 * happen and roughly what it cost, and the message row keeps a bound the thread can render without one
 * answer making the conversation slow to open.
 */
export const MAX_TOOL_PAYLOAD_CHARS = 4_000

/**
 * How much of a model's own thinking one answer keeps.
 *
 * A thinking model can spend tens of thousands of characters before it says anything, and a message row is
 * not a transcript of the process: the cap keeps a thread openable while the part that reads as reasoning —
 * the beginning of the trace — is still there. Higher than a tool payload, because a tool's answer is one
 * value and a trace is a whole argument the reader may want to follow.
 */
export const MAX_REASONING_CHARS = 12_000

function clipped(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… [${value.length - maxChars} more characters]`
}

export function clipToolPayload(value: string): string {
  return clipped(value, MAX_TOOL_PAYLOAD_CHARS)
}

/** The same bound, applied to the reasoning a turn stored with its answer. */
export function clipReasoning(value: string): string {
  return clipped(value, MAX_REASONING_CHARS)
}

/**
 * A tool's own value, as the thread shows it.
 *
 * A remote tool answers with text and a note reader answers with a structure, so the two are kept in the
 * shape that reads: text stays text, anything else is indented JSON. A value that cannot be serialized is
 * named rather than dropped, because a call that happened must not look like one that did not.
 */
export function toolPayloadText(value: unknown): string {
  if (typeof value === 'string') return clipToolPayload(value)
  try {
    return clipToolPayload(JSON.stringify(value ?? null, null, 2))
  } catch {
    return '[the value could not be shown as text]'
  }
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

/**
 * The transports this client can speak, and what each one needs before it works.
 *
 * The protocol names three. `streamableHttp` is one address that takes `POST`s, which is what a server
 * built this year speaks. `sse` is the older shape: a `GET` that stays open, an `endpoint` event naming
 * where to post, and every answer — the handshake's as much as a tool call's — arriving back on that same
 * stream. `stdio` cannot be here: it starts a child process, and a worker has none. A server that is only
 * a local command is used through a tunnel that fronts it with one of the two HTTP transports.
 *
 * Both of these require https, so a local server on plain http over a tunnel has to have https in front
 * of it first; that is the transport's own rule, not a setting.
 */
export const ASSISTANT_MCP_TRANSPORTS = ['streamableHttp', 'sse'] as const
export type AssistantMcpTransport = (typeof ASSISTANT_MCP_TRANSPORTS)[number]

/**
 * What the reader knows about one server's login without the worker opening the vault.
 *
 * Nothing here is a credential. The token itself stays ciphertext at rest and never crosses this boundary,
 * because the screen that shows it is the one a screenshot goes from — and a reader does not need to see
 * their own bearer token to notice that a server is authorized until Friday.
 */
export interface AssistantMcpAuthorization {
  /** The identity provider this server sends its readers to, once discovered. */
  issuer: string
  /** The scopes the resource asked for. Empty means the server asked for none, not that none were given. */
  scopes: string[]
  /** True when there is a token to send — which is not the same as it still working. */
  authorized: boolean
  /** When the stored token stops working, or 0 when the issuer never said. */
  expiresAt: number
}

export interface AssistantMcpServer {
  id: string
  label: string
  url: string
  /** Free text the reader types about the third party; shown on its card. */
  description: string
  transport: AssistantMcpTransport
  /** How long one listing or call may take. A slow third party is the reader's call, within bounds. */
  timeoutSeconds: number
  enabled: boolean
  toolMode: AssistantMcpToolMode
  /**
   * The server's own names for the tools the reader has switched off.
   *
   * Kept as a list of switched-off names rather than of switched-on ones because a tool the server adds
   * later must arrive usable: a server whose whole point is `search` should not have every new function
   * hidden behind a settings visit, and a name here that the server no longer offers simply stops
   * matching anything.
   */
  disabledTools: string[]
  /** Whether any request header is stored. The values themselves never leave the worker. */
  hasKey: boolean
  /** The OAuth arrangement, once the reader started one. Null means this server has never been asked. */
  authorization: AssistantMcpAuthorization | null
  createdAt: number
  updatedAt: number
}

/** Bounds on what one server's own settings may be, checked in the route and mirrored by the form. */
export const MAX_MCP_DESCRIPTION_CHARS = 240
export const MAX_MCP_HEADERS = 8
export const MAX_MCP_HEADER_NAME_CHARS = 64
export const MAX_MCP_HEADER_VALUE_CHARS = 1024
export const MIN_MCP_TIMEOUT_SECONDS = 5
export const MAX_MCP_TIMEOUT_SECONDS = 120
export const DEFAULT_MCP_TIMEOUT_SECONDS = 30

/** The characters a header name may use, which is the wire's own token set rather than a guess. */
const MCP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function isMcpHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_MCP_HEADER_NAME_CHARS && MCP_HEADER_NAME_RE.test(name)
}

/**
 * The headers box, read line by line.
 *
 * Every client's own config spells these differently — a JSON blob uses `Name: value`, a form uses
 * `Name=value` — and the box is where a reader pastes one, so both are accepted rather than making them
 * translate. A bad name is reported instead of dropped: a header silently missing is a 401 the reader
 * cannot explain.
 */
export function parseMcpHeaderLines(text: string): { headers: Record<string, string>, problems: string[] } {
  const headers: Record<string, string> = {}
  const problems: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const at = line.search(/[:=]/)
    const name = (at < 0 ? line : line.slice(0, at)).trim()
    const value = at < 0 ? '' : line.slice(at + 1).trim()
    if (!isMcpHeaderName(name)) {
      problems.push(name || line)
      continue
    }
    headers[name] = value.slice(0, MAX_MCP_HEADER_VALUE_CHARS)
  }
  return { headers, problems }
}

/** Why one entry of a pasted config file cannot be used, in codes the client turns into its own words. */
export type McpImportSkip = 'command' | 'no_url' | 'not_http' | 'transport'

export interface McpImportResult {
  servers: { name: string, url: string, transport: AssistantMcpTransport, headers?: Record<string, string> }[]
  skipped: { name: string, reason: McpImportSkip }[]
}

/**
 * A pasted `mcpServers` block, as every MCP client's README spells it.
 *
 * The shape is the reference clients' own, so a reader can copy a snippet from a server's page and paste
 * it here untouched. What this app cannot run is reported as a skipped entry rather than failing the
 * paste: one `stdio` server in a list of five must not hide the four that work.
 */
export function parseMcpServerJson(text: string): McpImportResult {
  const servers: McpImportResult['servers'] = []
  const skipped: McpImportResult['skipped'] = []
  const parsed = JSON.parse(text) as unknown
  const block = (parsed ?? {}) as { mcpServers?: unknown }
  const entries = block.mcpServers && typeof block.mcpServers === 'object' && !Array.isArray(block.mcpServers)
    ? Object.entries(block.mcpServers as Record<string, unknown>)
    : null
  if (entries === null) throw new Error('no mcpServers block')
  for (const [name, value] of entries) {
    const entry = (value ?? {}) as { type?: unknown, url?: unknown, headers?: unknown, command?: unknown }
    if (typeof entry.command === 'string') {
      skipped.push({ name, reason: 'command' })
      continue
    }
    // The two spellings every client's config uses for the two address shapes, and an entry that names
    // neither is read as the current one, which is what a bare `url` has always meant.
    const type = typeof entry.type === 'string' ? entry.type.trim() : ''
    const transport: AssistantMcpTransport | null = type === '' || type === 'streamableHttp' || type === 'http'
      ? 'streamableHttp'
      : type === 'sse'
        ? 'sse'
        : null
    if (transport === null) {
      skipped.push({ name, reason: 'transport' })
      continue
    }
    if (typeof entry.url !== 'string' || !entry.url.trim()) {
      skipped.push({ name, reason: 'no_url' })
      continue
    }
    if (!entry.url.trim().startsWith('https://')) {
      skipped.push({ name, reason: 'not_http' })
      continue
    }
    const headers: Record<string, string> = {}
    if (entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)) {
      for (const [headerName, headerValue] of Object.entries(entry.headers as Record<string, unknown>)) {
        if (isMcpHeaderName(headerName) && typeof headerValue === 'string') {
          headers[headerName] = headerValue.slice(0, MAX_MCP_HEADER_VALUE_CHARS)
        }
      }
    }
    servers.push({
      name: name.slice(0, MAX_MCP_LABEL_CHARS),
      url: entry.url.trim().slice(0, MAX_MCP_URL_CHARS),
      transport,
      ...(Object.keys(headers).length ? { headers } : {}),
    })
  }
  return { servers, skipped }
}

export const MAX_MCP_SERVERS = 8
export const MAX_MCP_TOOLS_PER_SERVER = 24
/** A disabled-tool list is a reader's own choices, bounded the way the listing itself is. */
export const MAX_MCP_DISABLED_TOOLS = 200
/** A tool name the upstreams accept: `^[a-zA-Z0-9_-]{1,64}$` after namespacing. */
export const MAX_MCP_TOOL_NAME_CHARS = 64
export const MAX_MCP_LABEL_CHARS = 60
export const MAX_MCP_URL_CHARS = 2048

/**
 * The name one remote tool is offered under.
 *
 * Both sides need the same answer: the worker builds it to offer the tool and to resolve a call back to its
 * server, and the transcript reads it back the other way to say which third party a past call went to. A
 * second copy of this spelling on the client would drift from the one the model was given.
 */
export function mcpToolName(serverId: string, remoteName: string): string {
  const owner = serverId.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()
  const clean = remoteName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_MCP_TOOL_NAME_CHARS - 8)
  return `mcp_${owner}_${clean}`.slice(0, MAX_MCP_TOOL_NAME_CHARS)
}

/**
 * Which configured server a namespaced name came from, and the tool's own name back out of it.
 *
 * Only the six-character owner survives the round trip, so the remote name read back is the sanitized one
 * the wire carries — good enough to name a card, and never what a call is built from: the worker resolves
 * the real name by listing the server it matched.
 */
export function mcpToolOrigin(name: string, servers: readonly { id: string, label: string }[]): { serverId: string, serverLabel: string, remoteName: string } | null {
  for (const server of servers) {
    const prefix = mcpToolName(server.id, '')
    if (!name.startsWith(prefix)) continue
    return { serverId: server.id, serverLabel: server.label, remoteName: name.slice(prefix.length) }
  }
  return null
}

/** What one external tool looks like after listing, in the shape the composer and executor both need. */
export interface AssistantMcpTool {
  /** The namespaced name the model is offered. */
  name: string
  /** The server's own name for it, which is what `tools/call` must carry. */
  remoteName: string
  serverId: string
  serverLabel: string
  description: string
  /** Whether the reader switched this one off. Only the settings listing fills it in. */
  disabled?: boolean
}

/**
 * One server's listing as the settings screen draws it.
 *
 * Cheaper than a tool definition: nothing here can be called, so the screen can ask every server —
 * including the ones switched off at the server level — what it offers without opening a session per
 * turn. `serverId` is what groups them back under their card.
 */
/**
 * One server as its own editor opens it.
 *
 * The header names are here and the values are not: the form has to show what is already configured — a
 * blank box reads as "nothing is set", and a box that came back filled would put a token in a browser.
 * They are fetched per server rather than listed, because reading them means decrypting the row.
 */
export interface AssistantMcpServerDetail {
  server: AssistantMcpServer
  headerNames: string[]
}

export interface AssistantMcpCatalogEntry {
  serverId: string
  serverLabel: string
  tools: { remoteName: string, name: string, description: string, disabled: boolean }[]
  /** Why this server answered nothing, in the reader's own language where the client can say it. */
  error?: string
}

/**
 * One third party that would not answer, with the part the screen can act on.
 *
 * `needsAuthorization` travels as a flag rather than being read back out of `error`, because `error` is a
 * sentence — it is shown to a reader in their own language, and re-parsed by anybody who wanted a button out
 * of it would find one only in the language the worker happened to write it in.
 */
export interface AssistantMcpProblem {
  serverId: string
  label: string
  error: string
  /** True when the refusal was for want of a login, which is the one refusal this app can fix from here. */
  needsAuthorization: boolean
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
  { name: 'list_notes', labelKey: 'assistant.tool.list_notes', permission: 'read' },
  { name: 'count_notes', labelKey: 'assistant.tool.count_notes', permission: 'read' },
  { name: 'list_folders', labelKey: 'assistant.tool.list_folders', permission: 'read' },
  { name: 'list_tags', labelKey: 'assistant.tool.list_tags', permission: 'read' },
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

/** A page the model actually consulted, as the vendor reported it. */
export interface AssistantSource {
  url: string
  title: string
  /** The passage the model leaned on, when the vendor said which one. */
  cited?: string
}

/**
 * Whether a reported source is a link a reader can follow.
 *
 * The one check every reader of a vendor's citations makes in common: a chip that leads nowhere reads as
 * a broken app, and a vendor's payload is not a place to trust a string because it arrived in a url field.
 */
export function isSourceUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value)
}

/** One model's share of a window, with what it cost when the reader has priced it. */
export interface AssistantModelUsage {
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  errors: number
  /** Empty when the model is unpriced, which `cost: null` then says out loud. */
  currency: string
  cost: number | null
}

export interface AssistantConversationUsage {
  id: string
  title: string
  requests: number
  inputTokens: number
  outputTokens: number
  updatedAt: number
}

/**
 * What the usage screen is drawn from.
 *
 * One window, its days, its models and its most expensive conversations, so the three panels on that
 * screen cannot disagree about which range they are describing: they are all read from one answer.
 */
export interface AssistantStats {
  range: '7' | '30' | 'all'
  from: string
  to: string
  total: AssistantUsage
  days: Array<{ day: string } & AssistantUsage>
  models: AssistantModelUsage[]
  conversations: AssistantConversationUsage[]
  /** One entry per currency the reader's prices are in, never summed across them. */
  spend: Array<{ currency: string, amount: number }>
  /** How many of the models used in this window have no price, so a total can say what it left out. */
  unpricedModels: number
  generatedAt: number
  limits: AssistantLimits
}

/** The link a published conversation is read at, in the shape every share in this app uses. */
export interface ConversationShareInfo {
  slug: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

/**
 * A published conversation as a stranger reads it.
 *
 * Every field here is one somebody looking over the reader's shoulder would have seen: who spoke, what
 * they said, when, which model answered, and the pages a search consulted. Reasoning, tool rows and
 * attachments are deliberately absent — they quote the reader's own notes and files — and the worker
 * builds this shape instead of stripping a row, so nothing new can leak into it by being added to a
 * message later.
 */
export interface PublicConversation {
  title: string
  createdAt: number
  updatedAt: number
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    createdAt: number
    modelLabel: string
    sources?: AssistantSource[]
  }>
  author: { name: string, avatarUrl: string }
  site: { name: string }
  share: { slug: string }
}

export const ASSISTANT_TOOL_BY_NAME: ReadonlyMap<string, AssistantToolSpec> = new Map(
  ASSISTANT_TOOL_SPECS.map((spec) => [spec.name, spec]),
)

/** A verdict a reader can leave on one answer. */
export const MESSAGE_FEEDBACK = ['up', 'down'] as const
export type MessageFeedback = (typeof MESSAGE_FEEDBACK)[number]

export interface AssistantMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  /**
   * What the model thought before it answered, when it reported any.
   *
   * Stored with the answer rather than kept only for the live turn, because the fold that shows it is part
   * of the reply: reopening the thread tomorrow has to show the same trace it showed while it streamed.
   * Capped by `MAX_REASONING_CHARS` when the row is written, and empty for a model that says nothing.
   */
  reasoning?: string
  tools: ToolActivity[]
  /**
   * The pages a web search consulted, quoted from the vendor's own report.
   *
   * Kept with the answer because a claim that came from somewhere outside the vault has to say where:
   * the reader is deciding whether to believe a sentence, and "I searched the web" is not a source.
   * Empty for every turn that did not search.
   */
  sources?: AssistantSource[]
  /** The project this turn was answered under, so the thread can say where its brief came from. */
  projectId?: string | null
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
  /**
   * The reader's verdict on this answer, when they gave one.
   *
   * Stored beside the message rather than in a table of its own: a turn has at most one verdict, and the
   * thing that reads it is the transcript. The value is what the column holds, so a backup and a restore
   * agree about what a downvote was.
   */
  feedback?: MessageFeedback
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
  /** The trace that answer came with. A version read back has to show the thinking it was written by. */
  reasoning: string
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
  /**
   * What every conversation inside this project is answered under.
   *
   * It rides in the system prompt beside the reader's own instructions, so it is a standing brief rather
   * than a per-turn one — the reason a project exists at all, as opposed to a folder that only files.
   */
  instructions: string
  /**
   * The folders this project reads its knowledge from, as folder ids.
   *
   * Empty is "the account's own scope answers", not "nothing": a project that names no folders has not
   * said anything, and saying nothing cannot narrow what the reader already allowed.
   */
  noteScope: string[]
  /** The model this project prefers, when the reader has said so. */
  modelId: string | null
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
