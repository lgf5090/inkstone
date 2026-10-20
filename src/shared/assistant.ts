/**
 * The chat assistant's data model, its settings shape, and the rules that need no database.
 *
 * Validation here is hand-written rather than schema-generated on purpose: every value that arrives
 * from a client, a backup file or a stored row goes through `normalize*` before it is trusted, and the
 * helpers clamp, enumerate and drop rather than throw, so one bad field cannot turn a saved setting
 * into a 500. This mirrors how `mergeSettings` treats the rest of the app's settings.
 */

import { assertRelayableEndpoint } from './ai-proxy-guard'
import { isValidTimeZone, parseScheduleSpec, type ScheduleSpec } from './assistant-schedule'
import { DEFAULT_WEB_SEARCH_ENGINE_ID, webSearchEngineFor, webSearchEngineValue } from './web-search-engines'
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

export const AUTOMATION_KINDS = ['reminder', 'task_digest', 'assistant_prompt', 'note_write'] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]

export const AUTOMATION_STATUSES = ['scheduled', 'running', 'paused', 'completed', 'failed'] as const
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number]

export const PENDING_ACTION_STATUSES = ['pending', 'approved', 'cancelled', 'expired', 'failed'] as const
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number]

export const MEMORY_REVIEW_ACTIONS = ['keep_both', 'mark_historical', 'replace', 'discard'] as const
export type MemoryReviewAction = (typeof MEMORY_REVIEW_ACTIONS)[number]

export const MAX_MESSAGE_CHARS = 16_000
/**
 * How much of an unfinished answer the run lease is allowed to carry.
 *
 * The lease row in `chat_active_runs` is a lock, and `partial_text` rides on it only so that a turn killed
 * mid-flight — a Worker isolate out of CPU leaves no `chat_messages` row at all — has somewhere its already
 * written words can be read back from. That makes the row a copy of model output, and a lock table is the
 * wrong place to store a body of text: an unbounded column here would turn every abandoned turn into a
 * permanent duplicate of an answer the reader may never come back for.
 *
 * So the fragment is cut to this, which is deliberately well under what an answer can be: enough to read
 * the direction an answer was going in and to pick it up again, too little for the row to be mistaken for
 * the transcript. The cut has to be visible from outside, which is why a value at the ceiling is reported
 * as truncated rather than as the whole thing.
 */
export const RUN_PARTIAL_MAX_CHARS = 4_000
export const MAX_MEMORY_CHARS = 2_000
export const MAX_TASK_TITLE_CHARS = 300
export const MAX_TASK_NOTES_CHARS = 10_000
export const MAX_AUTOMATION_MESSAGE_CHARS = 4_000
/**
 * How long an id field of a schedule may be.
 *
 * A note or folder id is 26 characters, and the only real use of a bound here is to stop a body carrying
 * a paragraph where an id belongs: the value is never shape-checked, because the ownership read the create
 * performs is what rejects one that is not the reader's, whatever it looks like.
 */
export const MAX_AUTOMATION_TARGET_ID_CHARS = 64
export const MAX_CONVERSATION_TITLE_CHARS = 200
/** How much standing instruction the prompt will carry: enough for a page, short enough to stay a rule. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 2_000
/** How many follow-up questions the model may volunteer under a finished answer. A shorter list is honest; padding one is not. */
export const MAX_TITLE_SUGGESTIONS = 3
/** The widest a single follow-up chip may run before the server trims it, so one long sentence cannot crowd the footline. */
export const MAX_TITLE_SUGGESTION_CHARS = 200

/**
 * The largest backup the import route will read, and the size the export warns about.
 *
 * One number for both halves: a backup that can be written but not read back is not a backup, so the
 * reader is told when the file they just downloaded is past the ceiling instead of finding out on the
 * day they need it.
 */
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024

/**
 * How long a temporary conversation is kept before the sweep deletes it.
 *
 * Counted from its last change rather than its creation, so a thread the reader came back to is not
 * deleted mid-use. The number is in the interface — "kept 30 days" is a promise a reader can hold this
 * app to, and one they can check against the row's own timestamp.
 */
export const EPHEMERAL_CONVERSATION_RETENTION_DAYS = 30

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

/**
 * One extra key a provider rotates through, as the settings screen reads it back.
 *
 * The plaintext never leaves the worker: this carries the same last-four hint the provider's own key
 * does, plus what the rotation has learned about it — when it last answered and what it last said when
 * it did not.
 */
export interface AssistantProviderKey {
  id: string
  providerId: string
  label: string
  hasKey: boolean
  keyHint: string
  enabled: boolean
  lastUsedAt: number | null
  errorCount: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/**
 * One hosted web-search engine's key, as a listing is allowed to describe it.
 *
 * There is no key field and no ciphertext field here, and that is the whole design: the only thing a screen
 * may show about a stored credential is that one exists and what its last four characters are. The secret
 * itself is read by one server-side call that signs one outbound search.
 */
export interface AssistantSearchKey {
  engine: string
  hasKey: boolean
  keyHint: string
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

/**
 * One row of a vendor's own listing: what this key can call, named the way the vendor names it.
 *
 * The two token numbers are what that row said about the model, and they are absent — not zero — for the
 * services whose `/v1/models` answers with ids alone, which is OpenAI's own, Anthropic's and DeepSeek's.
 * Reading a missing one as a guess is how a provider ceiling that never existed would start shortening
 * somebody's answers.
 */
export interface AssistantVendorModel {
  id: string
  label: string
  ownedBy: string | null
  created: number | null
  contextTokens?: number | null
  maxOutputTokens?: number | null
}

/** What a model is asked to do, so the picker only offers the ones that answer. */
export const ASSISTANT_MODEL_PURPOSES = ['chat', 'image_generate', 'image_edit', 'realtime'] as const
export type AssistantModelPurpose = (typeof ASSISTANT_MODEL_PURPOSES)[number]

/**
 * How a browser reaches a realtime voice session.
 *
 * OpenAI hands the browser a short-lived secret and the audio goes to the vendor directly. ModelBest
 * authenticates the browser socket with the long-lived key itself, so that provider is reached through
 * this deployment's relay and the browser is handed a same-origin path instead of a credential.
 */
export type AssistantRealtimeSession =
  | {
    transport: 'calls' | 'legacy'
    clientSecret: string
    model: string
    baseUrl: string
    expiresAt: number | null
  }
  | {
    transport: 'modelbest'
    model: string
    relayPath: string
    expiresAt: null
  }

/** The kind of endpoint behind the id: only `text` models can hold a conversation. */
export const ASSISTANT_MODEL_KINDS = ['text', 'image', 'embedding', 'rerank'] as const
export type AssistantModelKind = (typeof ASSISTANT_MODEL_KINDS)[number]

/**
 * What the reader says the model can be *given*.
 *
 * `image` is deliberately absent: the older `vision` switch already owns that fact, the runner and its
 * tests read it, and a second column saying the same thing is a future disagreement.
 *
 * `video` was here and is gone. A tick is a promise this app has to keep, and nothing kept it: no request
 * builder in `worker/assistant/upstream.ts` has a field for a clip on any of the three protocols, and no
 * local decoder exists that could turn one into words. So a marked model was handed the clip's *name*, the
 * composer said the file could not be read, and the two disagreed about what the tick meant. A switch with
 * nobody to honour it is worse than no switch, and the stored values of the models that had it ticked are
 * dropped by `parseModelModalities` on the way out rather than migrated.
 *
 * `audio` stays because it is now kept: the OpenAI-compatible branch puts `input_audio` in the same part
 * list that already carries a picture, for the two containers a provider decodes. Read
 * `protocolCarriesAudio` with that sentence — the tick means *this model, on this wire*, and the composer
 * refuses the other two wires before the reader pays for them.
 */
export const ASSISTANT_MODEL_MODALITIES = ['audio'] as const
export type AssistantModelModality = (typeof ASSISTANT_MODEL_MODALITIES)[number]

/**
 * What a file asks for that a turn cannot otherwise answer: the two kinds of bytes a reader can hand the
 * composer that are neither decoded as text nor shown as a picture.
 *
 * Wider than `AssistantModelModality` by exactly `video`, the one thing no protocol in this app can be
 * given. Every refusal the composer and the transcript print is judged against this list, so a clip can
 * still be explained even while no switch claims to accept one.
 */
export const ATTACHMENT_SENSES = ['audio', 'video'] as const
export type AttachmentSense = (typeof ATTACHMENT_SENSES)[number]

export function parseModelModalities(value: unknown): AssistantModelModality[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is AssistantModelModality =>
    ASSISTANT_MODEL_MODALITIES.includes(entry as AssistantModelModality)))]
}

