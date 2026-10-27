/**
 * Cloudflare's AI catalogue, and the parts of a model schema this app has to understand.
 *
 * The model list is live (Cloudflare adds and retires models), while a model's input schema is
 * stable enough to keep for an hour — the TTS screens ask for it on every open, and the schema call
 * is one more round trip per model. The body a speech model accepts is derived from that schema
 * rather than hard-coded: melotts takes `prompt` and aura takes `text`, and the speaker enums differ
 * per model.
 */
import { ApiError } from '../lib/errors'
import type { LoadedAccount } from './accounts'
import { cfFetch } from './cf-api'

export interface ModelInputSchema {
  properties: Record<string, unknown>
  required: string[]
}

export interface AiModel {
  id: string
  task?: string
  speakers?: string[]
  default_speaker?: string
  advanced_params?: Record<string, unknown>
}

export interface TtsAdvancedOptions {
  encoding?: string
  container?: string
  sample_rate?: number
  bit_rate?: number
  lang?: string
}

const SCHEMA_TTL_MS = 60 * 60 * 1000

const schemaCache = new Map<string, { schema: ModelInputSchema | null; fetchedAt: number }>()

/** Exposed for tests and for a cache-clear action; the cache is otherwise per isolate. */
export function clearAiModelSchemaCache(): void {
  schemaCache.clear()
}

function taskName(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name
    return typeof name === 'string' && name ? name : undefined
  }
  return undefined
}

function normalizeTask(value: string): string {
  return value.toLowerCase().replace(/-/g, ' ')
}

/** The catalogue, optionally narrowed to one task name (matched loosely, as Cloudflare writes it). */
export async function getAvailableModels(
  account: LoadedAccount,
  taskFilter?: string,
): Promise<AiModel[]> {
  const cfAccountId = account.row.cf_account_id
  if (!cfAccountId) throw ApiError.badRequest('That account has no Cloudflare account id')
  const body = await cfFetch<{ result?: unknown }>(
    account.auth,
    `/accounts/${cfAccountId}/ai/models/search`,
  )
  const result = body.result
  const raw = Array.isArray(result)
    ? result
    : result && typeof result === 'object'
      ? (result as { object?: unknown }).object
      : undefined
  const entries = Array.isArray(raw) ? raw : []
  const filter = taskFilter?.trim() ? normalizeTask(taskFilter) : ''
  const models: AiModel[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { name?: unknown; id?: unknown; task?: unknown }
    const id = typeof record.name === 'string'
      ? record.name
      : typeof record.id === 'string'
        ? record.id
        : ''
    if (!id) continue
    const task = taskName(record.task)
    if (filter && !normalizeTask(task ?? '').includes(filter)) continue
    models.push(task ? { id, task } : { id })
  }
  return models
}

export async function getModelInputSchema(
  account: LoadedAccount,
  model: string,
): Promise<ModelInputSchema | null> {
  const cfAccountId = account.row.cf_account_id
  if (!cfAccountId || !model) return null
  const key = `${account.row.id}::${model}`
  const cached = schemaCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) return cached.schema

  let schema: ModelInputSchema | null = null
  try {
    const body = await cfFetch<{ result?: { input?: unknown } }>(
      account.auth,
      `/accounts/${cfAccountId}/ai/models/schema?model=${encodeURIComponent(model)}`,
    )
    const input = body.result?.input
    if (input && typeof input === 'object') {
      const record = input as { properties?: unknown; required?: unknown }
      schema = {
        properties: record.properties && typeof record.properties === 'object'
          ? record.properties as Record<string, unknown>
          : {},
        required: Array.isArray(record.required)
          ? record.required.filter((item): item is string => typeof item === 'string')
          : [],
      }
    }
  } catch (error) {
    console.warn(`[inkstone] AI model schema lookup failed for ${model}:`, (error as Error)?.message)
  }
  schemaCache.set(key, { schema, fetchedAt: Date.now() })
  return schema
}

/**
 * OpenAI voice names mapped to Cloudflare speakers. Only a fallback: whatever the model's schema
 * enumerates wins, and a model without a speaker property never receives one.
 */
const VOICE_MAP: Record<string, string> = {
  alloy: 'luna',
  echo: 'mars',
  fable: 'athena',
  onyx: 'apollo',
  nova: 'aurora',
  shimmer: 'iris',
}