/**
 * Quick picks, so the reader is not typing 1048576 into a number field to get 1M.
 *
 * One ladder for every field that holds a token count — an output ceiling, an input ceiling, the context
 * window a model publishes, and the context one turn is fed. They are the same setting as far as the reader
 * is concerned and are read off the same scale, so two screens offering two sets of picks that barely
 * overlap made one number look like two different choices: 32K was pickable in the composer and unreachable
 * in the model editor, while 400K was the other way round.
 *
 * Every step counts in the unit a token is counted in: 1K is 1024, and the label under the button is the
 * same division, so the number the button saves is the number it says. A round thousand would print
 * 32_768 as 33K and read like a different setting than the one it is. The rungs above 128K are the windows
 * vendors actually publish — 192K, the 200K class, 400K, 512K and 1M — written the same way.
 */
export const TOKEN_STEPS: readonly number[] = [
  1024, 4096, 8192, 16_384, 32_768, 65_536, 131_072, 196_608, 204_800, 262_144, 409_600, 524_288, 1_048_576,
]

/**
 * One token count as the reader reads it: `256K` for a number on the ladder, `~6K` for one that is not.
 *
 * A value off the ladder is either a default the reader never chose — `DEFAULT_LIMITS.maxContextTokens` is
 * 6000 — or a number they typed, and the screen still has to say something about it. Printing the raw digits
 * of a four-million ceiling is a wall of text with no unit, so an off-ladder count gets the rounded label
 * with a `~` that admits it is approximate. Exact ladder values keep the bare label they always had.
 */
export function formatTokenStep(tokens: number): string {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`
  // Under a K the number is already the shortest honest answer: 512 reads better as 512 than as ~1K.
  if (tokens >= 1_048_576) return `~${Math.round(tokens / 1_048_576)}M`
  if (tokens >= 1024) return `~${Math.round(tokens / 1024)}K`
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

/**
 * One window of a model's time-of-day pricing.
 *
 * A provider that charges by the clock publishes windows instead of one rate: DeepSeek's peak hours are
 * a different price from the rest of the day. A window overrides the model's base price for the tokens
 * recorded while it is in force; a null side inherits that side's base price, which is what lets a peak
 * window change only its output rate.
 *
 * `start` and `end` are local wall-clock times in the assistant's timezone. `end < start` is one window
 * that crosses midnight, and its weekdays belong to the day it starts on. Empty `days` means every day.
 */
export interface AssistantPricePeriod {
  id: string
  label: string
  /** ISO weekdays, 1 = Monday … 7 = Sunday. Empty means every day. */
  days: number[]
  /** `HH:MM`, local to the assistant's timezone. */
  start: string
  /** `HH:MM`, local to the assistant's timezone; earlier than `start` crosses midnight. */
  end: string
  inputPrice: number | null
  outputPrice: number | null
}

/** How many windows one model may carry; a pricing page with more than this is a table, not a model. */
export const MAX_PRICE_PERIODS = 12

/** The long edge of a period's name in the editor. */
export const MAX_PRICE_PERIOD_LABEL_CHARS = 40

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
  /**
   * What the vendor's own listing said about this model, learned when the row was created.
   *
   * Kept apart from the two fields above because the two nulls mean opposite things: for `contextTokens`
   * and `maxOutputTokens` null is the reader's "inherit the account's ceiling", while here it is "nobody
   * has said". Neither column overwrites a reader's own value — detection is what the editor's ladder is
   * cut by and what its warning names, not a setting the request reads.
   */
  vendorContextTokens?: number | null
  vendorMaxOutputTokens?: number | null
  /** Whether the model may be shown a picture. On by default; a text-only upstream is turned off here. */
  vision: boolean
  /** Only a `chat` model answers the composer; the rest are listed for their own callers. */
  purpose: AssistantModelPurpose
  kind: AssistantModelKind
  /** False stops the tool schemas going out at all, which is what a model that hallucinates calls needs. */
  supportsTools: boolean
  /**
   * The account's standing refusal to let this model call anything.
   *
   * `supportsTools` says what the vendor claims the model can do; this says what the reader will have it
   * do, and the two are asked together — a model capable of writing a note is still refused when this is
   * on. The row always answers with a boolean; absent reads as off, which is every model written before
   * the switch existed and every one the editor has never touched.
   */
  noTools?: boolean
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
   * The model to try when this one cannot answer at all.
   *
   * Null is "no spare", which is what most models are. Only a failure that says something about this
   * model's own door is followed — a retired model, a provider that is down, a key out of quota — because
   * a request the provider refused on its own terms would be refused by the next model too.
   */
  fallbackModelId: string | null
  /**
   * What a million tokens of this model costs, as the provider publishes it.
   *
   * Null is "not priced" rather than free — a local model and an unpriced one look the same in a total,
   * and the statistics say which models they could not price instead of counting them as zero. Prices
   * are per million of the side they name, which is the unit every provider quotes in. These are the
   * base rates: a window in `pricePeriods` stamps the tokens it was in force for and overrides them.
   */
  inputPrice: number | null
  outputPrice: number | null
  /** The currency those two numbers are in, free text: `USD`, `CNY`, whatever the bill is in. */
  priceCurrency: string
  /**
   * Time-of-day rates. Empty means the base prices above are the whole story.
   *
   * The usage record files a turn's tokens under the window that was in force when it was written, and
   * the statistics price each bucket at that window's rate. A window whose price is null inherits the
   * matching base rate, so a provider that only changes its output rate needs one number.
   */
  pricePeriods: AssistantPricePeriod[]
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

/**
 * The largest number any of the three token fields will store — the context window, the input ceiling and
 * the output ceiling alike. A ceiling on the number, not a menu: it is past every window a vendor
 * publishes, so it is what "no smaller ceiling than that" is written as.
 */
export const MAX_TOKEN_CEILING = 4_000_000

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

/** The two numbers a model is known to be held to, or null for a bound nobody has stated. */
export interface EffectiveModelLimits {
  contextWindow: number | null
  maxOutput: number | null
}

/**
 * The tightest bound every source that speaks puts on one model.
 *
 * Two sources say anything about a model's size: the reader, who fills in the editor's fields, and the
 * vendor, whose number was learned when the row was created. The account's ceilings are deliberately not
 * candidates. `maxContextTokens` is a budget for what to send rather than a claim about any model's
 * window, and `maxOutputTokens` only answers while a model leaves its own field empty — a reader who then
 * raises that field is raising it above the account number on purpose, so neither may cut a ladder or
 * warn about a value. `null` is the honest third answer: a bound nobody knows must not be invented, and
 * the caller has to be able to tell "no ceiling" from "a small one".
 */
export function effectiveModelLimits(
  model: Pick<AssistantModel, 'contextTokens' | 'vendorContextTokens' | 'vendorMaxOutputTokens'>,
): EffectiveModelLimits {
  const contextWindow = tightestBound([model.contextTokens, model.vendorContextTokens])
  // A reply cannot be longer than the window it is written inside, so the window bounds the output too;
  // the reader's own output number is not a bound on itself, because changing it is what the field is for.
  return { contextWindow, maxOutput: tightestBound([model.vendorMaxOutputTokens, contextWindow]) }
}

/** The smallest of the numbers a source actually gave, and null when none of them did. */
function tightestBound(candidates: readonly (number | null | undefined)[]): number | null {
  const known = candidates.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
  return known.length ? Math.min(...known) : null
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

/**
 * What the reader allows a tool to do: never offered to the model, offered but held for an approval
 * press, or run on the model's own say-so.
 *
 * One vocabulary for the assistant's own tools and for the servers it calls out to, because a reader who
 * has learned what "ask" means in one place should not have to learn a second meaning in the other.
 */
export const ASSISTANT_TOOL_MODES = ['off', 'ask', 'auto'] as const
export type AssistantToolMode = (typeof ASSISTANT_TOOL_MODES)[number]

/**
 * What the assistant may do unattended, one answer per kind of tool.
 *
 * The kind is what the reader is really deciding about, not the individual tool: "ask before writing to
 * my notes" and "never delete anything" are policies about classes of action, and a reader who wanted to
 * enumerate thirty-five tools by hand would be doing the registry's job for it. The defaults are what
 * this app has always done — reads and writes run, deletions wait for a press.
 */
export type AssistantToolModes = Record<ToolPermission, AssistantToolMode>

export const DEFAULT_TOOL_MODES: AssistantToolModes = { read: 'auto', write: 'auto', destructive: 'ask' }

/** What the reader allows this kind of tool to do. */
export function toolModeFor(settings: Pick<AssistantSettings, 'toolModes'>, permission: ToolPermission): AssistantToolMode {
  return settings.toolModes[permission]
}

export interface AssistantSettings {
  agentName: string
  language: 'en-US' | 'zh-CN'
  timezone: string
  activeModelId: string | null
  /**
   * The model a realtime voice session is opened with.
   *
   * Kept apart from `activeModelId` because a realtime model cannot answer a text turn: it speaks
   * audio, has no note tools, and is billed by audio tokens. Null means the voice screen picks the
   * first enabled realtime model, so adding one is enough to make the entry usable.
   */
  realtimeModelId: string | null
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
   * What the assistant may do without asking, by kind of tool. Reads and writes run unattended by
   * default; a deletion waits for the reader's press. The composer's own chip is the same setting, seen
   * one class at a time, so there is one answer to "may it delete this?" rather than two that can drift.
   */
  toolModes: AssistantToolModes
  /** Answer from the offline stub instead of a provider, so the app is usable with no key. */
  offlineMode: boolean
  /** Which of the assistant's surfaces the container opens on. */
  startView: 'chat' | 'memory' | 'tasks' | 'automations' | 'settings'
  /** Folders the assistant may read notes from; empty means the whole vault. */
  noteScope: string[]
  sendOnEnter: boolean
  /**
   * Standing instructions the reader wants every answer to follow.
   *
   * Sent as its own section of the system prompt, after the built-in rules and before anything about the
   * turn — so it is the reader's voice, not a way to overwrite what the assistant is allowed to do.
   */
  customInstructions: string
  /**
   * Let the assistant choose which of the reader's models answers each turn.
   *
   * Off by default: a reader who picked a model expects that model, and a switch that silently changed
   * the voice would be the kind of setting nobody reads until it surprises them.
   */
  autoRoute: boolean
  /**
   * The address the built-in `web_search` tool queries, for a provider whose protocol has no search of its own.
   *
   * It is read only by the engine named in `webSearchEngine`, and only when that engine is a self-hosted
   * one: a vendor's API has its own fixed address and takes a key instead, and the key lives in its own
   * encrypted row rather than in this blob. Empty means a self-hosted search is off — the tool is not
   * offered at all — because a search that cannot be asked for is worse than no search.
   */
  webSearchEndpoint: string
  /**
   * Which engine the built-in `web_search` tool asks: one of the ids in `@shared/web-search-engines`.
   *
   * Self-hosted is the default, which is what every setup already in the field is, and what a reader who
   * configured nothing keeps. A hosted engine is not usable from this field alone — it needs the reader's
   * key, which is deliberately not a setting: see `webSearchConfigured`.
   */
  webSearchEngine: string
  /**
   * Whether a key is stored for the engine named above. Written by the server on the way out, never read in.
   *
   * Not a setting: it is deliberately absent from `DEFAULT_ASSISTANT_SETTINGS`, so `ASSISTANT_SETTING_KEYS`
   * does not name it, a PATCH cannot claim it, and the stored blob never holds it. It exists because the
   * composer's chip has to say *why* search is off, and one honest answer is "the engine you picked is
   * waiting for a key" — a fact no settings blob can carry, since the key itself lives in its own encrypted
   * row and is never handed to a browser.
   */
  webSearchKeyStored?: boolean
}

export const ASSISTANT_START_VIEWS = ['chat', 'memory', 'tasks', 'automations', 'settings'] as const

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  agentName: 'Inkstone Assistant',
  language: 'en-US',
  timezone: 'UTC',
  activeModelId: null,
  realtimeModelId: null,
  temperature: 0.4,
  limits: { ...DEFAULT_LIMITS },
  semanticMemory: true,
  semanticModel: DEFAULT_SEMANTIC_MODEL,
  autoMemory: false,
  conflictReview: true,
  aiConflictCheck: false,
  toolModes: { ...DEFAULT_TOOL_MODES },
  offlineMode: false,
  startView: 'chat',
  noteScope: [],
  sendOnEnter: true,
  customInstructions: '',
  autoRoute: false,
  webSearchEndpoint: '',
  webSearchEngine: DEFAULT_WEB_SEARCH_ENGINE_ID,
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
 * The reader's tool policy, read class by class.
 *
 * Two shapes arrive here. One is the map this app writes today, where a class the reader has not touched
 * is simply absent and the default answers for it. The other is a config written before the map existed,
 * which carried one boolean for the whole destructive class: an account that had switched auto-approve on
 * gets it back as `destructive: 'auto'`, because a setting silently reverting to "ask me every time" is
 * a reader's preference being changed behind their back.
 */
function toolModesValue(raw: Record<string, unknown>): AssistantToolModes {
  const stored = record(raw.toolModes)
  const legacy = booleanValue(raw.autoApproveWrites, false)
  return {
    read: enumValue(stored.read, ASSISTANT_TOOL_MODES, DEFAULT_TOOL_MODES.read),
    write: enumValue(stored.write, ASSISTANT_TOOL_MODES, DEFAULT_TOOL_MODES.write),
    destructive: enumValue(stored.destructive, ASSISTANT_TOOL_MODES, legacy ? 'auto' : DEFAULT_TOOL_MODES.destructive),
  }
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
    realtimeModelId: typeof raw.realtimeModelId === 'string' && raw.realtimeModelId ? raw.realtimeModelId.slice(0, 26) : null,
    temperature: numberInRange(raw.temperature, 0, 1.5, DEFAULT_ASSISTANT_SETTINGS.temperature),
    limits,
    semanticMemory: booleanValue(raw.semanticMemory, DEFAULT_ASSISTANT_SETTINGS.semanticMemory),
    semanticModel: semanticModelValue(raw.semanticModel, DEFAULT_ASSISTANT_SETTINGS.semanticModel),
    autoMemory: booleanValue(raw.autoMemory, DEFAULT_ASSISTANT_SETTINGS.autoMemory),
    conflictReview: booleanValue(raw.conflictReview, DEFAULT_ASSISTANT_SETTINGS.conflictReview),
    aiConflictCheck: booleanValue(raw.aiConflictCheck, DEFAULT_ASSISTANT_SETTINGS.aiConflictCheck),
    toolModes: toolModesValue(raw),
    offlineMode: booleanValue(raw.offlineMode, DEFAULT_ASSISTANT_SETTINGS.offlineMode),
    startView,
    noteScope: stringList(raw.noteScope, 12, 26),
    sendOnEnter: booleanValue(raw.sendOnEnter, DEFAULT_ASSISTANT_SETTINGS.sendOnEnter),
    customInstructions: stringValue(raw.customInstructions, DEFAULT_ASSISTANT_SETTINGS.customInstructions, MAX_CUSTOM_INSTRUCTIONS_CHARS),
    autoRoute: booleanValue(raw.autoRoute, DEFAULT_ASSISTANT_SETTINGS.autoRoute),
    webSearchEndpoint: searchEndpointValue(raw.webSearchEndpoint),
    webSearchEngine: webSearchEngineValue(raw.webSearchEngine),
  }
}

/** The longest web-search address the settings will hold: one address, not a query string someone pasted. */
export const MAX_SEARCH_ENDPOINT_CHARS = 2_048

/**
 * The configured web-search address, as stored text: blank, or a public http(s) URL.
 *
 * The worker fetches this address with its own network position, on the model's say-so, which makes it the
 * same class of input as a provider's base URL — so it is vetted by the same guard, and a value that fails
 * is dropped to blank rather than stored. Blank is a real answer here: the tool is then simply not offered,
 * and the composer says so instead of running a search that returns nothing.
 */
export function searchEndpointValue(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length > MAX_SEARCH_ENDPOINT_CHARS) return fallback
  try {
    assertRelayableEndpoint(trimmed)
  } catch {
    return fallback
  }
  return trimmed
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
 * A follow-up list made safe to store and to show: trimmed, empties dropped, each line bounded, duplicates
 * removed, and the whole thing capped to {@link MAX_TITLE_SUGGESTIONS}.
 *
 * This is the one shape both sides of the column share. The naming pass runs it on what the model volunteered
 * before writing — a list of five, or of three long sentences, is trimmed to three short ones rather than
 * thrown out whole, because a partial answer is worth more than none — and the transcript read runs it again
 * on the stored value, because the same column is what a backup hands back, and a file is not held to the
 * limits the live turn was. An input that is not an array, or an array of nothing usable, becomes `[]`, which
 * is what lets the row stay absent-keyed rather than carry a field nobody renders.
 */
export function clipSuggestionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const clean = entry.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_SUGGESTION_CHARS)
    if (!clean || out.includes(clean)) continue
    out.push(clean)
    if (out.length >= MAX_TITLE_SUGGESTIONS) break
  }
  return out
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

/**
 * The sense a file asks of a model, or null when a turn already knows how to read it.
 *
 * A text file is decoded into the prompt and a picture rides with it as an image part, so both are answered
 * by every path the composer offers. A recording asks for `audio` and a clip for `video`, and the two are
 * not the same list as `ASSISTANT_MODEL_MODALITIES`: this one is about what a file *wants*, which outlives
 * any switch the app can honestly offer.
 *
 * Whether one particular recording can be sent is a narrower question, answered by `audioFormatFor` and
 * `protocolCarriesAudio`, and this function is not it — a `.m4a` is still `audio` here even though no
 * provider would decode it.
 *
 * One function answers the question because three surfaces have to give the same answer: the worker names
 * the file in the model-facing block, the composer warns the reader before the turn is paid for, and the
 * viewer says so on the panel it opens. A second definition is a second place for those to drift, and the
 * drift is a chip that claims a file went into a turn that could never have read it.
 */
export function attachmentModality(mime: string, filename: string): AttachmentSense | null {
  const lower = `${mime} ${filename}`.toLocaleLowerCase()
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac)$/.test(lower)) return 'audio'
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|avi|mkv)$/.test(lower)) return 'video'
  return null
}

/**
 * The containers the audio field is documented to take.
 *
 * Not a wider list on purpose: `format` is an enum at the far end, and a request carrying one it does not
 * know is refused outright — the whole turn costs the reader and answers nothing. Guessing `mp3` for a
 * `.flac` would trade one honest refusal for a provider error.
 */
export type ChatAudioFormat = 'mp3' | 'wav'

const AUDIO_WAV_MIME = /^audio\/(x-)?(wav|wave|pcm)$/
const AUDIO_MP3_MIME = /^audio\/(mpeg|mp3)$/
const AUDIO_MP3_NAME = /\.(mp3|mpega)$/
const AUDIO_WAV_NAME = /\.(wav|wave)$/

/**
 * Which container these bytes are, or null when nothing downstream would decode them.
 *
 * A browser hands a dragged file with no `type` at all, so the extension answers too — the same pair the
 * pickers and `attachmentModality` already read. The name is checked last because a file called `song.mp3`
 * that is really a FLAC is a request the provider refuses; when a type is present and says something else,
 * the type wins and the answer is null.
 */
export function audioFormatFor(mime: string, filename: string): ChatAudioFormat | null {
  const type = mime.toLocaleLowerCase().split(';')[0]!.trim()
  if (type) {
    if (AUDIO_WAV_MIME.test(type)) return 'wav'
    if (AUDIO_MP3_MIME.test(type)) return 'mp3'
    return null
  }
  const lower = filename.toLocaleLowerCase()
  if (AUDIO_WAV_NAME.test(lower)) return 'wav'
  if (AUDIO_MP3_NAME.test(lower)) return 'mp3'
  return null
}

/**
 * The wires that have a field for audio bytes.
 *
 * `openai` is the chat-completions shape every imitator copies, and it is the one with `input_audio`.
 * Anthropic's messages API has no audio block at all, and Gemini's `inline_data` would be a third shape
 * this app has no case for sending — so on those two a recording is named in the turn and never carried,
 * whatever the reader has ticked.
 */
const AUDIO_CARRYING_PROTOCOLS: readonly AssistantProtocol[] = ['openai']

/** Whether this protocol's request builder can be handed a recording's bytes. */
export function protocolCarriesAudio(protocol: AssistantProtocol): boolean {
  return AUDIO_CARRYING_PROTOCOLS.includes(protocol)
}

/**
 * A recording is sent inline up to this size.
 *
 * Half the ceiling a chat file is stored under, on purpose: base64 costs about a third again of the bytes,
 * eight attachments is the composer's own limit, and a body of four megabytes is also four megabytes of the
 * isolate held for the answer. Below this the reader gets the recording; above it they get a line saying so,
 * which is what a picture already does at its own number.
 *
 * The number lives here rather than in the worker because two surfaces have to answer with it: the request
 * builder that decides whether these bytes ride at all, and the composer that refuses the file before a byte
 * of it leaves the browser. A second copy of it in the client would be a ceiling the worker never agreed to.
 */
export const AUDIO_SEND_MAX_BYTES = 2 * 1024 * 1024

/**
 * The audio entries a file picker may be given, when it may be given any.
 *
 * The system picker filters on the mime and on the extension, and a browser that cannot name a type hands
 * back an empty one, so both forms are listed. The two containers are exactly the ones `audioFormatFor`
 * answers a format for — never a wider list: `format` is an enum at the far end of the request, and an
 * offer the field would refuse is a file the reader picked with their own hands and the turn then named
 * back unread.
 *
 * Whether they belong in the attribute at all is not this list's decision; it is the model's, and the
 * composer asks the queue's own refusal. See `chatAttachmentAccept`.
 */
export const CHAT_AUDIO_ACCEPT: readonly string[] = [
  'audio/mpeg', 'audio/wav', 'audio/x-wav', '.mp3', '.wav',
]

/** A note tag or folder the reader pinned to one turn with `#`. */
export interface AssistantTurnScope {
  /**
   * What was pinned: a tag, a folder, or a note the reader added to the turn by hand.
   *
   * A note is not a permission like the other two — it is the reader pointing at one page, the same act
   * as having it open in the notebook, done several at a time from the composer.
   */
  kind: 'tag' | 'folder' | 'note'
  id: string
  name: string
}

/** One saved skill: the reader's own words, plus the arrangement they travel with. */
export const MAX_SKILL_TITLE_CHARS = 120
export const MAX_SKILL_CONTENT_CHARS = 8_000
/**
 * Long enough for one emoji, including the multi-code-point ones a family or a flag is written with —
 * `👨‍👩‍👧` is five UTF-16 units — and short enough that nothing but an icon fits.
 */
export const MAX_SKILL_ICON_CHARS = 8

export interface AssistantSkill {
  id: string
  title: string
  content: string
  /** Free-text grouping; empty means the skill is unfiled. */
  group: string
  /** The emoji it wears in the library; empty means it shows the generic glyph. */
  icon: string
  /**
   * What applying the skill arranges for the turn, in the same shapes the composer's own `/` and `#`
   * picks use. A skill that only carries words has three empty bindings, which is how every one written
   * before these columns existed still reads.
   */
  tools: string[]
  scopes: AssistantTurnScope[]
  /** Whichever model should answer; null leaves the reader's current pick alone. */
  modelId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * What the reader writes into a skill, as opposed to what comes back.
 *
 * Every field is optional because both halves of an edit arrive from the same form and the server keeps
 * whatever the request did not name; the timestamps and id are the server's to assign.
 */
export interface AssistantSkillInput {
  title?: string
  content?: string
  group?: string
  icon?: string
  tools?: string[]
  scopes?: AssistantTurnScope[]
  modelId?: string | null
}

/**
 * One skill as it travels in a bundle: everything the reader wrote, and nothing the server assigns.
 *
 * The id and the timestamps are left out on purpose — a skill that lands on another machine is a new row
 * there, not the same row seen twice, and an id from someone else's account would either collide with a
 * row that already exists or dangle after a delete. The bindings do travel, because half of what makes a
 * skill a skill is the arrangement: `tools` are the built-in registry's own names, which mean the same
 * thing everywhere, while a folder id or a model id that the importing account does not have is dropped
 * on the way in rather than failing the file.
 */
export interface AssistantSkillExport {
  title: string
  content: string
  group: string
  icon: string
  tools: string[]
  scopes: AssistantTurnScope[]
  modelId: string | null
}

/** The file a reader downloads, and the shape an import reads back. */
export interface AssistantSkillBundle {
  /** The bundle's own shape version, so a later reader can tell what it is looking at. */
  version: number
  skills: AssistantSkillExport[]
}

export const SKILL_BUNDLE_VERSION = 1
/** As many skills as the list route will hand over in one read, so an export never silently truncates. */
export const MAX_SKILL_BUNDLE_SKILLS = 500

/** The reader's library as the file it downloads. */
export function skillBundleOf(skills: readonly AssistantSkill[]): AssistantSkillBundle {
  return {
    version: SKILL_BUNDLE_VERSION,
    skills: skills.map((skill) => ({
      title: skill.title,
      content: skill.content,
      group: skill.group,
      icon: skill.icon,
      tools: skill.tools,
      scopes: skill.scopes,
      modelId: skill.modelId,
    })),
  }
}

/**
 * The entries a downloaded file holds, or `null` when the parsed JSON is not a bundle at all.
 *
 * A bare array is read as well as the bundle object, because a reader who hand-writes one skill should
 * not have to guess at a version envelope. The entries themselves are handed on unread: what an entry
 * may contain is the server's question, and answering it in two places is how the two answers drift.
 */
export function skillBundleEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { skills?: unknown }).skills)) {
    return (parsed as { skills: unknown[] }).skills
  }
  return null
}