/** The speaker choices and default a speech model's schema declares, if it has any. */
export function extractTtsSpeakerMeta(
  schema: ModelInputSchema | null,
): { speakers: string[]; defaultSpeaker?: string } {
  const speaker = schema?.properties.speaker
  if (!speaker || typeof speaker !== 'object') return { speakers: [] }
  const speakers = stringEnum(speaker)
  const fallback = (speaker as { default?: unknown }).default
  return typeof fallback === 'string'
    ? { speakers, defaultSpeaker: fallback }
    : { speakers }
}

export function resolveTtsSpeaker(
  requestedVoice: string | undefined,
  speakers: string[],
  defaultSpeaker?: string,
): string | undefined {
  if (speakers.length === 0) return undefined
  if (requestedVoice && speakers.includes(requestedVoice)) return requestedVoice
  const mapped = requestedVoice ? VOICE_MAP[requestedVoice] : undefined
  if (mapped && speakers.includes(mapped)) return mapped
  if (defaultSpeaker && speakers.includes(defaultSpeaker)) return defaultSpeaker
  return speakers[0]
}

/** The optional schema properties the speech screens offer as advanced settings. */
export function extractTtsAdvancedParams(
  schema: ModelInputSchema | null,
): Record<string, unknown> | undefined {
  if (!schema) return undefined
  const excluded = new Set(['text', 'prompt', 'speaker'])
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (excluded.has(name)) continue
    if (!raw || typeof raw !== 'object') continue
    const definition = raw as { type?: unknown; enum?: unknown; default?: unknown; minimum?: unknown; maximum?: unknown }
    const entry: Record<string, unknown> = {}
    if (typeof definition.type === 'string') entry.type = definition.type
    if (Array.isArray(definition.enum)) entry.enum = definition.enum
    if (definition.default !== undefined) entry.default = definition.default
    if (typeof definition.minimum === 'number') entry.min = definition.minimum
    if (typeof definition.maximum === 'number') entry.max = definition.maximum
    out[name] = entry
  }
  return Object.keys(out).length ? out : undefined
}

function stringEnum(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const list = (value as { enum?: unknown }).enum
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
}

/**
 * The request body one speech model accepts.
 *
 * With a schema every field is written only when the schema declares it. Without one the model
 * family decides the text field, which keeps melotts and the aura line working when the schema
 * lookup is down — the call may still fail upstream, but it fails for the right reason.
 */
export function buildTtsCfBody(
  schema: ModelInputSchema | null,
  model: string,
  input: string,
  voice: string | undefined,
  options: TtsAdvancedOptions = {},
): { body: Record<string, unknown>; speaker: string | undefined } {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown> | undefined>
  const melotts = model.toLowerCase().includes('melotts')
  const body: Record<string, unknown> = {}

  const textKey = properties.prompt ? 'prompt' : properties.text ? 'text' : melotts ? 'prompt' : 'text'
  body[textKey] = input

  let speaker: string | undefined
  if (properties.speaker) {
    const speakers = stringEnum(properties.speaker)
    if (speakers.length > 0) {
      const defaultSpeaker = typeof properties.speaker.default === 'string' ? properties.speaker.default : undefined
      speaker = resolveTtsSpeaker(voice, speakers, defaultSpeaker)
      if (speaker) body.speaker = speaker
    }
  } else if (!schema && !melotts && voice) {
    speaker = VOICE_MAP[voice] ?? voice
    body.speaker = speaker
  }

  const encodings = stringEnum(properties.encoding)
  if (encodings.length > 0) {
    body.encoding = encodings.includes('mp3') ? 'mp3' : encodings[0]
    if (options.encoding && encodings.includes(options.encoding)) body.encoding = options.encoding
  } else if (!schema && !melotts) {
    body.encoding = options.encoding ?? 'mp3'
  }

  if (options.container && properties.container) {
    const containers = stringEnum(properties.container)
    if (containers.includes(options.container)) body.container = options.container
  }

  const writeNumber = (name: 'sample_rate' | 'bit_rate', value: number | undefined) => {
    const definition = properties[name]
    if (value === undefined || !definition) return
    if (typeof definition.minimum === 'number' && value < definition.minimum) return
    if (typeof definition.maximum === 'number' && value > definition.maximum) return
    body[name] = value
  }
  writeNumber('sample_rate', options.sample_rate)
  writeNumber('bit_rate', options.bit_rate)

  if (options.lang) {
    if (properties.lang) {
      const langs = stringEnum(properties.lang)
      if (langs.length === 0 || langs.includes(options.lang)) body.lang = options.lang
    } else if (!schema && melotts) {
      body.lang = options.lang
    }
  }

  return { body, speaker }
}