/** Why one entry of an imported file could not be used, in codes the client turns into its own words. */
export type SkillImportSkip = 'shape' | 'empty'

export interface SkillImportResult {
  imported: number
  skipped: { title: string, reason: SkillImportSkip }[]
}

/** Ceilings for one turn's inline picks, so a composer cannot ask for the whole vault. */
export const MAX_TURN_TOOLS = 6
export const MAX_TURN_SCOPES = 6

/**
 * How many pages one project may name as its knowledge base.
 *
 * One number for both sides of the wire: the editor stops offering a pick past it and the route refuses a
 * body that carries more, because the list travels in the system prompt on every turn under the project.
 * Past this many, the folder scope is the right tool rather than a longer list.
 */
export const MAX_PROJECT_NOTES = 24

export interface AssistantConversation {
  id: string
  title: string
  pinned: boolean
  /** The reader's own shortlist, separate from the pinned order the list opens in. */
  starred: boolean
  /**
   * Put away without being deleted: still searchable, still backed up, but out of the everyday list.
   *
   * Distinct from the two flags above because it is the one that hides a row rather than marking it.
   */
  archived: boolean
  /**
   * A conversation the reader asked not to keep.
   *
   * It is stored all the same — a thread that vanished on a reload would lose the thought the reader was
   * in the middle of — but it is kept out of every listing, out of search and out of a backup, and the
   * hourly sweep deletes it once it has gone untouched for {@link EPHEMERAL_CONVERSATION_RETENTION_DAYS}.
   * That is the promise the UI makes, so it is the one the queries keep.
   */
  ephemeral: boolean
  /**
   * The conversation this one was forked from; null for one that started its own thread.
   *
   * A label on the tree and nothing more: a fork copies its turns, so deleting either side leaves the
   * other whole and the id is allowed to point at a conversation that no longer exists.
   */
  parentId?: string | null
  /** A folder from the notebook's own tree; null means the conversation is unfiled. */
  folderId: string | null
  /** The project this conversation belongs to, whose instructions and knowledge it inherits. */
  projectId?: string | null
  /**
   * The note this thread was started from.
   *
   * A label, like the parent id: it is what lets the thread say where it came from when the reader comes
   * back to it. It is not a search key — the list endpoint filters by text, folder, project and tag, and
   * nothing reads this one.
   */
  noteId?: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Only the list endpoints fill these in, so the thread view stays cheap. */
  tags?: ConversationTag[]
  /** Rolling summary of the messages that no longer fit the context window. */
  summary?: string | null
  summaryUpto?: number | null
  /**
   * The first message that matched a list search, with a short excerpt around the hit.
   *
   * Only a search fills this in. It is what turns "this thread contains the word" into a row the reader
   * can judge without opening it, and what the click scrolls to once the thread is open.
   */
  match?: { messageId: string, snippet: string } | null
}

/**
 * The protocols with a vendor-side web search that can simply be asked for.
 *
 * Everywhere else the switch can only work by pinning a search-capable tool from the reader's own MCP
 * servers, which is why the composer asks before it offers the switch at all.
 */
export const SEARCH_NATIVE_PROTOCOLS: ReadonlySet<string> = new Set(['anthropic', 'gemini'])

/**
 * The assistant's own search tool, executed by the worker against the reader's configured search address.
 *
 * Named apart from the vendor's search because the two are different things: this one is a tool call the
 * worker answers itself, so it works on every protocol, while the vendor-side one only exists on the two
 * protocols above and is preferred wherever it does.
 */
export const WEB_SEARCH_TOOL_NAME = 'web_search'

/**
 * Whether the built-in search tool has a channel it could actually use.
 *
 * The answer depends on which engine the reader picked, because the kinds differ in what they wait for: a
 * self-hosted engine has no address until one is written, a vendor's API has its own address written down
 * and answers only for a key — a key stored encrypted in its own row, never in this blob, so settings alone
 * cannot tell whether the reader has one. That is what `keyStored` is for. And DuckDuckGo's Instant Answer
 * waits for nothing at all: no address to write, no key to store, which is why "needs no key" and "is
 * self-hosted" are two different questions and cannot share one branch.
 *
 * A caller that cannot ask leaves it out, and an unknown is then taken at the reader's word: the composer
 * has only these settings to read, and telling a reader with a stored key that nothing could search would
 * be the likelier lie. A server-side caller must pass it — offering a keyed engine's tool without a key is
 * a call that can only fail, and the reader would read that failure as the engine being broken.
 */
export function webSearchConfigured(
  settings: Pick<AssistantSettings, 'webSearchEndpoint' | 'webSearchEngine'>,
  keyStored?: boolean,
): boolean {
  const engine = webSearchEngineFor(settings.webSearchEngine)
  if (engine.selfHosted) return settings.webSearchEndpoint.trim().length > 0
  if (!engine.requiresKey) return true
  return keyStored !== false
}

/**
 * Whether a remote tool's name suggests it can search the web.
 *
 * The fallback for an MCP server that really does search, and only consulted when the built-in tool above
 * is not configured: a name matched by this test can still be an unrelated lookup, so a first-party tool
 * the reader pointed at their own engine outranks a guess about somebody else's.
 */
export function looksLikeSearchTool(name: string): boolean {
  return /search|query|web|browse/i.test(name)
}

/**
 * How many conversations one page of the sidebar carries.
 *
 * A page rather than everything: the list is walked from the top, and a reader with a thousand threads
 * should not pay for all of them to see the ten they came back to. The next page is asked for by cursor.
 */
export const CONVERSATION_PAGE_SIZE = 30

/**
 * How many messages one page of a thread carries.
 *
 * The newest page is what opening a conversation costs; older turns arrive when the reader scrolls to
 * the top and asks for them.
 */
export const MESSAGE_PAGE_SIZE = 60

/**
 * A working draft kept beside a conversation.
 *
 * A reply is where a document usually starts — a plan, a spec, a run of code — and the thread is the wrong
 * place to edit one: a message is a record of what was said, so rewriting it would leave the transcript
 * disagreeing with itself. An artifact is the copy that is meant to be changed. It belongs to the
 * conversation rather than to a note, so it survives a reload and travels with a shared thread; `noteId`
 * is the seam a later build uses to sync one back into the notebook, and stays null until it does.
 */
export interface AssistantArtifact {
  id: string
  conversationId: string
  title: string
  content: string
  /** The note this draft was filed as and pushes back to; null while it is only a draft. */
  noteId: string | null
  /** The head version number. The row's title and content are this version's snapshot. */
  version: number
  createdAt: number
  updatedAt: number
}

/** How one draft version came to exist. A manual edit after it does not change this. */
export type AssistantArtifactVersionSource = 'user' | 'assistant' | 'restore' | 'import'

/**
 * One snapshot of a draft.
 *
 * The list endpoint returns these without `content` — a hundred thousand characters times fifty versions
 * is not a list — and a single-version read carries it. `messageId` is the assistant turn that wrote an
 * assistant version, when there was one.
 */
export interface AssistantArtifactVersion {
  id: string
  artifactId: string
  conversationId: string
  version: number
  title: string
  content?: string
  source: AssistantArtifactVersionSource
  messageId: string | null
  createdAt: number
}

/** How long a draft's own name may be. The same bound every other stored title carries. */
export const MAX_ARTIFACT_TITLE_CHARS = 200

/**
 * How much one draft may hold.
 *
 * Larger than a message, because a draft is the document a message was only the seed of — a whole spec or
 * a long file — and smaller than a note store, because it is a row on a conversation and not a file. A
 * draft past this is refused rather than silently truncated: the reader is editing it, and half a document
 * saved without a word is the failure they would least forgive.
 */
export const MAX_ARTIFACT_CONTENT_CHARS = 100_000

/** How many drafts one conversation may carry, so the panel's own list stays a list. */
export const MAX_ARTIFACTS_PER_CONVERSATION = 50

/**
 * How many versions one draft keeps.
 *
 * Old snapshots are pruned from the bottom when a write crosses this line, never the head. Fifty is far
 * more than a working document needs and small enough that a backup carrying every version stays a file
 * a reader can move.
 */
export const MAX_ARTIFACT_VERSIONS = 50

/**
 * How much of the open draft rides in the system prompt.
 *
 * A draft is the document the turn is working on, so the model needs to see it — but the whole of a
 * hundred-thousand-character draft on every turn would spend the context on text nobody asked about.
 * The runner sends the head and tail around this cap and tells the model to call `read_artifact` for the
 * rest. Eight thousand characters is roughly two thousand tokens, the same order as a long note.
 */
export const MAX_ARTIFACT_CONTEXT_CHARS = 8_000

/** The head and tail the prompt keeps when a draft is longer than its cap. */
export const ARTIFACT_CONTEXT_HEAD_CHARS = 6_000
export const ARTIFACT_CONTEXT_TAIL_CHARS = 2_000

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
  /** The draft this call created or rewrote, so the chip can offer to open it. */
  artifactId?: string
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

/** The three kinds of action, in the order a reader thinks about them: reading, changing, removing. */
export const ASSISTANT_TOOL_PERMISSIONS = ['read', 'write', 'destructive'] as const
export type ToolPermission = (typeof ASSISTANT_TOOL_PERMISSIONS)[number]

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
export const ASSISTANT_MCP_TOOL_MODES = ASSISTANT_TOOL_MODES
export type AssistantMcpToolMode = (typeof ASSISTANT_TOOL_MODES)[number]

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
  /**
   * The client id this app holds at that issuer.
   *
   * Public by the spec's own terms: it rides in the address bar on every redirect. It is shown so the
   * reader can see which of their registered apps this is — and so "withdraw the registration" has
   * something to name.
   */
  clientId: string
  /**
   * True when the id came from the issuer's own registration endpoint rather than from the reader's hands.
   *
   * Only a dynamic registration can be withdrawn at the issuer (RFC 7592), because that is the only one
   * this app was ever handed the means to delete. A hand-typed id can only be forgotten here.
   */
  dynamic: boolean
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
  /** What every tool of this server does unless the reader has said otherwise for that one tool. */
  toolMode: AssistantMcpToolMode
  /**
   * One tool's own answer, for the tools the reader has singled out.
   *
   * Kept as exceptions rather than as a row per tool because a tool the server adds later must arrive
   * usable: a server whose whole point is `search` should not have every new function hidden behind a
   * settings visit. A name here that the server no longer offers simply stops matching anything, and a
   * name set back to what the server already says is dropped, so this stays the list of tools the reader
   * has actually disagreed about.
   */
  toolModes: Record<string, AssistantMcpToolMode>
  /** Whether any request header is stored. The values themselves never leave the worker. */
  hasKey: boolean
  /** The OAuth arrangement, once the reader started one. Null means this server has never been asked. */
  authorization: AssistantMcpAuthorization | null
  createdAt: number
  updatedAt: number
}

/**
 * What one tool of a server may do: the reader's own answer for that tool, or the server's.
 *
 * One function rather than a ternary in each of the three places that ask — the listing that offers the
 * tool, the call that runs it, and the row that shows it — because two spellings of "which one wins" is
 * how a tool ends up looking switched off and answering anyway.
 */
export function mcpToolModeFor(
  server: Pick<AssistantMcpServer, 'toolMode' | 'toolModes'>,
  remoteName: string,
): AssistantMcpToolMode {
  return server.toolModes[remoteName] ?? server.toolMode
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
/** A reader's own per-tool answers are bounded the way the listing itself is. */
export const MAX_MCP_TOOL_OVERRIDES = 200
/** How much of a tool's published argument form the card keeps. It is shown, never parsed here. */
export const MAX_MCP_SCHEMA_CHARS = 4000
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
  /** What this tool does: its own answer when the reader gave one, the server's otherwise. */
  mode?: AssistantMcpToolMode
  /**
   * The tool's own `inputSchema`, as text.
   *
   * Kept so the card can answer "what does this one take?" — the question a reader has before deciding
   * whether to hand a third party the reach it is asking for. Text rather than a parsed object because
   * nothing here reads it: it is shown, and a schema this app cannot parse is still worth showing.
   */
  inputSchema?: string
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
  /** Every tool the server offers, with the mode each one is running under and its argument form. */
  tools: AssistantMcpTool[]
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
  { name: 'list_artifacts', labelKey: 'assistant.tool.list_artifacts', permission: 'read' },
  { name: 'read_artifact', labelKey: 'assistant.tool.read_artifact', permission: 'read' },
  { name: 'create_artifact', labelKey: 'assistant.tool.create_artifact', permission: 'write' },
  { name: 'update_artifact', labelKey: 'assistant.tool.update_artifact', permission: 'write' },
  { name: 'delete_note', labelKey: 'assistant.tool.delete_note', approvalKey: 'assistant.approval.delete_note', permission: 'destructive' },
  { name: 'create_reminder', labelKey: 'assistant.tool.create_reminder', permission: 'write' },
  { name: 'create_automation', labelKey: 'assistant.tool.create_automation', permission: 'write' },
  { name: 'list_automations', labelKey: 'assistant.tool.list_automations', permission: 'read' },
  { name: 'cancel_automation', labelKey: 'assistant.tool.cancel_automation', approvalKey: 'assistant.approval.cancel_automation', permission: 'destructive' },
  { name: 'list_projects', labelKey: 'assistant.tool.list_projects', permission: 'read' },
  { name: 'create_project', labelKey: 'assistant.tool.create_project', permission: 'write' },
  { name: 'search', labelKey: 'assistant.tool.search', permission: 'read' },
  { name: 'notify_reader', labelKey: 'assistant.tool.notify_reader', permission: 'write' },
  { name: 'image_generate', labelKey: 'assistant.tool.image_generate', permission: 'write' },
  { name: 'code_execute', labelKey: 'assistant.tool.code_execute', permission: 'write' },
  { name: 'fetch_url', labelKey: 'assistant.tool.fetch_url', permission: 'read' },
  { name: 'web_search', labelKey: 'assistant.tool.web_search', permission: 'read' },
]

/** A page the model actually consulted, as the vendor reported it. */
export interface AssistantSource {
  url: string
  title: string
  /** The passage the model leaned on, when the vendor said which one. */
  cited?: string
  /**
   * Where the card leads: a page on the web, or a note in this vault.
   *
   * Absent on every citation stored before notes could be cited, which is why it is optional and why the
   * reader of this field treats a missing value as `web`.
   */
  kind?: 'web' | 'note'
  /** The note the card opens, when `kind` is `note`. A url is not enough: the app opens by id. */
  id?: string
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

/**
 * Whether a citation names a note in this vault.
 *
 * Checked by id rather than by url: the url a note citation stores is the app's own relative path, which
 * is not a page a browser can be sent to, and the id is what the client opens with. A stored citation
 * whose id is not a note id is read as a web page and must then have a real url, which is what keeps a
 * backup from turning into a card that leads nowhere.
 */
export function isNoteSourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(value)
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
/** Which slice of the usage dimension tables a stats query is restricted to. */
export interface UsageFilter {
  /** A model label, as the transcript spells it. */
  model?: string
  /** A provider id, optionally narrowed to one of its keys by `keyId`. */
  providerId?: string
  keyId?: string
}

export interface AssistantStats {
  range: '7' | '30' | 'all'
  from: string
  to: string
  total: AssistantUsage
  days: Array<{ day: string } & AssistantUsage>
  models: AssistantModelUsage[]
  keys: AssistantKeyUsage[]
  /**
   * The window day by day, each day already split by model and by key.
   *
   * One series rather than three because the same days are read three ways — a bar per day grouped by model,
   * the same bars grouped by key, and one model's own line across the window — and three queries would be
   * three chances to describe a different window.
   */
  series: AssistantUsageDay[]
  /** Every model label seen in the window, unfiltered, so the model picker keeps all its choices. */
  modelOptions: string[]
  conversations: AssistantConversationUsage[]
  /** One entry per currency the reader's prices are in, never summed across them. */
  spend: Array<{ currency: string, amount: number }>
  /** How many of the models used in this window have no price, so a total can say what it left out. */
  unpricedModels: number
  generatedAt: number
  limits: AssistantLimits
}

/** One day of the window, with what it cost and what paid for it. */
export interface AssistantUsageDay {
  day: string
  requests: number
  inputTokens: number
  outputTokens: number
  /** Empty when nothing that day was priced: "no price" is not the same claim as "cost nothing". */
  costs: Array<{ currency: string, amount: number }>
  models: AssistantUsageSlice[]
  keys: AssistantUsageSlice[]
}

/** One bar of a day: what a single model, or a single key, contributed to it. */
export interface AssistantUsageSlice {
  /** The model label, or `providerId:keyId` when the day is split by key. */
  id: string
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  costs: Array<{ currency: string, amount: number }>
  /** True when this slice names a model the reader has not priced, so a chart can say what it left out. */
  unpriced: boolean
}

/**
 * The account's own numbers, over its whole life rather than a window.
 *
 * These are the figures a reader checks to see what the assistant has cost them in total, so none of them
 * is scoped to the range the usage screen is showing: a cumulative total that reset when the range changed
 * would not be cumulative.
 */
export interface AssistantUsageOverview {
  /** Every token the assistant has ever been charged for. */
  totalTokens: number
  /** The busiest single day, and what it spent. Null until there is a day to name. */
  peakDay: string | null
  peakTokens: number
  /** The longest a single turn has ever taken, in ms. Zero until one has been timed. */
  longestTurnMs: number
  /**
   * Consecutive days ending today.
   *
   * A day not yet spent on does not break the run — otherwise the number would read zero every morning
   * until the reader's first question of the day.
   */
  currentStreak: number
  longestStreak: number
  /** Every day with usage, oldest first. The activity map draws from this rather than from any range. */
  activity: Array<{ day: string, tokens: number }>
}

/** One provider key's share of the window, folded across whatever models it paid for. */
export interface AssistantKeyUsage {
  providerId: string
  providerLabel: string
  /** Empty until a provider carries more than one key; the row is the provider's own key when so. */
  keyId: string
  keyLabel: string
  requests: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  errors: number
  /** One entry per currency the key's models are priced in; empty when they are all unpriced. */
  costs: Array<{ currency: string, amount: number }>
  unpriced: boolean
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

/** How much a reader may say about a downvote. */
export const MAX_FEEDBACK_REASON_CHARS = 500

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
  /**
   * What the turn was allowed to read, when the reader pinned it to a note, a folder or a tag.
   *
   * Stored with the reader's own words rather than derived later: the scope is a decision made at the
   * moment of asking, and an answer that only knew one note should still say so when the thread is read
   * back a week later. Absent on every turn that pinned nothing, and on every row written before the
   * column existed.
   */
  scopes?: AssistantTurnScope[]
  /**
   * The follow-up questions the model volunteered for this answer, kept on the answer that produced them.
   *
   * Only the assistant row of a conversation's first turn ever carries them: they are asked for in the same
   * post-turn call that names the thread, and stored on the reply they follow so reopening the thread a week
   * later — or reading it from a backup on another device — shows the same three chips. Absent on a turn that
   * was never given a naming pass, on every row written before the column existed, and on every row whose
   * naming call failed (the answer is honest about having no suggestions rather than inventing filler).
   * Bounded to `MAX_TITLE_SUGGESTIONS`, each trimmed to `MAX_TITLE_SUGGESTION_CHARS`, on the way in and the
   * way back out.
   */
  suggestions?: string[]
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
  /**
   * What the reader said was wrong with a downvote, when they said anything.
   *
   * Only a `down` verdict carries one, and it is kept separate from the verdict so the transcript's existing
   * read of `feedback` still names the thumb it shows. Absent for an upvote, a bare downvote, and every row
   * written before a reason could be given.
   */
  feedbackReason?: string
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
  /**
   * When the reader kept this answer, or null for a turn nobody kept.
   *
   * The one piece of the saved state a transcript read carries: the bubble's press has to say whether it is
   * down before anything is written, and a mark the reader made on Tuesday has to still be there on Friday
   * and on another device. A timestamp rather than a flag because the shelf the keeps are listed on orders
   * by when the answer was taken, and the same value says both. Absent on a turn still streaming, which is
   * not a row yet and so cannot be kept.
   */
  savedAt?: number | null
}

/**
 * One answer the reader kept, as the shelf lists it.
 *
 * The thread travels with it because a keep is a pointer into a conversation: the row has to say what it
 * belongs to and be openable, and the server is the only thing that knows which title that thread has now.
 * A reader coming back with only the message id in hand would have to open every thread to find the one
 * that holds it.
 */
export interface SavedMessage {
  id: string
  conversationId: string
  /** The thread's title as it stands now, which the row shows and the shelf opens. */
  conversationTitle: string
  role: 'user' | 'assistant'
  /**
   * The turn's opening lines, with the whitespace flattened.
   *
   * Enough to recognise the answer without opening the thread — the row is a pointer, not a reading surface,
   * and a shelf of full replies is the transcript again in a narrower box.
   */
  excerpt: string
  savedAt: number
  createdAt: number
}

/**
 * How many kept answers one page of the shelf carries.
 *
 * Smaller than a transcript page: these rows are a list to scan for one thing the reader remembers keeping,
 * and a page that needs scrolling past twenty of them to reach the twenty-first answers nothing sooner.
 */
export const SAVED_MESSAGE_PAGE_SIZE = 20

/** How much of a kept answer the shelf row shows. */
export const SAVED_MESSAGE_EXCERPT_CHARS = 160

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
  /**
   * The project this fact belongs to, or null for one that belongs to the account.
   *
   * A project is a context — a client, an engagement, a piece of work — and what is true inside one is
   * not automatically true in the next. So a fact is filed where it was learned, and a turn answering
   * inside a project recalls that project's facts plus the account's own, never another project's.
   */
  projectId: string | null
  /**
   * The note this fact was written out as, when the reader asked for one.
   *
   * A pointer rather than a copy: the memory stays the fact, and the note is where it can be edited as
   * prose. Null means it has not been written out — not that it was written out and lost — so the list
   * offers "save as a note" only while it is null.
   */
  noteId: string | null
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
  /**
   * The pages this project reads by name, as note ids.
   *
   * Beside `noteScope` rather than inside it, because the two select at a different grain and one merged
   * list could not say which: a folder says "everything in here", this says "these three pages, wherever
   * they sit". Only ids this account owns reach the column — the route refuses the rest rather than
   * dropping them, because a project that quietly kept a third of a selection would report a knowledge
   * base the reader never chose.
   */
  noteIds: string[]
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
  /**
   * The folder a `note_write` routine files its answer into.
   *
   * Kept beside `targetNoteId` rather than merged into one "target" union because the two are read by
   * different questions: one says "make a page in here every time", the other says "rewrite this page".
   * Exactly one of them is set for a `note_write`, and both are null for every other kind — the create
   * refuses any other combination, because a schedule that quietly lost its folder would run forever and
   * write nothing. The id is only ever one this account owns; a stranger's is refused where it is set.
   */
  targetFolderId: string | null
  /** The page a `note_write` routine rewrites instead of making a new one. */
  targetNoteId: string | null
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
  /**
   * The page this run wrote, when it wrote one.
   *
   * The receipt has to name the note, not only say that something succeeded: the reader looking at a
   * schedule that rewrote a page every morning wants to open that page. Null for every run that did not
   * file a note, including the failed ones — a pointer at nothing would be worse than none.
   */
  noteId: string | null
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
  /** The drafts those conversations were carrying, restored with them. */
  artifacts: number
  /** The snapshots those drafts were carrying, restored with them. */
  artifactVersions: number
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
  type: 'start' | 'text' | 'reasoning' | 'tool' | 'artifact' | 'title' | 'stage' | 'usage' | 'error' | 'done' | 'mcp_problem' | 'notice'
  conversationId?: string
  userMessageId?: string
  assistantMessageId?: string
  title?: string
  /**
   * For `title`: the follow-up questions the naming pass volunteered for the answer it just filed.
   *
   * Sent beside `assistantMessageId`, which is the row they were written on and the row the chips belong
   * under — the frame is what lets the transcript put them there without reading the thread again. Absent
   * when the pass named the thread and volunteered nothing, and never an empty list.
   */
  suggestions?: string[]
  delta?: string
  tool?: ToolActivity
  /**
   * For `artifact`: the draft a tool just created or rewrote.
   *
   * The whole row travels because the panel is showing the text: a frame that carried only an id would
   * make every write a second request before the reader could see what changed.
   */
  artifact?: AssistantArtifact
  change?: 'created' | 'updated' | 'restored'
  stage?: 'reading' | 'searching' | 'generating' | 'waiting'
  usage?: { inputTokens: number, outputTokens: number }
  /** For `mcp_problem`: which external server failed to list, and why. */
  server?: string
  /**
   * For `notice`: something the reader asked for that this turn cannot do.
   *
   * A code rather than a sentence, because the sentence is interface copy and lives in the catalog.
   */
  notice?: 'web_search_unavailable'
  /**
   * For `start`: the token of the run lease this turn holds, so the reader's own tab can release exactly
   * that claim and nothing else's.
   *
   * Sent whenever the turn holds the claim — whether it took the lease itself or the route handed it the
   * token it claimed under. A turn watching somebody else's run has no token to be given.
   */
  runToken?: number
  error?: string
  code?: string
  message?: string
  finalMessage?: AssistantMessage
}

export function normalizeScheduleForStorage(value: unknown): ScheduleSpec | null {
  return parseScheduleSpec(value)
}
